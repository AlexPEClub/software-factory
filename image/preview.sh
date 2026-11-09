#!/usr/bin/env bash
# Startet die App eines PR-Branches als Vorschau (Port 3000 im Container).
# Erwartet: REPO, BRANCH, GH_TOKEN
set -euo pipefail
: "${REPO:?}" "${BRANCH:?}"

gh auth setup-git >/dev/null
cd /tmp
gh repo clone "$REPO" app -- --quiet --depth 1 --branch "$BRANCH"
cd app

INSTALL=$(jq -r '.install // empty' .factory/setup.json 2>/dev/null || true)
PREVIEW=$(jq -r '.preview // empty' .factory/setup.json 2>/dev/null || true)
INSTALL="${INSTALL:-npm ci}"
PREVIEW="${PREVIEW:-npm run build && npm run start -- -p \$PORT -H 0.0.0.0}"
export PORT=3000

echo "[preview] $REPO @ $BRANCH: $INSTALL"
bash -lc "$INSTALL"
echo "[preview] Start: $PREVIEW"
exec bash -lc "$PREVIEW"
