#!/usr/bin/env bash
# Summarises a running (or finished) simulation without waiting for it.
#   ./scripts/progress.sh [log-dir]      (defaults to the newest one)
set -u
DIR="${1:-}"
if [ -z "$DIR" ]; then
    for d in $(ls -dt /tmp/tmp.* 2>/dev/null); do
        if [ -f "$d/bot1.log" ]; then DIR="$d"; break; fi
    done
fi
[ -n "$DIR" ] || { echo "no simulation logs found"; exit 1; }

echo "logs      : $DIR"
echo "levels reached:"
grep -ho 'reached level [0-9]*' "$DIR"/bot*.log | sort | uniq -c
printf 'ships called  : %s\n' "$(grep -h 'calling a ship' "$DIR"/bot*.log | wc -l)"
printf 'rituals run   : %s\n' "$(grep -h 'ritual under way\|solo ritual -> evolution' "$DIR"/bot*.log | wc -l)"
printf 'starved       : %s\n' "$(grep -h 'died: we starved' "$DIR"/bot*.log | wc -l)"
printf 'bots running  : %s\n' "$(pgrep -fc 'zappy_ai.py' || echo 0)"
