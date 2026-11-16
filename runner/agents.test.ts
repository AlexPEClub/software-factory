// Agent-Auswahl und CLI-Vertrag ohne GitHub-Zugriff, Modellaufrufe oder echte Zugangsdaten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { agentDockerArgs, loadConfig, readAgentResult, redact } from "./main.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-agent-"));
function config(extra = {}) {
  const file = join(tmp(), "config.json");
  writeFileSync(file, JSON.stringify({ repos: [], ...extra }));
  return loadConfig(file);
}

test("alte Konfigurationen bleiben bei Claude; Codex verwendet seinen CLI-Modellstandard", () => {
  assert.equal(config().agent, "claude");
  assert.equal(config().model, "opus");
  assert.equal(config({ agent: "codex" }).model, "");
  assert.equal(config({ agent: "codex", model: "mein-modell" }).model, "mein-modell");
  assert.throws(() => config({ agent: "typo" }), /agent/);
  assert.throws(() => config({ model: 42 }), /model/);
  assert.throws(() => config({ codexAuthDir: "relativ" }), /codexAuthDir/);
});

test("Container bekommen nur den gewählten Login und keine Secret-Werte als Argumente", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "anthropic", CODEX_API_KEY: "codex", OPENAI_API_KEY: "openai" };
  assert.deepEqual(agentDockerArgs(config(), env), ["-e", "AGENT=claude", "-e", "MODEL=opus", "-e", "CLAUDE_CODE_OAUTH_TOKEN"]);
  assert.deepEqual(agentDockerArgs(config(), { ANTHROPIC_API_KEY: "secret" }).slice(-2), ["-e", "ANTHROPIC_API_KEY"]);
  assert.deepEqual(agentDockerArgs(config({ agent: "codex" }), env), ["-e", "AGENT=codex", "-e", "MODEL=", "-e", "CODEX_API_KEY"]);
  assert.deepEqual(agentDockerArgs(config({ agent: "codex" }), { OPENAI_API_KEY: "secret" }).slice(-2), ["-e", "OPENAI_API_KEY"]);
  assert.throws(() => agentDockerArgs(config(), {}), /ANTHROPIC_API_KEY/);
  assert.throws(() => agentDockerArgs(config({ agent: "codex" }), {}), /Codex braucht/);
});

test("ChatGPT-Anmeldung wird schreibbar gemountet und erfordert serielle Läufe", () => {
  const dir = tmp();
  writeFileSync(join(dir, "auth.json"), "{}");
  const cfg = config({ agent: "codex", maxParallel: 1 });
  cfg.codexAuthDir = dir;
  assert.deepEqual(agentDockerArgs(cfg, {}).slice(-2), ["--mount", `type=bind,src=${dir},dst=/home/pwuser/.codex`]);
  assert.throws(() => agentDockerArgs({ ...cfg, maxParallel: 2 }, {}), /maxParallel: 1/);
  // Ein API-Key braucht weder das Login-Verzeichnis noch die Serialisierung.
  assert.equal(agentDockerArgs({ ...cfg, maxParallel: 2 }, { CODEX_API_KEY: "secret" }).includes("--mount"), false);
});

test("Codex-JSONL liefert Ergebnis und Tokens, aber keine erfundenen Kosten oder Claude-Schritte", () => {
  const dir = tmp();
  const usage = { input_tokens: 50, cached_input_tokens: 20, output_tokens: 10 };
  writeFileSync(join(dir, "codex.jsonl"), [
    "abgeschnittener Anfang",
    "null",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fertig" } }),
    JSON.stringify({ type: "turn.completed", usage }),
    "",
  ].join("\n"));
  const result = readAgentResult(dir, "codex");
  assert.equal(result.result, "Fertig");
  assert.equal(result.is_error, false);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.total_cost_usd, undefined);
  assert.equal(result.num_turns, undefined);
  writeFileSync(join(dir, "codex.jsonl"), '{"type":"turn.failed","error":{"message":"Limit erreicht"}}\n');
  assert.equal(readAgentResult(dir, "codex").is_error, true);
  assert.equal(readAgentResult(dir, "codex").result, "Limit erreicht");
  assert.equal(readAgentResult(tmp(), "codex").is_error, true);
  writeFileSync(join(dir, "codex.jsonl"), '{"type":"error","message":"kaputt"}\n');
  assert.equal(readAgentResult(dir, "codex").is_error, true);
});

test("OpenAI-Keys und gespeicherte Login-Tokens werden aus Ausgaben entfernt", () => {
  const text = redact('sk-proj-GEHEIM CODEX_API_KEY=KEY OPENAI_API_KEY=KEY {"access_token":"ACCESS","refresh_token":"REFRESH","id_token":"ID"} eyJabc.def.ghi');
  for (const secret of ["GEHEIM", "=KEY", '"ACCESS"', '"REFRESH"', '"ID"', "eyJabc"]) assert.ok(!text.includes(secret));
});

const HELPER = join(import.meta.dirname, "..", "image", "bin", "factory-agent");
for (const agent of ["claude", "codex"]) {
  test(`factory-agent startet ${agent} mit Playbook, Prompt und Fehlercode`, { skip: process.platform === "win32" }, () => {
    const dir = tmp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2), input:fs.readFileSync(0,'utf8'), key:process.env.CODEX_API_KEY}));
console.log('{"type":"turn.completed"}');
console.error('test stderr');
process.exit(Number(process.env.TEST_EXIT_CODE || 0));
`;
    writeFileSync(join(bin, agent), fakeCli, { mode: 0o755 });
    const playbook = join(dir, "playbook.md");
    const rules = 'Regeln mit "Zitaten", $VAR und\nZeilenumbruch';
    const prompt = 'Auftrag mit "Zitaten" und $(keine-shell-ausfuehren)';
    writeFileSync(playbook, rules);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, AGENT: agent, FACTORY_WORK: dir,
      MODEL: "test-model", WORKFLOW: "starter-kit", OPENAI_API_KEY: "test-key", CODEX_API_KEY: "", CAPTURE: join(dir, "capture.json") };
    for (const exit of [0, 7]) {
      const run = spawnSync("bash", [HELPER, playbook], { input: prompt, encoding: "utf8", env: { ...env, TEST_EXIT_CODE: String(exit) } });
      assert.equal(run.status, exit, run.stderr);
      const captured = JSON.parse(readFileSync(env.CAPTURE, "utf8"));
      const args = captured.args as string[];
      assert.equal(args[args.indexOf("--model") + 1], "test-model");
      if (agent === "codex") {
        assert.equal(args[0], "exec");
        assert.ok(args.includes("--json"));
        assert.equal(JSON.parse(args.find((a) => a.startsWith("developer_instructions="))!.split("=").slice(1).join("=")), rules);
        assert.equal(captured.input, prompt);
        assert.equal(captured.key, "test-key");
        assert.ok(args.includes("shell_environment_policy.ignore_default_excludes=true"));
      } else {
        assert.equal(args[args.indexOf("-p") + 1], prompt);
        assert.equal(args[args.indexOf("--append-system-prompt-file") + 1], playbook);
        assert.ok(args.includes("/factory/workflows/starter-kit"));
      }
      assert.ok(readFileSync(join(dir, `${agent}.jsonl`), "utf8").includes("turn.completed"));
      assert.equal(readFileSync(join(dir, `${agent}.err`), "utf8").trim(), "test stderr");
    }
    const defaults = spawnSync("bash", [HELPER, playbook], { input: prompt, encoding: "utf8", env: { ...env, MODEL: "" } });
    assert.equal(defaults.status, 0, defaults.stderr);
    const args = JSON.parse(readFileSync(env.CAPTURE, "utf8")).args as string[];
    if (agent === "codex") assert.ok(!args.includes("--model"));
    else assert.equal(args[args.indexOf("--model") + 1], "opus");
  });
}

test("factory-agent lehnt unbekannte Agents ab", { skip: process.platform === "win32" }, () => {
  const run = spawnSync("bash", [HELPER, "irrelevant"], { encoding: "utf8", env: { ...process.env, AGENT: "typo" } });
  assert.equal(run.status, 2);
});

test("Skill-Installation erreicht beide Clients und sichert vorhandene Skills", { skip: process.platform === "win32" }, () => {
  const home = tmp();
  mkdirSync(join(home, ".agents", "skills", "init"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "init", "vorhanden"), "behalten");
  const installer = join(import.meta.dirname, "..", "scripts", "install-local-skills.sh");
  for (let i = 0; i < 2; i++) {
    const run = spawnSync("bash", [installer, "both"], { encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(run.status, 0, run.stderr);
    for (const root of [".agents", ".claude"]) {
      for (const skill of ["init", "write-spec", "to-factory"]) {
        assert.ok(readFileSync(join(home, root, "skills", skill, "SKILL.md"), "utf8").includes(`name: ${skill}`));
      }
    }
  }
  // Die Sicherung des ursprünglichen Verzeichnisses bleibt auch nach erneutem Installieren erhalten.
  const backups = readdirSync(join(home, ".agents", "skills")).filter((f) => f.startsWith("init.backup-"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, ".agents", "skills", backups[0], "vorhanden"), "utf8"), "behalten");
});

test("Statistik behandelt unbekannte Codex-Kosten und Schrittzahlen als unbekannt", { skip: process.platform === "win32" }, () => {
  const dir = tmp();
  const file = join(dir, "metrics.jsonl");
  const stats = join(import.meta.dirname, "..", "scripts", "factory-stats.ts");
  const codex = { t: new Date().toISOString(), repo: "a/b", issue: 1, phase: "build", status: "accepting", seconds: 60, turns: null, costUsd: null, agent: "codex" };
  const runStats = () => {
    const run = spawnSync(process.execPath, [stats, "--json"], { encoding: "utf8", env: { ...process.env, FACTORY_METRICS: file } });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  writeFileSync(file, JSON.stringify(codex) + "\n");
  assert.equal(runStats().entwicklung.schnittSchritte, null);
  writeFileSync(file, [codex, { ...codex, agent: "claude", turns: 4, costUsd: 2 }].map((r) => JSON.stringify(r)).join("\n"));
  const summary = runStats();
  assert.equal(summary.entwicklung.schnittSchritte, 4);
  assert.equal(summary.kostenGegenwertUsd, 2);
  assert.equal(summary.laeufeOhneKostenangabe, 1);
});
