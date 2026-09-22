#!/usr/bin/env bash
# ops/launchd/uninstall.sh -- remove the rendered mechameleon launchd
# plists. Never calls launchctl itself -- only prints the bootout commands
# the operator runs first (a running agent must be booted out before its
# plist file is deleted).
set -euo pipefail

TARGET_DIR="$HOME/Library/LaunchAgents"
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --target-dir) TARGET_DIR="${2:?--target-dir requires a directory}"; shift 2 ;;
    *) echo "uninstall.sh: unknown argument: $1" >&2; exit 1 ;;
  esac
done

PLISTS=""
for name in com.mechameleon.server.plist com.mechameleon.cloudflared.plist; do
  plist_path="$TARGET_DIR/$name"
  if [ -f "$plist_path" ]; then
    echo "launchctl bootout gui/$(id -u) $plist_path"
    PLISTS="$PLISTS $plist_path"
  fi
done

if [ -z "$PLISTS" ]; then
  echo "uninstall.sh: nothing to remove in $TARGET_DIR"
  exit 0
fi

if [ "$YES" -eq 0 ]; then
  printf 'Remove rendered plists from %s? [y/N] ' "$TARGET_DIR"
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) : ;;
    *) echo "uninstall.sh: left plists in place"; exit 0 ;;
  esac
fi

for plist_path in $PLISTS; do
  rm -f "$plist_path"
done
echo "uninstall.sh: removed:$PLISTS"
