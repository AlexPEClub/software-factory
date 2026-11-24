# Vorschlag: Betriebskonventionen für Factory-Projekte

> Status: **Entwurf zur Abstimmung** · Stand: 24.11.2026
> Betrifft: `/init`, Playbook, Job-Image, Runner, `add-repo.sh`, neues Repo `factory-pipelines`, später die Factory selbst

## Kurzfassung

Jedes neue Factory-Projekt bekommt von Anfang an denselben, erprobten Betriebsrahmen: CI/CD mit GitHub Actions, Secrets aus Infisical statt `.env`-Dateien, verschlüsselte Backups nach S3 mit automatischem Restore-Test, einen Health-Check-Standard, zentrale Logs und Dashboards in Grafana und Alarme als GitHub Issues. Alles davon ist über eine einzige Datei `.factory/delivery.json` konfigurierbar und abschaltbar.

`/init` bestätigt die Konventionen im Interview, empfiehlt eine Orchestrierungs-Stufe (Compose, Kamal oder k3s) und erzeugt die ersten Specs für die Factory: erst eine Lückenprüfung, dann die Pipelines für test, staging und production, dann Backup, Health und Observability. Danach kommen die Produkt-Features.

Die Umsetzung erfolgt in zwei Phasen: Phase 1 baut die Konventionen für Projekte, Phase 2 stellt die Factory selbst darauf um (GitHub App, Secrets aus Infisical, Rollout per CI).

## 1. Ziele

| # | Ziel | Wie die Konvention es erreicht |
|---|---|---|
| 1 | Kaum manuelle Arbeit auf Servern | Server entstehen per cloud-init, Deployments, Backups und Restores laufen über GitHub Actions bzw. systemd-Timer. SSH ist für Menschen die Ausnahme, nicht der Weg. |
| 2 | Einheitliche Secrets ohne `.env` | Infisical Cloud EU für alle Projekte, Umgebungen und die Factory. Pro Host genau eine verschlüsselte Maschinen-Identität, alles andere liegt nur im Arbeitsspeicher (tmpfs). CI nutzt GitHub OIDC und speichert gar keine Secrets. |
| 3 | Robuste, modulare, konfigurierbare Pipelines | Wiederverwendbare Workflows in einem versionierten Repo, im Projekt nur ein kurzer Aufruf plus `.factory/delivery.json`. Logik in Standardwerkzeugen, keine langen Bash-Skripte. Pipeline-Schalter und Feature-Flags in der App. |
| 4 | Backup und Restore | restic verschlüsselt nach S3 (anbieterunabhängig), täglich und vor jedem Produktions-Deploy, wöchentlicher automatischer Restore-Test, Restore als ein Workflow-Aufruf. |
| 5 | Health-Check jeder Komponente | `/livez`, `/readyz`, geschütztes `/health` mit Status pro Komponente. Genutzt von Orchestrierung, Deploy-Gate (mit automatischem Rollback) und Watchdog. |
| 6 | Einfache Observability | Grafana, Loki und Prometheus zentral auf dem Factory-Server, Grafana Alloy auf jedem Host. |
| 7 | GitHub Actions als Standard | Alle Pipelines sind GitHub Actions. Andere CI-Systeme bleiben möglich, sind aber nicht Teil der Vorlagen. |

**Grundsätze**

- **Konvention vor Konfiguration:** Ohne Angaben gilt der Standard. Jede Abweichung steht in `.factory/delivery.json` und wird in `docs/operations.md` begründet.
- **Ein Image, viele Umgebungen:** Gebaut wird einmal. staging und production bekommen denselben Image-Digest, nur Konfiguration und Secrets unterscheiden sich.
- **Gemergt und freigegeben wird vom Menschen:** Die Factory merged nie, Production braucht immer eine Freigabe.
- **Die Factory sieht nie Produktions-Secrets oder -Daten.**

## 2. Entscheidungen im Überblick

| Thema | Standard | Konfigurierbar über |
|---|---|---|
| Umgebungen | test (nur in CI), staging (automatisch ab `main`), production (Freigabe) | `environments` |
| Ort der Umgebungen | pro Projekt; Vorschlag von `/init`: staging auf dem Factory-Server, production auf eigener VM | `docs/operations.md`, Infisical (`DEPLOY_HOST`) |
| Server bereitstellen | cloud-init; OpenTofu optional | `provisioning` |
| Production-Auslöser | Freigabe an der GitHub-Umgebung `production` | `environments.production.approval` |
| Secrets | Infisical Cloud EU, OIDC für CI, eine Bootstrap-Identität pro Host | – |
| GitHub-Zugriff der Factory | GitHub App (Phase 2) | – |
| Pipelines | Repo `factory-pipelines` (öffentlich), Tags, Renovate | `pipelines` (Version) |
| Registry | GHCR | `image` |
| Orchestrierung | Compose + Caddy, Kamal oder k3s + Helm + Argo CD (alle mit Vorlagen); verwaltetes Kubernetes nur dokumentiert | `tier` |
| Datenbank | selbst betriebenes Postgres; Supabase optional | `state` |
| Backup | restic nach S3, täglich + vor Produktions-Deploy, 7/4/12, wöchentlicher Restore-Test, PITR (WAL-G) optional | `backup`, `state[].pitr` |
| S3-Anbieter | anbieterunabhängig (Endpoint, Bucket, Schlüssel aus Infisical) | Infisical |
| Backup-Schlüssel | in Infisical plus Offline-Kopie | – |
| Daten in staging | pro Projekt: synthetische Seeds (Standard) oder anonymisierte Produktionskopie | `environments.staging.data` |
| Observability | zentral auf dem Factory-Server, für production standardmäßig an | `observability` |
| Alarme | GitHub Issue mit Label `incident`, nie automatisch an die Factory | – |
| Watchdog | healthchecks.io (Empfehlung), optional GitHub-Actions-Probe mit einstellbarem Intervall, optional externer HTTP-Check | `watchdog` |
| Health | `/livez`, `/readyz`, geschütztes `/health` | `health` |
| Feature-Flags | OpenFeature + flagd mit Flag-Datei im Repo | `flags` |

## 3. Überblick

```
                    ┌──────────────── GitHub ────────────────┐
  Factory-PR ──────▶│ delivery.yml (Aufruf) ──▶ factory-pipelines@v1
                    │   ci: checks · image · e2e (test)        │
                    │   deploy: staging (auto) ─▶ production (Freigabe)
                    │   backup-restore · watchdog-probe         │
                    └──────┬───────────────┬──────────────────┘
                 OIDC      │               │ SSH (Forced Command) bzw. GitOps
                           ▼               ▼
                   ┌─────────────┐   ┌──────────────────────────────────────┐
                   │ Infisical EU│◀──│ Hosts: Factory-Server · Prod-VM · k3s │
                   └─────────────┘   │  Infisical Agent → /run/secrets       │
                                     │  App-Container · Backup-Timer · Alloy │
                                     └───────┬─────────────┬────────────────┘
                                  restic     │             │ Logs/Metriken
                                             ▼             ▼
                                     ┌─────────────┐  ┌───────────────────────────┐
                                     │ S3-Bucket   │  │ Factory-Server:           │
                                     └─────────────┘  │ Grafana · Loki · Prometheus│
                                                      │ Runner: Incident-Intake    │
                                                      └───────────┬───────────────┘
                     healthchecks.io ◀── Heartbeats ── Hosts       │
                            └──────── API-Abfrage ─────────────────┘──▶ Issue „incident“
```

## 4. Umgebungen und Promotion

- **test** existiert nur in CI: Das gebaute Image läuft mit Wegwerf-Diensten (Postgres usw. aus `deploy/compose.test.yml`) im Actions-Runner, die E2E-Tests laufen gegen genau dieses Image. Läuft bei jedem PR, auch bei denen der Factory. Die bestehenden PR-Vorschauen der Factory bleiben unverändert.
- **staging** wird bei jedem Push auf `main` automatisch mit dem Image-Digest aus CI ausgerollt.
- **production** bekommt denselben Digest, nachdem staging inklusive Health-Gate grün ist und du an der GitHub-Umgebung `production` freigibst.
- **Rollback:** Schlägt das Health-Gate nach einem Deploy fehl, rollt die Pipeline automatisch auf den vorherigen Digest zurück und meldet das im PR bzw. als Issue mit Label `deploy-failed`. Manuell: Workflow `deploy` mit älterem Digest starten.
- **Datenbank-Migrationen** laufen als eigener Schritt vor dem Umschalten, nach dem Expand/Contract-Muster: Jede Migration ist mit der vorherigen App-Version verträglich, damit ein App-Rollback ohne DB-Rollback funktioniert. Vor jeder Produktions-Migration entsteht ein Backup-Snapshot.

**Platzierung:** Wo staging und production laufen, wird pro Projekt in `/init` entschieden und in `docs/operations.md` festgehalten. Vorschlag: staging auf dem Factory-Server, production auf einer eigenen VM. Production auf dem Factory-Server ist erlaubt, `/init` weist dann auf Folgendes hin: Ressourcen werden mit den Agent-Läufen geteilt, und ein Ausfall des Servers trifft Factory, Monitoring und Produktion gleichzeitig. Isolation auf dem Factory-Server: eigenes Docker-Netz und Speicherlimits pro App und Umgebung, Job-Container sehen weder Docker-Socket noch `/run/secrets` der Apps, Site-Blöcke über `/etc/software-factory/sites.d/` (bereits vorhanden).

**Server bereitstellen:** Eine cloud-init-Datei aus `factory-pipelines/templates/cloud-init/` macht aus einem frischen Ubuntu einen Deploy-Host: Docker, Caddy (oder k3s), Infisical Agent, Alloy, Deploy-Nutzer mit Forced Command, Firewall, unattended-upgrades. OpenTofu-Module für Server, DNS und Bucket sind ein optionaler Schalter, zuerst für Hetzner.

## 5. Secrets

**Ablage:** Infisical Cloud (EU-Region). Pro Projekt ein Infisical-Projekt mit den Umgebungen `test`, `staging`, `production`. Die Factory selbst bekommt in Phase 2 ein eigenes Projekt.

**Zugriff**

| Wer | Wie | Darf lesen |
|---|---|---|
| GitHub Actions, PR-Läufe | OIDC, Subject `repo:<owner>/<repo>:pull_request` | nur `test` |
| GitHub Actions, Umgebung staging | OIDC, Subject `repo:<owner>/<repo>:environment:staging` | `staging` |
| GitHub Actions, Umgebung production | OIDC, Subject `repo:<owner>/<repo>:environment:production` (nur nach Freigabe) | `production` |
| Host | Maschinen-Identität (Universal Auth), Client-Secret per `systemd-creds` verschlüsselt | nur die Umgebungen, die auf dem Host laufen |
| Factory-Agents | gar nicht | – |

Im GitHub-Repo liegen damit **keine Secrets**, nur unkritische Variablen (Infisical-Projekt-ID, Identity-ID). GHCR nutzt den `GITHUB_TOKEN`.

**Auf dem Host:** Der Infisical Agent läuft als systemd-Dienst, liest seine Identität aus `LoadCredentialEncrypted` und schreibt die Secrets jeder App als Dateien nach `/run/secrets/<projekt>-<umgebung>/` (tmpfs, nur für den Container-Nutzer lesbar). Die Container bekommen sie als Datei eingebunden (Compose `secrets:`, bei Kamal als Volume, bei k3s über den Infisical-Operator). Ein kleiner Entrypoint-Wrapper aus `factory-pipelines` exportiert sie als Umgebungsvariablen und startet die App.

Warum Dateien statt `env_file`: Umgebungsvariablen aus `env_file` landen in der Container-Konfiguration unter `/var/lib/docker` und damit dauerhaft auf der Platte. Genau das soll vermieden werden. Kamal legt aus demselben Grund seine Secret-Dateien nicht auf dem Host ab: In der Kamal-Stufe übergibt Kamal nur nicht geheime Konfiguration, Secrets kommen über den Agent.

Bei k3s liegen Kubernetes-Secrets in der k3s-Datenbank, deshalb ist dort `--secrets-encryption` Pflicht.

**Startreihenfolge:** App-Stacks starten über eine systemd-Unit, die auf den Infisical Agent wartet. Nach einem Neustart sind die Secrets so vor den Containern da.

**Abhängigkeit:** Laufende Container arbeiten weiter, wenn Infisical nicht erreichbar ist. Ein Neustart des Hosts braucht Infisical. Das ist in `docs/operations.md` dokumentiert.

## 6. Pipelines

### Repo `factory-pipelines`

Öffentliches Repo, versioniert mit Tags (`v1.4.0`, gleitend `v1`). Inhalt:

```
.github/workflows/
  delivery.yml          Einstieg: liest .factory/delivery.json und steuert die Jobs
  ci.yml                Checks aus .factory/setup.json, Image bauen (buildx, Cache), E2E gegen das Image, optional Scan
  deploy.yml            Deploy einer Umgebung: Secrets via OIDC, Migration, Rollout je Stufe, Health-Gate, Rollback
  backup-restore.yml    Restore auf Abruf (workflow_dispatch), production nur mit Freigabe
  watchdog-probe.yml    optionale Health-Probe per Zeitplan
actions/                Composite Actions: config lesen, infisical, deploy-compose, deploy-kamal, deploy-argocd, health-gate
images/backup/          Backup-Image: restic + Postgres-Client, Befehle backup | restore | verify
schema/delivery.schema.json
templates/              Aufruf-Workflow, compose.yml, compose.test.yml, Kamal deploy.yml, Helm-Chart, cloud-init, Renovate-Preset
examples/demo-app/      Beispiel-App, an der das Repo seine eigenen Workflows Ende-zu-Ende testet
```

**Im Projekt** liegen nur der Aufruf und die Konfiguration:

```yaml
# .github/workflows/delivery.yml
name: delivery
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  packages: write
  id-token: write
  issues: write
  pull-requests: write
jobs:
  delivery:
    uses: <owner>/factory-pipelines/.github/workflows/delivery.yml@v1.4.0
    with:
      config: .factory/delivery.json
```

Renovate hebt die Version per PR an. Dieser PR durchläuft dieselbe Pipeline, ein Update kann also nicht unbemerkt alles brechen.

### `.factory/delivery.json`

Die einzige Stelle für Betriebsschalter. Der erste Job validiert sie gegen das JSON-Schema. Ein Tippfehler bricht die Pipeline sofort mit klarer Meldung ab, statt später irgendwo.

```json
{
  "$schema": "https://raw.githubusercontent.com/<owner>/factory-pipelines/v1/schema/delivery.schema.json",
  "tier": "compose",
  "provisioning": "cloud-init",
  "image": { "dockerfile": "Dockerfile", "platforms": ["linux/amd64"], "scan": true },
  "environments": {
    "test": { "e2e": true, "services": "deploy/compose.test.yml" },
    "staging": { "domain": "staging.example.org", "autoDeploy": true, "data": "seed" },
    "production": { "domain": "app.example.org", "approval": true }
  },
  "state": [
    { "type": "postgres", "service": "db", "pitr": false },
    { "type": "volume", "name": "uploads" }
  ],
  "backup": {
    "enabled": true,
    "schedule": "daily",
    "retention": { "daily": 7, "weekly": 4, "monthly": 12 },
    "restoreTest": "weekly"
  },
  "health": { "components": ["db", "storage", "mail"] },
  "observability": { "enabled": true, "metrics": false },
  "watchdog": {
    "provider": "healthchecks",
    "githubProbe": { "enabled": false, "intervalMinutes": 30 },
    "externalHttp": "none"
  },
  "flags": { "enabled": true, "file": "flags/flags.json" }
}
```

Die Checks selbst kommen weiter aus `.factory/setup.json`. CI und `factory-verify` prüfen damit exakt dasselbe.

### Robustheit

- Jeder Schritt ist ein Standardwerkzeug mit bekanntem Verhalten (buildx, `docker compose`, `kamal`, `argocd`, `restic`, `jq`). Eigene Skripte sind kurz und haben Tests in `factory-pipelines`.
- `factory-pipelines` testet sich bei jedem Release Ende-zu-Ende mit `examples/demo-app` auf einer Test-VM, für jede Stufe.
- Deploys sind idempotent: derselbe Digest zweimal ausgerollt ändert nichts.
- Der Deploy-Nutzer auf dem Host hat einen Forced Command (`command=` in `authorized_keys`). Der SSH-Schlüssel aus Infisical kann nur „Projekt X, Umgebung Y auf Digest Z setzen“, keine Shell.
- Ergebnis jedes Deploys kommentiert die Pipeline im PR bzw. am Commit: Umgebung, Digest, Health-Ergebnis.

## 7. Orchestrierungs-Stufen

Für alle drei Stufen gibt es Vorlagen in `factory-pipelines`. `/init` empfiehlt eine Stufe nach diesen Kriterien und schreibt die Begründung in `docs/operations.md`.

| Stufe | Passt, wenn | Deploy | Downtime beim Deploy |
|---|---|---|---|
| **Compose + Caddy** (Standard) | ein Host pro Umgebung, bis etwa 5 Dienste, kurze Unterbrechung beim Deploy vertretbar | Actions → SSH (Forced Command) → `docker compose pull && up -d`, Health-Gate | wenige Sekunden |
| **Kamal** | ein bis wenige Hosts, Deploys ohne Unterbrechung nötig, Web-App mit wenigen Rollen | Actions → `kamal deploy` mit kamal-proxy | keine |
| **k3s + Helm + Argo CD** | viele Dienste (ab etwa 6–8), mehrere Knoten, Selbstheilung oder Skalierung nötig, Jobs/Operatoren aus dem Kubernetes-Ökosystem, oder Kunde verlangt Kubernetes | GitOps: Pipeline schreibt den Digest je Umgebung, Argo CD synchronisiert | keine (Rolling Update) |
| **Verwaltetes Kubernetes** (nur dokumentiert) | Hochverfügbarkeit über Zonen, Compliance- oder Kundenvorgabe | wie k3s, Cluster vom Anbieter | keine |

Weitere Kriterien für `/init`: verfügbare Kapazität (der Factory-Server ist ein KVM 4 mit 16 GB, Agent-Läufe brauchen bis zu 2 × 3 GB), Betriebserfahrung im Team, Kosten. Im Zweifel die einfachere Stufe, ein späterer Wechsel ist durch das gleiche Image und dieselbe `delivery.json` überschaubar.

k3s läuft immer auf eigenen Hosts, nicht auf dem Factory-Server.

## 8. Daten, Backup und Restore

**Standard-Datenbank:** selbst betriebenes Postgres als Container bzw. bei k3s als StatefulSet. Neues Stack-Pack `postgres`: Migrationen als Dateien im Repo, ausgeführt im Deploy-Schritt, Expand/Contract. Supabase bleibt als Option mit eigenem Stack-Pack. Login dann über eine Bibliothek im App-Stack (Empfehlung in der Stack-Entscheidung von `/init`).

**Was gesichert wird:** alles, was unter `state` steht. Die Lückenprüfung (Abschnitt 12) sucht im Code nach Zustand, der dort fehlt (Volumes, Uploads, SQLite-Dateien, Queues).

**Wie**

- Backup-Image aus `factory-pipelines`, gestartet per systemd-Timer (Compose, Kamal) bzw. CronJob (k3s).
- Postgres: `pg_dump -Fc` direkt in `restic backup --stdin`. Volumes: `restic backup` des Volume-Pfads.
- Ein restic-Repository pro Projekt und Umgebung: `s3:<endpoint>/<bucket>/<projekt>/<umgebung>`. Endpoint, Bucket, Schlüssel und restic-Passwort kommen aus Infisical, der Anbieter ist frei wählbar.
- Zeitplan: täglich, zusätzlich vor jeder Produktions-Migration. Aufbewahrung: `forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune`.
- Integrität: wöchentlich `restic check --read-data-subset=5%`.
- Point-in-Time-Recovery als Schalter (`state[].pitr: true`): WAL-G archiviert WAL-Segmente in denselben Bucket.
- Härtung (optional, wenn der Anbieter es kann): Object Lock bzw. Versionierung, damit ein kompromittierter Host Backups nicht löschen kann. Das Aufräumen (`prune`) läuft dann mit separaten Zugangsdaten.

**Restore-Test:** wöchentlich, automatisch: neuester Snapshot in einen Wegwerf-Postgres-Container auf dem Host, danach Plausibilitätsprüfung (Migrationsstand wie erwartet, Kerntabellen nicht leer), Container weg, Ergebnis als Heartbeat an den Watchdog. Fehlt der Heartbeat oder schlägt die Prüfung fehl, entsteht ein `incident`. Der Test läuft auf dem Host und nicht in GitHub Actions, damit Produktionsdaten nicht in GitHubs Infrastruktur geladen werden.

**Restore auf Abruf:** Workflow `backup-restore` mit Umgebung, Snapshot (Standard: neuester) und Ziel (gleicher Host oder neuer Host). Für production nur mit Freigabe. Der Wiederanlauf auf einem neuen Host ist damit: Host per cloud-init anlegen, Deploy, Restore. Einmal pro Quartal als Übung empfohlen.

**Schlüssel:** Das restic-Passwort liegt in Infisical und zusätzlich offline (persönlicher Passwortmanager oder ausgedruckt). `docs/operations.md` hält fest, wo, aber nie den Schlüssel selbst. Ohne Offline-Kopie wären bei Verlust des Infisical-Zugangs alle Backups wertlos.

**staging-Daten** (`environments.staging.data`):
- `seed` (Standard): synthetische Daten aus dem Repo (`seed`-Befehl in `.factory/setup.json`). Keine personenbezogenen Daten außerhalb von production.
- `anonymized-copy`: neuester Produktions-Snapshot → Anonymisierungs-SQL aus dem Repo → staging. Ist zugleich ein Restore-Test. `/init` weist auf DSGVO-Folgen hin, besonders wenn staging auf dem Factory-Server läuft, und darauf, dass das Anonymisierungs-SQL bei jeder Schemaänderung mitgepflegt werden muss.

## 9. Health-Check

Jede App stellt drei Endpunkte bereit:

| Endpunkt | Zweck | Öffentlich | Prüft |
|---|---|---|---|
| `/livez` | Prozess lebt | ja | nichts außer dem Prozess selbst, nie abhängige Dienste |
| `/readyz` | kann Anfragen bedienen | ja, nur Status ohne Details | kritische Abhängigkeiten (DB erreichbar, Migrationen aktuell) |
| `/health` | Zustand jeder Hauptkomponente | nein, `Authorization: Bearer <HEALTH_TOKEN>` aus Infisical | alle Komponenten aus `health.components` |

Antwort von `/health`:

```json
{
  "status": "degraded",
  "version": "1.8.2",
  "commit": "a1b2c3d",
  "checks": {
    "db":      { "status": "ok",   "critical": true,  "latencyMs": 4 },
    "storage": { "status": "ok",   "critical": true,  "latencyMs": 22 },
    "mail":    { "status": "down", "critical": false, "error": "SMTP timeout" }
  }
}
```

`status` ist `down`, sobald eine kritische Komponente ausfällt, `degraded` bei einer unkritischen. HTTP 200 bei `ok` und `degraded`, 503 bei `down`. Jeder Check hat ein Zeitlimit, damit der Endpunkt selbst nie hängt.

**Wer nutzt es:**
- Orchestrierung: Compose-Healthcheck bzw. Kubernetes-Probes auf `/livez` und `/readyz`.
- Deploy-Gate: nach dem Rollout `/readyz` bis grün (mit Zeitlimit), danach `/health` mit Token: kritische Komponenten `ok` und `commit` gleich dem ausgerollten Commit. Sonst Rollback.
- Watchdog: `/readyz` von außen.
- Factory: Die Health-Spec (Abschnitt 12) verlangt einen E2E-Test für alle drei Endpunkte. Jedes spätere Feature, das eine neue Abhängigkeit einführt, ergänzt seinen Check, das steht in der `build`-Skill-Regel.

## 10. Observability, Alarme und Watchdog

**Stack:** Grafana, Loki und Prometheus als Compose-Stack auf dem Factory-Server (`ops/observability/` im Factory-Repo, per `setup.sh` optional eingerichtet), Grafana hinter Caddy mit Domain und Login. Prometheus nimmt Metriken per `remote_write` an. Auf jedem Host sammelt Grafana Alloy Container-Logs und Host-Metriken und schickt sie mit Labels `projekt`, `umgebung`, `dienst` per HTTPS (Zugangsdaten aus Infisical). Aufbewahrung: Logs 30 Tage, Metriken 30 Tage. Ressourcenbedarf etwa 1–1,5 GB RAM, `/init` berücksichtigt das bei der Kapazitätsplanung. Je Projekt ein vorbereitetes Dashboard: Health, Fehlerrate in Logs, Ressourcen, letzte Deploys und Backups. App-Metriken (`/metrics`) sind ein Schalter.

**Alarme als GitHub Issues:** Der Runner übernimmt einen „Incident-Intake“. Bei jedem Poll fragt er zusätzlich die aktiven Alarme in Grafana und den Status der Checks bei healthchecks.io ab. Pro Alarm gibt es genau ein offenes Issue mit Label `incident` im Projekt-Repo, bei Erholung kommentiert und schließt der Runner es. Diese Issues bekommen **nie** automatisch das Label `factory`. Ob die Factory einen Incident bearbeitet, entscheidest du. Deploy-Fehler öffnet die Pipeline selbst als Issue mit Label `deploy-failed`.

**Watchdog: wer merkt, dass ein Host oder der Factory-Server ausfällt?** Monitoring auf dem Factory-Server kann den eigenen Ausfall nicht melden. Deshalb drei wählbare Wege (`watchdog`), kombinierbar:

1. **healthchecks.io (Empfehlung)**: Jeder Host meldet alle 5 Minuten einen Heartbeat, aber nur wenn `/readyz` der App grün ist. Backup und Restore-Test melden ebenfalls. Bleibt ein Heartbeat aus, schlägt healthchecks.io Alarm. Vorteile: kostet keine Actions-Minuten, erkennt auch ausgefallene Backups, und der Runner holt den Status per API ab, also ohne Webhook und ohne GitHub-Token bei einem Dritten. Fällt der Factory-Server selbst aus (der Runner meldet ebenfalls einen Heartbeat), benachrichtigt healthchecks.io direkt per E-Mail. Ein Issue kann ein toter Runner nicht mehr anlegen.
   Free Tier „Hobbyist“: 20 Checks. Pro Projekt fallen etwa 3–5 an (Heartbeat je Umgebung, Backup, Restore-Test), das reicht für die Factory plus etwa vier Projekte. Laut FAQ ist der Hobbyist-Tarif für private Infrastruktur gedacht, kommerzielle Nutzer sollen mit der Zeit upgraden. Für mehr Checks bzw. kommerziellen Einsatz der Business-Tarif. Selbst betreiben ginge (Open Source), aber nicht auf dem Factory-Server.
2. **GitHub-Actions-Probe** (Standard aus): `watchdog-probe.yml` ruft per Zeitplan `/readyz` auf und öffnet bzw. schließt das Issue selbst. Intervall einstellbar, Standard 30 Minuten. Kosten in privaten Repos: jeder Lauf zählt als mindestens eine Minute, alle 10 Minuten ≈ 4.300, alle 30 Minuten ≈ 1.440 Minuten im Monat (Free-Kontingent privat: 2.000). In öffentlichen Repos kostenlos, aber GitHub deaktiviert Zeitpläne nach 60 Tagen ohne Aktivität im Repo, und Zeitpläne können sich unter Last verzögern. Deshalb nur als Ergänzung.
3. **Externer HTTP-Check** (Standard aus): prüft von außen auch DNS, TLS und Erreichbarkeit. Vorschlag UptimeRobot Free (50 Monitore, 5-Minuten-Intervall, kommerzielle Nutzung laut aktuellen Bedingungen wieder erlaubt). Webhooks sind im Free-Tarif nach allen Quellen nicht enthalten, Alarme kommen dann per E-Mail, nicht als Issue.

Die Tarifangaben sind Stand November 2026 und vor der Umsetzung auf den Seiten der Anbieter zu prüfen.

## 11. Feature-Flags

Zwei Arten von Schaltern:
- **Pipeline-Schalter:** in `.factory/delivery.json` (E2E, Scan, Backup, Observability, Watchdog …).
- **Feature-Flags in der App:** OpenFeature-SDK mit flagd, Flags in `flags/flags.json` im Repo. Unterschiede je Umgebung über Targeting auf den Kontext `environment`. Kein zusätzlicher Dienst: flagd liest die Datei (In-Process-Provider bzw. Sidecar). Ein Flag umschalten heißt: PR, Merge, Deploy, also nachvollziehbar und mit Freigabe für production. Wer Flags zur Laufzeit per Oberfläche schalten will, kann später einen Flag-Dienst hinter dieselbe OpenFeature-Schnittstelle setzen, ohne App-Code zu ändern.

Konvention für die Factory: Größere Features hinter einem Flag bauen, das in production zunächst aus ist. Die `build`-Skill-Regel bekommt dazu einen Absatz, die Spec kann es per Akzeptanzkriterium verlangen.

## 12. Ablauf in der Factory

### `/init` (lokal, du bist dabei)

Neuer Pflichtabschnitt **Betrieb** im Interview, nach der Stack-Entscheidung, wie bisher eine Frage pro Runde mit Empfehlung:

1. Umgebungen und ihr Ort (Vorschlag: test in CI, staging auf dem Factory-Server, production auf eigener VM)
2. Orchestrierungs-Stufe nach den Kriterien aus Abschnitt 7, mit Begründung
3. Zustand und Backup: Datenbanken, Volumes, PITR nötig?, staging-Daten
4. Health-Komponenten (aus dem Stack abgeleitet, du bestätigst)
5. Observability und Watchdog
6. Anforderungen über Brief und Konvention hinaus (z. B. Verfügbarkeitsziel, Aufbewahrungspflichten, Datenstandort, Kundenvorgaben)

Ergebnis:
- **`docs/operations.md`**: Betriebsentscheidungen mit Begründung, Abweichungen von der Konvention, Ort der Offline-Schlüssel, Runbook-Verweise.
- **`.factory/delivery.json`** und der Aufruf-Workflow aus den Vorlagen.
- **Plattform-Specs** aus Vorlagen im Factory-Repo (`conventions/specs/`), vom Nutzer durchgesehen und freigegeben, Status `Planned`. Die bisherige Regel „Projekt-Setup ist kein Feature“ bekommt eine Ausnahme: Plattform-Specs sind eigene Einträge in `features/INDEX.md` mit Typ `Plattform`.
- **Checkliste für dich** mit den Schritten, die die Factory nicht kann (Abschnitt 14).

Die Stack-Empfehlung ändert sich: Standard für Web-Apps mit Konten und Daten wird Next.js + TypeScript + Tailwind + shadcn/ui, **Postgres (selbst betrieben)** mit Migrationswerkzeug und einer Login-Bibliothek, Vitest + Playwright. Supabase bleibt als Alternative.

### Plattform-Specs und Bau-Reihenfolge

```
P0: PROJ-1 Konventionen prüfen → PROJ-2 CI (test) → PROJ-3 Health-Check → PROJ-4 Deploy staging → PROJ-5 Production-Freigabe
P1: PROJ-6 Backup + Restore-Test (braucht PROJ-4) · PROJ-7 Observability + Watchdog (braucht PROJ-4)
Produkt-Features ab PROJ-8, starten sobald PROJ-2 fertig ist
```

- **PROJ-1 Konventionen prüfen** (dein Wunsch: Bestätigung in `/init` *und* eine erste Prüfung durch die Factory): Die Factory gleicht Brief, PRD, Stack, Grundgerüst und `docs/operations.md` ab und sucht Lücken: Zustand ohne Backup, Abhängigkeiten ohne Health-Check, fehlende Umgebungskonfiguration, Widersprüche zur Stufe. Ergebnis ist ein PR mit Ergänzungen an `docs/operations.md` und `.factory/delivery.json`, offene Entscheidungen als Rückfrage im Issue. Du mergst.
- Jede Plattform-Spec hat einen Abschnitt **Voraussetzungen (Mensch)** als Checkliste, z. B. „Infisical-Projekt mit Identitäten angelegt“, „S3-Bucket vorhanden“, „DNS für staging zeigt auf den Host“. Die Prüfung fragt nach, solange etwas offen ist, denn prüfen kann die Factory das nicht.

### Playbook, Skills und Job-Image

- **Prüfung:** Plattform-Specs erkennen, Voraussetzungen-Checkliste prüfen.
- **Bau:** Vorlagen aus `factory-pipelines` verwenden statt Pipelines frei zu schreiben. Neue Pflicht-Checks für Betriebsdateien: Schema-Validierung von `delivery.json`, `actionlint`, `docker compose config`, `helm lint` + `kubeconform` bzw. Kamal-Konfiguration je nach Stufe. `/init` trägt sie in `.factory/setup.json` ein, `factory-verify` prüft sie damit automatisch.
- **Abnahme:** Für Plattform-Specs testet der Abnahme-Agent nicht im Browser, sondern prüft den CI-Lauf des PRs (die test-Umgebung *ist* dieser Lauf) und die statischen Checks. Deploy-Kriterien lassen sich erst nach dem Merge belegen: Die PR-Beschreibung listet sie unter „Wird nach dem Merge geprüft“, die Pipeline kommentiert das Ergebnis des ersten staging-Deploys im PR und öffnet bei Fehlschlag ein `deploy-failed`-Issue.
- **Job-Image:** `actionlint`, `check-jsonschema`, `helm`, `kubeconform`, Docker-CLI mit Compose-Plugin (nur für `config`, kein Daemon), `hadolint`.
- **Skills:** `architecture` und `build` bekommen einen Abschnitt „Betrieb“ (neue Abhängigkeit ⇒ Health-Check; neuer Zustand ⇒ `state` ergänzen; neue Secrets ⇒ Name in `docs/operations.md`, Wert setzt der Mensch in Infisical; größere Features hinter Flag).
- **Runner:** Incident-Intake (Abschnitt 10), Issues mit `incident` oder `deploy-failed` nie als Factory-Aufgabe behandeln.
- **`add-repo.sh`:** legt zusätzlich die GitHub-Umgebungen `staging` und `production` an (production: Freigabe durch dich, nur Branch `main`), Labels `incident` und `deploy-failed`, CODEOWNERS-Eintrag für `.github/` und `.factory/delivery.json`.

## 13. Sicherheitsgrenzen

- Die Factory schreibt Workflow-Dateien. Damit ein Agent darüber nicht an Produktions-Secrets kommt: Produktions- und staging-Secrets gibt es nur per OIDC an GitHub-Umgebungen, die auf `main` beschränkt sind. production braucht deine Freigabe. PR-Läufe, auch die der Factory, bekommen nur `test`-Secrets.
- Änderungen an `.github/` und `.factory/delivery.json` erfordern dein Review (CODEOWNERS), was ohnehin gilt, weil du jeden PR mergst. Das Playbook verlangt, solche Änderungen im PR-Text eigens aufzuführen.
- Pipeline-Versionen werden auf Tags gepinnt, Updates kommen nur per Renovate-PR.
- Der Deploy-Schlüssel kann nur den Forced Command ausführen. Die Gruppe `docker` ist root-gleich, deshalb bekommt der Deploy-Nutzer keine Shell.
- Job-Container sehen weder Docker-Socket noch `/run/secrets` noch die Volumes der Apps auf dem Factory-Server.

## 14. Was weiterhin von Hand passiert

Ehrlich aufgelistet. Alles einmalig pro Projekt bzw. Server, nichts davon per SSH:
- Infisical: Projekt, Umgebungen und Identitäten anlegen, Secrets eintragen. Später per Infisical-Terraform-Provider automatisierbar.
- S3-Bucket und Zugangsschlüssel anlegen, Offline-Kopie des Backup-Schlüssels ablegen.
- Server bestellen (oder per OpenTofu), cloud-init-Datei beim Anlegen angeben, DNS-Einträge setzen.
- healthchecks.io-Konto, Checks anlegen (oder per API aus der Pipeline).
- GitHub App installieren (Phase 2).
- Production freigeben und PRs mergen.

## 15. Phasen und Arbeitspakete

### Phase 1: Konventionen für Projekte

| Paket | Inhalt | Ergebnis |
|---|---|---|
| 1.1 | Konventionen im Factory-Repo: `conventions/` mit Leitfaden, Kriterien der Stufen, Vorlage `operations.md`, Spec-Vorlagen PROJ-1 bis 7 | PR im Factory-Repo |
| 1.2 | Repo `factory-pipelines`: Workflows, Composite Actions, Backup-Image, Schema, Vorlagen für alle drei Stufen, cloud-init, Demo-App mit Ende-zu-Ende-Test | Release `v1.0.0` |
| 1.3 | `/init`: Abschnitt Betrieb, neue Stack-Empfehlung, Erzeugen von `operations.md`, `delivery.json`, Plattform-Specs, Checkliste | PR |
| 1.4 | Playbook, Skills, Job-Image: Plattform-Specs, neue Checks, Abnahme für Plattform-Specs, Stack-Pack `postgres` | PR |
| 1.5 | Factory-Server: Observability-Stack (`ops/observability/`), Incident-Intake im Runner, `add-repo.sh` (Umgebungen, Labels, CODEOWNERS) | PR |
| 1.6 | Pilot: ein echtes neues Projekt von `/init` bis production, Erkenntnisse zurück in die Vorlagen | Erfahrungsbericht |

Bis Phase 2 liest der Runner seine neuen Zugangsdaten (healthchecks.io-API, Grafana) noch aus `secrets.env`.

### Phase 2: Die Factory selbst

- GitHub App statt `gh auth login`: kurzlebige Tokens, Berechtigung „Workflows“ ausdrücklich, Installation pro Repo.
- Infisical für die Factory: Claude-Token, App-Schlüssel und alle Runner-Zugangsdaten über den Infisical Agent, Identität per `systemd-creds`. `secrets.env` entfällt.
- `setup.sh` wird zur cloud-init-Datei für den Factory-Server.
- Rollout per CI: Merge im Factory-Repo → GitHub Action → Forced Command `factory-rollout`. Kein SSH mehr für Updates.
- Backup des Factory-Zustands (`/var/lib/software-factory`: Metriken, Limits, Job-Daten) nach derselben Konvention.
- Heartbeat des Runners an healthchecks.io.

## 16. Offene Punkte und Risiken

Vor bzw. während der Umsetzung zu klären:

1. **Bootstrap der Host-Identität:** Das erste Client-Secret kommt per cloud-init auf den Host. User-Data bleibt beim Anbieter abrufbar, deshalb: Secret mit kurzer Laufzeit bzw. einmaliger Nutzung, beim ersten Boot durch ein neues ersetzt und per `systemd-creds` verschlüsselt. Ob Infisical das so unterstützt, ist zu prüfen. Sonst bleibt hier ein einmaliger manueller Schritt.
2. **Infisical als Abhängigkeit:** Ausfall verhindert Neustarts und Deploys, nicht den laufenden Betrieb. Prüfen, ob der Agent einen Cache im tmpfs halten kann.
3. **Kamal ohne Secret-Dateien auf dem Host:** prüfen, dass sich die Kamal-Stufe sauber mit eingebundenen Secret-Dateien statt Kamal-Secrets betreiben lässt.
4. **Argo CD und Digest-Promotion:** Die Pipeline muss den Digest je Umgebung ins Repo schreiben. Dafür braucht `github-actions` einen Bypass in den Rulesets von `main`, oder die Umgebungszustände liegen auf einem eigenen Branch. Beim Bau der k3s-Vorlage entscheiden.
5. **Grafana-Alarme abfragen:** Der Runner liest aktive Alarme über die Alertmanager-API von Grafana. Details beim Bau prüfen.
6. **Kapazität des Factory-Servers:** Agent-Läufe, Vorschauen, Observability, staging und eventuell production auf 16 GB. `/init` braucht eine einfache Kapazitätsrechnung, sonst landen zu viele Umgebungen auf dem Factory-Server.
7. **Tarife der Watchdog-Dienste:** healthchecks.io (kommerzielle Nutzung), UptimeRobot (Webhooks) vor der Umsetzung auf den Anbieterseiten bestätigen.
8. **Scope von Phase 1:** drei Stufen mit Vorlagen und Ende-zu-Ende-Tests sind der größte Posten. Reihenfolge innerhalb von 1.2: Compose zuerst (Pilot), dann Kamal, dann k3s.
