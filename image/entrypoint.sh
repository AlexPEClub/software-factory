#!/usr/bin/env bash
# Startet einen Factory-Job: Repo holen, Branch auschecken, Claude Code mit Playbook laufen lassen.
# Erwartet: REPO, ISSUE, BRANCH, MODEL, WORKFLOW, GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN (oder ANTHROPIC_API_KEY),
# FACTORY_LANGUAGE (Projektsprache, BCP 47, Standard de) und /work/prompt.md (vom Runner geschrieben). RESUME=1: Fortsetzung nach dem Nutzungslimit mit demselben
# Arbeitsstand und derselben Claude-Session.
set -euo pipefail
# Fehlermeldungen (git, gh …) ins selbe Log wie die übrigen Ausgaben: Der Runner zeigt dessen Ende,
# wenn der Job abbricht, bevor Claude startet. Claude selbst schreibt weiter nach /work/claude.err.
exec 2>&1

log() { echo "[factory] $*"; }

: "${REPO:?}" "${ISSUE:?}" "${BRANCH:?}"
MODEL="${MODEL:-opus}"
export PHASE="${PHASE:-build}"   # check = prüfen, build = entwickeln, accept = unabhängige Abnahme
WORKFLOW="${WORKFLOW:-starter-kit}"
RESUME="${RESUME:-}"
export FACTORY_LANGUAGE="${FACTORY_LANGUAGE:-de}"   # für factory-report, factory-verify und die Skills

# Workflow-Skills als Nutzer-Skills bereitstellen (landen nicht im Ziel-Repo)
mkdir -p "$HOME/.claude/skills"
if [ -d "/factory/workflows/$WORKFLOW/skills" ]; then
  cp -r "/factory/workflows/$WORKFLOW/skills/." "$HOME/.claude/skills/"
fi
# Claude-Sessions im Job-Ordner ablegen: Sie überleben den Container, damit ein Lauf nach dem Limit fortgesetzt werden kann
mkdir -p /work/claude-sessions
rm -rf "$HOME/.claude/projects"
ln -s /work/claude-sessions "$HOME/.claude/projects"

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
if [ "$RESUME" = "1" ] && [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$BRANCH" ]; then
  # Fortsetzung nach dem Nutzungslimit: lokaler Stand bleibt, auch nicht gepushte Commits und uncommittete Änderungen
  log "Fortsetzung auf dem lokalen Stand von $BRANCH"
else
  # Ein abgebrochener Lauf (Zeitlimit, Server-Neustart …) kann unfertige Änderungen hinterlassen.
  # Sie würden den Checkout blockieren; deshalb kommen sie in den Stash und bleiben dort wiederherstellbar.
  if [ -n "$(git status --porcelain)" ]; then
    log "Unfertige Änderungen eines früheren Laufs gefunden, lege sie im Stash ab"
    git stash push --quiet --include-untracked -m "factory: Reste vor Lauf $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      || { log "Stash nicht möglich, verwerfe die Reste"; git reset --quiet --hard; git clean -ffdq; }
  fi
  if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
    git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
    # Die Abnahme startet immer mit genau dem gepushten Stand, ohne Reste früherer Läufe
    if [ "$PHASE" = "accept" ]; then git reset --quiet --hard "origin/$BRANCH" && git clean -ffdxq; fi
  else
    git checkout --quiet -B "$BRANCH" "origin/$DEFAULT_BRANCH"
  fi
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

# Fortsetzung: Session des vorigen Laufs dieser Phase, falls sie noch vorhanden ist. Sonst normaler Lauf mit prompt.md.
SESSION_FILE=/work/claude-session
RESUME_ARGS=()
PROMPT="$(cat /work/prompt.md)"
if [ "$RESUME" = "1" ] && [ -s "$SESSION_FILE" ]; then
  SID=$(head -c 100 "$SESSION_FILE" | tr -cd 'a-zA-Z0-9-')
  if [ -n "$SID" ] && compgen -G "/work/claude-sessions/*/$SID.jsonl" >/dev/null; then
    RESUME_ARGS=(--resume "$SID")
    PROMPT="The run was interrupted by the Claude Code usage limit and is now being resumed. Continue exactly where you stopped (same phase, same rules, same output language: ${FACTORY_LANGUAGE:-de}). First check with git status and git log what is already done."
    log "Setze Claude-Session $SID fort"
  else
    log "Keine Session zum Fortsetzen gefunden, starte neu mit dem Arbeitsstand"
  fi
fi
[ "$RESUME" = "1" ] || rm -f "$SESSION_FILE"   # neue Phase oder neuer Versuch: alte Session gilt nicht mehr

log "Starte Claude Code ($MODEL, Phase: $PHASE, Workflow: $WORKFLOW) für $REPO#$ISSUE auf $BRANCH"
set +e
claude -p "$PROMPT" "${RESUME_ARGS[@]}" \
  --append-system-prompt-file /factory/playbook.md \
  --add-dir "/factory/workflows/$WORKFLOW" \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  > /work/claude.jsonl 2> /work/claude.err
CODE=$?
set -e
# Session-ID für eine mögliche Fortsetzung merken
SID=$(jq -Rr 'fromjson? | select(.type == "system" and .subtype == "init") | .session_id // empty' /work/claude.jsonl 2>/dev/null | head -n 1)
[ -n "$SID" ] && echo "$SID" > "$SESSION_FILE"
log "Claude Code beendet mit Exit-Code $CODE"
tail -n 1 /work/claude.jsonl | jq -r '"Ergebnis: " + ((.result // "-") | tostring | .[0:500])' 2>/dev/null || true
exit $CODE
