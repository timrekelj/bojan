#!/bin/sh
# Prepares the repo checkout, then runs the OpenCode V2 server in the foreground.
set -eu

REPO_URL="${REPO_URL:-https://github.com/timrekelj/bojan.git}"
REPO_DIR="${REPO_DIR:-/workspace/bojan}"
PORT="${OPENCODE_PORT:-4096}"

# Basic auth password for every client. OpenCode reads OPENCODE_PASSWORD (username is always
# `opencode`). Without it the server would generate a random one at each start.
: "${OPENCODE_PASSWORD:=${OPENCODE_SERVER_PASSWORD:-}}"
if [ -z "$OPENCODE_PASSWORD" ]; then
  echo "[opencode-agent] OPENCODE_PASSWORD is not set: self-building is not configured, idling" >&2
  exec sleep infinity
fi
export OPENCODE_PASSWORD

git config --global user.name "bojan-bot"
git config --global user.email "${GIT_EMAIL:-bojan-bot@users.noreply.github.com}"
git config --global init.defaultBranch main
git config --global --add safe.directory "$REPO_DIR"

if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git
  echo "[opencode-agent] git credential helper configured via gh"
else
  echo "[opencode-agent] GH_TOKEN not set: pushing and PRs will fail" >&2
fi

if [ -d "$REPO_DIR/.git" ]; then
  echo "[opencode-agent] fetching $REPO_DIR"
  git -C "$REPO_DIR" fetch --prune origin
else
  echo "[opencode-agent] cloning $REPO_URL into $REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi

echo "[opencode-agent] npm ci"
(cd "$REPO_DIR" && npm ci --no-audit --no-fund)

cd "$REPO_DIR"
echo "[opencode-agent] starting opencode serve on 0.0.0.0:$PORT"
exec opencode serve --hostname 0.0.0.0 --port "$PORT"
