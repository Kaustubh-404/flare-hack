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

# Private keys Flare publishes in fce-extension-scaffold. They are already on
# GitHub, so committing the vendored scaffold adds no exposure — but they are
# allowlisted by exact value, not by path, so any OTHER 64-hex key in those same
# files still trips the scan.
#
# Our own .env overrides PROXY_PRIVATE_KEY with the real deployer key, so the
# scaffold default is never actually used.
KNOWN_PUBLIC_KEYS=(
  983760a4ebf75b2ac3a93531168a0f225d01e5dc6e3568adbd46233ba1fb4fa4  # scaffold PROXY_PRIVATE_KEY default
  804b01a8c27a65cc694a867be76edae3ccce7a7161cda1f67a8349df696d2207  # scaffold devnet funded key
)

# Third-party code we vendored unmodified, scanned as a tree rather than
# per-line — the same treatment forge-std gets. It is full of doc placeholders,
# platform constants and test fixtures that look like keys and are not.
#
# The line is drawn at authorship, not convenience: everything WE wrote is still
# scanned, including extension/typescript/src/app and extension/contracts, which
# are deliberately absent from this list.
VENDORED='^(packages/contracts/lib/|extension/(docs|testing|docker|proxy|python|go|scripts|tools|testdata|results|config)/)'

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
        | $GREP -v 'not-a-secret' \
        | $GREP -vE "$VENDORED" \
        | $GREP -vFf <(printf '%s\n' "${KNOWN_PUBLIC_KEYS[@]}"))
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
