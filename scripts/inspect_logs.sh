#!/usr/bin/env bash
# Prints the interesting (non-foraging) lines of each bot log in a run.
#   ./scripts/inspect_logs.sh <log-dir> [tail-lines]
set -u
DIR="${1:?usage: inspect_logs.sh <log-dir> [lines]}"
N="${2:-8}"
for f in "$DIR"/bot*.log; do
    echo "--- $(basename "$f") ---"
    grep -v "picked" "$f" | tail -"$N"
done
