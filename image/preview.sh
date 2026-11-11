#!/usr/bin/env bash
# Startet die App eines PR-Branches als Vorschau (Port 3000 im Container).
# Der Runner holt den Quellcode vorher nach /app. Dieser Container bekommt keine Zugangsdaten:
# Installationsskripte und App-Code können weder GitHub noch Claude erreichen.
set -euo pipefail
cd /app

INSTALL=$(jq -r '.install // empty' .factory/setup.json 2>/dev/null || true)
PREVIEW=$(jq -r '.preview // empty' .factory/setup.json 2>/dev/null || true)
INSTALL="${INSTALL:-npm ci}"
PREVIEW="${PREVIEW:-npm run build && npm run start -- -p \$PORT -H 0.0.0.0}"
export PORT=3000

echo "[preview] Installation: $INSTALL"
bash -lc "$INSTALL"
echo "[preview] Start: $PREVIEW"
exec bash -lc "$PREVIEW"
