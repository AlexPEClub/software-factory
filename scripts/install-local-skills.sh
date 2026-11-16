#!/usr/bin/env bash
# Installiert die lokalen Factory-Skills (init, write-spec, to-factory) einmalig auf deinem Rechner.
# Sie gelten dann in allen Projekten. Updates: im Factory-Repo "git pull", fertig (es sind Verknüpfungen).
#   ./scripts/install-local-skills.sh [claude|codex|both]
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/local-skills"
AGENT="${1:-claude}"
case "$AGENT" in
  claude) DEST="$HOME/.claude/skills" ;;
  codex) DEST="$HOME/.agents/skills" ;;
  both) bash "$0" claude; bash "$0" codex; exit ;;
  *) echo "Aufruf: $0 [claude|codex|both]" >&2; exit 2 ;;
esac
mkdir -p "$DEST"
for skill in "$SRC"/*/; do
  name=$(basename "$skill")
  if [ -e "$DEST/$name" ] && [ ! -L "$DEST/$name" ]; then
    mv "$DEST/$name" "$DEST/$name.backup-$(date +%Y%m%d%H%M%S)"
    echo "  vorhandenen Skill '$name' gesichert"
  fi
  ln -sfn "${skill%/}" "$DEST/$name"
  echo "  ✓ $AGENT: $name"
done
echo "Fertig. Die Skills stehen in jedem Projekt zur Verfügung."
