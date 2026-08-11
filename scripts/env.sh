#!/usr/bin/env bash
# Source this to use the project-pinned toolchain and load .env.
#   source scripts/env.sh
#
# Go 1.25.1 lives OUTSIDE the repo (~/.local/share/flare-dora-toolchain) so its
# ~14.5k files never touch the project tree or the IDE's index. The FCC scaffold
# tooling requires 1.25.1+; the system Go is left alone.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLDIR="${FLARE_TOOLCHAIN:-$HOME/.local/share/flare-dora-toolchain}"

if [ -x "$TOOLDIR/go/bin/go" ]; then
  export GOROOT="$TOOLDIR/go"
  export PATH="$GOROOT/bin:$PATH"
else
  echo "warn: pinned Go not found at $TOOLDIR — run scripts/install-toolchain.sh" >&2
fi

[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
echo "go $(go version 2>/dev/null | awk '{print $3}')  |  chain ${CHAIN_ID:-unset}  |  deployer ${INITIAL_OWNER:-unset}"
