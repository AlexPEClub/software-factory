# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A self-hosted "software factory": a long-running runner on a Linux VPS (Ubuntu 24.04) polls GitHub issues labelled `factory` and, per issue, starts a Docker container that runs the unmodified Claude Code CLI headless (`claude -p … --dangerously-skip-permissions`) to check, build, and independently accept the work, ending in a PR that a human merges. The runner itself never writes code.

All user-facing text (issue comments, labels, board columns, docs, logs) is **German**. Keep new strings German.

## Commands

- Runner tests (no GitHub, Docker, or tokens needed; Node 22.6+ runs `.ts` directly):
  `node --test runner/main.test.ts`
  Single test: `node --test --test-name-pattern="readJobFile" runner/main.test.ts`
  Some tests use `mkfifo`/symlinks, so they need a POSIX system (Linux/macOS/WSL), not native Windows.
- Runner in production runs under **Bun** (`Bun.spawn`, `Bun.sleep`): `bun runner/main.ts` (one tick only: `--once`). Config path comes from `FACTORY_CONFIG`, default `/etc/software-factory/config.json`. It needs `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.
- Build the job image from the repo root (the Dockerfile copies `image/`, `playbooks/`, `workflows/`): `docker build -f image/Dockerfile -t software-factory-job:latest .`
- Server setup (idempotent, as root): `./setup.sh`. It installs Bun, the `factory-stats`/`factory-improve` wrappers, and the systemd unit from `deploy/software-factory.service`.
- Local (developer machine): `./scripts/install-local-skills.sh` symlinks `local-skills/*` into `~/.claude/skills`; `./scripts/new-project.sh <name>` and `./scripts/add-repo.sh owner/repo` connect target repos.

## Architecture

**Runner (`runner/main.ts`, single file).** Each `tick()`: finish/timeout exited containers → count free slots (`maxParallel`, a single shared pool across all phases, repos, and the improve run) → `tickRepo()` per repo → optional improve run. State lives almost entirely in GitHub:
- Issue status = one label `factory:<status>` (keys of `STATUS`: new, checking, question, rejected, approved, working, accepting, review, done, failed), mirrored to a GitHub Projects board column (+ a "Schritt" field for the build sub-step). `LEGACY` maps old label names.
- Factory comments carry hidden markers `<!-- software-factory:<status>[:<phase>] -->`. Markers only count when authored by the factory's own GitHub login (`isFactoryComment`). The next action is derived from the current label + last marker + whether a trusted human commented since (`humanCommentsSinceFactory`).
- Only the factory login and `allowedUsers` are trusted. Untrusted comments are replaced with a placeholder in the prompt (`buildPrompt`).
- Local runner-only state: `dataDir` (`/var/lib/software-factory`) holds `jobs/`, `scenarios/`, `state/` (lost-job retry counter), `runs/` (per-run summaries for the improve run), and `metrics.jsonl` (read by `scripts/factory-stats.ts`).

**Three phases, separate containers** (`Phase` = check | build | accept; `Mode` = new | answer | change-request | retry | rework):
- `check`: validates spec/bug, writes acceptance scenarios to `/scenarios` (mounted rw only here).
- `build`: never sees scenarios. Result is accepted only if `verify.json` is green **for the exact pushed head SHA** of `factory/<issue>` and the PR does not touch `features/*/spec.md` (`checkBuild`).
- `accept`: independent agent, scenarios mounted read-only; can send back (`rework`) up to `maxReworks` times, then the last round may only end `accepted` or `unresolved`.

**Runner ↔ container contract.** The runner writes `/work/prompt.md`. The agent reports via `image/bin/factory-report`, which writes `/work/status.json`; `factory-verify` runs the target repo's `.factory/setup.json` checks into `/work/verify.json` + `verify.md`. The runner reads `claude.jsonl` (stream-json) for the result/cost. Job dirs are agent-controlled, so the runner (root) reads/writes them only via `readJobFile`/`writeJobFile` (`O_NOFOLLOW`, regular files only). Anything posted to GitHub goes through `redact()`. Keep these invariants; `main.test.ts` covers them.

**Job image (`image/`).** Playwright base + gh + Claude Code + uv. `entrypoint.sh` installs the workflow's skills as user skills, clones/checks out `factory/<issue>`, runs `.factory/setup.json` `install` (not in check phase), then runs Claude with `playbooks/factory.md` as the appended system prompt. A target repo can add `.factory/Dockerfile` on top of the base image (`imageFor` builds and caches it by file SHA + base image ID). `preview.sh` serves per-PR previews behind a Caddy basic-auth proxy (ports 4000+slot external, 5000+slot internal), started without credentials. `improve.sh` + `playbooks/improve.md` analyse past runs and open a PR against `factoryRepo`.

**Behaviour lives in Markdown, not code.** Agent rules: `playbooks/factory.md` (phase steps, `factory-report` states, never merge, never edit the spec, ask instead of guessing). Development method: `workflows/<name>/` (`workflow.md` + `skills/` + `stacks/`), selected by `workflow` in the config; default `starter-kit` (architecture → build → qa, files under `features/<ID>/{spec,design,qa-report}.md`). When changing allowed end states or report commands, keep `playbooks/factory.md`, `image/bin/factory-report`, and `endStates` in `finish()` consistent.

**Local skills (`local-skills/`)** run on the developer's machine, not the server: `init` (set up a target repo incl. `.factory/setup.json` and `docs/stack.md`), `write-spec`, `to-factory` (creates the `factory` issue with a `Spec: features/…/spec.md` line, which the check phase requires).
