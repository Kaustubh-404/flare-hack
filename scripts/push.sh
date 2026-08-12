#!/usr/bin/env bash
#
# The only way this repo gets pushed.
#
#   ./scripts/push.sh
#
# Runs the secret audit and REFUSES to push if it fails. Written because a
# `check && git commit && git push` chain does not gate the push on the check's
# exit code — the audit printed DO NOT PUSH and the push went out anyway. It was
# a false positive that time. Relying on remembering to read the output is not a
# control.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! ./scripts/check-secrets.sh; then
  echo
  echo "🛑 push refused — the secret audit did not pass."
  echo "   Fix the finding, or mark a verified false positive with a 'not-a-secret'"
  echo "   comment on that line, then run this again."
  exit 1
fi

echo
git push "$@"
