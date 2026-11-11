#!/bin/bash
# merge-lane.sh <lane> <file...>  — pull a lane's owned files back to canonical.
set -e
LANE="$1"; shift
# Same variables as lane.sh: GAUNTLET_LANES and GAUNTLET_CANON.
DIR="${GAUNTLET_LANES:-$HOME/gauntlet-lanes}/$LANE"
CANON="${GAUNTLET_CANON:-$(cd "$(dirname "$0")/.." && pwd)}"
for f in "$@"; do
  [ -f "$DIR/$f" ] || { echo "missing $f in lane $LANE"; exit 1; }
  mkdir -p "$CANON/$(dirname "$f")"
  cp "$DIR/$f" "$CANON/$f"
  echo "merged $f"
done
