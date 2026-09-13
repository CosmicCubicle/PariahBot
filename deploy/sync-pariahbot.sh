#!/usr/bin/env bash
# Polls GitHub for new commits and redeploys PariahBot.
set -euo pipefail

REPO_DIR="/opt/PariahBot"
LOG="/opt/PariahBot/sync.log"
BRANCH="master"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd "$REPO_DIR"
LOCAL=$(git rev-parse "$BRANCH")
git fetch origin "$BRANCH" --quiet
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi

echo "$(date -Is) syncing $LOCAL -> $REMOTE" >> "$LOG"
PKG_BEFORE=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo "")
COMMANDS_CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" -- commands/ deploy-commands.js)
git reset --hard "origin/$BRANCH" >> "$LOG" 2>&1
PKG_AFTER=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo "")

if [ "$PKG_BEFORE" != "$PKG_AFTER" ]; then
  npm install --omit=dev >> "$LOG" 2>&1
fi
if [ -n "$COMMANDS_CHANGED" ]; then
  node deploy-commands.js >> "$LOG" 2>&1
fi

sudo /usr/bin/systemctl restart pariahbot.service
echo "$(date -Is) deployed $REMOTE, service restarted" >> "$LOG"