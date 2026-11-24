# Observability-Stack der Factory

Grafana, Loki und Prometheus als Compose-Stack auf dem Factory-Server (Betriebskonventionen, Abschnitt 10). Einrichtung Schritt für Schritt: [docs/hostinger-vps-setup.md, Schritt 6c](../../docs/hostinger-vps-setup.md#6c-monitoring-und-alarme-optional). Hier stehen die technischen Details und die Namen, auf die sich Projekte beziehen.

## Aufbau

| Dienst | Image | Port (nur 127.0.0.1) | Speicherlimit | Aufbewahrung |
|---|---|---|---|---|
| Grafana | `grafana/grafana-oss:11.5.2` | 3300 | 384 MB | – |
| Loki | `grafana/loki:3.4.2` | 3100 | 512 MB | 30 Tage (`loki.yml`) |
| Prometheus | `prom/prometheus:v3.2.1` | 9090 | 512 MB | 30 Tage bzw. 10 GB |

Zusammen höchstens 1,4 GB Arbeitsspeicher. Von außen erreichbar ist nur, was die Caddy-Site `/etc/software-factory/sites.d/observability.caddy` freigibt (erzeugt von `obs.sh`, eingebunden vom Caddy der Factory):

| Pfad unter `https://<observability.domain>` | Ziel | Schutz |
|---|---|---|
| `/loki/api/v1/push` | Loki (Logs von Grafana Alloy) | Basic Auth je Host |
| `/api/v1/write` | Prometheus `remote_write` (Metriken von Grafana Alloy) | Basic Auth je Host |
| alles andere | Grafana | Login von Grafana |

Dateien:

- `compose.yml`, `loki.yml`, `prometheus.yml`: der Stack
- `grafana/provisioning/`: Datenquellen (UIDs `prometheus`, `loki`), Dashboard-Ordner „Factory“, Standard-Alarme
- `grafana/dashboards/projekt.json`: Dashboard „Projekt“ (Auswahl Projekt und Umgebung): Bereit (`/readyz`), Zeit seit dem letzten Deploy, Fehler in den Logs, Arbeitsspeicher und CPU je Dienst, Platte und RAM des Hosts, letzte Backups und Restore-Tests, Fehler-Logzeilen
- `alloy/host.alloy`: Vorlage für Grafana Alloy auf einem Deploy-Host
- `obs.sh`: Verwaltung (auf dem Server auch als `factory-obs`)

## Zugangsdaten

Bis Phase 2 der Betriebskonventionen liegen sie in `/etc/software-factory/secrets.env` (nur root):

| Name | Zweck | Wer legt ihn an |
|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | Login `admin` in Grafana | `obs.sh install` |
| `GRAFANA_TOKEN` | Token des Dienstkontos `factory-runner` (Rolle Viewer): Der Runner liest damit die aktiven Alarme | `obs.sh install` |
| `HEALTHCHECKS_API_KEY` | Nur lesender API-Schlüssel von healthchecks.io: Der Runner liest damit den Status der Checks | du, von Hand |

`obs.sh compose …` gibt nur `GRAFANA_ADMIN_PASSWORD` und `OBS_DOMAIN` an Compose weiter, nie die ganze `secrets.env`. Die Zugänge für den Empfang liegen als bcrypt-Hash in `/etc/software-factory/observability/ingest-users`.

### Namen für Projekte (Secrets je Umgebung in Infisical)

`obs.sh ingest-user <projekt>-<umgebung>` legt einen Zugang an und gibt die Werte einmal aus:

| Secret | Wert |
|---|---|
| `OBS_LOGS_URL` | `https://<observability.domain>/loki/api/v1/push` |
| `OBS_METRICS_URL` | `https://<observability.domain>/api/v1/write` |
| `OBS_USER` | `<projekt>-<umgebung>` |
| `OBS_PASSWORD` | zufällig, nur einmal angezeigt |

Ein Zugang kann Logs mit beliebigen Labels schicken. Er trennt Hosts, nicht Projekte: Wer ihn verliert, `obs.sh ingest-user` mit demselben Namen setzt ein neues Passwort, `obs.sh ingest-remove` sperrt ihn.

## Labels

Alle Logs und Metriken tragen `projekt`, `umgebung` (`staging`, `production`) und `dienst`:

- **Container:** aus dem Compose-Projektnamen `<projekt>-<umgebung>` (so startet `factory-host` aus factory-pipelines die Apps) und dem Compose-Dienst (`app`, `db`, …). Container anderer Herkunft schickt die Vorlage nicht.
- **Host-Metriken und `/readyz`-Probe:** aus `HOST_PROJEKT` und `HOST_UMGEBUNG` in der Umgebung von Alloy. Auf dem Factory-Server ist das Projekt `factory`.
- **Journal** der Units `factory-*` (Backup, Restore-Test, Heartbeat): `dienst` = Unit-Name, dazu `host`. Ohne `projekt`, weil ein Host mehrere Apps sichern kann; die Zeilen nennen `<projekt>-<umgebung>`.

App-Logs als eine JSON-Zeile pro Eintrag mit `level` (PROJ-7, AK-2). Als Fehler zählen `error`, `fatal` und bei pino `50`, `60`.

## Alarme

`grafana/provisioning/alerting/rules.yml` bringt drei Alarme mit: viele Fehler in den Logs (mehr als 20 in 5 Minuten, 10 Minuten lang), Platte über 90 % und Arbeitsspeicher über 90 % (je 15 Minuten). Ob eine App läuft, meldet healthchecks.io (Heartbeat nur bei grünem `/readyz`), deshalb gibt es dafür hier keinen Alarm.

Der Runner der Factory liest aktive Alarme über `GET /api/alertmanager/grafana/api/v2/alerts` und ordnet sie über das Label `projekt` einem Repo zu (`incidents.projects` in der Factory-Config). Kontaktpunkte in Grafana braucht es dafür nicht. Eigene Alarme in Grafana funktionieren genauso, solange ihre Ergebnisse das Label `projekt` tragen.

## Konfiguration prüfen (startet nichts)

```bash
OBS_DOMAIN=grafana.example.org GRAFANA_ADMIN_PASSWORD=x docker compose -f ops/observability/compose.yml config -q
```
