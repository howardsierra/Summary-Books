#!/usr/bin/env bash
# Runs the test suites.
#
#   tests/run.sh                 unit tests + every browser suite
#   tests/run.sh unit            unit tests only (no SillyTavern needed)
#   tests/run.sh core memory     unit tests + the named browser suites
#
# Browser suites need a SillyTavern checkout with `npm install` done:
#   ST_DIR=/path/to/SillyTavern tests/run.sh
# The script copies the extension into ST_DIR, starts SillyTavern on port
# 8000 if it isn't running, and starts the two fake model servers.
# Playwright must be installed (npm i -D playwright, or globally).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
OUT="${PS_TEST_OUT:-$HERE/.out}"
export PS_TEST_OUT="$OUT"
mkdir -p "$OUT"
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"

ALL_SUITES=(core memory world callboard sidecar-profile sidecar-model branches budget touch windows launcher race)
status=0

echo "━━ unit tests"
node --test --import "$HERE/unit/setup.mjs" "$HERE"/unit/*.test.mjs || status=1
[ "${1:-}" = "unit" ] && exit $status

SUITES=("$@")
[ ${#SUITES[@]} -eq 0 ] && SUITES=("${ALL_SUITES[@]}")

if [ -z "${ST_DIR:-}" ]; then
  echo "ST_DIR is not set: skipping browser suites (set it to a SillyTavern checkout)." >&2
  exit $status
fi

# Install a copy of the extension (a symlink would make SillyTavern's
# auto-update run git in this repo).
DEST="$ST_DIR/data/default-user/extensions/private-scenes"
mkdir -p "$DEST"
rm -rf "$DEST/src"
cp -r "$REPO/index.js" "$REPO/manifest.json" "$REPO/style.css" "$REPO/src" "$DEST/"

ST_URL="${ST_URL:-http://127.0.0.1:8000}"
started_st=""
if ! curl -s -o /dev/null "$ST_URL/"; then
  (cd "$ST_DIR" && node server.js --port 8000 --listen false > "$OUT/sillytavern.log" 2>&1 &)
  started_st=1
  for _ in $(seq 1 60); do curl -s -o /dev/null "$ST_URL/" && break; sleep 1; done
fi

MOCK_PORT="${MOCK_PORT:-5005}" SIDECAR_PORT="${SIDECAR_PORT:-5006}"
node "$HERE/mock-llm.mjs" "$OUT/requests.log" "$MOCK_PORT" > "$OUT/mock.log" 2>&1 &
MOCK_PID=$!
node "$HERE/mock-llm.mjs" "$OUT/requests-side.log" "$SIDECAR_PORT" > "$OUT/mock-side.log" 2>&1 &
SIDE_PID=$!
cleanup() {
  kill $MOCK_PID $SIDE_PID 2>/dev/null
  [ -n "$started_st" ] && pkill -f "node server.js --port 8000" 2>/dev/null
}
trap cleanup EXIT
sleep 1

for name in "${SUITES[@]}"; do
  file="$HERE/e2e/$name.js"
  if [ ! -f "$file" ]; then echo "no suite named $name" >&2; status=1; continue; fi
  node "$file" || status=1
done
[ $status -eq 0 ] && echo "ALL PASSED" || echo "SOME TESTS FAILED"
exit $status
