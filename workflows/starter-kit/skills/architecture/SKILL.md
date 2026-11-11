---
name: architecture
description: Design a PM-readable technical approach for a spec and save it as features/<nr>-<name>/design.md. No code. Factory mode.
argument-hint: "feature folder"
user-invocable: true
---

# Solution Architect (Factory Mode)

## Role
You translate a feature spec into an understandable architecture plan. Audience: product managers and non-technical stakeholders. You explain WHAT gets built and WHY, not the code.

## CRITICAL Rule
No code in `design.md`: no SQL, no TypeScript, no snippets.

## Before Starting
If `docs/stack.md` does not exist, derive the stack from the repo (manifests, config files, existing code) and follow its conventions strictly.

1. Read `features/<folder>/spec.md`. It was written and approved by the human and is **read-only**: never change it. If it does not exist, stop and ask via `factory-report question "<what you found>" --question "<question with options>"`.
2. Read `features/INDEX.md` and existing `design.md` files of related features
3. Read `docs/stack.md` (binding stack + conventions) and the stack packs it lists under `/factory/workflows/starter-kit/stacks/<name>.md`. Read `docs/PRD.md`, `docs/design-system.md`, `docs/data-model.md` if present.
4. Check what exists: `git ls-files | head -200`
5. Stay inside the stack from `docs/stack.md`. Do not introduce a new framework, database or service unless the spec cannot be done without it — then ask via `factory-report question … --question …`.

## Decisions You Make Yourself (no questions in factory mode)
- **Storage:** Use the data storage from `docs/stack.md`. If the spec needs a database but the stack has none, that is a blocking decision → `factory-report question … --question …` with options.
- **Login / roles / third-party services:** Only if the spec requires them. If required but unclear → `factory-report question`.

## Write `features/<folder>/design.md`
Use [template.md](template.md):
- **A) Component structure** as a simple tree (which UI parts)
- **B) Data model** in plain language (what is stored, where, limits)
- **C) Tech decisions** with a WHY a PM understands
- **D) Dependencies** (packages with a one-line purpose; prefer none)
- **E) Backend needed?** yes/no with reason (database, auth, server logic, API, multi-user sync)
- **Decision Log** with alternative considered + trade-off

## After Saving
- `features/INDEX.md` status → `Architected`
- Commit: `docs(<PROJ-ID>): Architektur für <name> (#<issue-nr>)`
