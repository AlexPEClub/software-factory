#!/usr/bin/env bash
# Bereitet ein GitHub-Repo für die Factory vor: legt die Labels an und trägt das Repo in die Config ein.
#   ./scripts/add-repo.sh besitzer/repo
set -euo pipefail
REPO="${1:?Aufruf: ./scripts/add-repo.sh besitzer/repo}"
CONF=/etc/software-factory/config.json

label() { gh label create "$1" -R "$REPO" --color "$2" --description "$3" --force >/dev/null; echo "  ✓ $1"; }
echo "Labels in $REPO:"
label "factory"                "5319E7" "Die Software Factory soll dieses Issue bearbeiten"
label "factory:new"            "D4C5F9" "Factory: Neu, noch nicht geprüft"
label "factory:checking"       "BFD4F2" "Factory: prüft Spec bzw. Bug-Beschreibung"
label "factory:question"       "FBCA04" "Factory: Rückfrage, braucht eine Antwort von dir"
label "factory:rejected"       "B60205" "Factory: so nicht baubar, Spec überarbeiten"
label "factory:approved"       "8250DF" "Factory: freigegeben, wartet auf freien Platz"
label "factory:working"        "F9A03F" "Factory: in Arbeit (Architektur, Umsetzung, Tests)"
label "factory:review"         "E99695" "Factory: PR bereit, du bist dran"
label "factory:done"           "0E8A16" "Factory: gemergt"
label "factory:failed"         "D93F0B" "Factory: technisch hängen geblieben"
# Labels aus der ersten Version entfernen
for old in queued triage investigating implementing verifying pr waiting; do gh label delete "factory:$old" -R "$REPO" --yes >/dev/null 2>&1 || true; done

if [ -f "$CONF" ]; then
  TMP=$(mktemp)
  jq --arg r "$REPO" '.repos = ((.repos // []) | map(select(. != "DEIN-GITHUB-NAME/dein-repo")) + [$r] | unique)' "$CONF" > "$TMP" && mv "$TMP" "$CONF"
  echo "In $CONF eingetragen."
fi

# Mit dem Board verknüpfen, falls eins konfiguriert ist
if [ -f "$CONF" ] && jq -e '.project.number' "$CONF" >/dev/null 2>&1; then
  OWNER=$(jq -r '.project.owner' "$CONF"); NR=$(jq -r '.project.number' "$CONF")
  gh project link "$NR" --owner "$OWNER" --repo "$REPO" >/dev/null 2>&1 && echo "Mit Board $OWNER/$NR verknüpft."
fi
echo "Fertig. Die Factory übernimmt Issues mit Label 'factory' in $REPO ab der nächsten Minute."
