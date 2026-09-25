#!/usr/bin/env bash
# Runs a headless game for a while and reports what the bots achieved.
# Used to check the AI actually progresses:
#
#   ./scripts/simulate.sh [seconds] [nb_bots] [t]
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECS="${1:-60}"
BOTS="${2:-6}"
T="${3:-100}"
PORT="${PORT:-$((4300 + RANDOM % 200))}"
WIDTH="${WIDTH:-15}"
HEIGHT="${HEIGHT:-15}"
LOGS="$(mktemp -d)"

"$ROOT/server" -p "$PORT" -x "$WIDTH" -y "$HEIGHT" \
    -n red -c "$BOTS" -t "$T" >"$LOGS/server.log" 2>&1 &
server=$!
sleep 0.5

# SPAWN=1 lets the bots call ships and launch replacements for the fallen,
# which is what a team needs to keep six members alive all the way to 8.
SPAWN_FLAG="--no-spawn"
[ "${SPAWN:-0}" = "1" ] && SPAWN_FLAG="--max-spawn 4"

bots=()
for i in $(seq 1 "$BOTS"); do
    python3 "$ROOT/client_src/zappy_ai.py" -n red -p "$PORT" -v $SPAWN_FLAG \
        >"$LOGS/bot$i.log" 2>&1 &
    bots+=($!)
    sleep 0.2
done

sleep "$SECS"
for pid in "${bots[@]}"; do kill "$pid" 2>/dev/null; done
sleep 0.5
pkill -f "zappy_ai.py -n red -p $PORT" 2>/dev/null   # bots launched by bots
kill "$server" 2>/dev/null
wait 2>/dev/null

count() { grep -h "$1" "$LOGS"/bot*.log 2>/dev/null | wc -l; }

echo "=== $SECS s with $BOTS bots on a ${WIDTH}x${HEIGHT} world, t=$T ==="
for i in $(seq 1 "$BOTS"); do
    best=$(grep -o 'reached level [0-9]*' "$LOGS/bot$i.log" | tail -1)
    # only a real starvation counts: the rest is us shutting the game down
    starved=$(grep -c 'died: we starved' "$LOGS/bot$i.log")
    printf 'bot %-2s %-18s %s\n' "$i" "${best:-level 1}" \
        "$([ "$starved" -gt 0 ] && echo '(starved)')"
done
echo "rituals called  : $(count 'calling')"
echo "rituals run     : $(count 'ritual under way\|solo ritual -> evolution')"
echo "players enrolled: $(count 'enrolled in a ritual')"
echo "level ups       : $(count 'reached level')"
echo "starved         : $(count 'died: we starved')"
echo "server said     : $(tail -1 "$LOGS/server.log")"
echo "logs            : $LOGS"
