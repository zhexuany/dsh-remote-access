#!/bin/sh
# Run every test that needs no Host process, no tunnel and no network.
#
#   test/run-tests.sh                      # offline: unit + client panel
#   test/run-tests.sh https://<tunnel-host> [cookie-name=cookie-value]
#                                          # also runs the panel against a live tunnel
#
# The DSH Desktop app ships its own Node runtime, so the tests run through
# `ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness>"` when no `node` is on PATH.
set -e

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SELF_DIR/.." && pwd)

APP="${DSH_NEXT_APP:-}"
if [ -z "$APP" ]; then
  for candidate in "/Applications/DeepSeek Harness.app" "$HOME/Applications/DeepSeek Harness.app"; do
    if [ -x "$candidate/Contents/MacOS/DeepSeek Harness" ]; then
      APP="$candidate"
      break
    fi
  done
fi

if [ -n "$APP" ]; then
  # the packaged app keeps its npm tree inside app.asar; only Electron's asar-aware
  # require() can reach it, which is exactly how the panel test runs below
  if [ -f "$APP/Contents/Resources/app.asar" ]; then
    DSH_NEXT_APP_ROOT="$APP/Contents/Resources/app.asar"
  else
    DSH_NEXT_APP_ROOT="$APP/Contents/Resources/app"
  fi
  export DSH_NEXT_APP_ROOT
fi

run() {
  if [ -n "$APP" ] && [ -x "$APP/Contents/MacOS/DeepSeek Harness" ]; then
    env ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" "$@"
  elif command -v node >/dev/null 2>&1; then
    node "$@"
  else
    echo "run-tests: no DSH Desktop app and no node runtime found (set DSH_NEXT_APP to the DeepSeek Harness .app path)" >&2
    exit 127
  fi
}

echo "== host service unit (loopback link + access probe + retired switch) =="
run "$ROOT/test/service-unit.mjs"

echo
echo "== installer unit (profile manifest + managed mux heartbeat block) =="
run "$ROOT/test/installer-unit.mjs"

echo
echo "== websocket primitives unit (handshake + frame codec) =="
run "$ROOT/test/ws-unit.mjs"

echo
echo "== stream strip unit (history replay optimisation) =="
run "$ROOT/test/stream-strip-unit.mjs"

echo
echo "== mux chunk unit (DSHD1 downlink framing) =="
run "$ROOT/test/mux-chunk-unit.mjs"

echo
echo "== mux proxy unit (compressed tunnel transport) =="
run "$ROOT/test/mux-proxy-unit.mjs"

echo
echo "== fs browse unit (remote folder chooser) =="
run "$ROOT/test/fs-browse-unit.mjs"

echo
echo "== client panel smoke =="
if [ -n "$1" ]; then
  if [ -n "$2" ]; then
    run "$ROOT/test/client-smoke.mjs" --live "$1" --cookie "$2"
  else
    run "$ROOT/test/client-smoke.mjs" --live "$1"
  fi
else
  run "$ROOT/test/client-smoke.mjs"
fi

echo
echo "== client panel under real React (react + react-dom + jsdom) =="
for mode in ready refused unknown; do
  status=0
  run "$ROOT/test/client-react.mjs" --mode "$mode" || status=$?
  if [ "$status" = 2 ]; then
    echo "client-react: skipped — install the test deps (see README §8) to run this suite"
    break
  fi
  if [ "$status" != 0 ]; then
    exit "$status"
  fi
done

echo
echo "all tests passed"
