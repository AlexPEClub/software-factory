// Software Factory – Runner
// Läuft dauerhaft auf dem Server. Holt GitHub Issues mit dem Label "factory",
// startet pro Issue einen Docker-Container mit Claude Code und hält Labels und Board aktuell.
// Er schreibt selbst nie Code. Das macht der Agent im Container.

import {
  appendFileSync, closeSync, constants, existsSync, fchownSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, rmSync, statSync, writeFileSync, writeSync, chownSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BOARD, DEFAULT_LANGUAGE, TEXT, languageName, normalizeLanguage, textLang, type IncidentInfo } from "./strings.ts";

export type Config = {
  repos: string[];
  label: string;
  /** Factory-Sprache (BCP 47): Spalten des gemeinsamen Boards und Hinweise auf dem Server. Standard: de.
   *  Die Sprache der Ausgaben in einem Projekt steht in dessen `.factory/setup.json` → `language`. */
  language?: string;
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
  preview?: {
    host: string; domain?: string; password: string; max?: number; memory?: string;
    /** false: kein Hinweis-Block für `domain` auf Port 443, weil ein anderer Dienst (sites.d) die Domain bedient. Standard: true */
    domainBlock?: boolean;
  };
  /** Ping an healthchecks.io nach jedem Durchlauf (Watchdog für den Factory-Server selbst). Leer: aus */
  heartbeatUrl?: string;
  /**
   * Incident-Intake: aktive Alarme von healthchecks.io und Grafana als Issues mit Label "incident" im Projekt-Repo.
   * Schlüssel aus der Umgebung (secrets.env): HEALTHCHECKS_API_KEY (nur lesend), GRAFANA_TOKEN. Ohne Schlüssel bleibt die Quelle aus.
   */
  incidents?: {
    enabled?: boolean;
    /** Projektname → Repo. Projektname = Label `projekt` eines Grafana-Alarms bzw. Tag oder Namensanfang eines Checks */
    projects?: Record<string, string>;
    /** Repo für Alarme ohne zugeordnetes Projekt (z. B. das Factory-Repo). Leer: nur im Log */
    fallbackRepo?: string;
    healthchecks?: { apiUrl?: string };
    grafana?: { url?: string };
  };
  /** Observability-Stack auf diesem Server (ops/observability/obs.sh). Der Runner selbst liest nur incidents. */
  observability?: { domain?: string };
};

type Comment = { author: { login: string } | null; body: string; createdAt: string };
type Issue = { number: number; title: string; body: string; url: string; labels: { name: string }[]; comments: Comment[] };
type Container = { name: string; repo: string; issue: number; phase: Phase; mode: string; running: boolean; startedAt: string; finishedAt: string; exitCode: number };
type Phase = "check" | "build" | "accept";
type Mode = "new" | "answer" | "change-request" | "retry" | "rework" | "resume";

const CONFIG_PATH = process.env.FACTORY_CONFIG ?? "/etc/software-factory/config.json";
const MARK = "<!-- software-factory:";
// Status eines Issues (Label factory:<status>) und die Spalte dazu auf dem Board. Namen in der Factory-Sprache (strings.ts).
const STATUS_COLORS: Record<string, string> = {
  new: "GRAY", checking: "BLUE", question: "YELLOW", rejected: "RED", approved: "PURPLE", working: "ORANGE",
  accepting: "BLUE", review: "PINK", done: "GREEN", failed: "RED", paused: "GRAY",
};
const boardText = (cfg: Config) => BOARD[textLang(cfg.language)];
/** Projekt-Texte (Kommentare in Issues und PRs) für einen Sprachcode */
const texts = (language: string) => TEXT[textLang(language)];
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
    label: "factory", maxParallel: 2, model: "opus", workflow: "starter-kit", pollSeconds: 60,
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

// ---------- Nutzungslimit von Claude Code ----------
// Übernommen aus dem Fork AndrewSteel/software-factory (Commit e16739e), angepasst.

/** So oft setzt die Factory einen Lauf nach dem Nutzungslimit fort, danach entscheidet der Mensch. */
const MAX_RESUMES = 5;
const RESUME_BUFFER_MS = 5 * 60_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Ortszeit in Zeitzone `tz` → UTC-Millisekunden. Unbekannte Zeitzone: als UTC gelesen. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asZoned = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    return guess - (asZoned - guess);
  } catch { return guess; }
}

/** Heutiges Datum in Zeitzone `tz`. */
function todayIn(now: Date, tz: string): [number, number, number] {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(now).map((x) => [x.type, x.value]));
    return [+p.year, +p.month - 1, +p.day];
  } catch { return [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()]; }
}

/**
 * Erkennt in der letzten Ausgabe von Claude Code ein Nutzungs- oder Ausgabenlimit, z. B.
 * "You've hit your 5-hour limit · resets 1:40am (UTC)" oder
 * "You've hit your individual spend limit · ask your admin … · your 5-hour limit resets 9:30pm (UTC)",
 * und liefert den Zeitpunkt zum Fortsetzen (Reset + Puffer). Ohne lesbare Reset-Zeit: in einer Stunde. Kein Limit: null.
 */
export function limitResumeAt(text: string, now = new Date()): Date | null {
  if (!/hit your [\w\s-]*limit|usage limit reached/i.test(text)) return null;
  const epoch = text.match(/limit reached\|(\d{10,13})/i);
  if (epoch) {
    const ms = epoch[1].length === 10 ? Number(epoch[1]) * 1000 : Number(epoch[1]);
    return new Date(Math.max(ms, now.getTime()) + RESUME_BUFFER_MS);
  }
  const m = text.match(/resets\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i);
  if (!m) return new Date(now.getTime() + 60 * 60_000);
  const tz = m[6]?.trim() || "UTC";
  let hour = Number(m[3]) % 24;
  const ampm = m[5]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const minute = Number(m[4] ?? 0);
  let at: number;
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (month >= 0) {
    const [year] = todayIn(now, tz);
    at = zonedToUtc(year, month, Number(m[2]), hour, minute, tz);
    if (at < now.getTime() - 24 * 3600_000) at = zonedToUtc(year + 1, month, Number(m[2]), hour, minute, tz); // Jahreswechsel
  } else {
    const [y, mo, d] = todayIn(now, tz);
    at = zonedToUtc(y, mo, d, hour, minute, tz);
    if (at <= now.getTime()) at = zonedToUtc(y, mo, d + 1, hour, minute, tz);
  }
  return new Date(Math.max(at, now.getTime()) + RESUME_BUFFER_MS);
}

/** Globale Sperre: Das Kontingent gehört zum Abo, nicht zum Issue. Bis zu diesem Zeitpunkt startet der Runner keinen Lauf. */
const limitFile = (cfg: Config) => join(cfg.dataDir, "limit.json");
export function limitUntil(cfg: Config): number {
  try { return Date.parse(JSON.parse(readFileSync(limitFile(cfg), "utf8")).until) || 0; } catch { return 0; }
}
function setLimitUntil(cfg: Config, at: Date) {
  if (at.getTime() <= limitUntil(cfg)) return; // nie verkürzen
  writeFileSync(limitFile(cfg), JSON.stringify({ until: at.toISOString() }));
  log("limit:paused", { until: at.toISOString() });
}

// ---------- Dauerhafter Zustand pro Issue (nur für den Runner) ----------

/** resume: Lauf wurde vom Nutzungslimit unterbrochen und wird ab `at` mit demselben Arbeitsstand fortgesetzt. */
type IssueState = { lostRetries?: number; resume?: { at: string; phase: Phase; count: number } };
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

/** Liest `language` aus `.factory/setup.json` vom Standard-Branch. Ohne Datei oder Angabe: Standardsprache. */
export function languageFromSetup(content: string | null | undefined): string {
  try { return normalizeLanguage(JSON.parse(content ?? "").language); } catch { return DEFAULT_LANGUAGE; }
}

// Projektsprache je Repo, einige Minuten zwischengespeichert, damit nicht jeder Durchlauf GitHub fragt
const LANGUAGE_TTL_MS = 5 * 60_000;
const languageCache = new Map<string, { language: string; at: number }>();
/** Projektsprache eines Repos (`.factory/setup.json` → `language`, BCP 47). Bei einem Fehler bleibt der letzte bekannte Wert. */
export async function projectLanguage(repo: string): Promise<string> {
  const cached = languageCache.get(repo);
  if (cached && Date.now() - cached.at < LANGUAGE_TTL_MS) return cached.language;
  let language = cached?.language ?? DEFAULT_LANGUAGE;
  try {
    const file = JSON.parse(await gh(["api", `repos/${repo}/contents/.factory/setup.json`]));
    language = languageFromSetup(Buffer.from(file.content ?? "", "base64").toString("utf8"));
  } catch (e) {
    // Datei fehlt (404): Standardsprache. Andere Fehler: letzten bekannten Wert behalten.
    if (/not found|404/i.test(String(e))) language = DEFAULT_LANGUAGE;
  }
  languageCache.set(repo, { language, at: Date.now() });
  return language;
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

    // Spalten im Standardfeld "Status" einrichten (ersetzt Todo / In Progress / Done).
    // Wechselt die Factory-Sprache, werden die Spalten umbenannt; offene Issues bekommen ihre Spalte beim nächsten Durchlauf neu.
    const text = boardText(cfg);
    const status = fields.find((f) => f.name === "Status");
    const have = new Set((status?.options ?? []).map((o: any) => o.name));
    if (status && Object.values(text.status).some((s) => !have.has(s.name))) {
      const options = Object.entries(text.status).map(([key, s]) => `{name: ${JSON.stringify(s.name)}, color: ${STATUS_COLORS[key]}, description: ${JSON.stringify(s.description)}}`).join(", ");
      await gh(["api", "graphql", "-f", `query=mutation { updateProjectV2Field(input: {fieldId: "${status.id}", singleSelectOptions: [${options}]}) { clientMutationId } }`]);
      log("board:columns", { columns: Object.values(text.status).map((s) => s.name) });
    }
    // Zusatzfeld für den Schritt: Feld der anderen Sprache und das alte Feld "Factory" der ersten Version entfernen,
    // ebenso ein Feld mit falschen Optionen (wird neu angelegt)
    const stepNames = Object.values(text.steps);
    for (const f of fields) {
      const otherLanguage = Object.values(BOARD).some((b) => b.stepField === f.name) && f.name !== text.stepField;
      const wrongOptions = f.name === text.stepField && stepNames.some((n) => !(f.options ?? []).some((o: any) => o.name === n));
      if (f.name === "Factory" || otherLanguage || wrongOptions) await gh(["project", "field-delete", "--id", f.id]);
    }
    fields = await fieldList(owner, number);
    if (!fields.find((f) => f.name === text.stepField)) {
      await gh(["project", "field-create", String(number), "--owner", owner, "--name", text.stepField,
        "--data-type", "SINGLE_SELECT", "--single-select-options", stepNames.join(",")]);
    }

    fields = await fieldList(owner, number);
    board = { id: project.id, status: toField(fields.find((f) => f.name === "Status")), step: toField(fields.find((f) => f.name === text.stepField)) };
    log("board:ready", { project: project.title });
  } catch (e) {
    log("board:error", { error: String(e) });
  }
}

async function syncBoard(cfg: Config, url: string, status: string, step?: string) {
  if (!board || !cfg.project) return;
  const text = boardText(cfg);
  const optionId = board.status.options[text.status[status]?.name];
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
    const stepId = status === "working" && step ? board.step.options[text.steps[step]] : undefined;
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
/** Dateien, die ein Lauf im Job-Ordner hinterlässt und die der Runner auswertet. Der Klon (repo/) bleibt. */
export const JOB_OUTPUTS = ["status.json", "verify.json", "verify.md", "claude.jsonl", "claude.err", "setup.log"];
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

/** Regel zur Ausgabesprache, steht ganz oben im Prompt. Anweisungen an den Agent sind englisch, Ausgaben in der Projektsprache. */
export function languageRule(language: string): string {
  const name = languageName(language);
  return `**Output language: ${name} (\`${language}\`).** Write everything people read in ${name}: issue comments, ` +
    `\`factory-report\` summaries and questions, pull request title and body, the text of commit messages, and all documents ` +
    `you write in the repo (design.md, qa-report.md, …), even if this prompt, the issue or comments use another language. ` +
    `Code identifiers, code comments and conventional-commit prefixes (\`feat(PROJ-3):\`) stay in English.`;
}

export function buildPrompt(cfg: Config, repo: string, issue: Issue, phase: Phase, mode: Mode, prUrl?: string, extra?: string, language = DEFAULT_LANGUAGE): string {
  const modeText: Record<Mode, string> = {
    new: "New run",
    answer: "Continuation after an answer from the human (see the latest comments)",
    "change-request": `Change request for the open PR ${prUrl ?? ""} (see the latest comments). Keep working on the same branch, do not open a new PR.`,
    retry: "New attempt after a failure (see the latest comments for hints)",
    rework: `Returned from acceptance: fix the findings from the latest factory comment of the acceptance (rework) on the open PR ${prUrl ?? ""}.`,
    resume: `Continuation after the usage limit: the previous run of this phase was interrupted. Its working state is unchanged in /work/repo (local branch, including unpushed commits and uncommitted changes). Check with git status and git log what is already done and continue from there instead of starting over.${prUrl ? ` Open PR: ${prUrl}` : ""}`,
  };
  // Kommentare von nicht berechtigten Personen bekommt der Agent nicht zu sehen
  const comments = issue.comments.map((c) => {
    const who = loginOf(c) || "unknown";
    if (isFactoryComment(c)) return `### Factory · ${c.createdAt}\n${c.body.replace(/<!-- software-factory:[\w:]+ -->\n?/g, "")}`;
    if (!isTrusted(cfg, who)) return `### ${who} · ${c.createdAt}\n_(Comment hidden: ${who} is not authorized for the factory. Ignore it.)_`;
    return `### ${who} · ${c.createdAt}\n${c.body.replace(/<!-- software-factory:[\w:]+ -->\n?/g, "")}`;
  }).join("\n\n");
  const start = phase === "check"
    ? `Phase **Check**: only check, do not build anything. Start with \`factory-report checking "..."\` and end with approved (after writing the test scenarios to /scenarios/scenarios.md), question or rejected.`
    : phase === "build"
      ? `Phase **Build**: the check has passed (see history). Start with \`factory-report architecture "..."\` (for a change request or a return from acceptance, start directly with implementing). End with built.`
      : `Phase **Acceptance**: you are the independent tester for the PR ${prUrl ?? ""}. End with accepted, rework or (only in the last round) unresolved.`;
  return [
    `# Assignment`,
    ``, languageRule(language), ``,
    `- Repo: ${repo}`, `- Issue: #${issue.number} (${issue.url})`, `- Branch: factory/${issue.number}`,
    `- Workflow: ${cfg.workflow} (description: /factory/workflows/${cfg.workflow}/workflow.md)`,
    `- Phase: ${phase === "check" ? "Check" : phase === "build" ? "Build" : "Acceptance"}`,
    `- Mode: ${modeText[mode]}`,
    ...(extra ? [`- ${extra}`] : []),
    ``, `## Issue: ${issue.title}`, ``, issue.body || "_(no text)_",
    ``, `## History`, ``, comments || "_(no comments)_",
    ``, `Follow the factory playbook from your system prompt. ${start}`,
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

export async function launch(cfg: Config, repo: string, issue: Issue, phase: Phase, mode: Mode, prUrl?: string, extra?: string) {
  const name = containerName(repo, issue.number);
  const dir = jobDir(cfg, repo, issue.number);
  mkdirSync(dir, { recursive: true });
  chownSync(dir, CONTAINER_UID, CONTAINER_UID);
  // Ausgaben früherer Läufe entfernen: Sonst meldet ein Lauf, der vor Claude abbricht, den alten Fehler erneut
  for (const f of JOB_OUTPUTS) rmSync(join(dir, f), { force: true });
  const language = await projectLanguage(repo);
  writeJobFile(join(dir, "prompt.md"), buildPrompt(cfg, repo, issue, phase, mode, prUrl, extra, language));

  if (phase === "check" && !issue.comments.some((c) => isFactoryComment(c) && c.body.includes(`${MARK}claimed`))) {
    await comment(repo, issue.number, "claimed", texts(language).claimed);
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
    "-e", `MODEL=${cfg.model}`, "-e", `WORKFLOW=${cfg.workflow}`, "-e", `PHASE=${phase}`, "-e", `FACTORY_LANGUAGE=${language}`,
    ...(mode === "resume" ? ["-e", "RESUME=1"] : []),
    "-e", "GH_TOKEN", "-e", authVar, // Werte kommen aus der Umgebung, nicht aus der Kommandozeile
    "-v", `${dir}:/work`, ...scenarioMount,
    await imageFor(cfg, repo),
  ], { GH_TOKEN: ghToken });
  log("job:started", { repo, issue: issue.number, phase, mode, container: name });
}

/** Nach einem Bau-Lauf: Sind die Pflicht-Checks auf genau dem gepushten Stand grün und ist die Spec unverändert? */
async function checkBuild(repo: string, issue: number, dir: string, t: ReturnType<typeof texts>, prUrl?: string): Promise<string | null> {
  const verify = readJobJson(join(dir, "verify.json"));
  if (!verify || verify.ok !== true || !Array.isArray(verify.results) || verify.results.length === 0) return t.noVerify;
  let head = "";
  try { head = (await gh(["api", `repos/${repo}/git/ref/heads/factory/${issue}`, "--jq", ".object.sha"])).trim(); } catch {}
  if (!head) return t.notPushed(`factory/${issue}`);
  if (verify.sha !== head) return t.shaMismatch(String(verify.sha).slice(0, 7), head.slice(0, 7));
  if (prUrl) {
    try {
      const files = (await gh(["pr", "diff", prUrl, "--name-only"])).split("\n");
      const spec = files.find((f) => /^features\/[^/]+\/spec\.md$/.test(f.trim()));
      if (spec) return t.specChanged(spec.trim());
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
  const t = texts(await projectLanguage(c.repo));
  let problem = reason ?? null;
  if (!problem && !(status.status && endStates[c.phase].includes(status.status))) problem = t.noResult;
  if (!problem && (c.exitCode !== 0 || result.is_error)) problem = t.cliError(c.exitCode);
  if (!problem && c.phase === "build" && status.status === "accepting") problem = await checkBuild(c.repo, c.issue, dir, t, status.pr);
  const ended = !problem;
  const errTail = redact(readJobFile(join(dir, "claude.err"), 1500) ?? "");
  // Vom Nutzungslimit unterbrochen (nicht vom Runner beendet): später mit demselben Arbeitsstand fortsetzen
  const state = getState(cfg, c.repo, c.issue);
  const resumeAt = !ended && !reason ? limitResumeAt(`${typeof result.result === "string" ? result.result : ""}\n${errTail}`) : null;
  const resumeCount = (state.resume?.count ?? 0) + 1;
  const pause = resumeAt && resumeCount <= MAX_RESUMES;
  if (resumeAt && !pause) problem = t.limitExhausted(MAX_RESUMES);
  const metricStatus = ended ? (status.status === "review" && status.unresolved ? "unresolved" : status.status) : pause ? "paused" : "failed";

  log("job:finished", {
    repo: c.repo, issue: c.issue, phase: c.phase, exitCode: c.exitCode, status: metricStatus, problem,
    minutes: result.duration_ms ? Math.round(result.duration_ms / 60000) : null,
    turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null,
  });
  // Bricht der Job vor Claude ab (Klonen, Checkout …), steht der Grund nur im Log des Containers
  const containerLog = redact((await docker(["logs", "--tail", "40", c.name]).catch(() => "")).slice(-1500));
  // Kurze Zusammenfassung des Laufs dauerhaft festhalten: Grundlage für den Verbesserungs-Lauf
  try {
    const runsDir = join(cfg.dataDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}__${c.repo.replace("/", "__")}__${c.issue}__${c.phase}.json`), JSON.stringify({
      repo: c.repo, issue: c.issue, phase: c.phase, mode: c.mode, exitCode: c.exitCode,
      status: metricStatus, problem, reported: status,
      result: typeof result.result === "string" ? redact(result.result.slice(0, 4000)) : null,
      turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null, errTail, containerLog,
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
  } else if (pause && resumeAt) {
    setLimitUntil(cfg, resumeAt);
    setState(cfg, c.repo, c.issue, { ...state, resume: { at: resumeAt.toISOString(), phase: c.phase, count: resumeCount } });
    const issue = JSON.parse(await gh(["issue", "view", String(c.issue), "-R", c.repo, "--json", "number,title,body,url,labels,comments"]));
    await setStage(c.repo, issue, "paused");
    await syncBoard(cfg, issue.url, "paused");
    const when = resumeAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    await comment(c.repo, c.issue, `paused:${c.phase}`, t.paused(when, resumeCount, MAX_RESUMES));
  } else {
    let detail = typeof result.result === "string" ? result.result.slice(-1500) : "";
    if (!detail) detail = errTail.slice(-800);
    if (!detail) detail = containerLog.slice(-800);
    detail = redact(detail).replace(/```/g, "'''").trim();
    if (state.resume) setState(cfg, c.repo, c.issue, { ...state, resume: undefined });
    const issue = JSON.parse(await gh(["issue", "view", String(c.issue), "-R", c.repo, "--json", "number,title,body,url,labels,comments"]));
    await setStage(c.repo, issue, "failed");
    await syncBoard(cfg, issue.url, "failed");
    await comment(c.repo, c.issue, `failed:${c.phase}`, t.failed(problem ?? "", detail));
  }
  await docker(["rm", "-f", c.name]).catch(() => {});
}

// ---------- Vorschau pro Pull Request (optional) ----------

const CADDYFILE = "/etc/software-factory/Caddyfile";
const PREVIEW_PORT = (slot: number) => 4000 + slot; // von außen erreichbar (mit Passwort)
const INTERNAL_PORT = (slot: number) => 5000 + slot; // nur lokal, dahinter läuft die App
let caddyHash: string | null = null;
let caddyFresh = false; // Caddy einmal pro Runner-Start neu aufsetzen (Konfiguration kann sich geändert haben)
const CADDYFILE_CHECK = "/etc/software-factory/Caddyfile.check";
const SITES_DIR = "/etc/software-factory/sites.d"; // Site-Blöcke anderer Dienste auf diesem Server
const SITES_MOUNT = "/etc/caddy/sites.d";
let caddySites: string | null = null; // Fingerabdruck der Site-Dateien beim letzten Schreiben
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

/**
 * Baut die komplette Caddy-Datei. Die Factory besitzt diese Datei allein und schreibt sie bei jeder Änderung neu.
 * Andere Dienste auf demselben Server legen eigene Site-Blöcke in SITES_DIR ab (`*.caddy`); mit `sites` werden sie
 * per `import` eingebunden. `preview.domainBlock: false` lässt den Hinweis-Block für die Domain weg, damit ein
 * anderer Dienst die Domain auf Port 443 bedienen kann (die Zertifikate für die Vorschau-Ports holt Caddy trotzdem).
 */
export function caddyConfig(cfg: Config, slots: number[], hash: string, sites = false): string {
  const domain = cfg.preview?.domain;
  // Mit Domain holt Caddy selbst ein Zertifikat (Ports 80 und 443 müssen erreichbar sein). Ohne Domain nur HTTP.
  const global = domain ? `{\n  admin localhost:2019\n}` : `{\n  auto_https off\n  admin localhost:2019\n}`;
  const blocks = slots.map((slot) =>
    `${domain ? `${domain}:${PREVIEW_PORT(slot)}` : `:${PREVIEW_PORT(slot)}`} {\n  basic_auth {\n    factory ${hash}\n  }\n  reverse_proxy 127.0.0.1:${INTERNAL_PORT(slot)}\n}`);
  if (domain && cfg.preview?.domainBlock !== false) blocks.unshift(`${domain} {\n  respond ${JSON.stringify(boardText(cfg).domainNotice)} 200\n}`);
  if (sites) blocks.push(`# Site-Blöcke anderer Dienste auf diesem Server (${SITES_DIR}/*.caddy)\nimport ${SITES_MOUNT}/*.caddy`);
  return `${global}\n\n${blocks.join("\n\n")}\n`;
}

/** Fingerabdruck der Site-Dateien anderer Dienste: Ändert er sich, schreibt die Factory ihre Caddy-Datei neu. */
export function sitesSignature(dir = SITES_DIR): string {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".caddy")).sort(); } catch { return ""; }
  const h = createHash("sha256");
  for (const n of names) {
    h.update(n + "\0");
    try { h.update(readFileSync(join(dir, n))); } catch {}
    h.update("\0");
  }
  return names.length ? h.digest("hex") : "";
}

/** Prüft eine Caddy-Datei samt eingebundener Site-Dateien mit demselben Image, ohne Netz, ohne etwas zu starten. */
async function caddyValid(text: string): Promise<string | null> {
  writeFileSync(CADDYFILE_CHECK, text);
  try {
    await docker(["run", "--rm", "--network", "none",
      "-v", `${CADDYFILE_CHECK}:/etc/caddy/Caddyfile:ro`, "-v", `${SITES_DIR}:${SITES_MOUNT}:ro`,
      "caddy:2-alpine", "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"], undefined, 60_000);
    return null;
  } catch (e) {
    return String(e).slice(-800);
  } finally {
    rmSync(CADDYFILE_CHECK, { force: true });
  }
}

async function writeCaddy(cfg: Config, previews: Preview[]) {
  if (!cfg.preview) return;
  if (!caddyHash) caddyHash = (await docker(["run", "--rm", "caddy:2-alpine", "caddy", "hash-password", "--plaintext", cfg.preview.password])).trim();
  mkdirSync(SITES_DIR, { recursive: true, mode: 0o755 });
  const slots = previews.map((p) => p.slot);
  const signature = sitesSignature();
  // `import` nur, wenn es Site-Dateien gibt – dann immer vorher geprüft. Fremde Site-Dateien dürfen die
  // Vorschauen nie lahmlegen: Ist das Ganze ungültig (z. B. dieselbe Domain doppelt), geht es ohne sie weiter.
  let text = caddyConfig(cfg, slots, caddyHash, Boolean(signature));
  if (signature) {
    const problem = await caddyValid(text);
    if (problem) {
      log("caddy:sites-invalid", { dir: SITES_DIR, error: problem });
      text = caddyConfig(cfg, slots, caddyHash, false);
    }
  }
  writeFileSync(CADDYFILE, text);
  caddySites = signature;
  const running = (await docker(["ps", "--filter", "name=^sf-caddy$", "--format", "{{.Names}}"])).trim();
  if (!running || !caddyFresh) {
    await docker(["rm", "-f", "sf-caddy"]).catch(() => {});
    // Zertifikate liegen im Volume sf-caddy-data und überleben Neustarts
    await docker(["run", "-d", "--name", "sf-caddy", "--network", "host", "--restart", "unless-stopped",
      "-v", `${CADDYFILE}:/etc/caddy/Caddyfile:ro`, "-v", `${SITES_DIR}:${SITES_MOUNT}:ro`,
      "-v", "sf-caddy-data:/data", "caddy:2-alpine"]);
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

  // Neu schreiben auch, wenn ein anderer Dienst seine Site-Datei geändert hat
  let changed = !caddyFresh || sitesSignature() !== caddySites;
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
          `${MARK}preview -->\n${texts(await projectLanguage(repo)).preview(link)}`);
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

// ---------- Incident-Intake und Heartbeat ----------
// Bei jedem Durchlauf: aktive Alarme von healthchecks.io (Checks mit Status "down") und Grafana (Alertmanager-API)
// holen und je Alarm genau ein offenes Issue mit Label "incident" im Repo des Projekts halten. Ist der Alarm vorbei,
// kommentiert und schließt der Runner das Issue. Diese Issues bekommen nie das Label "factory".
// Nur lesend: kein Webhook, kein GitHub-Token bei einem Dritten.

/** Labels, mit denen ein Issue nie als Aufgabe der Factory gilt */
export const NEVER_FACTORY = ["incident", "deploy-failed"];
export const isFactoryWork = (issue: { labels: { name: string }[] }) => !issue.labels.some((l) => NEVER_FACTORY.includes(l.name));

export type IncidentSource = IncidentInfo["source"];
export type Alert = IncidentInfo & { key: string };
type IncidentIssue = { number: number; body: string; author: { login: string } | null; createdAt: string };

const INCIDENT_LABEL = "incident";
const INCIDENT_MARK = /<!-- software-factory:incident:([A-Za-z0-9_-]+) -->/;
const KEY_PREFIX: Record<IncidentSource, string> = { healthchecks: "hc-", grafana: "gf-" };
const sourceOfKey = (key: string) => (Object.keys(KEY_PREFIX) as IncidentSource[]).find((s) => key.startsWith(KEY_PREFIX[s]));
const safeKey = (s: unknown) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
const incidentLabelReady = new Set<string>();
const unmappedLogged = new Set<string>();

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/** Projekt eines Checks: Tag mit dem Projektnamen, sonst Slug bzw. Name = Projekt oder beginnt mit "<projekt>-" (längster Treffer). */
export function projectForCheck(check: { tags?: string; slug?: string; name?: string }, projects: Record<string, string> = {}): string {
  const names = Object.keys(projects);
  const tag = (check.tags ?? "").split(/\s+/).find((t) => names.includes(t));
  if (tag) return tag;
  const candidates = [check.slug, check.name].filter(Boolean).map((s) => String(s).toLowerCase());
  return names.filter((p) => candidates.some((c) => c === p.toLowerCase() || c.startsWith(`${p.toLowerCase()}-`)))
    .sort((a, b) => b.length - a.length)[0] ?? "";
}

/** Checks von healthchecks.io mit Status "down". null: Quelle aus oder nicht erreichbar (dann schließt der Runner nichts). */
export async function fetchHealthchecks(cfg: Config): Promise<Alert[] | null> {
  const key = process.env.HEALTHCHECKS_API_KEY;
  if (!key) return null;
  const base = cfg.incidents?.healthchecks?.apiUrl || "https://healthchecks.io/api/v3/";
  try {
    const data = await getJson(new URL("checks/", base.endsWith("/") ? base : `${base}/`).toString(), { "X-Api-Key": key });
    if (!Array.isArray(data?.checks)) throw new Error("Antwort ohne checks");
    return data.checks.filter((c: any) => c?.status === "down").map((c: any): Alert => {
      // Nur-lesende Schlüssel liefern unique_key statt der Ping-URL
      const id = safeKey(c.unique_key ?? String(c.ping_url ?? "").split("/").pop() ?? c.slug);
      return {
        key: `${KEY_PREFIX.healthchecks}${id || safeKey(c.name)}`, source: "healthchecks",
        project: projectForCheck(c, cfg.incidents?.projects), title: String(c.name || c.slug || id),
        since: c.next_ping ?? undefined,
        details: [
          `Check: \`${c.slug || c.name}\``,
          ...(c.tags ? [`Tags: \`${c.tags}\``] : []),
          `last_ping: ${c.last_ping ?? "–"}`,
          ...(c.grace ? [`grace: ${c.grace} s`] : []),
        ],
      };
    });
  } catch (e) {
    log("incident:source-error", { source: "healthchecks", error: String(e) });
    return null;
  }
}

/** Aktive Alarme aus Grafana (eingebauter Alertmanager). null: Quelle aus oder nicht erreichbar. */
export async function fetchGrafanaAlerts(cfg: Config): Promise<Alert[] | null> {
  const token = process.env.GRAFANA_TOKEN;
  if (!token) return null;
  const base = (cfg.incidents?.grafana?.url || "http://127.0.0.1:3300").replace(/\/+$/, "");
  try {
    const data = await getJson(`${base}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`,
      { Authorization: `Bearer ${token}` });
    if (!Array.isArray(data)) throw new Error("Antwort ist keine Liste");
    return data.filter((a: any) => (a?.status?.state ?? "active") === "active" && safeKey(a?.fingerprint)).map((a: any): Alert => {
      const labels: Record<string, string> = a.labels ?? {};
      const notes: Record<string, string> = a.annotations ?? {};
      const where = [labels.umgebung, labels.instance].filter(Boolean).join(", ");
      return {
        key: `${KEY_PREFIX.grafana}${safeKey(a.fingerprint)}`, source: "grafana",
        project: labels.projekt ?? "", title: `${labels.alertname ?? "Alarm"}${where ? ` (${where})` : ""}`,
        since: a.startsAt, link: a.generatorURL || undefined,
        details: [
          ...(notes.summary ? [notes.summary] : []),
          ...(notes.description ? [notes.description] : []),
          `Labels: ${Object.entries(labels).filter(([k]) => !k.startsWith("__")).map(([k, v]) => `\`${k}=${v}\``).join(" ")}`,
        ],
      };
    });
  } catch (e) {
    log("incident:source-error", { source: "grafana", error: String(e) });
    return null;
  }
}

/** Repo eines Projekts laut Config, sonst das Auffang-Repo. Leer: keins. */
export const incidentRepo = (cfg: Config, project: string) =>
  (project && cfg.incidents?.projects?.[project]) || cfg.incidents?.fallbackRepo || "";

/** Issues, die der Runner für einen Alarm angelegt hat und die er noch einmal anlegen würde: Schlüssel → Repo und Nummer. */
type IncidentState = Record<string, { repo: string; issue: number }>;
const incidentStateFile = (cfg: Config) => join(cfg.dataDir, "incidents.json");
function getIncidentState(cfg: Config): IncidentState {
  try { return JSON.parse(readFileSync(incidentStateFile(cfg), "utf8")); } catch { return {}; }
}

async function ensureIncidentLabel(repo: string) {
  if (incidentLabelReady.has(repo)) return;
  await gh(["label", "create", INCIDENT_LABEL, "-R", repo, "--color", "B60205", "--description", "Alarm aus Monitoring oder Watchdog", "--force"]);
  incidentLabelReady.add(repo);
}

/**
 * Gleicht Alarme und offene Incident-Issues ab. `results`: je Quelle die aktiven Alarme, null wenn die Quelle aus
 * oder nicht erreichbar war. Issues einer solchen Quelle bleiben unverändert, damit ein Ausfall der API nichts schließt.
 * Schließt ein Mensch das Issue, solange der Alarm noch aktiv ist, legt der Runner kein neues an (erst beim nächsten Alarm).
 */
export async function syncIncidents(cfg: Config, results: { source: IncidentSource; alerts: Alert[] | null }[]) {
  const reachable = new Set(results.filter((r) => r.alerts !== null).map((r) => r.source));
  const active = new Map<string, Alert>();
  for (const r of results) for (const a of r.alerts ?? []) active.set(a.key, a);
  const state = getIncidentState(cfg);
  const repos = new Set([...Object.values(cfg.incidents?.projects ?? {}), cfg.incidents?.fallbackRepo ?? ""].filter(Boolean));

  for (const a of active.values()) {
    const repo = incidentRepo(cfg, a.project);
    if (repo) { repos.add(repo); continue; }
    if (!unmappedLogged.has(a.key)) log("incident:unmapped", { key: a.key, source: a.source, project: a.project, title: a.title });
    unmappedLogged.add(a.key);
  }

  for (const repo of repos) {
    try {
      const open: IncidentIssue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", INCIDENT_LABEL, "--state", "open",
        "--json", "number,body,author,createdAt", "--limit", "100"]));
      // Nur Issues, die der Runner selbst angelegt hat (wie bei den Markern in Kommentaren)
      const byKey = new Map<string, IncidentIssue[]>();
      for (const i of open.filter((i) => !!FACTORY_LOGIN && i.author?.login === FACTORY_LOGIN)) {
        const key = (i.body ?? "").match(INCIDENT_MARK)?.[1];
        if (key) byKey.set(key, [...(byKey.get(key) ?? []), i].sort((x, y) => x.number - y.number));
      }
      const t = texts(await projectLanguage(repo));

      for (const a of [...active.values()].filter((a) => incidentRepo(cfg, a.project) === repo)) {
        const [keep, ...duplicates] = byKey.get(a.key) ?? [];
        if (keep) {
          for (const d of duplicates) {
            await gh(["issue", "comment", String(d.number), "-R", repo, "--body-file", "-"], `${MARK}incident:duplicate -->\n${t.incidentDuplicate(keep.number)}`);
            await gh(["issue", "close", String(d.number), "-R", repo, "--reason", "not planned"]);
            log("incident:duplicate-closed", { repo, issue: d.number, keep: keep.number, key: a.key });
          }
          state[a.key] = { repo, issue: keep.number };
          continue;
        }
        if (state[a.key]?.repo === repo) continue; // von Hand geschlossen, Alarm läuft noch
        await ensureIncidentLabel(repo);
        // Bewusst nur "incident", nie das Label der Factory
        const url = (await gh(["issue", "create", "-R", repo, "--title", t.incidentTitle(a), "--label", INCIDENT_LABEL, "--body-file", "-"],
          `<!-- software-factory:incident:${a.key} -->\n${redact(t.incidentBody(a))}`)).trim();
        const issue = Number(url.match(/\/issues\/(\d+)/)?.[1] ?? 0);
        state[a.key] = { repo, issue };
        log("incident:opened", { repo, issue, key: a.key, source: a.source, title: a.title });
      }

      // Erholt: offene Issues ohne aktiven Alarm schließen, aber nur wenn ihre Quelle erreichbar war
      for (const [key, issues] of byKey) {
        const source = sourceOfKey(key);
        if (active.has(key) || !source || !reachable.has(source)) continue;
        for (const i of issues) {
          await gh(["issue", "comment", String(i.number), "-R", repo, "--body-file", "-"], `${MARK}incident:resolved -->\n${t.incidentResolved(source)}`);
          await gh(["issue", "close", String(i.number), "-R", repo, "--reason", "completed"]);
          log("incident:resolved", { repo, issue: i.number, key });
        }
        delete state[key];
      }
    } catch (e) {
      log("incident:repo-error", { repo, error: String(e) });
    }
  }

  // Vorbei, während das Issue schon (von Hand) geschlossen war: beim nächsten Alarm wieder ein neues Issue
  for (const key of Object.keys(state)) {
    const source = sourceOfKey(key);
    if (!active.has(key) && source && reachable.has(source)) delete state[key];
  }
  for (const key of unmappedLogged) if (!active.has(key)) unmappedLogged.delete(key);
  mkdirSync(cfg.dataDir, { recursive: true });
  writeFileSync(incidentStateFile(cfg), JSON.stringify(state));
}

export async function incidentIntake(cfg: Config) {
  if (!cfg.incidents?.enabled) return;
  const [hc, gf] = await Promise.all([fetchHealthchecks(cfg), fetchGrafanaAlerts(cfg)]);
  await syncIncidents(cfg, [{ source: "healthchecks", alerts: hc }, { source: "grafana", alerts: gf }]);
}

/** Lebenszeichen an healthchecks.io: Bleibt es aus, meldet healthchecks.io den Ausfall per E-Mail. */
export async function heartbeat(cfg: Config) {
  if (!cfg.heartbeatUrl) return;
  try {
    const res = await fetch(cfg.heartbeatUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    log("heartbeat:error", { error: String(e) });
  }
}

// ---------- Hauptschleife ----------

/** Ein Lauf ging verloren (z. B. Server-Neustart): einmal automatisch neu starten, danach entscheidet der Mensch. */
async function lostJob(cfg: Config, repo: string, issue: Issue): Promise<boolean> {
  const s = getState(cfg, repo, issue.number);
  if ((s.lostRetries ?? 0) < 1) { setState(cfg, repo, issue.number, { ...s, lostRetries: (s.lostRetries ?? 0) + 1 }); return true; }
  await setStage(repo, issue, "failed");
  await syncBoard(cfg, issue.url, "failed");
  await comment(repo, issue.number, `failed:${lastFactoryMarker(issue)?.phase ?? "build"}`, texts(await projectLanguage(repo)).lost);
  setState(cfg, repo, issue.number, {});
  return false;
}

async function tickRepo(cfg: Config, repo: string, containers: Container[], slots: { free: number }) {
  const listed: Issue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", cfg.label, "--state", "open",
    "--json", "number,title,body,url,labels,comments", "--limit", "100"]));
  // Alarme und Deploy-Fehler sind nie Aufgaben der Factory, auch wenn jemand das Label setzt
  const issues = listed.filter(isFactoryWork);
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
    else if (current === "paused") {
      const r = getState(cfg, repo, issue.number).resume;
      if (r && !answered && Date.now() < Date.parse(r.at)) continue;                           // Limit noch nicht zurückgesetzt
      phase = r?.phase ?? (marker?.phase as Phase) ?? "build";
      mode = "resume";
      if (phase !== "check") prUrl = (await findPr(repo, issue.number, "open"))?.url;
    }
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
        `Acceptance round: ${reworks + 1}${last ? " (last round: no more returns. Passed → accepted, otherwise unresolved)" : ""}`);
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
          texts(await projectLanguage(c.repo)).timeout(cfg.jobTimeoutMinutes));
      }
    } catch (e) {
      log("finish:error", { repo: c.repo, issue: c.issue, error: String(e) });
    }
  }
  containers = (await listContainers()).filter((c) => c.running);
  const improving = await improveRunning(cfg);
  // Nutzungslimit aktiv: keine neuen Läufe und keine Fortsetzungen. Laufende Jobs, Labels und Board werden weiter gepflegt.
  const limited = Date.now() < limitUntil(cfg);
  const slots = { free: limited ? 0 : cfg.maxParallel - containers.length - (improving ? 1 : 0) };

  // Ein fehlerhaftes Repo darf die anderen nicht blockieren
  for (const repo of cfg.repos) {
    try { await tickRepo(cfg, repo, containers, slots); }
    catch (e) { log("repo:error", { repo, error: String(e) }); }
  }

  await maybeImprove(cfg, slots.free).catch((e) => log("improve:error", { error: String(e) }));

  // Erst das Lebenszeichen, dann die Alarme: Nach einem Neustart steht der eigene Check sonst noch auf "down"
  await heartbeat(cfg);
  await incidentIntake(cfg).catch((e) => log("incident:error", { error: String(e) }));
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
    heartbeat: cfg.heartbeatUrl ? "an" : "aus",
    incidents: cfg.incidents?.enabled
      ? { healthchecks: !!process.env.HEALTHCHECKS_API_KEY, grafana: !!process.env.GRAFANA_TOKEN, projects: Object.keys(cfg.incidents.projects ?? {}) }
      : "aus",
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
