#!/usr/bin/env bash
# Bereitet ein GitHub-Repo für die Factory vor: legt die Labels an und trägt das Repo in die Config ein.
#   ./scripts/add-repo.sh besitzer/repo
set -euo pipefail
REPO="${1:?Aufruf: ./scripts/add-repo.sh besitzer/repo}"
CONF=/etc/software-factory/config.json

label() { gh label create "$1" -R "$REPO" --color "$2" --description "$3" --force >/dev/null; echo "  ✓ $1"; }
echo "Labels in $REPO:"
label "factory"              "5319E7" "Die Software Factory soll dieses Issue bearbeiten"
label "factory:queued"       "C5DEF5" "Factory: wartet auf einen freien Platz"
label "factory:triage"       "BFD4F2" "Factory: prüft das Issue"
label "factory:investigating" "BFD4F2" "Factory: analysiert"
label "factory:implementing" "1D76DB" "Factory: setzt um"
label "factory:verifying"    "1D76DB" "Factory: prüft das Ergebnis"
label "factory:pr"           "0E8A16" "Factory: Pull Request ist fertig"
label "factory:waiting"      "FBCA04" "Factory: braucht eine Entscheidung von dir"
label "factory:failed"       "D93F0B" "Factory: kommt nicht weiter"
label "factory:done"         "006B75" "Factory: gemergt"

if [ -f "$CONF" ]; then
  TMP=$(mktemp)
  jq --arg r "$REPO" '.repos = ((.repos // []) | map(select(. != "DEIN-GITHUB-NAME/dein-repo")) + [$r] | unique)' "$CONF" > "$TMP" && mv "$TMP" "$CONF"
  echo "In $CONF eingetragen."
fi
