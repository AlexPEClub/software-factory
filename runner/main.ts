// Software Factory – Runner
// Läuft dauerhaft auf dem Server. Holt GitHub Issues mit dem Label "factory",
// startet pro Issue einen Docker-Container mit Claude Code und hält Labels und Board aktuell.
// Er schreibt selbst nie Code. Das macht der Agent im Container.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chownSync } from "node:fs";
import { join } from "node:path";

type Config = {
  repos: string[];
  label: string;
  maxParallel: number;
  model: string;
  workflow: string;
  pollSeconds: number;
  jobTimeoutMinutes: number;
  image: string;
  dataDir: string;
  containerMemory: string;
  /** Wie viele Prüf-Läufe gleichzeitig (zusätzlich zu den Bau-Läufen) */
  maxChecks: number;
  /** Wie viele Abnahme-Läufe gleichzeitig */
  maxAccepts: number;
  /** Wie oft die Abnahme zurück in die Entwicklung geben darf, bevor sie mit Hinweis durchwinkt */
  maxReworks: number;
  project?: { owner: string; number: number };
  /** Factory-Repo, in dem der Verbesserungs-Lauf Vorschläge als Pull Request öffnet */
  factoryRepo?: string;
  /** Verbesserungs-Lauf automatisch alle X Tage (zusätzlich zu `factory-improve`) */
  improve?: { everyDays?: number };
  /** Vorschau pro PR: http://<host>:<4000+slot>, mit Passwortschutz (Nutzer "factory") */
  preview?: { host: string; password: string; max?: number; memory?: string };
};

type Comment = { author: { login: string }; body: string; createdAt: string };
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

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

function loadConfig(): Config {
  const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return {
    label: "factory", maxParallel: 2, model: "opus", workflow: "starter-kit", pollSeconds: 60,
    jobTimeoutMinutes: 90, image: "software-factory-job:latest", dataDir: "/var/lib/software-factory",
    containerMemory: "3g", maxChecks: 1, maxAccepts: 1, maxReworks: 2, ...c,
  };
}

async function run(cmd: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.input !== undefined ? new Blob([opts.input]) : "ignore",
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${err.trim() || out.trim()}`);
  return out;
}
const gh = (args: string[], input?: string) => run(["gh", ...args], { input });
const docker = (args: string[], env?: Record<string, string>) => run(["docker", ...args], { env });

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

/** Letzter Kommentar der Factory: Status und Phase aus dem Marker. */
function lastFactoryMarker(issue: Issue): { status: string; phase?: Phase } | null {
  for (let i = issue.comments.length - 1; i >= 0; i--) {
    const m = issue.comments[i].body.match(/<!-- software-factory:(\w+)(?::(\w+))? -->/);
    if (m) return { status: m[1], phase: m[2] as Phase | undefined };
  }
  return null;
}

/** Wie oft die Abnahme seit der letzten Freigabe bzw. dem letzten Review zurückgegeben hat. */
function reworksSinceApproval(issue: Issue): number {
  let n = 0;
  for (const c of issue.comments) {
    if (c.body.includes(`${MARK}approved:`) || c.body.includes(`${MARK}review:`)) n = 0;
    else if (c.body.includes(`${MARK}rework:`)) n++;
  }
  return n;
}

/** Kommentare des Menschen nach dem letzten Kommentar der Factory. */
function humanCommentsSinceFactory(issue: Issue): Comment[] {
  let last = -1;
  issue.comments.forEach((c, i) => { if (c.body.includes(MARK)) last = i; });
  return issue.comments.slice(last + 1).filter((c) => !c.body.includes(MARK));
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

function buildPrompt(cfg: Config, repo: string, issue: Issue, phase: Phase, mode: Mode, prUrl?: string, extra?: string): string {
  const modeText: Record<Mode, string> = {
    new: "Neuer Lauf",
    answer: "Fortsetzung nach einer Antwort des Menschen (siehe letzte Kommentare)",
    "change-request": `Änderungswunsch zum offenen PR ${prUrl ?? ""} (siehe letzte Kommentare). Arbeite auf demselben Branch weiter, keinen neuen PR öffnen.`,
    retry: "Erneuter Versuch nach einem Fehler (siehe letzte Kommentare für Hinweise)",
    rework: `Rückgabe aus der Abnahme: Behebe die Befunde aus dem letzten Kommentar „Abnahme nicht bestanden" am offenen PR ${prUrl ?? ""}.`,
  };
  const comments = issue.comments.map((c) =>
    `### ${c.author.login} · ${c.createdAt}\n${c.body.replace(/<!-- software-factory:[\w:]+ -->\n?/g, "[Factory] ")}`).join("\n\n");
  const start = phase === "check"
    ? `Phase **Prüfung**: Prüfe nur, entwickle nichts. Beginne mit \`factory-report checking "..."\` und ende mit approved (vorher Testszenarien nach /scenarios/scenarios.md), question oder rejected.`
    : phase === "build"
      ? `Phase **Bau**: Die Prüfung ist bestanden (siehe Verlauf). Beginne mit \`factory-report architecture "..."\` (bei Änderungswunsch oder Rückgabe aus der Abnahme direkt mit implementing). Ende mit built.`
      : `Phase **Abnahme**: Du bist der unabhängige Prüfer für den PR ${prUrl ?? ""}. Ende mit accepted oder rework.`;
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
    await docker(["build", "-q", "-t", tag, dir]);
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
  writeFileSync(join(dir, "prompt.md"), buildPrompt(cfg, repo, issue, phase, mode, prUrl, extra));
  chownSync(join(dir, "prompt.md"), CONTAINER_UID, CONTAINER_UID);

  if (phase === "check" && !issue.comments.some((c) => c.body.includes(`${MARK}claimed`))) {
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
    "--memory", cfg.containerMemory, "--shm-size", "1g",
    "-e", `REPO=${repo}`, "-e", `ISSUE=${issue.number}`, "-e", `BRANCH=factory/${issue.number}`,
    "-e", `MODEL=${cfg.model}`, "-e", `WORKFLOW=${cfg.workflow}`, "-e", `PHASE=${phase}`,
    "-e", "GH_TOKEN", "-e", authVar, // Werte kommen aus der Umgebung, nicht aus der Kommandozeile
    "-v", `${dir}:/work`, ...scenarioMount,
    await imageFor(cfg, repo),
  ], { GH_TOKEN: ghToken });
  log("job:started", { repo, issue: issue.number, phase, mode, container: name });
}

/** Wertet einen beendeten Container aus und räumt ihn weg. */
async function finish(cfg: Config, c: Container) {
  const dir = jobDir(cfg, c.repo, c.issue);
  let status: { status?: string; step?: string; pr?: string } = {};
  try { status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")); } catch {}
  let result: any = {};
  try {
    const lines = readFileSync(join(dir, "claude.jsonl"), "utf8").trim().split("\n");
    result = JSON.parse(lines[lines.length - 1]);
  } catch {}

  const endStates: Record<Phase, string[]> = {
    check: ["approved", "question", "rejected", "failed"],
    build: ["accepting", "question", "failed"],
    accept: ["review", "working", "question", "failed"], // working = Rückgabe an die Entwicklung
  };
  const ended = status.status && endStates[c.phase].includes(status.status);
  log("job:finished", {
    repo: c.repo, issue: c.issue, phase: c.phase, exitCode: c.exitCode, status: status.status ?? null,
    minutes: result.duration_ms ? Math.round(result.duration_ms / 60000) : null,
    turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null,
  });
  // Kurze Zusammenfassung des Laufs dauerhaft festhalten: Grundlage für den Verbesserungs-Lauf
  try {
    const runsDir = join(cfg.dataDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    let errTail = "";
    try { errTail = readFileSync(join(dir, "claude.err"), "utf8").slice(-1500); } catch {}
    writeFileSync(join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}__${c.repo.replace("/", "__")}__${c.issue}__${c.phase}.json`), JSON.stringify({
      repo: c.repo, issue: c.issue, phase: c.phase, mode: c.mode, exitCode: c.exitCode,
      status: ended ? status.status : "failed", reported: status,
      result: typeof result.result === "string" ? result.result.slice(0, 4000) : null,
      turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, errTail,
    }, null, 2));
  } catch (e) { log("runs:error", { error: String(e) }); }
  // Dauerhaft festhalten, auch nach dem Aufräumen: Grundlage für factory-stats
  const seconds = Math.max(0, Math.round((Date.parse(c.finishedAt) - Date.parse(c.startedAt)) / 1000));
  appendFileSync(join(cfg.dataDir, "metrics.jsonl"), JSON.stringify({
    t: new Date().toISOString(), repo: c.repo, issue: c.issue, phase: c.phase, mode: c.mode,
    status: ended ? status.status : "failed", exitCode: c.exitCode, seconds: Number.isFinite(seconds) ? seconds : null,
    turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, model: cfg.model,
  }) + "\n");

  if (!ended) {
    let reason = typeof result.result === "string" ? result.result.slice(0, 1500) : "";
    if (!reason) {
      try { reason = readFileSync(join(dir, "claude.err"), "utf8").slice(-1500); } catch {}
    }
    const issue = JSON.parse(await gh(["issue", "view", String(c.issue), "-R", c.repo, "--json", "number,title,body,url,labels,comments"]));
    await setStage(c.repo, issue, "failed");
    await comment(c.repo, c.issue, `failed:${c.phase}`,
      `### ⚠️ Der Lauf wurde ohne Ergebnis beendet (Exit-Code ${c.exitCode})\n\n` +
      (reason ? "```\n" + reason.trim() + "\n```\n\n" : "") +
      `_Schreib einen Kommentar mit einem Hinweis, dann versucht die Factory es erneut._`);
  }
  await docker(["rm", "-f", c.name]).catch(() => {});
}

// ---------- Vorschau pro Pull Request (optional) ----------

const CADDYFILE = "/etc/software-factory/Caddyfile";
const PREVIEW_PORT = (slot: number) => 4000 + slot; // von außen erreichbar (mit Passwort)
const INTERNAL_PORT = (slot: number) => 5000 + slot; // nur lokal, dahinter läuft die App
let caddyHash: string | null = null;
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

async function writeCaddy(cfg: Config, previews: Preview[]) {
  if (!cfg.preview) return;
  if (!caddyHash) caddyHash = (await docker(["run", "--rm", "caddy:2-alpine", "caddy", "hash-password", "--plaintext", cfg.preview.password])).trim();
  const blocks = previews.map((p) =>
    `:${PREVIEW_PORT(p.slot)} {\n  basic_auth {\n    factory ${caddyHash}\n  }\n  reverse_proxy 127.0.0.1:${INTERNAL_PORT(p.slot)}\n}`);
  writeFileSync(CADDYFILE, `{\n  auto_https off\n  admin localhost:2019\n}\n\n${blocks.join("\n\n")}\n`);
  const running = (await docker(["ps", "--filter", "name=^sf-caddy$", "--format", "{{.Names}}"])).trim();
  if (!running) {
    await docker(["rm", "-f", "sf-caddy"]).catch(() => {});
    await docker(["run", "-d", "--name", "sf-caddy", "--network", "host", "--restart", "unless-stopped",
      "-v", `${CADDYFILE}:/etc/caddy/Caddyfile:ro`, "caddy:2-alpine"]);
  } else {
    await docker(["exec", "sf-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
  }
}

/** Startet/aktualisiert Vorschauen für offene Factory-PRs und räumt alte weg. */
async function syncPreviews(cfg: Config, repo: string, issues: Issue[]) {
  if (!cfg.preview) return;
  const max = cfg.preview.max ?? 3;
  let previews = (await listPreviews()).filter((p) => p.repo === repo);
  const wanted = new Map<number, { url: string; number: number; sha: string }>();
  for (const issue of issues.filter((i) => stageOf(i) === "review")) {
    const pr = JSON.parse(await gh(["pr", "list", "-R", repo, "--head", `factory/${issue.number}`, "--state", "open", "--json", "number,url,headRefOid"]))[0];
    if (pr) wanted.set(issue.number, { url: pr.url, number: pr.number, sha: pr.headRefOid });
  }

  let changed = false;
  // Weg mit Vorschauen ohne offenen PR, mit altem Stand oder abgestürzt
  for (const p of previews) {
    const w = wanted.get(p.issue);
    if (!w || w.sha !== p.sha || !p.running) {
      await docker(["rm", "-f", p.name]).catch(() => {});
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
    const ghToken = (await gh(["auth", "token"])).trim();
    const name = `sf-preview-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-${issueNr}`;
    await docker(["run", "-d", "--name", name,
      "--label", "sf.preview=1", "--label", `sf.repo=${repo}`, "--label", `sf.issue=${issueNr}`,
      "--label", `sf.sha=${pr.sha}`, "--label", `sf.slot=${slot}`,
      "-p", `127.0.0.1:${INTERNAL_PORT(slot)}:3000`, "--memory", cfg.preview.memory ?? "1500m",
      "-e", `REPO=${repo}`, "-e", `BRANCH=factory/${issueNr}`, "-e", "GH_TOKEN",
      "--entrypoint", "/factory/preview.sh", await imageFor(cfg, repo)], { GH_TOKEN: ghToken });
    changed = true;
    const link = `http://${cfg.preview.host}:${PREVIEW_PORT(slot)}`;
    log("preview:started", { repo, issue: issueNr, pr: pr.number, url: link });

    const key = `${repo}#${pr.number}`;
    if (!previewNoticePosted.has(key)) {
      const comments = JSON.parse(await gh(["pr", "view", String(pr.number), "-R", repo, "--json", "comments"])).comments as Comment[];
      if (!comments.some((c) => c.body.includes(`${MARK}preview -->`))) {
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

async function maybeImprove(cfg: Config) {
  const requested = join(cfg.dataDir, "improve-requested");
  const lastRun = join(cfg.dataDir, "improve-last");
  const lines = (await docker(["ps", "-a", "--filter", "label=sf.improve=1", "--format", "{{.Names}}|{{.State}}"])).trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const [name, state] = line.split("|");
    if (state === "running") return;
    const out = await docker(["logs", "--tail", "5", name]).catch(() => "");
    log("improve:finished", { container: name, tail: out.trim().slice(-600) });
    await docker(["rm", "-f", name]).catch(() => {});
  }
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
    "--memory", cfg.containerMemory,
    "-e", `REPO=${cfg.factoryRepo}`, "-e", `MODEL=${cfg.model}`, "-e", "GH_TOKEN", "-e", authVar,
    "-v", `${work}:/work`, "-v", `${runs}:/data/runs:ro`, "-v", `${metrics}:/data/metrics.jsonl:ro`,
    "--entrypoint", "/factory/improve.sh", cfg.image], { GH_TOKEN: ghToken });
  log("improve:started", { repo: cfg.factoryRepo });
}

// ---------- Hauptschleife ----------

async function tick(cfg: Config) {
  let containers = await listContainers();

  // 1. Beendete Container auswerten, zu lange laufende stoppen
  for (const c of containers) {
    if (!c.running) { await finish(cfg, c); continue; }
    const minutes = (Date.now() - Date.parse(c.startedAt)) / 60000;
    if (minutes > cfg.jobTimeoutMinutes) {
      log("job:timeout", { repo: c.repo, issue: c.issue, minutes: Math.round(minutes) });
      await docker(["kill", c.name]).catch(() => {});
    }
  }
  containers = (await listContainers()).filter((c) => c.running);
  let freeChecks = cfg.maxChecks - containers.filter((c) => c.phase === "check").length;
  let freeBuilds = cfg.maxParallel - containers.filter((c) => c.phase === "build").length;
  let freeAccepts = cfg.maxAccepts - containers.filter((c) => c.phase === "accept").length;

  for (const repo of cfg.repos) {
    const issues: Issue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", cfg.label, "--state", "open",
      "--json", "number,title,body,url,labels,comments", "--limit", "100"]));
    issues.sort((a, b) => a.number - b.number); // älteste zuerst
    const openNumbers = new Set(issues.map((i) => i.number));

    // Label entfernt oder Issue geschlossen → laufenden Job stoppen
    for (const c of containers.filter((c) => c.repo === repo && !openNumbers.has(c.issue))) {
      log("job:stopped", { repo, issue: c.issue, reason: "Label entfernt oder Issue geschlossen" });
      await docker(["kill", c.name]).catch(() => {});
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
        log("job:done", { repo, issue: issue.number });
      }
    }

    for (const issue of issues) {
      const status = stageOf(issue);
      const running = containers.find((c) => c.repo === repo && c.issue === issue.number);
      if (running) {
        // Genauen Schritt aus dem laufenden Job aufs Board bringen
        let step: string | undefined;
        try { step = JSON.parse(readFileSync(join(jobDir(cfg, repo, issue.number), "status.json"), "utf8")).step || undefined; } catch {}
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
      const marker = lastFactoryMarker(issue);
      const answered = humanCommentsSinceFactory(issue).length > 0;
      if (current === "new") phase = "check";
      else if (current === "checking") { phase = "check"; mode = "retry"; }          // Prüf-Job verloren
      else if (current === "approved") phase = "build";
      else if (current === "working") {
        phase = "build";
        mode = marker?.status === "rework" ? "rework" : "retry";                     // Rückgabe aus der Abnahme oder Job verloren
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

      // Prüfungen und Bau haben getrennte Plätze. Ohne freien Platz bleibt das Issue in seinem Status und kommt beim nächsten Durchlauf dran.
      if (phase === "check" && freeChecks > 0) { await launch(cfg, repo, issue, "check", mode); freeChecks--; }
      else if (phase === "build" && freeBuilds > 0) { await launch(cfg, repo, issue, "build", mode, prUrl); freeBuilds--; }
      else if (phase === "accept" && freeAccepts > 0) {
        if (!prUrl) prUrl = (await findPr(repo, issue.number, "open"))?.url;
        const reworks = reworksSinceApproval(issue);
        const last = reworks >= cfg.maxReworks;
        await launch(cfg, repo, issue, "accept", mode, prUrl,
          `Abnahme-Runde: ${reworks + 1}${last ? " (letzte Runde: keine Rückgabe mehr, offene Probleme als „Bitte genau prüfen“ melden)" : ""}`);
        freeAccepts--;
      }
    }

    await syncPreviews(cfg, repo, issues).catch((e) => log("preview:error", { repo, error: String(e) }));
  }

  await maybeImprove(cfg).catch((e) => log("improve:error", { error: String(e) }));
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
  await initBoard(cfg);
  log("runner:started", { preview: cfg.preview ? `http://${cfg.preview.host}:4001…` : "aus", containerUid: CONTAINER_UID, repos: cfg.repos, maxChecks: cfg.maxChecks, maxParallel: cfg.maxParallel, model: cfg.model, workflow: cfg.workflow });
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

main();
