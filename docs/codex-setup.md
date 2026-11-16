# Claude Code oder Codex auswählen

Die Factory kann alle Phasen mit der offiziellen Claude-Code-CLI oder der offiziellen Codex-CLI ausführen: Prüfung, Bau, Abnahme und Verbesserungsläufe. Die Auswahl gilt für die gesamte Factory. Ohne `agent` bleibt das bisherige Verhalten erhalten: Claude Code mit Modell `opus`.

## Codex mit eurem ChatGPT-Konto

Nach der normalen Serverinstallation mit `./setup.sh` diese Werte in `/etc/software-factory/config.json` setzen; die übrigen Einstellungen bleiben erhalten:

```json
{
  "agent": "codex",
  "model": "",
  "maxParallel": 1,
  "codexAuthDir": "/etc/software-factory/codex"
}
```

`model: ""` verwendet die Modellauswahl der Codex-CLI. Alternativ eine Modell-ID eintragen, auf die euer Konto zugreifen kann. Beim Wechsel von Claude unbedingt `opus` entfernen; Claude-Modellnamen funktionieren bei Codex nicht.

Auf dem Server als root einen eigenen Login für die Factory einrichten:

```bash
JOB_UID=$(docker run --rm --entrypoint id software-factory-job:latest -u)
install -d -m 700 -o "$JOB_UID" -g "$JOB_UID" /etc/software-factory/codex
docker run --rm -it \
  --mount type=bind,src=/etc/software-factory/codex,dst=/home/pwuser/.codex \
  --entrypoint codex software-factory-job:latest \
  -c 'cli_auth_credentials_store="file"' login --device-auth
```

Die CLI zeigt einen Link und einen Code. Den Link auf eurem Rechner öffnen und mit dem ChatGPT-Konto anmelden. Device-Code-Anmeldung muss für euer Konto bzw. euren Workspace freigeschaltet sein. Falls sie nicht verfügbar ist, beschreibt die [OpenAI-Anmeldedokumentation](https://learn.chatgpt.com/docs/auth#login-on-a-headless-device) den Login über SSH-Portweiterleitung.

Das Verzeichnis bleibt zwischen den Jobs erhalten, damit Codex `auth.json` selbst erneuern kann. Die Factory verlangt dafür `maxParallel: 1`. Diesen Login ausschließlich für diese Factory verwenden; keine parallel verwendete Anmeldung vom Arbeitsplatz kopieren. Die Datei enthält Zugangsdaten und gehört weder ins Repository noch in Logs. Diese Variante ist für eigene vertrauenswürdige, private Projekte vorgesehen. Für öffentliche Projekte API-Key-Anmeldung verwenden; bei beiden Varianten nur vertrauenswürdigen Repository-Code ausführen. Siehe [OpenAI: Account-Anmeldung in Automatisierungen](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

Vorhandene `CODEX_API_KEY`- oder `OPENAI_API_KEY`-Einträge aus `secrets.env` entfernen, wenn die Factory über das ChatGPT-Konto laufen soll: Ein API-Key hat Vorrang vor dem gespeicherten Login.

Danach GitHub wie gewohnt mit `gh auth login -s project` anmelden, das Ziel-Repo anbinden und starten:

```bash
systemctl restart software-factory
journalctl -u software-factory -f
```

Die Nutzung zählt gegen die Limits des angemeldeten Kontos. Ein abgelaufener oder widerrufener Login kann eine erneute Anmeldung mit dem obigen Befehl erfordern; dafür den Dienst vorher mit `systemctl stop software-factory` stoppen und laufende Jobs auslaufen lassen. Anschließend den Dienst wieder starten.

## Codex mit API-Key

In `config.json` `agent: "codex"` und `model: ""` setzen. `codexAuthDir` ist nicht nötig; mehrere Jobs dürfen parallel laufen. Den Key als `CODEX_API_KEY=...` in `/etc/software-factory/secrets.env` eintragen (`chmod 600`). Alternativ wird `OPENAI_API_KEY` akzeptiert; bei beiden gewinnt `CODEX_API_KEY`. Anschließend den Dienst neu starten.

API-Nutzung wird separat über das OpenAI-Platform-Konto abgerechnet. Siehe [OpenAI: Anmeldung](https://learn.chatgpt.com/docs/auth) und [nicht interaktive Ausführung](https://learn.chatgpt.com/docs/non-interactive-mode).

## Zurück zu Claude Code

```json
{
  "agent": "claude",
  "model": "opus"
}
```

`CLAUDE_CODE_OAUTH_TOKEN` oder `ANTHROPIC_API_KEY` wie in der [Serveranleitung](hostinger-vps-setup.md#4-claude-anmelden) hinterlegen. Das Codex-Login-Verzeichnis wird bei Claude-Jobs nicht eingebunden. Bei einem Wechsel laufende Jobs zunächst beenden lassen; deren Auswertung verwendet weiterhin den Agent, mit dem sie gestartet wurden. Eine reine Änderung an `config.json` wird automatisch eingelesen; nach Änderungen an `secrets.env` den Dienst neu starten.

## Lokale Skills mit Codex

Auf eurem Rechner im Factory-Repo ausführen (unter Windows in Git Bash oder WSL):

```bash
./scripts/install-local-skills.sh codex
# Oder für beide Programme:
./scripts/install-local-skills.sh both
```

Codex lädt die Verknüpfungen unter `~/.agents/skills/`. Im Projekt `$init`, `$write-spec` und `$to-factory` verwenden oder über `/skills` auswählen. `$init` ist der Factory-Skill; Codex' eingebautes `/init` hat eine andere Aufgabe. Claude verwendet weiterhin `/init`, `/write-spec` und `/to-factory`. Die Skills teilen sich dieselben Quellen in `local-skills/`; Updates kommen über `git pull`.

## Bestehende Installation aktualisieren und prüfen

```bash
git pull --ff-only
docker build -t software-factory-job:latest -f image/Dockerfile .
systemctl restart software-factory
```

Projektspezifische `.factory/Dockerfile`-Images baut der Runner nach einer Änderung des Basis-Images automatisch neu. Sie müssen weiterhin auf dem Factory-Image aufbauen, damit `factory-agent` und beide CLIs enthalten sind.

Tests unter Linux mit Node 22.18+, Bash, git und jq, ohne Modellaufrufe oder Tokens:

```bash
node --test runner/*.test.ts
```

Logs liegen pro Job unter `/var/lib/software-factory/jobs/<owner>__<repo>__<issue>/`: `claude.jsonl`/`claude.err` oder `codex.jsonl`/`codex.err`. Metriken speichern den Agent und bei Codex die gemeldeten Tokens. Codex liefert keinen USD-Preis und keine mit Claude vergleichbare Schrittzahl; diese Werte bleiben unbekannt. `factory-stats` weist Läufe ohne Kostenangabe gesondert aus.

Beide CLIs dürfen innerhalb des isolierten Job-Containers entwickeln, Tests ausführen und auf GitHub zugreifen. Die bestehenden Pflicht-Checks, Spec-Schutz und menschliche PR-Freigabe gelten für beide Agents.
