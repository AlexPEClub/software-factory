#!/usr/bin/env bash
# Startet einen Factory-Job: Repo holen, Branch auschecken, gewählten Agent mit Playbook laufen lassen.
# Erwartet: REPO, ISSUE, BRANCH, AGENT, MODEL, WORKFLOW, GH_TOKEN und den passenden Agent-Login
# und /work/prompt.md (vom Runner geschrieben).
set -euo pipefail

log() { echo "[factory] $*"; }

: "${REPO:?}" "${ISSUE:?}" "${BRANCH:?}"
AGENT="${AGENT:-claude}"
export PHASE="${PHASE:-build}"   # check = prüfen, build = entwickeln, accept = unabhängige Abnahme
WORKFLOW="${WORKFLOW:-starter-kit}"
export AGENT WORKFLOW

# Workflow-Skills als Nutzer-Skills bereitstellen (landen nicht im Ziel-Repo)
case "$AGENT" in
  claude) SKILLS_DIR="$HOME/.claude/skills" ;;
  codex) SKILLS_DIR="$HOME/.agents/skills" ;;
  *) echo "Unbekannter Agent: $AGENT" >&2; exit 2 ;;
esac
mkdir -p "$SKILLS_DIR"
if [ -d "/factory/workflows/$WORKFLOW/skills" ]; then
  cp -r "/factory/workflows/$WORKFLOW/skills/." "$SKILLS_DIR/"
fi

gh auth setup-git >/dev/null
GH_LOGIN=$(gh api user --jq .login)
GH_ID=$(gh api user --jq .id)
git config --global user.name "$GH_LOGIN (Software Factory)"
git config --global user.email "${GH_ID}+${GH_LOGIN}@users.noreply.github.com"
git config --global init.defaultBranch main

cd /work
if [ ! -d repo/.git ]; then
  log "Klone $REPO"
  gh repo clone "$REPO" repo -- --quiet
fi
cd repo
git fetch --quiet origin
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  # Die Abnahme startet immer mit genau dem gepushten Stand, ohne Reste früherer Läufe
  if [ "$PHASE" = "accept" ]; then git reset --quiet --hard "origin/$BRANCH" && git clean -ffdxq; fi
else
  git checkout --quiet -B "$BRANCH" "origin/$DEFAULT_BRANCH"
fi

# Abhängigkeiten installieren (zum Entwickeln und für die Abnahme nötig)
if [ "$PHASE" != "check" ] && [ -f .factory/setup.json ]; then
  INSTALL=$(jq -r '.install // empty' .factory/setup.json)
  if [ -n "$INSTALL" ]; then
    log "Setup: $INSTALL"
    bash -lc "$INSTALL" > /work/setup.log 2>&1 || log "Setup fehlgeschlagen (siehe /work/setup.log), der Agent kümmert sich"
  fi
fi

export FACTORY_DEFAULT_BRANCH="$DEFAULT_BRANCH"
log "Starte $AGENT (${MODEL:-CLI-Standard}, Phase: $PHASE, Workflow: $WORKFLOW) für $REPO#$ISSUE auf $BRANCH"
set +e
factory-agent /factory/playbook.md < /work/prompt.md
CODE=$?
set -e
log "$AGENT beendet mit Exit-Code $CODE"
exit $CODE
