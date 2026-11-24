---
name: to-factory
description: Hand an approved feature spec to the Software Factory by creating a GitHub issue with the factory label that points to the spec. Use after /write-spec, once the spec is committed and pushed.
argument-hint: "PROJ-X"
user-invocable: true
disable-model-invocation: true
---

# Hand Over to the Software Factory

Hands a finished spec, approved by the human, to the Software Factory.

**Language:** the issue is written in the project language (`.factory/setup.json` → `language`, `de` if missing). Talk to the user in the language they write in.

## Steps

1. **Find the spec:** `ls -d features/<PROJ-X>-*/` → it must contain `spec.md`. If there is none, stop: tell the user there is no spec for <PROJ-X> yet and to run `/write-spec` first.

2. **Check that the spec is on GitHub.** The factory reads it from the default branch, not from your machine.
   - Default branch: `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`
   - `git fetch origin` and check that `spec.md` is identical on `origin/<default-branch>`: `git diff --quiet origin/<default-branch> -- features/<folder>/spec.md`
   - If it is changed locally, not committed or not pushed: tell the user what is missing and ask whether you should commit and push. Never push without asking.

3. **Avoid a duplicate handover:** `gh issue list --label factory --state open --search "<PROJ-X> in:title" --json number,title`. If there is already an open issue, show its link and stop.

4. **Create the issue:**
   - Title: `<PROJ-X>: <feature name from the spec>`
   - Label: `factory`
   - Body in the project language. The first line `Spec: …` stays exactly like this in every language, the factory looks for it:
     ```
     Spec: features/<folder>/spec.md

     <one sentence on what it is about, from the user stories>

     **<"Acceptance criteria (short)" in the project language>:**
     - <ID>: …
     - <ID>: …

     _<"The spec is the contract. The factory builds against it and asks here if anything is unclear." in the project language>_
     ```
     Use the criterion IDs exactly as in the spec (`AK-1` in German specs, `AC-1` otherwise). German example:
     ```
     Spec: features/PROJ-3-genre-sortierung/spec.md

     Nutzer können ihre Bibliothek nach Genre sortieren.

     **Akzeptanzkriterien (Kurzfassung):**
     - AK-1: …

     _Die Spec ist der Vertrag. Die Factory baut danach und meldet sich hier bei Fragen._
     ```
   - Command: `gh issue create --label factory --title "…" --body-file <file>`
   - Do **not** change `features/INDEX.md` here. From now on the factory maintains the status in its branch.

5. **Report back to the user:** the issue link and that the factory picks it up within a minute. Progress is visible via the labels on the issue and the board.
