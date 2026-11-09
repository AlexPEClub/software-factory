# Workflow: Starter Kit

Basiert auf dem [AI Coding Starter Kit](https://github.com/AlexPEClub/ai-coding-starter-kit) von Alex Sprogis, angepasst für die Factory.

## Aufgabenteilung

- **Du (lokal mit Claude Code):** Spec schreiben mit `/write-spec` (Interview), prüfen, auf den Standard-Branch pushen, mit `/to-factory` an die Factory übergeben. Die Spec ist die Basis für alles und wird von dir abgenommen.
- **Factory (auf dem Server):** Architektur, Umsetzung, QA, Pull Request.
- **Du:** Pull Request prüfen und mergen.

Die lokalen Skills liegen unter `local-skills/` im Factory-Repo. Kopiere sie in `.claude/skills/` deines Projekts.

## Ablage

Pro Feature ein Ordner, Spec, Architektur und Testbericht getrennt:

```
features/
  INDEX.md                         Übersicht aller Features + Status + nächste freie ID
  PROJ-3-genre-sortierung/
    spec.md                        WAS: User Stories, Akzeptanzkriterien, Edge Cases (Vertrag, von dir)
    design.md                      WIE: Komponenten, Datenmodell, Tech-Entscheidungen (Factory)
    qa-report.md                   ERGEBNIS: Testlauf gegen die Akzeptanzkriterien (Factory)
```

## Zuordnung zu den Factory-Stages

- **Feature** (Issue enthält `Spec: features/<ordner>/spec.md`)
  - `triage` → Spec lesen und auf Testbarkeit prüfen, nicht verändern
  - `investigating` → Skill `architecture` → `design.md`
  - `implementing` → Skill `build`
  - `verifying` → Skill `qa` → `qa-report.md`
- **Feature ohne Spec** → die Factory baut nicht, sondern bittet im Issue um eine Spec
- **Bug** (keine Spec nötig)
  - `investigating` → reproduzieren, roten Test schreiben
  - `implementing` → Fix
  - `verifying` → Skill `qa` im Bug-Modus

## Status in `features/INDEX.md`

`Planned` (Spec fertig, von dir) → `Architected` → `In Progress` → `In Review` → `Approved` (QA bestanden)

## Einen anderen Workflow verwenden

Die Factory ist nicht an diesen Workflow gebunden. Ein Workflow ist ein Ordner unter `workflows/<name>/` mit
- `workflow.md`: welcher Skill in welcher Stage läuft und wo Ergebnisse abgelegt werden
- `skills/`: die Skills (werden im Job-Container als Nutzer-Skills installiert)

Das Playbook (`playbooks/factory.md`) bleibt gleich: Stages melden, bei Unklarheit fragen, Checks, PR. Auswahl über `workflow` in der Factory-Config.
