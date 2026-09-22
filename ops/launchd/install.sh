#!/usr/bin/env bash
# ops/launchd/install.sh -- render (and, outside --dry-run, install) the
# mechameleon launchd agents. Never calls launchctl itself -- it only
# prints the commands the operator runs to load/start the rendered agents.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$SCRIPT_DIR" && git rev-parse --show-toplevel)
NODE_BIN=$(command -v node) || { echo "install.sh: node not found on PATH" >&2; exit 1; }
NODE_DIR=$(dirname -- "$NODE_BIN")
CLOUDFLARED_BIN=$(command -v cloudflared) || { echo "install.sh: cloudflared not found on PATH" >&2; exit 1; }
PORT="${PORT:-3101}"
CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/mecha-config.yml}"
HOME_DIR="$HOME"

DRY_RUN=0
TARGET_DIR="$HOME/Library/LaunchAgents"
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  TARGET_DIR="${2:?install.sh --dry-run requires a target directory}"
fi

render() {
  sed \
    -e "s#__REPO__#$REPO#g" \
    -e "s#__NODE_DIR__#$NODE_DIR#g" \
    -e "s#__CLOUDFLARED__#$CLOUDFLARED_BIN#g" \
    -e "s#__CONFIG__#$CONFIG#g" \
    -e "s#__PORT__#$PORT#g" \
    -e "s#__HOME__#$HOME_DIR#g" \
    "$1" > "$2"
}

mkdir -p "$TARGET_DIR"
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$HOME/Library/Logs/mechameleon"
fi

render "$SCRIPT_DIR/com.mechameleon.server.plist.template" "$TARGET_DIR/com.mechameleon.server.plist"
render "$SCRIPT_DIR/com.mechameleon.cloudflared.plist.template" "$TARGET_DIR/com.mechameleon.cloudflared.plist"

echo "Rendered:"
echo "  $TARGET_DIR/com.mechameleon.server.plist"
echo "  $TARGET_DIR/com.mechameleon.cloudflared.plist"
echo
echo "To load and start them, run:"
echo "  launchctl bootstrap gui/$(id -u) $TARGET_DIR/com.mechameleon.server.plist"
echo "  launchctl kickstart gui/$(id -u)/com.mechameleon.server"
echo "  launchctl bootstrap gui/$(id -u) $TARGET_DIR/com.mechameleon.cloudflared.plist"
echo "  launchctl kickstart gui/$(id -u)/com.mechameleon.cloudflared"
if [ "$DRY_RUN" -eq 0 ]; then
  echo "Logs: $HOME/Library/Logs/mechameleon/{server,cloudflared}.{out,err}.log"
fi
