#!/usr/bin/env bash
#
# Pre-push secret audit. Run before every push.
#
#   ./scripts/check-secrets.sh
#
# Uses /usr/bin/grep explicitly. A plain `grep` may be a wrapper around ugrep
# with --ignore-files, which honours .gitignore — that silently skips .env and
# makes a secret scan report "clean" without having looked at the one file most
# likely to contain a key. Do not "simplify" this back to bare grep.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
GREP=/usr/bin/grep
fail=0

echo "── 1. secret-shaped paths in the tracked tree ──"
if git ls-files | $GREP -iE "(^|/)(\.env$|\.env\.[^e]|secrets?/|.*wallet.*\.(md|json|txt)|.*\.(key|pem|seed)$)" ; then
  echo "  ❌ tracked path looks secret-bearing"; fail=1
else
  echo "  ✅ none"
fi

echo "── 2. private keys / seeds inside tracked file contents ──"
# 64-hex private keys, XRPL family seeds (s...), PEM blocks, populated env vars
PATTERN='(^|[^0-9a-fA-Fx])[0-9a-fA-F]{64}([^0-9a-fA-F]|$)|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bs[1-9A-HJ-NP-Za-km-z]{28,}\b|(PRIVATE_KEY|SECRET|SEED|MNEMONIC)=["'"'"']?[^"'"'"'[:space:]]+'
# Lines carrying an explicit `not-a-secret` marker are exempt. This is
# deliberately per-line rather than per-file: excluding whole test directories
# is where a real key would eventually hide.
hits=$(git ls-files -z | xargs -0 $GREP -nIE "$PATTERN" 2>/dev/null \
        | $GREP -vE '^(package-lock\.json|.*\.example):' \
        | $GREP -vE 'integrity"|sha512-|sha256-' \
        | $GREP -vE '^packages/contracts/lib/' \
        | $GREP -v 'not-a-secret')             # vendored forge-std, read-only
if [ -n "$hits" ]; then
  echo "$hits" | head -20; echo "  ❌ possible secret in tracked content"; fail=1
else
  echo "  ✅ none"
fi

echo "── 3. history (secrets survive in old commits) ──"
if git log --all --pretty=format: --name-only 2>/dev/null \
   | sort -u | $GREP -iE "(^|/)(\.env$|secrets?/|.*wallet.*\.(md|json)|.*\.(key|pem|seed)$)"; then
  echo "  ❌ secret-bearing path exists in history"; fail=1
else
  echo "  ✅ none"
fi

echo "── 4. live keys on disk must all be gitignored ──"
if [ -f .env ]; then
  # A real value: at least 20 non-space chars right after '=', no leading comment.
  for f in $($GREP -rlE '^(DEPLOYER_PRIVATE_KEY|XRPL_SEED)="?[^[:space:]#"]{20,}' . \
              --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=lib 2>/dev/null); do
    if git check-ignore -q "$f"; then
      echo "  ✅ ignored: $f"
    else
      echo "  ❌ NOT IGNORED: $f"; fail=1
    fi
  done
fi

echo
if [ "$fail" -eq 0 ]; then echo "✅ safe to push"; else echo "❌ DO NOT PUSH"; fi
exit $fail
