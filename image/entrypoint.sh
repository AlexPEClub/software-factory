#!/usr/bin/env bash
# Startet einen Factory-Job: Repo holen, Branch auschecken, Claude Code mit Playbook laufen lassen.
# Erwartet: REPO, ISSUE, BRANCH, MODEL, WORKFLOW, GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN (oder ANTHROPIC_API_KEY)
# und /work/prompt.md (vom Runner geschrieben).
set -euo pipefail

log() { echo "[factory] $*"; }

: "${REPO:?}" "${ISSUE:?}" "${BRANCH:?}"
MODEL="${MODEL:-opus}"
WORKFLOW="${WORKFLOW:-starter-kit}"

# Workflow-Skills als Nutzer-Skills bereitstellen (landen nicht im Ziel-Repo)
mkdir -p "$HOME/.claude/skills"
if [ -d "/factory/workflows/$WORKFLOW/skills" ]; then
  cp -r "/factory/workflows/$WORKFLOW/skills/." "$HOME/.claude/skills/"
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
else
  git checkout --quiet -B "$BRANCH" "origin/$DEFAULT_BRANCH"
fi

# Abhängigkeiten installieren, falls das Repo ein Setup-Rezept hat
if [ -f .factory/setup.json ]; then
  INSTALL=$(jq -r '.install // empty' .factory/setup.json)
  if [ -n "$INSTALL" ]; then
    log "Setup: $INSTALL"
    bash -lc "$INSTALL" > /work/setup.log 2>&1 || log "Setup fehlgeschlagen (siehe /work/setup.log), der Agent kümmert sich"
  fi
fi

export FACTORY_DEFAULT_BRANCH="$DEFAULT_BRANCH"
log "Starte Claude Code ($MODEL, Workflow: $WORKFLOW) für $REPO#$ISSUE auf $BRANCH"
set +e
claude -p "$(cat /work/prompt.md)" \
  --append-system-prompt-file /factory/playbook.md \
  --add-dir "/factory/workflows/$WORKFLOW" \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  > /work/claude.jsonl 2> /work/claude.err
CODE=$?
set -e
log "Claude Code beendet mit Exit-Code $CODE"
tail -n 1 /work/claude.jsonl | jq -r '"Ergebnis: " + ((.result // "-") | tostring | .[0:500])' 2>/dev/null || true
exit $CODE
