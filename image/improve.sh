#!/usr/bin/env bash
# Verbesserungs-Lauf: wertet die bisherigen Läufe aus und schlägt Änderungen am Playbook vor.
# Erwartet: REPO (Factory-Repo), GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN (oder ANTHROPIC_API_KEY), MODEL
# Daten unter /data (nur lesend), Arbeitsordner /work.
set -euo pipefail
: "${REPO:?}"
MODEL="${MODEL:-opus}"
export PHASE=improve

gh auth setup-git >/dev/null
GH_LOGIN=$(gh api user --jq .login); GH_ID=$(gh api user --jq .id)
git config --global user.name "$GH_LOGIN (Software Factory)"
git config --global user.email "${GH_ID}+${GH_LOGIN}@users.noreply.github.com"

rm -rf /work/repo
gh repo clone "$REPO" /work/repo -- --quiet
cd /work/repo
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
BRANCH="improve/$(date +%Y-%m-%d-%H%M)"
git checkout --quiet -b "$BRANCH"
export FACTORY_DEFAULT_BRANCH="$DEFAULT_BRANCH" FACTORY_METRICS=/data/metrics.jsonl

PLAYBOOK=/work/repo/playbooks/improve.md
[ -f "$PLAYBOOK" ] || PLAYBOOK=/factory/improve.md

RUNS=$(ls /data/runs 2>/dev/null | wc -l)
LINES=$(wc -l < /data/metrics.jsonl 2>/dev/null || echo 0)
echo "[improve] $LINES Läufe in den Metriken, $RUNS Zusammenfassungen, Branch $BRANCH"

set +e
claude -p "Werte die bisherigen Läufe der Software Factory aus und schlage Verbesserungen vor, wie im Verbesserungs-Playbook beschrieben. Factory-Repo: $REPO (geklont unter /work/repo, Branch $BRANCH, Standard-Branch $DEFAULT_BRANCH). Daten: /data/metrics.jsonl ($LINES Läufe) und /data/runs ($RUNS Zusammenfassungen)." \
  --append-system-prompt-file "$PLAYBOOK" \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  --output-format stream-json --verbose \
  > /work/claude.jsonl 2> /work/claude.err
CODE=$?
set -e
tail -n 1 /work/claude.jsonl | jq -r '"Ergebnis: " + ((.result // "-") | tostring | .[0:800])' 2>/dev/null || true
exit $CODE
