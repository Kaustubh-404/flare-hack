#!/usr/bin/env bash
# Installs the pinned Go outside the repo. Idempotent.
set -euo pipefail
GOVER=1.25.1
TOOLDIR="${FLARE_TOOLCHAIN:-$HOME/.local/share/flare-dora-toolchain}"
mkdir -p "$TOOLDIR"
if [ -x "$TOOLDIR/go/bin/go" ] && "$TOOLDIR/go/bin/go" version | grep -q "go$GOVER"; then
  echo "already installed: $("$TOOLDIR/go/bin/go" version)"; exit 0
fi
curl -sSL "https://go.dev/dl/go${GOVER}.linux-amd64.tar.gz" -o "$TOOLDIR/go.tgz"
tar xzf "$TOOLDIR/go.tgz" -C "$TOOLDIR" && rm "$TOOLDIR/go.tgz"
echo "installed: $("$TOOLDIR/go/bin/go" version)  →  $TOOLDIR"
