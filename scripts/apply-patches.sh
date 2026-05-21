#!/bin/sh
# apply-patches.sh — apply patches/ to node_modules after pnpm install.
#
# patch-package v8 does not detect pnpm's lockfile (pnpm-lock.yaml), so we
# use the standard `patch` utility directly instead (CLOSEOUT-07 / D-12).
#
# Usage: called automatically by pnpm postinstall hook.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCHES_DIR="$REPO_ROOT/patches"
NODE_MODULES="$REPO_ROOT/node_modules"

if [ ! -d "$PATCHES_DIR" ]; then
  echo "apply-patches: no patches/ directory, skipping."
  exit 0
fi

for PATCH in "$PATCHES_DIR"/*.patch; do
  [ -f "$PATCH" ] || continue
  BASENAME=$(basename "$PATCH" .patch)
  PKG_NAME=$(echo "$BASENAME" | sed 's/+[0-9][^+]*$//')
  PKG_DIR="$NODE_MODULES/$PKG_NAME"

  if [ ! -d "$PKG_DIR" ]; then
    echo "apply-patches: WARNING: package directory $PKG_DIR not found, skipping $PATCH"
    continue
  fi

  # Check if already applied (patch --dry-run -R succeeds = already applied)
  if patch --dry-run -R -p1 -d "$PKG_DIR" < "$PATCH" >/dev/null 2>&1; then
    echo "apply-patches: $BASENAME already applied, skipping."
    continue
  fi

  echo "apply-patches: applying $BASENAME..."
  patch -p1 -d "$PKG_DIR" < "$PATCH"
  echo "apply-patches: $BASENAME applied successfully."
done
