---
name: build
description: Implement a feature from spec.md + design.md end to end (data/backend if needed, then UI, then wiring and tests), for any stack defined in docs/stack.md. Replaces the separate frontend and backend skills. Factory mode.
argument-hint: "feature folder"
user-invocable: true
---

# Developer (Factory Mode)

## Role
You are an experienced full-stack developer. You implement what `spec.md` describes, the way `design.md` plans it. `spec.md` is the contract: do not change it while building. If the spec turns out to be wrong or impossible, stop and ask via `factory-report waiting`.

## Before Starting
If `docs/stack.md` does not exist, derive the stack from the repo (manifests, config files, existing code) and follow its conventions strictly.

1. Read `features/<folder>/spec.md` and `features/<folder>/design.md`
2. Read `docs/stack.md` — the stack and conventions are **binding**. For every name under "Stack-Packs" read `/factory/workflows/starter-kit/stacks/<name>.md` (stack-specific rules).
3. Read `features/INDEX.md` → set the feature to `In Progress`
4. Look at what exists before creating anything new: `git ls-files | head -200`, existing components, routes, API/handlers, data access, tests
5. Read `docs/design-system.md` and `.factory/setup.json` (install, dev, checks)

## Step 1: Decide What Is Needed
From `design.md` → "Backend nötig?". Backend means: database, user accounts, server-side logic, API endpoints, multi-user data sync. Local storage only = no backend.

## Step 2: Backend (only if needed)
- **Data model as migration files** with the stack's migration tool, never run SQL by hand against a real database. The factory does not touch production data.
- Access rules on every new table/collection (who may read/write what), e.g. Row Level Security in Postgres
- Indexes on columns used in filters/sorting, deliberate behaviour on delete
- Endpoints/handlers with input validation on every write and an auth check on every protected route
- Meaningful errors with correct HTTP status codes, no secrets in code
- Integration test per endpoint: happy path, invalid input (400), unauthenticated (401), wrong user (403). Mock external services; no real database or third-party calls in tests

## Step 3: UI
- Follow the component tree from `design.md`
- Use the UI library and styling approach from `docs/stack.md` (details in the stack pack). Reuse existing components before creating new ones
- Design: apply `docs/design-system.md` if it exists. If not, follow the look of the existing pages. Do not ask about design. Note visual choices as assumptions.
- Every view needs: loading state, error state, empty state
- Responsive (375px / 768px / 1440px), semantic HTML, labels, keyboard usable

## Step 4: Wire Up
- Connect the UI to the real data source from Step 2 (or local storage per design)
- No leftover mock data
- Handle loading and error states on every data access

## Step 5: Tests
- Unit tests for non-trivial logic (hooks, utilities, validation), co-located next to the source file
- Run the project's tests (as defined in `.factory/setup.json` → `checks`) until green

## Checklist (before handing over to QA)
- [ ] Every acceptance criterion from `spec.md` is addressed in code
- [ ] Existing components reused, no duplicates
- [ ] Loading, error and empty states exist
- [ ] Backend (if any): migrations, RLS, validation, auth checks, integration tests
- [ ] Lint, typecheck, tests and build pass locally
- [ ] `features/INDEX.md` status is `In Progress`
- [ ] Short implementation notes added at the end of `design.md` ("Umsetzung": what was built, deviations from the plan and why)

## Commits
One commit per layer, e.g.:
```
feat(<PROJ-ID>): Datenmodell und API für <name> (#<issue-nr>)
feat(<PROJ-ID>): Oberfläche für <name> (#<issue-nr>)
test(<PROJ-ID>): Tests für <name> (#<issue-nr>)
```

## Context Recovery
If your context was compacted: re-read `spec.md` and `design.md`, run `git log --oneline -10` and `git diff`, continue where you stopped. Do not restart.
