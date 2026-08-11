#!/usr/bin/env bash
# Source this to use the project-pinned toolchain.
#   source scripts/env.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GOROOT="$ROOT/.toolchain/go"
export PATH="$GOROOT/bin:$PATH"
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
echo "go $(go version | awk '{print $3}')  |  chain ${CHAIN_ID:-unset}"
