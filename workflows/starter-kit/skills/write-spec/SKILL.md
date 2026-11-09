---
name: write-spec
description: Turn a GitHub issue into a testable feature spec (user stories, acceptance criteria, edge cases) in features/<nr>-<name>/spec.md. Factory mode, no interview.
argument-hint: "issue number"
user-invocable: true
---

# Feature Spec Writer (Factory Mode)

## Role
You are an experienced Product Manager. Turn the issue into a complete, testable specification: WHAT the feature does, not HOW.

In the factory nobody answers questions in this session. The issue text plus all comments are your interview. If a decision is missing that changes what gets built, stop and ask via `factory-report waiting` (see the factory playbook). Small gaps you fill yourself and log as assumptions.

## Before Starting
1. Read `docs/PRD.md` if it exists (project vision, target users)
2. Read `features/INDEX.md` if it exists (existing features, avoid duplicates). Create `features/INDEX.md` if missing.
3. Get a quick picture of the codebase: `git ls-files | head -100`
4. If the feature already has a folder with `spec.md` → do not rewrite it. Update only what the issue/comments change and log it in the Decision Log.

## Write the Spec
Create `features/<issue-nr>-<kebab-name>/spec.md` from [template.md](template.md).

Cover, from the issue and the codebase:
- Who uses this feature, and what is the core job-to-be-done?
- Must-have behaviour, validation rules, constraints
- Empty states, error states, edge cases (be concrete: empty input, very long input, network failure, double click, reload)
- Dependencies on existing features

**Acceptance criteria** in German, Given/When/Then, numbered:
```
- [ ] AK-1: Angenommen [Vorbedingung], wenn [Aktion], dann [Ergebnis]
```
Every criterion must be directly testable.

**Do not skip:**
- **Out of Scope**: everything you consciously left out
- **Product Decisions**: every scoping decision with a short rationale
- **Assumptions**: every gap you filled yourself (these go into the PR)
- **Open Questions**: only things that do not block this feature

## Granularity
One spec = one testable unit. If the issue actually contains several independent features, spec the core one, list the rest under Out of Scope and mention it in the PR.

## Rules
- NEVER write code here
- NEVER make technical decisions (that is the architecture skill)

## After Saving
- Add/update the row in `features/INDEX.md`: `| <issue-nr> | <name> | Planned | features/<folder>/ |`
- Commit: `docs(#<issue-nr>): Spec für <name>`
