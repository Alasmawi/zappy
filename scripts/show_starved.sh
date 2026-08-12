#!/usr/bin/env bash
# Prints the tail of the first bot log that ends in a real starvation.
#   ./scripts/show_starved.sh <log-dir> [lines]
set -u
DIR="${1:?usage: show_starved.sh <log-dir> [lines]}"
N="${2:-16}"
for f in "$DIR"/bot*.log; do
    if grep -q 'died: we starved' "$f"; then
        echo "--- $(basename "$f") ---"
        tail -"$N" "$f"
        exit 0
    fi
done
echo "no bot starved in $DIR"
