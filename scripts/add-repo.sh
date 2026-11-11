#!/usr/bin/env bash
# Bindet ein GitHub-Repo an die Factory an: legt die Labels an, trägt das Repo in die Config ein
# und verknüpft es mit dem Board. Gibt es noch kein Board, wird eins angelegt.
#   ./scripts/add-repo.sh besitzer/repo
# Für jedes weitere Repo einfach erneut ausführen; alle Repos teilen sich ein Board.
set -euo pipefail
REPO="${1:?Aufruf: ./scripts/add-repo.sh besitzer/repo}"
CONF="${FACTORY_CONFIG:-/etc/software-factory/config.json}"

gh repo view "$REPO" --json name >/dev/null 2>&1 || { echo "Repo $REPO nicht gefunden oder kein Zugriff (gh auth status prüfen)."; exit 1; }

label() { gh label create "$1" -R "$REPO" --color "$2" --description "$3" --force >/dev/null; echo "  ✓ $1"; }
echo "Labels in $REPO:"
label "factory"                "5319E7" "Die Software Factory soll dieses Issue bearbeiten"
label "factory:new"            "D4C5F9" "Factory: Neu, noch nicht geprüft"
label "factory:checking"       "BFD4F2" "Factory: prüft Spec bzw. Bug-Beschreibung"
label "factory:question"       "FBCA04" "Factory: Rückfrage, braucht eine Antwort von dir"
label "factory:rejected"       "B60205" "Factory: so nicht baubar, Spec überarbeiten"
label "factory:approved"       "8250DF" "Factory: freigegeben, wartet auf freien Platz"
label "factory:working"        "F9A03F" "Factory: in Arbeit (Architektur, Umsetzung, Tests)"
label "factory:accepting"      "1D76DB" "Factory: unabhängige Abnahme läuft"
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

# Factory-Repo für den Verbesserungs-Lauf: deine eigene Kopie (Fork), aus der dieser Server installiert wurde
if [ -f "$CONF" ] && jq -e '.factoryRepo == "AUTO"' "$CONF" >/dev/null 2>&1; then
  ORIGIN=$(git -C "$(dirname "$0")/.." remote get-url origin 2>/dev/null | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
  ME=$(gh api user --jq .login)
  if [ -n "$ORIGIN" ] && [ "${ORIGIN%%/*}" = "$ME" ]; then FR="$ORIGIN"; else FR=""; fi
  TMP=$(mktemp)
  jq --arg r "$FR" '.factoryRepo = $r' "$CONF" > "$TMP" && mv "$TMP" "$CONF"
  if [ -n "$FR" ]; then echo "Verbesserungs-Vorschläge landen in $FR."
  else echo "Hinweis: Für Verbesserungs-Vorschläge brauchst du eine eigene Kopie der Factory (Fork), siehe Anleitung."; fi
fi

# Board: vorhandenes verknüpfen, sonst einmalig anlegen
NEW_BOARD=0
if [ -f "$CONF" ]; then
  if ! jq -e '(.project.number | type) == "number" and .project.owner != "DEIN-GITHUB-NAME"' "$CONF" >/dev/null 2>&1; then
    OWNER="${REPO%%/*}"
    echo "Noch kein Board eingetragen, lege eins an ($OWNER):"
    NR=$(gh project create --owner "$OWNER" --title "Software Factory" --format json --jq .number) \
      || { echo "Board konnte nicht angelegt werden. Fehlt die Berechtigung? → gh auth refresh -s project"; exit 1; }
    TMP=$(mktemp)
    jq --arg o "$OWNER" --argjson n "$NR" '.project = {owner: $o, number: $n}' "$CONF" > "$TMP" && mv "$TMP" "$CONF"
    echo "  ✓ Board $NR angelegt und in $CONF eingetragen"
    NEW_BOARD=1
  fi
  OWNER=$(jq -r '.project.owner' "$CONF"); NR=$(jq -r '.project.number' "$CONF")
  gh project link "$NR" --owner "$OWNER" --repo "$REPO" >/dev/null 2>&1 && echo "Mit Board $OWNER/$NR verknüpft." || true
  URL=$(gh project view "$NR" --owner "$OWNER" --format json --jq .url 2>/dev/null || true)
  [ -n "$URL" ] && echo "Board: $URL"
fi

# Neues Board: Runner neu starten, damit er die Spalten einrichtet
if [ "$NEW_BOARD" = 1 ] && systemctl is-active --quiet software-factory 2>/dev/null; then
  systemctl restart software-factory && echo "Runner neu gestartet, die Spalten erscheinen in wenigen Sekunden."
fi
echo "Fertig. Die Factory übernimmt Issues mit Label 'factory' in $REPO ab der nächsten Minute."
