#!/usr/bin/env bash
# Bindet ein GitHub-Repo an die Factory an: legt die Labels und die GitHub-Umgebungen staging und production an,
# trägt das Repo in die Config ein und verknüpft es mit dem Board. Gibt es noch kein Board, wird eins angelegt.
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
# Betrieb: Alarme (Runner) und Deploy-Fehler (Pipeline). Diese Issues bearbeitet die Factory nie von selbst.
label "incident"               "E11D21" "Alarm aus Monitoring oder Watchdog, nie automatisch Aufgabe der Factory"
label "deploy-failed"          "B60205" "Deploy fehlgeschlagen, von der Pipeline gemeldet"
# Labels aus der ersten Version entfernen
for old in queued triage investigating implementing verifying pr waiting; do gh label delete "factory:$old" -R "$REPO" --yes >/dev/null 2>&1 || true; done

# GitHub-Umgebungen für die Pipeline (Betriebskonventionen, Abschnitt 13): Secrets für staging und production gibt es
# nur in Läufen auf main, production braucht zusätzlich die Freigabe des Repo-Besitzers.
ERR=$(mktemp)
only_main() { # UMGEBUNG
  local have
  have=$(gh api "repos/$REPO/environments/$1/deployment-branch-policies" --jq '.branch_policies[] | select(.type != "tag") | .name' 2>/dev/null || true)
  grep -qx main <<<"$have" || gh api -X POST "repos/$REPO/environments/$1/deployment-branch-policies" -f name=main -f type=branch >/dev/null
}
environment() { # UMGEBUNG JSON [JSON-ohne-Freigabe] [Hinweis]
  local note="${4:-}"
  if printf '%s' "$2" | gh api -X PUT "repos/$REPO/environments/$1" --input - >/dev/null 2>"$ERR"; then :
  elif [ -n "${3:-}" ] && printf '%s' "$3" | gh api -X PUT "repos/$REPO/environments/$1" --input - >/dev/null 2>>"$ERR"; then
    note=""
    echo "  ! $1 ohne Pflicht-Freigabe angelegt. GitHub erlaubt Freigaben in privaten Repos erst ab GitHub Pro/Team."
    echo "    Bis dahin: production-Deploys nur von Hand starten, Freigabe später unter Settings → Environments setzen."
  else
    echo "  ! Umgebung $1 nicht angelegt: $(tr '\n' ' ' < "$ERR")"; return 0
  fi
  if only_main "$1" 2>>"$ERR"; then echo "  ✓ $1 (nur Branch main$note)"
  else echo "  ! $1 angelegt, Branch-Regel main fehlt: $(tr '\n' ' ' < "$ERR")"; fi
}
echo "Umgebungen in $REPO:"
BRANCHES='"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}'
environment staging "{$BRANCHES}"
OWNER_TYPE=$(gh api "repos/$REPO" --jq .owner.type)
OWNER_ID=$(gh api "repos/$REPO" --jq .owner.id)
if [ "$OWNER_TYPE" = "User" ]; then
  environment production "{\"reviewers\": [{\"type\": \"User\", \"id\": $OWNER_ID}], \"prevent_self_review\": false, $BRANCHES}" "{$BRANCHES}" ", Freigabe durch ${REPO%%/*}"
else
  environment production "{$BRANCHES}" "" ""
  echo "  ! ${REPO%%/*} ist eine Organisation: Pflicht-Freigabe für production unter Settings → Environments selbst eintragen."
fi
rm -f "$ERR"

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
