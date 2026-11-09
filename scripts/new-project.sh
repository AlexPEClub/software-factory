#!/usr/bin/env bash
# Legt ein neues Projekt aus dem Factory-Template an und hängt es an deine Factory.
# Läuft auf deinem Rechner (nicht auf dem Server).
#
#   ./scripts/new-project.sh <projektname> [--public]
#
# Einstellungen (Umgebungsvariablen oder ~/.config/software-factory/env):
#   FACTORY_SERVER    SSH-Ziel deines Servers, z. B. root@187.124.14.173
#   FACTORY_TEMPLATE  Template-Repo (Standard: AlexPEClub/factory-template)
#   FACTORY_DIR       Pfad der Factory auf dem Server (Standard: /opt/software-factory)
set -euo pipefail
[ -f "$HOME/.config/software-factory/env" ] && . "$HOME/.config/software-factory/env"

NAME="${1:?Aufruf: ./scripts/new-project.sh <projektname> [--public]}"
VISIBILITY="--private"; [ "${2:-}" = "--public" ] && VISIBILITY="--public"
TEMPLATE="${FACTORY_TEMPLATE:-AlexPEClub/factory-template}"
SERVER="${FACTORY_SERVER:?FACTORY_SERVER fehlt, z. B. export FACTORY_SERVER=root@1.2.3.4}"
FDIR="${FACTORY_DIR:-/opt/software-factory}"
OWNER=$(gh api user --jq .login)
REPO="$OWNER/$NAME"

echo "▶ Repo $REPO aus $TEMPLATE anlegen"
gh repo create "$REPO" $VISIBILITY --template "$TEMPLATE" >/dev/null
# GitHub erzeugt das Repo aus dem Template asynchron: kurz warten, bis der erste Commit da ist
for i in $(seq 1 30); do gh api "repos/$REPO/commits?per_page=1" >/dev/null 2>&1 && break; sleep 2; done
gh repo clone "$REPO" "$NAME" -- --quiet
cd "$NAME"

echo "▶ An die Factory auf $SERVER hängen"
ssh "$SERVER" "cd $FDIR && ./scripts/add-repo.sh $REPO"

echo
echo "Fertig: $(pwd)"
echo "Nächste Schritte:"
echo "  1. Briefing in docs/briefing.md legen"
echo "  2. Claude Code hier starten und /init ausführen"
echo "  3. Pro Feature: /write-spec PROJ-X, dann /to-factory PROJ-X"
