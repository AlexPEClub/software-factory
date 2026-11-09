// Software Factory – Runner
// Läuft dauerhaft auf dem Server. Holt GitHub Issues mit dem Label "factory",
// startet pro Issue einen Docker-Container mit Claude Code und hält Labels und Board aktuell.
// Er schreibt selbst nie Code. Das macht der Agent im Container.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chownSync } from "node:fs";
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
  project?: { owner: string; number: number };
  /** Vorschau pro PR: http://<host>:<4000+slot>, mit Passwortschutz (Nutzer "factory") */
  preview?: { host: string; password: string; max?: number; memory?: string };
};

type Comment = { author: { login: string }; body: string; createdAt: string };
type Issue = { number: number; title: string; body: string; url: string; labels: { name: string }[]; comments: Comment[] };
type Container = { name: string; repo: string; issue: number; running: boolean; startedAt: string; exitCode: number };
type Mode = "new" | "answer" | "change-request" | "retry";

const CONFIG_PATH = process.env.FACTORY_CONFIG ?? "/etc/software-factory/config.json";
const MARK = "<!-- software-factory:";
const ACTIVE = new Set(["queued", "triage", "investigating", "implementing", "verifying"]);
const STAGE_NAMES: Record<string, string> = {
  queued: "Warteschlange", triage: "Triage", investigating: "Analyse", implementing: "Umsetzung",
  verifying: "Prüfung", pr: "PR bereit", waiting: "Wartet auf dich", failed: "Fehlgeschlagen", done: "Fertig",
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
    containerMemory: "3g", ...c,
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

let board: { id: string; fieldId: string; options: Record<string, string> } | null = null;
const boardItems = new Map<string, { itemId: string; stage?: string }>();

async function initBoard(cfg: Config) {
  if (!cfg.project) return;
  const { owner, number } = cfg.project;
  try {
    const project = JSON.parse(await gh(["project", "view", String(number), "--owner", owner, "--format", "json"]));
    let fields = JSON.parse(await gh(["project", "field-list", String(number), "--owner", owner, "--format", "json"])).fields;
    let field = fields.find((f: any) => f.name === "Factory");
    if (!field) {
      await gh(["project", "field-create", String(number), "--owner", owner, "--name", "Factory",
        "--data-type", "SINGLE_SELECT", "--single-select-options", Object.values(STAGE_NAMES).join(",")]);
      fields = JSON.parse(await gh(["project", "field-list", String(number), "--owner", owner, "--format", "json"])).fields;
      field = fields.find((f: any) => f.name === "Factory");
    }
    const options: Record<string, string> = {};
    for (const o of field.options ?? []) options[o.name] = o.id;
    board = { id: project.id, fieldId: field.id, options };
    log("board:ready", { project: project.title });
  } catch (e) {
    log("board:error", { error: String(e) });
  }
}

async function syncBoard(cfg: Config, url: string, stage: string) {
  if (!board || !cfg.project) return;
  const optionId = board.options[STAGE_NAMES[stage]];
  if (!optionId) return;
  let entry = boardItems.get(url);
  if (entry?.stage === stage) return;
  try {
    if (!entry) {
      const item = JSON.parse(await gh(["project", "item-add", String(cfg.project.number), "--owner", cfg.project.owner, "--url", url, "--format", "json"]));
      entry = { itemId: item.id };
      boardItems.set(url, entry);
    }
    await gh(["project", "item-edit", "--id", entry.itemId, "--project-id", board.id, "--field-id", board.fieldId, "--single-select-option-id", optionId]);
    entry.stage = stage;
  } catch (e) {
    log("board:sync-error", { url, error: String(e) });
  }
}

// ---------- Jobs ----------

const containerName = (repo: string, n: number) => `sf-${repo.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-${n}`;
const jobDir = (cfg: Config, repo: string, n: number) => join(cfg.dataDir, "jobs", `${repo.replace("/", "__")}__${n}`);

async function listContainers(): Promise<Container[]> {
  const names = (await docker(["ps", "-a", "--filter", "label=software-factory=1", "--format", "{{.Names}}"])).split("\n").filter(Boolean);
  const result: Container[] = [];
  for (const name of names) {
    const info = JSON.parse(await docker(["inspect", name]))[0];
    result.push({
      name, repo: info.Config.Labels["sf.repo"], issue: Number(info.Config.Labels["sf.issue"]),
      running: info.State.Running, startedAt: info.State.StartedAt, exitCode: info.State.ExitCode,
    });
  }
  return result;
}

function buildPrompt(cfg: Config, repo: string, issue: Issue, mode: Mode, prUrl?: string): string {
  const modeText: Record<Mode, string> = {
    new: "Neuer Lauf",
    answer: "Fortsetzung nach einer Antwort des Menschen (siehe letzte Kommentare)",
    "change-request": `Änderungswunsch zum offenen PR ${prUrl ?? ""} (siehe letzte Kommentare). Arbeite auf demselben Branch weiter, keinen neuen PR öffnen.`,
    retry: "Erneuter Versuch nach einem Fehlschlag (siehe letzte Kommentare für Hinweise)",
  };
  const comments = issue.comments.map((c) =>
    `### ${c.author.login} · ${c.createdAt}\n${c.body.replace(/<!-- software-factory:\w+ -->\n?/g, "[Factory] ")}`).join("\n\n");
  return [
    `# Auftrag`,
    `- Repo: ${repo}`, `- Issue: #${issue.number} (${issue.url})`, `- Branch: factory/${issue.number}`,
    `- Workflow: ${cfg.workflow} (Beschreibung: /factory/workflows/${cfg.workflow}/workflow.md)`,
    `- Modus: ${modeText[mode]}`,
    ``, `## Issue: ${issue.title}`, ``, issue.body || "_(kein Text)_",
    ``, `## Verlauf`, ``, comments || "_(keine Kommentare)_",
    ``, `Folge dem Factory-Playbook aus deinem System-Prompt. Beginne mit \`factory-report triage "..."\`.`,
  ].join("\n");
}

async function launch(cfg: Config, repo: string, issue: Issue, mode: Mode, prUrl?: string) {
  const name = containerName(repo, issue.number);
  const dir = jobDir(cfg, repo, issue.number);
  mkdirSync(dir, { recursive: true });
  chownSync(dir, CONTAINER_UID, CONTAINER_UID);
  for (const f of ["status.json", "verify.json", "verify.md"]) rmSync(join(dir, f), { force: true });
  writeFileSync(join(dir, "prompt.md"), buildPrompt(cfg, repo, issue, mode, prUrl));
  chownSync(join(dir, "prompt.md"), CONTAINER_UID, CONTAINER_UID);

  if (mode === "new") {
    await comment(repo, issue.number, "claimed",
      `🏭 Die Factory hat das Issue übernommen und arbeitet auf dem Branch \`factory/${issue.number}\`. Den Fortschritt siehst du an den Labels.`);
  }
  await setStage(repo, issue, "queued");

  const ghToken = (await gh(["auth", "token"])).trim();
  const authVar = process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  await docker(["rm", "-f", name]).catch(() => {});
  await docker([
    "run", "-d", "--name", name,
    "--label", "software-factory=1", "--label", `sf.repo=${repo}`, "--label", `sf.issue=${issue.number}`,
    "--memory", cfg.containerMemory, "--shm-size", "1g",
    "-e", `REPO=${repo}`, "-e", `ISSUE=${issue.number}`, "-e", `BRANCH=factory/${issue.number}`,
    "-e", `MODEL=${cfg.model}`, "-e", `WORKFLOW=${cfg.workflow}`,
    "-e", "GH_TOKEN", "-e", authVar, // Werte kommen aus der Umgebung, nicht aus der Kommandozeile
    "-v", `${dir}:/work`,
    cfg.image,
  ], { GH_TOKEN: ghToken });
  log("job:started", { repo, issue: issue.number, mode, container: name });
}

/** Wertet einen beendeten Container aus und räumt ihn weg. */
async function finish(cfg: Config, c: Container) {
  const dir = jobDir(cfg, c.repo, c.issue);
  let status: { stage?: string; pr?: string } = {};
  try { status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")); } catch {}
  let result: any = {};
  try {
    const lines = readFileSync(join(dir, "claude.jsonl"), "utf8").trim().split("\n");
    result = JSON.parse(lines[lines.length - 1]);
  } catch {}

  const ended = status.stage && ["waiting", "pr", "failed"].includes(status.stage);
  log("job:finished", {
    repo: c.repo, issue: c.issue, exitCode: c.exitCode, stage: status.stage ?? null,
    minutes: result.duration_ms ? Math.round(result.duration_ms / 60000) : null,
    turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null,
  });

  if (!ended) {
    let reason = typeof result.result === "string" ? result.result.slice(0, 1500) : "";
    if (!reason) {
      try { reason = readFileSync(join(dir, "claude.err"), "utf8").slice(-1500); } catch {}
    }
    const issue = JSON.parse(await gh(["issue", "view", String(c.issue), "-R", c.repo, "--json", "number,title,body,url,labels,comments"]));
    await setStage(c.repo, issue, "failed");
    await comment(c.repo, c.issue, "failed",
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
  for (const issue of issues.filter((i) => stageOf(i) === "pr")) {
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
      "--entrypoint", "/factory/preview.sh", cfg.image], { GH_TOKEN: ghToken });
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
  let free = cfg.maxParallel - containers.length;

  for (const repo of cfg.repos) {
    const issues: Issue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", cfg.label, "--state", "open",
      "--json", "number,title,body,url,labels,comments", "--limit", "100"]));
    const openNumbers = new Set(issues.map((i) => i.number));

    // Label entfernt oder Issue geschlossen → laufenden Job stoppen
    for (const c of containers.filter((c) => c.repo === repo && !openNumbers.has(c.issue))) {
      log("job:stopped", { repo, issue: c.issue, reason: "Label entfernt oder Issue geschlossen" });
      await docker(["kill", c.name]).catch(() => {});
    }

    // Abgeschlossene: PR gemergt → Fertig
    const closed: Issue[] = JSON.parse(await gh(["issue", "list", "-R", repo, "--label", "factory:pr", "--state", "closed",
      "--json", "number,title,body,url,labels,comments", "--limit", "20"]));
    for (const issue of [...closed, ...issues.filter((i) => stageOf(i) === "pr")]) {
      if (await findPr(repo, issue.number, "merged")) {
        await setStage(repo, issue, "done");
        await syncBoard(cfg, issue.url, "done");
        rmSync(jobDir(cfg, repo, issue.number), { recursive: true, force: true });
        log("job:done", { repo, issue: issue.number });
      }
    }

    for (const issue of issues) {
      const running = containers.some((c) => c.repo === repo && c.issue === issue.number);
      const stage = stageOf(issue);
      if (stage) await syncBoard(cfg, issue.url, stage);
      if (running || stage === "done") continue;

      let mode: Mode | null = null;
      let prUrl: string | undefined;
      if (!stage) mode = "new";
      // Wartet auf freien Platz (noch nie gestartet) oder Job verloren (z. B. Server-Neustart)
      else if (ACTIVE.has(stage)) mode = issue.comments.some((c) => c.body.includes(MARK)) ? "retry" : "new";
      else if (humanCommentsSinceFactory(issue).length > 0) {
        if (stage === "waiting") mode = "answer";
        else if (stage === "failed") mode = "retry";
        else if (stage === "pr") { prUrl = (await findPr(repo, issue.number, "open"))?.url; if (prUrl) mode = "change-request"; }
      }
      if (!mode) continue;
      if (free <= 0) { if (stage !== "queued") { await setStage(repo, issue, "queued"); await syncBoard(cfg, issue.url, "queued"); } continue; }
      await launch(cfg, repo, issue, mode, prUrl);
      await syncBoard(cfg, issue.url, "queued");
      free--;
    }

    await syncPreviews(cfg, repo, issues).catch((e) => log("preview:error", { repo, error: String(e) }));
  }
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
  log("runner:started", { preview: cfg.preview ? `http://${cfg.preview.host}:4001…` : "aus", containerUid: CONTAINER_UID, repos: cfg.repos, maxParallel: cfg.maxParallel, model: cfg.model, workflow: cfg.workflow });
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
