#!/usr/bin/env bash
# Usage: source infra/scripts/bot-env.sh <bot-name>
# Sets GH_TOKEN, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL
# and configures git credential for the given bot's GitHub App identity.
#
# Valid bot names: backend-dev-bot  frontend-dev-bot  qa-dev-bot

set -euo pipefail

BOT="${1:-}"
if [[ -z "$BOT" ]]; then
  echo "Usage: source bot-env.sh <bot-name>" >&2
  return 1 2>/dev/null || exit 1
fi

AGENTS_DIR="$HOME/.agents"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_SCRIPT="$SCRIPT_DIR/get-github-token.py"

case "$BOT" in
  backend-dev-bot)
    APP_ID=3154069
    INSTALLATION_ID=118124537
    KEY_PATH="$AGENTS_DIR/backend-dev-bot/backend-dev-bot.2026-03-21.private-key.pem"
    BOT_EMAIL="backend-dev-bot[bot]@users.noreply.github.com"
    BOT_NAME="backend-dev-bot[bot]"
    ;;
  frontend-dev-bot)
    APP_ID=3157905
    INSTALLATION_ID=118239064
    KEY_PATH="$AGENTS_DIR/frontend-dev-bot/frontend-dev-bot.2026-03-22.private-key.pem"
    BOT_EMAIL="frontend-dev-bot[bot]@users.noreply.github.com"
    BOT_NAME="frontend-dev-bot[bot]"
    ;;
  qa-dev-bot)
    APP_ID=3157936
    INSTALLATION_ID=118239534
    KEY_PATH="$AGENTS_DIR/qa-dev-bot/qa-dev-bot.2026-03-22.private-key.pem"
    BOT_EMAIL="qa-dev-bot[bot]@users.noreply.github.com"
    BOT_NAME="qa-dev-bot[bot]"
    ;;
  *)
    echo "Unknown bot: $BOT. Valid: backend-dev-bot, frontend-dev-bot, qa-dev-bot" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

echo "Fetching installation token for $BOT..." >&2
GH_TOKEN="$(python3 "$TOKEN_SCRIPT" "$APP_ID" "$INSTALLATION_ID" "$KEY_PATH")"
export GH_TOKEN

export GIT_AUTHOR_NAME="$BOT_NAME"
export GIT_AUTHOR_EMAIL="$BOT_EMAIL"
export GIT_COMMITTER_NAME="$BOT_NAME"
export GIT_COMMITTER_EMAIL="$BOT_EMAIL"

# Configure git to use the token for github.com HTTPS
git config --global credential.helper store 2>/dev/null || true
echo "https://x-access-token:${GH_TOKEN}@github.com" | \
  git credential approve 2>/dev/null || true

echo "Bot $BOT is ready. GH_TOKEN set, git identity configured." >&2
