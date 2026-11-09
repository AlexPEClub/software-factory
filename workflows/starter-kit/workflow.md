# Workflow: Starter Kit

Basiert auf dem [AI Coding Starter Kit](https://github.com/AlexPEClub/ai-coding-starter-kit) von Alex Sprogis, angepasst für den unbeaufsichtigten Factory-Betrieb.

## Ablage

Pro Feature ein Ordner, Spec, Architektur und Testbericht getrennt:

```
features/
  INDEX.md                     Übersicht aller Features + Status
  <nummer>-<kurzname>/
    spec.md                    WAS: User Stories, Akzeptanzkriterien, Edge Cases (Vertrag)
    design.md                  WIE: Komponenten, Datenmodell, Tech-Entscheidungen
    qa-report.md               ERGEBNIS: Testlauf gegen die Akzeptanzkriterien
```

`<nummer>` ist die Issue-Nummer, z. B. `features/12-favoriten/`. Fehlt `features/`, legst du es an.

## Zuordnung zu den Factory-Stages

- **Feature**
  - `investigating` → Skill `write-spec` (aus dem Issue, ohne Interview) → Skill `architecture`
  - `implementing` → Skill `build`
  - `verifying` → Skill `qa`
- **Bug**
  - `investigating` → reproduzieren, roten Test schreiben (keine Spec nötig)
  - `implementing` → Fix
  - `verifying` → Skill `qa` im Bug-Modus (nur betroffene Kriterien + Regression), kein eigener Feature-Ordner nötig

## Status in `features/INDEX.md`

`Planned` (Spec fertig) → `Architected` (Design fertig) → `In Progress` (Build) → `In Review` (QA läuft) → `Approved` (QA bestanden)

## Einen anderen Workflow verwenden

Die Factory ist nicht an diesen Workflow gebunden. Ein Workflow ist ein Ordner unter `workflows/<name>/` mit
- `workflow.md`: welcher Skill in welcher Stage läuft und wo Ergebnisse abgelegt werden
- `skills/`: die Skills (werden im Job-Container als Nutzer-Skills installiert)

Das Playbook (`playbooks/factory.md`) bleibt gleich: Stages melden, bei Unklarheit fragen, Checks, PR. Auswahl über `workflow` in der Factory-Config.
