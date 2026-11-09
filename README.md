# Software Factory

Eine Software Factory mit Claude Code, die rund um die Uhr auf deinem eigenen Server läuft. Dein Laptop kann dabei zu sein.

Du schreibst ein GitHub Issue und gibst ihm das Label `factory`. Ein Agent übernimmt: prüft das Issue, schreibt eine Spec, plant, entwickelt, testet und öffnet einen Pull Request mit Belegen (Checks, Screenshots, getroffene Annahmen). Ist etwas unklar, fragt er im Issue nach und macht weiter, sobald du antwortest. **Gemergt wird von dir.**

> 🚧 Erste Version, in aktiver Entwicklung.

## So funktioniert es

```
GitHub Issue (Label "factory")
        │
        ▼
Runner auf deinem Server ── prüft jede Minute die Issues
        │
        ▼
Eigener Docker-Container pro Issue
  └─ Claude Code + Playbook + Workflow-Skills
       Triage → Analyse → Umsetzung → Prüfung → Pull Request
        │
        ├─ unklar?  → Frage als Kommentar im Issue, wartet auf dich
        └─ fertig?  → Pull Request mit Checks + Screenshots
                          │
                          ▼
                    Du reviewst und mergst
```

- **Runner** (`runner/`): kleiner Dienst auf dem Server. Holt Issues, startet Container, setzt Labels und Board-Status. Schreibt selbst keinen Code.
- **Job-Image** (`image/`): Claude Code, GitHub CLI, git, Node und Chromium (für Tests und Screenshots).
- **Playbook** (`playbooks/factory.md`): die festen Regeln für jeden Lauf. Stages melden, bei Unklarheit fragen statt raten, Pflicht-Checks, nie selbst mergen.
- **Workflow** (`workflows/starter-kit/`): wie entwickelt wird. Standard ist der Workflow aus dem [AI Coding Starter Kit](https://github.com/AlexPEClub/ai-coding-starter-kit): `write-spec → architecture → build → qa`, mit getrennten Dateien pro Feature (`spec.md`, `design.md`, `qa-report.md`). Austauschbar, siehe [workflow.md](workflows/starter-kit/workflow.md).

## Voraussetzungen

- Ein Linux-Server mit Ubuntu 24.04, mindestens 2 vCPU und 8 GB RAM
- Ein Claude-Abo (Pro, Max, Team oder Enterprise) **oder** ein Anthropic-API-Key
- Ein GitHub-Account

## Schnellstart

```bash
git clone https://github.com/AlexPEClub/software-factory.git /opt/software-factory
cd /opt/software-factory
./setup.sh
```

Danach:
1. **Claude-Login:** auf deinem Rechner `claude setup-token` ausführen und den Token als `CLAUDE_CODE_OAUTH_TOKEN=...` in `/etc/software-factory/secrets.env` eintragen
2. **GitHub-Login** auf dem Server: `gh auth login -s project`
3. **Repo anbinden:** `./scripts/add-repo.sh dein-name/dein-repo`
4. `systemctl restart software-factory`
5. Ein Issue mit Label `factory` anlegen

Die ausführliche Schritt-für-Schritt-Anleitung (inkl. Server bei Hostinger) folgt in `docs/`.

## Das Ziel-Repo

Die Factory liest `.factory/setup.json` im Ziel-Repo:

```json
{
  "install": "npm ci",
  "dev": "npm run dev -- -p $PORT",
  "checks": {
    "lint": "npm run lint",
    "typecheck": "npx tsc --noEmit",
    "test": "npm test",
    "build": "npm run build"
  }
}
```

Fehlt die Datei, legt der Agent sie beim ersten Lauf an.

## Claude-Abo: was ist erlaubt?

Die Factory startet die **unveränderte, offizielle Claude Code CLI** auf deinem eigenen Server. Angemeldet wird mit deinem eigenen Abo über `claude setup-token`, den Weg, den Anthropic für Skripte und CI dokumentiert ([Authentication](https://code.claude.com/docs/en/authentication)). Das Repo speichert oder teilt keine fremden Logins.

- Abo-Limits gelten für die Factory und deine normale Claude-Nutzung zusammen. Starte mit `maxParallel: 1–2`.
- Für Teams oder wenn du die Factory als Dienst für andere betreibst: `ANTHROPIC_API_KEY` verwenden ([Legal and Compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- Stand: November 2026. Anthropic kann die Regeln ändern, prüf die verlinkte Doku.

## Lizenz

MIT
