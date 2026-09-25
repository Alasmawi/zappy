#!/usr/bin/env bash
# Starts a whole game: one server, one GUI bridge and a squad of bots.
#
#   ./scripts/play.sh [port] [nb_bots] [t]
#
# Stop everything with Ctrl-C.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-4242}"
BOTS="${2:-6}"
T="${3:-100}"
WIDTH="${WIDTH:-15}"
HEIGHT="${HEIGHT:-15}"
TEAM="${TEAM:-red}"
HTTP="${HTTP:-8080}"
LOGS="$ROOT/logs"

mkdir -p "$LOGS"
pids=()

cleanup() {
    echo
    echo "stopping..."
    for pid in "${pids[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
    done
    wait 2>/dev/null
}
trap cleanup EXIT INT TERM

if [ ! -x "$ROOT/server" ]; then
    echo "building the server..."
    make -C "$ROOT" || exit 1
fi

echo "server  : port $PORT, world ${WIDTH}x${HEIGHT}, t=$T, team '$TEAM'"
"$ROOT/server" -p "$PORT" -x "$WIDTH" -y "$HEIGHT" \
    -n "$TEAM" -c "$BOTS" -t "$T" >"$LOGS/server.log" 2>&1 &
pids+=($!)
sleep 0.5

if command -v node >/dev/null 2>&1; then
    echo "gui     : http://localhost:$HTTP"
    node "$ROOT/gui/zappy_gui.js" -p "$PORT" --http "$HTTP" \
        >"$LOGS/gui.log" 2>&1 &
    pids+=($!)
else
    echo "gui     : skipped (node is not installed)"
fi

for i in $(seq 1 "$BOTS"); do
    python3 "$ROOT/client_src/zappy_ai.py" -n "$TEAM" -p "$PORT" -v --no-spawn \
        >"$LOGS/bot$i.log" 2>&1 &
    pids+=($!)
    sleep 0.2
done
echo "bots    : $BOTS running, logs in $LOGS/"
echo
echo "Ctrl-C to stop."
wait
