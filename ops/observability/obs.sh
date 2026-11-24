#!/usr/bin/env bash
# Observability-Stack der Factory (Grafana, Loki, Prometheus) auf dem Factory-Server verwalten.
# Als root im Factory-Ordner. Mehrfach ausführen ist ok.
#
#   ops/observability/obs.sh install              Stack starten bzw. aktualisieren, Caddy-Site schreiben,
#                                                 Lese-Token für den Runner anlegen (GRAFANA_TOKEN)
#   ops/observability/obs.sh ingest-user NAME     Zugang zum Log- und Metrik-Empfang für einen Host anlegen bzw.
#                                                 neu setzen (NAME z. B. meine-app-staging). Das Passwort wird nur
#                                                 einmal angezeigt.
#   ops/observability/obs.sh ingest-remove NAME   Zugang entfernen
#   ops/observability/obs.sh site                 Nur die Caddy-Site neu schreiben
#   ops/observability/obs.sh compose ARGS…        docker compose für den Stack, z. B. "compose ps" oder "compose logs loki"
#
# Einstellungen:
#   /etc/software-factory/config.json  → observability.domain (z. B. grafana.deine-domain.de)
#   /etc/software-factory/secrets.env  → GRAFANA_ADMIN_PASSWORD (legt install an), GRAFANA_TOKEN (legt install an)
#   /etc/software-factory/observability/ingest-users  → je Zeile "NAME BCRYPT-HASH" (verwaltet dieses Skript)
# Phase 2 der Betriebskonventionen holt die Zugangsdaten aus Infisical statt aus secrets.env.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
CONF_DIR=${FACTORY_CONF_DIR:-/etc/software-factory}
SECRETS=$CONF_DIR/secrets.env
CONFIG=$CONF_DIR/config.json
USERS=$CONF_DIR/observability/ingest-users
SITE=$CONF_DIR/sites.d/observability.caddy
GRAFANA=http://127.0.0.1:3300
CADDY_IMAGE=caddy:2-alpine

die() { echo "Fehler: $*" >&2; exit 1; }
secret() { grep -E "^$1=" "$SECRETS" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
set_secret() {
  local tmp; tmp=$(mktemp)
  { grep -vE "^$1=" "$SECRETS" 2>/dev/null || true; printf '%s=%s\n' "$1" "$2"; } > "$tmp"
  install -m 600 "$tmp" "$SECRETS"; rm -f "$tmp"
}
domain() { jq -r '.observability.domain // ""' "$CONFIG" 2>/dev/null || true; }
random() { openssl rand -hex 24; }

# docker compose mit genau den Variablen, die compose.yml braucht. secrets.env wird nicht als Ganzes übergeben,
# damit der Claude-Token nie in einem Container des Stacks landet.
dc() {
  env -i PATH="$PATH" HOME="${HOME:-/root}" \
    GRAFANA_ADMIN_PASSWORD="$(secret GRAFANA_ADMIN_PASSWORD)" OBS_DOMAIN="$(domain)" \
    docker compose -f "$DIR/compose.yml" "$@"
}

# Caddy-Site für sites.d: Grafana unter der Domain, Log- und Metrik-Empfang mit Basic Auth.
# Die Factory bindet die Datei beim nächsten Durchlauf ein (Caddy der Factory, sf-caddy, Ports 80/443).
write_site() {
  local d; d=$(domain)
  [ -n "$d" ] || die "observability.domain fehlt in $CONFIG"
  [[ "$d" =~ ^[A-Za-z0-9.-]+$ ]] || die "Ungültige Domain: $d"
  install -d -m 755 "$CONF_DIR/sites.d"
  local auth
  if [ -s "$USERS" ]; then
    auth=$(awk '{ printf "\t\t%s %s\n", $1, $2 }' "$USERS")
    auth=$(printf '\tbasic_auth {\n%s\n\t}\n' "$auth")
  else
    auth=$(printf '\trespond "Kein Zugang eingerichtet (obs.sh ingest-user)" 403\n')
  fi
  local tmp; tmp=$(mktemp)
  cat > "$tmp" <<EOF
# Observability-Stack der Factory. Erzeugt von ops/observability/obs.sh, nicht von Hand ändern.
(factory_obs_ingest) {
$auth
}

$d {
	encode zstd gzip
	# Logs von Grafana Alloy (Loki-Push-API)
	handle /loki/api/v1/push {
		import factory_obs_ingest
		reverse_proxy 127.0.0.1:3100
	}
	# Metriken von Grafana Alloy (Prometheus remote_write)
	handle /api/v1/write {
		import factory_obs_ingest
		reverse_proxy 127.0.0.1:9090
	}
	# Alles andere: Grafana mit eigenem Login
	handle {
		reverse_proxy 127.0.0.1:3300
	}
}
EOF
  install -m 600 "$tmp" "$SITE"; rm -f "$tmp"
  echo "  ✓ Caddy-Site $SITE (die Factory bindet sie innerhalb einer Minute ein)"
}

wait_grafana() {
  for _ in $(seq 1 60); do
    curl -fsS "$GRAFANA/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "Grafana antwortet nicht auf $GRAFANA (obs.sh compose logs grafana)"
}

# Admin-Zugang über stdin an curl, nicht über die Kommandozeile
grafana_api() { # METHODE PFAD [JSON]
  local pw; pw=$(secret GRAFANA_ADMIN_PASSWORD)
  printf 'user = "admin:%s"\n' "$pw" | curl -fsS --config - -X "$1" -H 'Content-Type: application/json' \
    ${3:+--data "$3"} "$GRAFANA$2"
}

# Dienstkonto "factory-runner" (Rolle Viewer) mit Token: Der Runner liest damit die aktiven Alarme.
runner_token() {
  if [ -n "$(secret GRAFANA_TOKEN)" ]; then echo "  ✓ GRAFANA_TOKEN vorhanden"; return 0; fi
  wait_grafana
  local id
  id=$(grafana_api GET "/api/serviceaccounts/search?query=factory-runner" | jq -r '.serviceAccounts[] | select(.name == "factory-runner") | .id' | head -1)
  [ -n "$id" ] || id=$(grafana_api POST /api/serviceaccounts '{"name": "factory-runner", "role": "Viewer"}' | jq -r .id)
  local token
  token=$(grafana_api POST "/api/serviceaccounts/$id/tokens" "{\"name\": \"runner-$(date +%Y%m%d%H%M%S)\"}" | jq -r .key)
  [ -n "$token" ] && [ "$token" != null ] || die "Token für den Runner konnte nicht angelegt werden"
  set_secret GRAFANA_TOKEN "$token"
  echo "  ✓ GRAFANA_TOKEN in $SECRETS (Runner neu starten: systemctl restart software-factory)"
}

cmd=${1:-}
case "$cmd" in
  install)
    command -v docker >/dev/null || die "Docker fehlt"
    [ -f "$CONFIG" ] || die "$CONFIG fehlt (zuerst ./setup.sh)"
    [ -n "$(domain)" ] || die "observability.domain fehlt in $CONFIG"
    install -d -m 700 "$CONF_DIR/observability"
    [ -f "$SECRETS" ] || install -m 600 /dev/null "$SECRETS"
    if [ -z "$(secret GRAFANA_ADMIN_PASSWORD)" ]; then
      set_secret GRAFANA_ADMIN_PASSWORD "$(random)"
      echo "  ✓ GRAFANA_ADMIN_PASSWORD in $SECRETS angelegt (Login in Grafana: admin)"
    fi
    dc pull -q
    dc up -d --remove-orphans
    echo "  ✓ Stack läuft (obs.sh compose ps)"
    write_site
    runner_token
    ;;
  ingest-user)
    name=${2:-}
    [[ "$name" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || die "Aufruf: obs.sh ingest-user NAME (Kleinbuchstaben, Ziffern, Bindestriche, z. B. meine-app-staging)"
    install -d -m 700 "$CONF_DIR/observability"
    pw=$(random)
    hash=$(docker run --rm "$CADDY_IMAGE" caddy hash-password --plaintext "$pw")
    tmp=$(mktemp)
    { grep -vE "^$name " "$USERS" 2>/dev/null || true; printf '%s %s\n' "$name" "$hash"; } > "$tmp"
    install -m 600 "$tmp" "$USERS"; rm -f "$tmp"
    write_site
    d=$(domain)
    cat <<EOF

Zugang für $name. Das Passwort wird nur jetzt angezeigt. Trag die Werte als Secrets der Umgebung in Infisical ein:

  OBS_LOGS_URL=https://$d/loki/api/v1/push
  OBS_METRICS_URL=https://$d/api/v1/write
  OBS_USER=$name
  OBS_PASSWORD=$pw

Konfiguration für Grafana Alloy auf dem Host: ops/observability/alloy/host.alloy
EOF
    ;;
  ingest-remove)
    name=${2:?Aufruf: obs.sh ingest-remove NAME}
    tmp=$(mktemp)
    grep -vE "^$name " "$USERS" > "$tmp" 2>/dev/null || true
    install -m 600 "$tmp" "$USERS"; rm -f "$tmp"
    write_site
    ;;
  site) write_site ;;
  compose) shift; dc "$@" ;;
  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
