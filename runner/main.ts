// Software Factory – Runner
// Läuft dauerhaft auf dem Server. Holt GitHub Issues mit dem Label "factory",
// startet pro Issue einen Docker-Container mit Claude Code und hält Labels und Board aktuell.
// Er schreibt selbst nie Code. Das macht der Agent im Container.

import {
  appendFileSync, closeSync, constants, existsSync, fchownSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  rmSync, statSync, writeFileSync, writeSync, chownSync,
} from "node:fs";
import { join } from "node:path";

export type Config = {
  repos: string[];
  label: string;
  /** Wie viele Agent-Läufe gleichzeitig, über alle Phasen und Repos (Prüfung, Bau, Abnahme, Verbesserung) */
  maxParallel: number;
  model: string;
  workflow: string;
  pollSeconds: number;
  jobTimeoutMinutes: number;
  image: string;
  dataDir: string;
  containerMemory: string;
  /** Wie oft die Abnahme zurück in die Entwicklung geben darf. Danach entscheidet der Mensch. */
  maxReworks: number;
  /** GitHub-Nutzer, deren Kommentare die Factory als Antwort oder Änderungswunsch annimmt (zusätzlich zum eigenen Login) */
  allowedUsers?: string[];
  project?: { owner: string; number: number };
  /** Factory-Repo, in dem der Verbesserungs-Lauf Vorschläge als Pull Request öffnet */
  factoryRepo?: string;
  /** Verbesserungs-Lauf automatisch alle X Tage (zusätzlich zu `factory-improve`). Standard: aus */
  improve?: { everyDays?: number };
  /** Vorschau pro PR mit Passwortschutz (Nutzer "factory"). Mit domain über HTTPS, sonst http://<host>:<4000+slot> */
  preview?: { host: string; domain?: string; password: string; max?: number; memory?: string };
};

type Comment = { author: { login: string } | null; body: string; createdAt: string };
type Issue = { number: number; title: string; body: string; url: string; labels: { name: string }[]; comments: Comment[] };
type Container = { name: string; repo: string; issue: number; phase: Phase; mode: string; running: boolean; startedAt: string; finishedAt: string; exitCode: number };
type Phase = "check" | "build" | "accept";
type Mode = "new" | "answer" | "change-request" | "retry" | "rework";

const CONFIG_PATH = process.env.FACTORY_CONFIG ?? "/etc/software-factory/config.json";
const MARK = "<!-- software-factory:";
// Status eines Issues (Label factory:<status>) und die Spalte dazu auf dem Board
const STATUS: Record<string, { name: string; color: string; description: string }> = {
  new: { name: "Neu", color: "GRAY", description: "Angelegt, die Factory hat es noch nicht geprüft" },
  checking: { name: "In Prüfung", color: "BLUE", description: "Die Factory prüft Spec bzw. Bug-Beschreibung" },
  question: { name: "Rückfrage", color: "YELLOW", description: "Die Factory braucht eine Antwort von dir" },
  rejected: { name: "Abgelehnt", color: "RED", description: "So nicht baubar, die Spec muss überarbeitet werden" },
  approved: { name: "Freigegeben", color: "PURPLE", description: "Prüfung bestanden, wartet auf einen freien Platz" },
  working: { name: "In Arbeit", color: "ORANGE", description: "Architektur, Umsetzung, Tests" },
  accepting: { name: "Abnahme", color: "BLUE", description: "Ein unabhängiger Agent testet den Pull Request" },
  review: { name: "Review", color: "PINK", description: "PR und Vorschau sind bereit, du bist dran" },
  done: { name: "Fertig", color: "GREEN", description: "Gemergt" },
  failed: { name: "Fehlgeschlagen", color: "RED", description: "Technisch hängen geblieben, Kommentar startet neuen Versuch" },
};
const STEPS: Record<string, string> = { architecture: "Architektur", implementing: "Umsetzung", verifying: "Tests" };
// Alte Labels (vor dem neuen Status-Modell) → neue
const LEGACY: Record<string, string> = {
  queued: "new", triage: "checking", investigating: "working", implementing: "working",
  verifying: "working", pr: "review", waiting: "question",
};
let CONTAINER_UID = 1001; // Nutzer im Job-Image, wird beim Start aus dem Image gelesen
/** GitHub-Login, unter dem die Factory kommentiert. Nur Marker dieses Logins zählen als Factory-Zustand. */
let FACTORY_LOGIN = "";
export const setFactoryLogin = (login: string) => { FACTORY_LOGIN = login; };

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

export function loadConfig(path = CONFIG_PATH): Config {
  const c = JSON.parse(readFileSync(path, "utf8"));
  return {
    label: "factory", maxParallel: 1, model: "opus", workflow: "starter-kit", pollSeconds: 60,
    jobTimeoutMinutes: 90, image: "software-factory-job:latest", dataDir: "/var/lib/software-factory",
    containerMemory: "3g", maxReworks: 2, ...c,
  };
}

async function run(cmd: string[], opts: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.input !== undefined ? new Blob([opts.input]) : "ignore",
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
  // Kein Aufruf darf den Runner dauerhaft blockieren
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs ?? 5 * 60_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`${cmd.slice(0, 3).join(" ")}: Zeitlimit überschritten`);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${err.trim() || out.trim()}`);
  return out;
}
const gh = (args: string[], input?: string) => run(["gh", ...args], { input });
const docker = (args: string[], env?: Record<string, string>, timeoutMs?: number) => run(["docker", ...args], { env, timeoutMs });

// ---------- Dateien aus Job-Ordnern ----------
// Der Container kann in seinem Job-Ordner beliebige Dateien anlegen, auch Symlinks auf Dateien des Servers.
// Der Runner läuft als root: Er liest und schreibt dort deshalb nur normale Dateien und folgt keinen Links.

/** Liest eine normale Datei (keine Symlinks, keine Geräte oder Pipes). Bei großen Dateien das Ende. */
export function readJobFile(path: string, maxBytes = 1_000_000): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, maxBytes);
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally { closeSync(fd); }
}

/** Legt eine Datei neu an (ein vorhandener Link wird entfernt, nicht verfolgt) und übergibt sie dem Container-Nutzer. */
export function writeJobFile(path: string, content: string, uid = CONTAINER_UID, gid = uid) {
  rmSync(path, { force: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeSync(fd, content); fchownSync(fd, uid, gid); } finally { closeSync(fd); }
}

const readJobJson = (path: string, maxBytes = 200_000): any => {
  try { return JSON.parse(readJobFile(path, maxBytes) ?? ""); } catch { return null; }
};

/** Entfernt Zugangsdaten aus Texten, bevor sie öffentlich in GitHub landen. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[Zugangsdaten entfernt]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[Zugangsdaten entfernt]")
    .replace(/(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)=\S+/g, "$1=[entfernt]");
}

// ---------- Dauerhafter Zustand pro Issue (nur für den Runner) ----------

type IssueState = { lostRetries?: number };
const stateFile = (cfg: Config, repo: string, n: number) => join(cfg.dataDir, "state", `${repo.replace("/", "__")}__${n}.json`);
function getState(cfg: Config, repo: string, n: number): IssueState {
  try { return JSON.parse(readFileSync(stateFile(cfg, repo, n), "utf8")); } catch { return {}; }
}
function setState(cfg: Config, repo: string, n: number, s: IssueState) {
  mkdirSync(join(cfg.dataDir, "state"), { recursive: true });
  writeFileSync(stateFile(cfg, repo, n), JSON.stringify(s));
}

// ---------- GitHub ----------

const stageOf = (issue: { labels: { name: string }[] }) =>
  issue.labels.map((l) => l.name).find((n) => n.startsWith("factory:"))?.slice("factory:".length);

async function setStage(repo: string, issue: Issue, stage: string) {
  const args = ["issue", "edit", String(issue.number), "-R", repo, "--add-label", `factory:${stage}`];
  for (const l of issue.labels) if (l.name.startsWith("factory:") && l.name !== `factory:${stage}`) args.push("--remove-label", l.name);
  await gh(args);
  issue.labels = issue.labels.filter((l) => !l.name.startsWith("factory:")).concat({ name: `factory:${stage}` });
}

async function comment(repo: string, n: number, stage: string, text: string) {
  await gh(["issue", "comment", String(n), "-R", repo, "--body-file", "-"], `${MARK}${stage} -->\n${text}`);
}

const loginOf = (c: Comment) => c.author?.login ?? "";
/** Kommentar der Factory selbst: Marker zählen nur, wenn sie vom Login der Factory stammen. */
export const isFactoryComment = (c: Comment) => !!FACTORY_LOGIN && loginOf(c) === FACTORY_LOGIN && c.body.includes(MARK);
/** Darf diese Person der Factory antworten oder Änderungen wünschen? */
export const isTrusted = (cfg: Config, login: string) =>
  !!login && (login === FACTORY_LOGIN || (cfg.allowedUsers ?? []).some((u) => u.toLowerCase() === login.toLowerCase()));

/** Letzter Kommentar der Factory: Status und Phase aus dem Marker. */
export function lastFactoryMarker(issue: Issue): { status: string; phase?: Phase } | null {
  for (let i = issue.comments.length - 1; i >= 0; i--) {
    if (!isFactoryComment(issue.comments[i])) continue;
    const m = issue.comments[i].body.match(/<!-- software-factory:(\w+)(?::(\w+))? -->/);
    if (m) return { status: m[1], phase: m[2] as Phase | undefined };
  }
  return null;
}

/** Wie oft die Abnahme seit der letzten Freigabe bzw. dem letzten Review zurückgegeben hat. */
export function reworksSinceApproval(issue: Issue): number {
  let n = 0;
  for (const c of issue.comments.filter(isFactoryComment)) {
    if (c.body.includes(`${MARK}approved:`) || c.body.includes(`${MARK}review:`)) n = 0;
    else if (c.body.includes(`${MARK}rework:`)) n++;
  }
  return n;
}

/** Kommentare berechtigter Menschen nach dem letzten Kommentar der Factory. */
export function humanCommentsSinceFactory(cfg: Config, issue: Issue): Comment[] {
  let last = -1;
  issue.comments.forEach((c, i) => { if (isFactoryComment(c)) last = i; });
  return issue.comments.slice(last + 1).filter((c) => !c.body.includes(MARK) && isTrusted(cfg, loginOf(c)));
}

async function findPr(repo: string, n: number, state: "open" | "merged" | "all") {
  const prs = JSON.parse(await gh(["pr", "list", "-R", repo, "--head", `factory/${n}`, "--state", state, "--json", "number,url,state"]));
  return prs[0] as { number: number; url: string; state: string } | undefined;
}

// ---------- Board (GitHub Projects, optional) ----------
// Spalten = Standardfeld "Status" des Boards. Zusatzfeld "Schritt" zeigt bei "In Arbeit" den genauen Schritt.

type BoardField = { id: string; options: Record<string, string> };
let board: { id: string; status: BoardField; step: BoardField } | null = null;
const boardItems = new Map<string, { itemId: string; key?: string }>();

async function fieldList(owner: string, number: number) {
  return JSON.parse(await gh(["project", "field-list", String(number), "--owner", owner, "--format", "json"])).fields as any[];
}
const toField = (f: any): BoardField => ({ id: f.id, options: Object.fromEntries((f.options ?? []).map((o: any) => [o.name, o.id])) });

async function initBoard(cfg: Config) {
  if (!cfg.project) return;
  const { owner, number } = cfg.project;
  try {
    const project = JSON.parse(await gh(["project", "view", String(number), "--owner", owner, "--format", "json"]));
    let fields = await fieldList(owner, number);

    // Spalten im Standardfeld "Status" einrichten (ersetzt Todo / In Progress / Done)
    const status = fields.find((f) => f.name === "Status");
    const have = new Set((status?.options ?? []).map((o: any) => o.name));
    if (status && Object.values(STATUS).some((s) => !have.has(s.name))) {
      const options = Object.values(STATUS).map((s) => `{name: ${JSON.stringify(s.name)}, color: ${s.color}, description: ${JSON.stringify(s.description)}}`).join(", ");
      await gh(["api", "graphql", "-f", `query=mutation { updateProjectV2Field(input: {fieldId: "${status.id}", singleSelectOptions: [${options}]}) { clientMutationId } }`]);
      log("board:columns", { columns: Object.values(STATUS).map((s) => s.name) });
    }
    if (!fields.find((f) => f.name === "Schritt")) {
      await gh(["project", "field-create", String(number), "--owner", owner, "--name", "Schritt",
        "--data-type", "SINGLE_SELECT", "--single-select-options", Object.values(STEPS).join(",")]);
    }
    // Altes Zusatzfeld aus der ersten Version entfernen
    const legacy = fields.find((f) => f.name === "Factory");
    if (legacy) await gh(["project", "field-delete", "--id", legacy.id]);

    fields = await fieldList(owner, number);
    board = { id: project.id, status: toField(fields.find((f) => f.name === "Status")), step: toField(fields.find((f) => f.name === "Schritt")) };
    log("board:ready", { project: project.title });
  } catch (e) {
    log("board:error", { error: String(e) });
  }
}

async function syncBoard(cfg: Config, url: string, status: string, step?: string) {
  if (!board || !cfg.project) return;
  const optionId = board.status.options[STATUS[status]?.name];
  if (!optionId) return;
  const key = `${status}:${step ?? ""}`;
  let entry = boardItems.get(url);
  if (entry?.key === key) return;
  try {
    if (!entry) {
      const item = JSON.parse(await gh(["project", "item-add", String(cfg.project.number), "--owner", cfg.project.owner, "--url", url, "--format", "json"]));
      entry = { itemId: item.id };
      boardItems.set(url, entry);
    }
    await gh(["project", "item-edit", "--id", entry.itemId, "--project-id", board.id, "--field-id", board.status.id, "--single-select-option-id", optionId]);
    const stepId = status === "working" && step ? board.step.options[STEPS[step]] : undefined;
    if (stepId) await gh(["project", "item-edit", "--id", entry.itemId, "--project-id", board.id, "--field-id", board.step.id, "--single-select-option-id", stepId]);
    else await gh(["project", "item-edit", "--id", entry.itemId, "--project-id", board.id, "--field-id", board.step.id, "--clear"]);
    entry.key = key;
  } catch (e) {
    log("board:sync-error", { url, error: String(e) });
  }
}

// ---------- Jobs ----------

const containerName = (repo: string, n: number) => `sf-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-${n}`;
const jobDir = (cfg: Config, repo: string, n: number) => join(cfg.dataDir, "jobs", `${repo.replace("/", "__")}__${n}`);
const scenarioDir = (cfg: Config, repo: string, n: number) => join(cfg.dataDir, "scenarios", `${repo.replace("/", "__")}__${n}`);
const agentLimits = (cfg: Config) => ["--memory", cfg.containerMemory, "--memory-swap", cfg.containerMemory, "--pids-limit", "4096", "--shm-size", "1g"];

async function listContainers(): Promise<Container[]> {
  const names = (await docker(["ps", "-a", "--filter", "label=software-factory=1", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
  const result: Container[] = [];
  for (const name of names) {
    const info = JSON.parse(await docker(["inspect", name]))[0];
    result.push({
      name, repo: info.Config.Labels["sf.repo"], issue: Number(info.Config.Labels["sf.issue"]),
      phase: (info.Config.Labels["sf.phase"] ?? "build") as Phase,
      mode: info.Config.Labels["sf.mode"] ?? "new",
      finishedAt: info.State.FinishedAt,
      running: info.State.Running, startedAt: info.State.StartedAt, exitCode: info.State.ExitCode,
    });
  }
  return result;
}

export function buildPrompt(cfg: Config, repo: string, issue: Issue, phase: Phase, mode: Mode, prUrl?: string, extra?: string): string {
  const modeText: Record<Mode, string> = {
    new: "Neuer Lauf",
    answer: "Fortsetzung nach einer Antwort des Menschen (siehe letzte Kommentare)",
    "change-request": `Änderungswunsch zum offenen PR ${prUrl ?? ""} (siehe letzte Kommentare). Arbeite auf demselben Branch weiter, keinen neuen PR öffnen.`,
    retry: "Erneuter Versuch nach einem Fehler (siehe letzte Kommentare für Hinweise)",
    rework: `Rückgabe aus der Abnahme: Behebe die Befunde aus dem letzten Kommentar „Abnahme nicht bestanden" am offenen PR ${prUrl ?? ""}.`,
  };
  // Kommentare von nicht berechtigten Personen bekommt der Agent nicht zu sehen
  const comments = issue.comments.map((c) => {
    const who = loginOf(c) || "unbekannt";
    if (isFactoryComment(c)) return `### Factory · ${c.createdAt}\n${c.body.replace(/<!-- software-factory:[\w:]+ -->\n?/g, "")}`;
    if (!isTrusted(cfg, who)) return `### ${who} · ${c.createdAt}\n_(Kommentar ausgeblendet: ${who} ist für die Factory nicht berechtigt. Nicht beachten.)_`;
    return `### ${who} · ${c.createdAt}\n${c.body.replace(/<!-- software-factory:[\w:]+ -->\n?/g, "")}`;
  }).join("\n\n");
  const start = phase === "check"
    ? `Phase **Prüfung**: Prüfe nur, entwickle nichts. Beginne mit \`factory-report checking "..."\` und ende mit approved (vorher Testszenarien nach /scenarios/scenarios.md), question oder rejected.`
    : phase === "build"
      ? `Phase **Bau**: Die Prüfung ist bestanden (siehe Verlauf). Beginne mit \`factory-report architecture "..."\` (bei Änderungswunsch oder Rückgabe aus der Abnahme direkt mit implementing). Ende mit built.`
      : `Phase **Abnahme**: Du bist der unabhängige Prüfer für den PR ${prUrl ?? ""}. Ende mit accepted, rework oder (nur in der letzten Runde) unresolved.`;
  return [
    `# Auftrag`,
    `- Repo: ${repo}`, `- Issue: #${issue.number} (${issue.url})`, `- Branch: factory/${issue.number}`,
    `- Workflow: ${cfg.workflow} (Beschreibung: /factory/workflows/${cfg.workflow}/workflow.md)`,
    `- Phase: ${phase === "check" ? "Prüfung" : phase === "build" ? "Bau" : "Abnahme"}`,
    `- Modus: ${modeText[mode]}`,
    ...(extra ? [`- ${extra}`] : []),
    ``, `## Issue: ${issue.title}`, ``, issue.body || "_(kein Text)_",
    ``, `## Verlauf`, ``, comments || "_(keine Kommentare)_",
    ``, `Folge dem Factory-Playbook aus deinem System-Prompt. ${start}`,
  ].join("\n");
}

/** Job-Image für ein Repo: Standard-Image oder, falls das Repo .factory/Dockerfile hat, ein darauf aufbauendes eigenes. */
async function imageFor(cfg: Config, repo: string): Promise<string> {
  let file: { sha: string; content: string };
  try { file = JSON.parse(await gh(["api", `repos/${repo}/contents/.factory/Dockerfile`])); } catch { return cfg.image; }
  const base = (await docker(["image", "inspect", cfg.image, "--format", "{{.Id}}"])).trim().replace("sha256:", "").slice(0, 12);
  const tag = `sf-job-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}:${file.sha.slice(0, 12)}-${base}`;
  const exists = await docker(["image", "inspect", tag]).then(() => true).catch(() => false);
  if (!exists) {
    const dir = join(cfg.dataDir, "images", repo.replace("/", "__"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), Buffer.from(file.content, "base64").toString("utf8"));
    log("image:building", { repo, tag });
    await docker(["build", "-q", "-t", tag, dir], undefined, 45 * 60_000);
    log("image:built", { repo, tag });
  }
  return tag;
}

async function launch(cfg: Config, repo: string, issue: Issue, phase: Phase, mode: Mode, prUrl?: string, extra?: string) {
  const name = containerName(repo, issue.number);
  const dir = jobDir(cfg, repo, issue.number);
  mkdirSync(dir, { recursive: true });
  chownSync(dir, CONTAINER_UID, CONTAINER_UID);
  for (const f of ["status.json", "verify.json", "verify.md"]) rmSync(join(dir, f), { force: true });
  writeJobFile(join(dir, "prompt.md"), buildPrompt(cfg, repo, issue, phase, mode, prUrl, extra));

  if (phase === "check" && !issue.comments.some((c) => isFactoryComment(c) && c.body.includes(`${MARK}claimed`))) {
    await comment(repo, issue.number, "claimed",
      `🏭 Die Factory hat das Issue übernommen und prüft es jetzt. Den Fortschritt siehst du am Status (Label bzw. Board).`);
  }
  const status = phase === "check" ? "checking" : phase === "build" ? "working" : "accepting";
  // Testszenarien liegen außerhalb des Repos: Prüfung schreibt sie, Abnahme liest sie, der Bau sieht sie nie
  const scen = scenarioDir(cfg, repo, issue.number);
  mkdirSync(scen, { recursive: true });
  chownSync(scen, CONTAINER_UID, CONTAINER_UID);
  const scenarioMount = phase === "check" ? ["-v", `${scen}:/scenarios`] : phase === "accept" ? ["-v", `${scen}:/scenarios:ro`] : [];
  await setStage(repo, issue, status);
  await syncBoard(cfg, issue.url, status);

  const ghToken = (await gh(["auth", "token"])).trim();
  const authVar = process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  await docker(["rm", "-f", name]).catch(() => {});
  await docker([
    "run", "-d", "--name", name,
    "--label", "software-factory=1", "--label", `sf.repo=${repo}`, "--label", `sf.issue=${issue.number}`, "--label", `sf.phase=${phase}`, "--label", `sf.mode=${mode}`,
    ...agentLimits(cfg),
    "-e", `REPO=${repo}`, "-e", `ISSUE=${issue.number}`, "-e", `BRANCH=factory/${issue.number}`,
    "-e", `MODEL=${cfg.model}`, "-e", `WORKFLOW=${cfg.workflow}`, "-e", `PHASE=${phase}`,
    "-e", "GH_TOKEN", "-e", authVar, // Werte kommen aus der Umgebung, nicht aus der Kommandozeile
    "-v", `${dir}:/work`, ...scenarioMount,
    await imageFor(cfg, repo),
  ], { GH_TOKEN: ghToken });
  log("job:started", { repo, issue: issue.number, phase, mode, container: name });
}

/** Nach einem Bau-Lauf: Sind die Pflicht-Checks auf genau dem gepushten Stand grün und ist die Spec unverändert? */
async function checkBuild(repo: string, issue: number, dir: string, prUrl?: string): Promise<string | null> {
  const verify = readJobJson(join(dir, "verify.json"));
  if (!verify || verify.ok !== true || !Array.isArray(verify.results) || verify.results.length === 0) {
    return "Die Pflicht-Checks wurden nicht ausgeführt oder sind nicht grün (`factory-verify`).";
  }
  let head = "";
  try { head = (await gh(["api", `repos/${repo}/git/ref/heads/factory/${issue}`, "--jq", ".object.sha"])).trim(); } catch {}
  if (!head) return `Der Branch \`factory/${issue}\` wurde nicht gepusht.`;
  if (verify.sha !== head) return `Die Checks liefen auf \`${String(verify.sha).slice(0, 7)}\`, gepusht ist aber \`${head.slice(0, 7)}\`. Nach dem letzten Commit muss \`factory-verify\` erneut laufen.`;
  if (prUrl) {
    try {
      const files = (await gh(["pr", "diff", prUrl, "--name-only"])).split("\n");
      const spec = files.find((f) => /^features\/[^/]+\/spec\.md$/.test(f.trim()));
      if (spec) return `Der Pull Request ändert die Spec \`${spec.trim()}\`. Die Spec ist der Vertrag und darf nur vom Menschen geändert werden.`;
    } catch {}
  }
  return null;
}

/** Wertet einen beendeten Container aus und räumt ihn weg. `reason` = Grund, warum der Runner ihn beendet hat. */
async function finish(cfg: Config, c: Container, reason?: string) {
  const dir = jobDir(cfg, c.repo, c.issue);
  const status: { status?: string; step?: string; pr?: string; unresolved?: boolean } = readJobJson(join(dir, "status.json")) ?? {};
  let result: any = {};
  const tail = readJobFile(join(dir, "claude.jsonl"), 500_000) ?? "";
  try { result = JSON.parse(tail.trim().split("\n").pop() ?? ""); } catch {}

  const endStates: Record<Phase, string[]> = {
    check: ["approved", "question", "rejected", "failed"],
    build: ["accepting", "question", "failed"],
    accept: ["review", "working", "question", "failed"], // working = Rückgabe an die Entwicklung
  };
  let problem = reason ?? null;
  if (!problem && !(status.status && endStates[c.phase].includes(status.status))) problem = "Der Lauf hat kein Ergebnis gemeldet.";
  if (!problem && (c.exitCode !== 0 || result.is_error)) problem = `Claude Code wurde mit einem Fehler beendet (Exit-Code ${c.exitCode}).`;
  if (!problem && c.phase === "build" && status.status === "accepting") problem = await checkBuild(c.repo, c.issue, dir, status.pr);
  const ended = !problem;
  const metricStatus = ended ? (status.status === "review" && status.unresolved ? "unresolved" : status.status) : "failed";

  log("job:finished", {
    repo: c.repo, issue: c.issue, phase: c.phase, exitCode: c.exitCode, status: metricStatus, problem,
    minutes: result.duration_ms ? Math.round(result.duration_ms / 60000) : null,
    turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null,
  });
  const errTail = redact(readJobFile(join(dir, "claude.err"), 1500) ?? "");
  // Kurze Zusammenfassung des Laufs dauerhaft festhalten: Grundlage für den Verbesserungs-Lauf
  try {
    const runsDir = join(cfg.dataDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}__${c.repo.replace("/", "__")}__${c.issue}__${c.phase}.json`), JSON.stringify({
      repo: c.repo, issue: c.issue, phase: c.phase, mode: c.mode, exitCode: c.exitCode,
      status: metricStatus, problem, reported: status,
      result: typeof result.result === "string" ? redact(result.result.slice(0, 4000)) : null,
      turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, errTail,
    }, null, 2));
  } catch (e) { log("runs:error", { error: String(e) }); }
  // Dauerhaft festhalten, auch nach dem Aufräumen: Grundlage für factory-stats
  const seconds = Math.max(0, Math.round((Date.parse(c.finishedAt) - Date.parse(c.startedAt)) / 1000));
  appendFileSync(join(cfg.dataDir, "metrics.jsonl"), JSON.stringify({
    t: new Date().toISOString(), repo: c.repo, issue: c.issue, phase: c.phase, mode: c.mode,
    status: metricStatus, exitCode: c.exitCode, seconds: Number.isFinite(seconds) ? seconds : null,
    turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, model: cfg.model,
  }) + "\n");

  if (ended) {
    setState(cfg, c.repo, c.issue, {});
  } else {
    let detail = typeof result.result === "string" ? result.result.slice(-1500) : "";
    if (!detail) detail = errTail.slice(-800);
    detail = redact(detail).replace(/```/g, "'''").trim();
    const issue = JSON.parse(await gh(["issue", "view", String(c.issue), "-R", c.repo, "--json", "number,title,body,url,labels,comments"]));
    await setStage(c.repo, issue, "failed");
    await syncBoard(cfg, issue.url, "failed");
    await comment(c.repo, c.issue, `failed:${c.phase}`,
      `### ⚠️ Der Lauf wurde ohne gültiges Ergebnis beendet\n\n**Grund:** ${problem}\n\n` +
      (detail ? "Letzte Ausgabe:\n```\n" + detail + "\n```\n\n" : "") +
      `_Schreib einen Kommentar mit einem Hinweis, dann versucht die Factory es erneut._`);
  }
  await docker(["rm", "-f", c.name]).catch(() => {});
}

// ---------- Vorschau pro Pull Request (optional) ----------

const CADDYFILE = "/etc/software-factory/Caddyfile";
const PREVIEW_PORT = (slot: number) => 4000 + slot; // von außen erreichbar (mit Passwort)
const INTERNAL_PORT = (slot: number) => 5000 + slot; // nur lokal, dahinter läuft die App
let caddyHash: string | null = null;
let caddyFresh = false; // Caddy einmal pro Runner-Start neu aufsetzen (Konfiguration kann sich geändert haben)
const previewNoticePosted = new Set<string>();

type Preview = { name: string; repo: string; issue: number; sha: string; slot: number; running: boolean };

async function listPreviews(): Promise<Preview[]> {
  const names = (await docker(["ps", "-a", "--filter", "label=sf.preview=1", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
  const result: Preview[] = [];
  for (const name of names) {
    const info = JSON.parse(await docker(["inspect", name]))[0];
    const l = info.Config.Labels;
    result.push({ name, repo: l["sf.repo"], issue: Number(l["sf.issue"]), sha: l["sf.sha"], slot: Number(l["sf.slot"]), running: info.State.Running });
  }
  return result;
}

export const previewLink = (cfg: Config, slot: number) =>
  cfg.preview?.domain ? `https://${cfg.preview.domain}:${PREVIEW_PORT(slot)}` : `http://${cfg.preview?.host}:${PREVIEW_PORT(slot)}`;

export function caddyConfig(cfg: Config, slots: number[], hash: string): string {
  const domain = cfg.preview?.domain;
  // Mit Domain holt Caddy selbst ein Zertifikat (Ports 80 und 443 müssen erreichbar sein). Ohne Domain nur HTTP.
  const global = domain ? `{\n  admin localhost:2019\n}` : `{\n  auto_https off\n  admin localhost:2019\n}`;
  const blocks = slots.map((slot) =>
    `${domain ? `${domain}:${PREVIEW_PORT(slot)}` : `:${PREVIEW_PORT(slot)}`} {\n  basic_auth {\n    factory ${hash}\n  }\n  reverse_proxy 127.0.0.1:${INTERNAL_PORT(slot)}\n}`);
  if (domain) blocks.unshift(`${domain} {\n  respond "Software Factory: Vorschauen laufen auf eigenen Ports." 200\n}`);
  return `${global}\n\n${blocks.join("\n\n")}\n`;
}

async function writeCaddy(cfg: Config, previews: Preview[]) {
  if (!cfg.preview) return;
  if (!caddyHash) caddyHash = (await docker(["run", "--rm", "caddy:2-alpine", "caddy", "hash-password", "--plaintext", cfg.preview.password])).trim();
  writeFileSync(CADDYFILE, caddyConfig(cfg, previews.map((p) => p.slot), caddyHash));
  const running = (await docker(["ps", "--filter", "name=^sf-caddy$", "--format", "{{.Names}}"])).trim();
  if (!running || !caddyFresh) {
    await docker(["rm", "-f", "sf-caddy"]).catch(() => {});
    // Zertifikate liegen im Volume sf-caddy-data und überleben Neustarts
    await docker(["run", "-d", "--name", "sf-caddy", "--network", "host", "--restart", "unless-stopped",
      "-v", `${CADDYFILE}:/etc/caddy/Caddyfile:ro`, "-v", "sf-caddy-data:/data", "caddy:2-alpine"]);
    caddyFresh = true;
  } else {
    await docker(["exec", "sf-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
  }
}

const previewDir = (cfg: Config, name: string) => join(cfg.dataDir, "previews", name);

/** Startet/aktualisiert Vorschauen für offene Factory-PRs und räumt alte weg. */
async function syncPreviews(cfg: Config, repo: string, issues: Issue[]) {
  if (!cfg.preview) return;
  const max = cfg.preview.max ?? 1;
  let previews = (await listPreviews()).filter((p) => p.repo === repo);
  const wanted = new Map<number, { url: string; number: number; sha: string }>();
  for (const issue of issues.filter((i) => stageOf(i) === "review")) {
    const pr = JSON.parse(await gh(["pr", "list", "-R", repo, "--head", `factory/${issue.number}`, "--state", "open", "--json", "number,url,headRefOid"]))[0];
    if (pr) wanted.set(issue.number, { url: pr.url, number: pr.number, sha: pr.headRefOid });
  }

  let changed = !caddyFresh;
  // Weg mit Vorschauen ohne offenen PR, mit altem Stand oder abgestürzt
  for (const p of previews) {
    const w = wanted.get(p.issue);
    if (!w || w.sha !== p.sha || !p.running) {
      await docker(["rm", "-f", p.name]).catch(() => {});
      rmSync(previewDir(cfg, p.name), { recursive: true, force: true });
      log("preview:stopped", { repo, issue: p.issue, reason: !w ? "kein offener PR" : w.sha !== p.sha ? "neuer Stand" : "abgestürzt" });
      changed = true;
    }
  }
  const all = await listPreviews();
  previews = all.filter((p) => p.repo === repo);
  const usedSlots = new Set(all.map((p) => p.slot));

  for (const [issueNr, pr] of wanted) {
    if (previews.some((p) => p.issue === issueNr)) continue;
    const slot = Array.from({ length: max }, (_, i) => i + 1).find((s) => !usedSlots.has(s));
    if (!slot) { log("preview:no-slot", { repo, issue: issueNr }); continue; }
    usedSlots.add(slot);
    const name = `sf-preview-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-${issueNr}`;
    const image = await imageFor(cfg, repo);

    // 1. Quellcode in einem kurzen Container mit GitHub-Zugang holen …
    const src = previewDir(cfg, name);
    rmSync(src, { recursive: true, force: true });
    mkdirSync(src, { recursive: true });
    chownSync(src, CONTAINER_UID, CONTAINER_UID);
    const ghToken = (await gh(["auth", "token"])).trim();
    await docker(["run", "--rm", "-e", `REPO=${repo}`, "-e", `BRANCH=factory/${issueNr}`, "-e", "GH_TOKEN",
      "-v", `${src}:/src`, "--entrypoint", "bash", image, "-c",
      `gh auth setup-git >/dev/null && gh repo clone "$REPO" /src/app -- --quiet --depth 1 --branch "$BRANCH"`], { GH_TOKEN: ghToken });

    // 2. … und die App ohne jegliche Zugangsdaten starten
    await docker(["run", "-d", "--name", name,
      "--label", "sf.preview=1", "--label", `sf.repo=${repo}`, "--label", `sf.issue=${issueNr}`,
      "--label", `sf.sha=${pr.sha}`, "--label", `sf.slot=${slot}`,
      "-p", `127.0.0.1:${INTERNAL_PORT(slot)}:3000`,
      "--memory", cfg.preview.memory ?? "1500m", "--pids-limit", "2048",
      "-v", `${src}/app:/app`, "--entrypoint", "/factory/preview.sh", image]);
    changed = true;
    const link = previewLink(cfg, slot);
    log("preview:started", { repo, issue: issueNr, pr: pr.number, url: link });

    const key = `${repo}#${pr.number}`;
    if (!previewNoticePosted.has(key)) {
      const comments = JSON.parse(await gh(["pr", "view", String(pr.number), "-R", repo, "--json", "comments"])).comments as Comment[];
      if (!comments.some((c) => isFactoryComment(c) && c.body.includes(`${MARK}preview -->`))) {
        await gh(["pr", "comment", String(pr.number), "-R", repo, "--body-file", "-"],
          `${MARK}preview -->\n### 🔍 Vorschau zum Durchklicken\n\n${link}\n\nLogin: \`factory\` · Passwort: steht in \`/etc/software-factory/config.json\` auf dem Server.\n\n_Die Vorschau braucht nach jedem neuen Stand 1–2 Minuten zum Starten. Nach Merge oder Schließen des PRs wird sie entfernt._`);
      }
      previewNoticePosted.add(key);
    }
  }
  if (changed) await writeCaddy(cfg, await listPreviews());
}

// ---------- Verbesserungs-Lauf ----------
// Wertet alle bisherigen Läufe aus und schlägt Änderungen an Playbook/Skills als PR im Factory-Repo vor.
// Auslöser: `factory-improve` (legt eine Anforderungs-Datei an) oder automatisch alle improve.everyDays Tage.
// Belegt einen Agent-Platz wie jeder andere Lauf.

async function improveRunning(cfg: Config): Promise<boolean> {
  const lines = (await docker(["ps", "-a", "--filter", "label=sf.improve=1", "--format", "{{.Names}}|{{.State}}|{{.RunningFor}}"])).trim().split("\n").filter(Boolean);
  let running = false;
  for (const line of lines) {
    const [name, state] = line.split("|");
    if (state === "running") {
      const started = JSON.parse(await docker(["inspect", name]))[0].State.StartedAt;
      if ((Date.now() - Date.parse(started)) / 60000 <= cfg.jobTimeoutMinutes) { running = true; continue; }
      log("improve:timeout", { container: name });
      await docker(["kill", name]).catch(() => {});
    }
    const out = await docker(["logs", "--tail", "5", name]).catch(() => "");
    log("improve:finished", { container: name, tail: redact(out.trim().slice(-600)) });
    await docker(["rm", "-f", name]).catch(() => {});
  }
  return running;
}

async function maybeImprove(cfg: Config, freeSlots: number) {
  if (freeSlots <= 0) return;
  const requested = join(cfg.dataDir, "improve-requested");
  const lastRun = join(cfg.dataDir, "improve-last");
  const days = cfg.improve?.everyDays;
  const due = !!days && (!existsSync(lastRun) || Date.now() - statSync(lastRun).mtimeMs > days * 86400000);
  if (!existsSync(requested) && !due) return;
  rmSync(requested, { force: true });
  if (!cfg.factoryRepo) { log("improve:error", { error: "factoryRepo fehlt in der Config" }); return; }
  writeFileSync(lastRun, new Date().toISOString());

  const work = join(cfg.dataDir, "improve-work");
  const runs = join(cfg.dataDir, "runs");
  const metrics = join(cfg.dataDir, "metrics.jsonl");
  mkdirSync(work, { recursive: true }); mkdirSync(runs, { recursive: true });
  if (!existsSync(metrics)) writeFileSync(metrics, "");
  chownSync(work, CONTAINER_UID, CONTAINER_UID);
  const ghToken = (await gh(["auth", "token"])).trim();
  const authVar = process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  await docker(["run", "-d", "--name", "sf-improve", "--label", "sf.improve=1",
    ...agentLimits(cfg),
    "-e", `REPO=${cfg.factoryRepo}`, "-e", `MODEL=${cfg.model}`, "-e", "GH_TOKEN", "-e", authVar,
    "-v", `${work}:/work`, "-v", `${runs}:/data/runs:ro`, "-v", `${metrics}:/data/metrics.jsonl:ro`,
    "--entrypoint", "/factory/improve.sh", cfg.image], { GH_TOKEN: ghToken });
  log("improve:started", { repo: cfg.factoryRepo });
}

// ---------- Hauptschleife ----------

/** Ein Lauf ging verloren (z. B. Server-Neustart): einmal automatisch neu starten, danach entscheidet der Mensch. */
async function lostJob(cfg: Config, repo: string, issue: Issue): Promise<boolean> {
  const s = getState(cfg, repo, issue.number);
  if ((s.lostRetries ?? 0) < 1) { setState(cfg, repo, issue.number, { ...s, lostRetries: (s.lostRetries ?? 0) + 1 }); return true; }
  await setStage(repo, issue, "failed");
  await syncBoard(cfg, issue.url, "failed");
  await comment(repo, issue.number, `failed:${lastFactoryMarker(issue)?.phase ?? "build"}`,
    `### ⚠️ Der Lauf ist wiederholt verloren gegangen\n\nDie Factory startet ihn nicht noch einmal automatisch, damit keine Endlosschleife entsteht.\n\n_Schreib einen Kommentar, dann versucht sie es erneut._`);
  setState(cfg, repo, issue.number, {});
  return false;
}

async function tickRepo(cfg: Config, repo: string, containers: Container[], slots: { free: number }) {
  const issues: Issue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", cfg.label, "--state", "open",
    "--json", "number,title,body,url,labels,comments", "--limit", "100"]));
  issues.sort((a, b) => a.number - b.number); // älteste zuerst
  const openNumbers = new Set(issues.map((i) => i.number));

  // Label entfernt oder Issue geschlossen → laufenden Job stoppen und als beendet erfassen
  for (const c of containers.filter((c) => c.repo === repo && !openNumbers.has(c.issue))) {
    log("job:stopped", { repo, issue: c.issue, reason: "Label entfernt oder Issue geschlossen" });
    await docker(["kill", c.name]).catch(() => {});
    await docker(["rm", "-f", c.name]).catch(() => {});
    slots.free++;
  }

  // Alte Labels aus der ersten Version umstellen
  for (const issue of issues) {
    const legacy = LEGACY[stageOf(issue) ?? ""];
    if (legacy) await setStage(repo, issue, legacy);
  }

  // Review abgeschlossen: PR gemergt → Fertig
  const closed: Issue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", "factory:review", "--state", "closed",
    "--json", "number,title,body,url,labels,comments", "--limit", "20"]));
  for (const issue of [...closed, ...issues.filter((i) => stageOf(i) === "review")]) {
    if (await findPr(repo, issue.number, "merged")) {
      await setStage(repo, issue, "done");
      await syncBoard(cfg, issue.url, "done");
      rmSync(jobDir(cfg, repo, issue.number), { recursive: true, force: true });
      rmSync(scenarioDir(cfg, repo, issue.number), { recursive: true, force: true });
      rmSync(stateFile(cfg, repo, issue.number), { force: true });
      log("job:done", { repo, issue: issue.number });
    }
  }

  for (const issue of issues) {
    const status = stageOf(issue);
    const running = containers.find((c) => c.repo === repo && c.issue === issue.number && openNumbers.has(c.issue));
    if (running) {
      // Genauen Schritt aus dem laufenden Job aufs Board bringen
      const step = readJobJson(join(jobDir(cfg, repo, issue.number), "status.json"), 10_000)?.step || undefined;
      if (status) await syncBoard(cfg, issue.url, status, step);
      continue;
    }
    if (!status) { await setStage(repo, issue, "new"); }
    const current = stageOf(issue)!;
    await syncBoard(cfg, issue.url, current);
    if (current === "done") continue;

    // Was als Nächstes zu tun ist
    let phase: Phase | null = null;
    let mode: Mode = "new";
    let prUrl: string | undefined;
    let lost = false;
    const marker = lastFactoryMarker(issue);
    const answered = humanCommentsSinceFactory(cfg, issue).length > 0;
    if (current === "new") phase = "check";
    else if (current === "checking") { phase = "check"; mode = "retry"; lost = true; }          // Prüf-Job verloren
    else if (current === "approved") phase = "build";
    else if (current === "working") {
      phase = "build";
      mode = marker?.status === "rework" ? "rework" : "retry";                                  // Rückgabe aus der Abnahme oder Job verloren
      lost = mode === "retry";
      if (mode === "rework") prUrl = (await findPr(repo, issue.number, "open"))?.url;
    }
    else if (current === "accepting") { phase = "accept"; prUrl = (await findPr(repo, issue.number, "open"))?.url; }
    else if (answered && current === "question") { phase = (marker?.phase as Phase) ?? "check"; mode = "answer"; }
    else if (answered && current === "rejected") { phase = "check"; mode = "answer"; }
    else if (answered && current === "failed") { phase = (marker?.phase as Phase) ?? "build"; mode = "retry"; }
    else if (answered && current === "review") {
      prUrl = (await findPr(repo, issue.number, "open"))?.url;
      if (prUrl) { phase = "build"; mode = "change-request"; }
    }
    if (!phase) continue;
    // Ein gemeinsamer Platz-Pool für alle Phasen. Ohne freien Platz bleibt das Issue in seinem Status und kommt beim nächsten Durchlauf dran.
    if (slots.free <= 0) continue;
    if (lost && !(await lostJob(cfg, repo, issue))) continue;

    if (phase === "accept") {
      if (!prUrl) prUrl = (await findPr(repo, issue.number, "open"))?.url;
      const reworks = reworksSinceApproval(issue);
      const last = reworks >= cfg.maxReworks;
      await launch(cfg, repo, issue, "accept", mode, prUrl,
        `Abnahme-Runde: ${reworks + 1}${last ? " (letzte Runde: keine Rückgabe mehr. Bestanden → accepted, sonst unresolved)" : ""}`);
    } else {
      await launch(cfg, repo, issue, phase, mode, prUrl);
    }
    slots.free--;
  }

  await syncPreviews(cfg, repo, issues).catch((e) => log("preview:error", { repo, error: String(e) }));
}

async function tick(cfg: Config) {
  let containers = await listContainers();

  // 1. Beendete Container auswerten, zu lange laufende stoppen und als Fehlschlag erfassen
  for (const c of containers) {
    try {
      if (!c.running) { await finish(cfg, c); continue; }
      const minutes = (Date.now() - Date.parse(c.startedAt)) / 60000;
      if (minutes > cfg.jobTimeoutMinutes) {
        log("job:timeout", { repo: c.repo, issue: c.issue, minutes: Math.round(minutes) });
        await docker(["kill", c.name]).catch(() => {});
        await finish(cfg, { ...c, running: false, exitCode: 137, finishedAt: new Date().toISOString() },
          `Zeitlimit von ${cfg.jobTimeoutMinutes} Minuten überschritten.`);
      }
    } catch (e) {
      log("finish:error", { repo: c.repo, issue: c.issue, error: String(e) });
    }
  }
  containers = (await listContainers()).filter((c) => c.running);
  const improving = await improveRunning(cfg);
  const slots = { free: cfg.maxParallel - containers.length - (improving ? 1 : 0) };

  // Ein fehlerhaftes Repo darf die anderen nicht blockieren
  for (const repo of cfg.repos) {
    try { await tickRepo(cfg, repo, containers, slots); }
    catch (e) { log("repo:error", { repo, error: String(e) }); }
  }

  await maybeImprove(cfg, slots.free).catch((e) => log("improve:error", { error: String(e) }));
}

async function main() {
  const once = process.argv.includes("--once");
  let cfg = loadConfig();
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    log("config:error", { error: "Weder CLAUDE_CODE_OAUTH_TOKEN noch ANTHROPIC_API_KEY gesetzt" });
    process.exit(1);
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN && process.env.ANTHROPIC_API_KEY) {
    log("config:warning", { warning: "Beide Login-Arten gesetzt. Es wird nur CLAUDE_CODE_OAUTH_TOKEN an die Jobs gegeben." });
  }
  CONTAINER_UID = Number((await docker(["run", "--rm", "--entrypoint", "id", cfg.image, "-u"])).trim());
  FACTORY_LOGIN = (await gh(["api", "user", "--jq", ".login"])).trim();
  await initBoard(cfg);
  log("runner:started", {
    login: FACTORY_LOGIN, allowedUsers: cfg.allowedUsers ?? [],
    preview: cfg.preview ? previewLink(cfg, 1).replace(/:4001$/, ":4001…") : "aus",
    containerUid: CONTAINER_UID, repos: cfg.repos, maxParallel: cfg.maxParallel, model: cfg.model, workflow: cfg.workflow,
  });
  while (true) {
    try {
      cfg = loadConfig();
      await tick(cfg);
    } catch (e) {
      log("tick:error", { error: String(e) });
    }
    if (once) break;
    await Bun.sleep(cfg.pollSeconds * 1000);
  }
}

export { finish, tick }; // für Tests

if ((import.meta as any).main) main();
