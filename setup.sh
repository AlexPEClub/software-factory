#!/usr/bin/env bash
# Richtet die Software Factory auf einem frischen Ubuntu-Server ein (getestet: Ubuntu 24.04).
# Aufruf als root im Repo-Ordner:  ./setup.sh
# Mehrfach ausführen ist ok: bereits installierte Teile werden übersprungen.
set -euo pipefail
cd "$(dirname "$0")"
FACTORY_DIR="$(pwd)"
CONF_DIR=/etc/software-factory

say() { printf "\n\033[1m▶ %s\033[0m\n" "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen (sudo ./setup.sh)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "Systempakete"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq unzip git >/dev/null

if ! command -v docker >/dev/null; then
  say "Docker installieren"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker >/dev/null
fi

if ! command -v gh >/dev/null; then
  say "GitHub CLI installieren"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi

if [ ! -x /root/.bun/bin/bun ]; then
  say "Bun installieren"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
fi

say "Konfiguration unter $CONF_DIR"
install -d -m 700 "$CONF_DIR"
[ -f "$CONF_DIR/config.json" ] || { cp factory.config.example.json "$CONF_DIR/config.json"; echo "  Vorlage angelegt: $CONF_DIR/config.json (bitte anpassen)"; }
[ -f "$CONF_DIR/secrets.env" ] || { touch "$CONF_DIR/secrets.env"; chmod 600 "$CONF_DIR/secrets.env"; }
install -d /var/lib/software-factory/jobs
# Vorschau: Server-IP und zufälliges Passwort eintragen, falls noch "AUTO"
if jq -e '.preview.host == "AUTO" or .preview.password == "AUTO"' "$CONF_DIR/config.json" >/dev/null 2>&1; then
  IP=$(curl -fsS4 https://ifconfig.me || hostname -I | awk '{print $1}')
  PW=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  TMP=$(mktemp)
  jq --arg ip "$IP" --arg pw "$PW" '.preview.host = (if .preview.host == "AUTO" then $ip else .preview.host end) | .preview.password = (if .preview.password == "AUTO" then $pw else .preview.password end)' "$CONF_DIR/config.json" > "$TMP" && mv "$TMP" "$CONF_DIR/config.json" && chmod 600 "$CONF_DIR/config.json"
  echo "  Vorschau: http://$IP:4001… · Login factory · Passwort in $CONF_DIR/config.json"
fi
docker pull -q caddy:2-alpine >/dev/null

say "Job-Image bauen (dauert beim ersten Mal ein paar Minuten)"
docker build -q -t software-factory-job:latest -f image/Dockerfile . >/dev/null
echo "  ✓ software-factory-job:latest"

say "Runner als Dienst einrichten"
sed "s#/opt/software-factory#$FACTORY_DIR#g" deploy/software-factory.service > /etc/systemd/system/software-factory.service
systemctl daemon-reload
systemctl enable software-factory >/dev/null 2>&1

# Was fehlt noch?
MISSING=()
grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.' "$CONF_DIR/secrets.env" || MISSING+=("Claude-Login: Token in $CONF_DIR/secrets.env (siehe Anleitung)")
gh auth status >/dev/null 2>&1 || MISSING+=("GitHub-Login: gh auth login -s project")
grep -q "DEIN-GITHUB-NAME" "$CONF_DIR/config.json" && MISSING+=("Repos eintragen: $CONF_DIR/config.json")

if [ ${#MISSING[@]} -eq 0 ]; then
  systemctl restart software-factory
  say "Fertig. Die Factory läuft."
  echo "  Logs ansehen: journalctl -u software-factory -f"
else
  say "Installiert. Bevor die Factory startet, fehlt noch:"
  for m in "${MISSING[@]}"; do echo "  • $m"; done
  echo "  Danach: systemctl restart software-factory"
fi
