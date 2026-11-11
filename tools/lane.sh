#!/bin/bash
# lane.sh <lane-name> <port-offset>  — private copy of the repo so parallel
# builders can never break each other's screenshots.
set -e
export PATH=/opt/homebrew/bin:$PATH
LANE="$1"; OFF="${2:-1}"
# GAUNTLET_CANON: the checkout to copy from (default: the repo this script is in).
# GAUNTLET_LANES: the folder that holds the lane copies (default: ~/gauntlet-lanes).
CANON="${GAUNTLET_CANON:-$(cd "$(dirname "$0")/.." && pwd)}"
DIR="${GAUNTLET_LANES:-$HOME/gauntlet-lanes}/$LANE"
PORT=$((5810 + OFF))
mkdir -p "$DIR"
# Lane marker, served from public/ as a PLAIN filename. Vite refuses to serve
# dotfiles and answers them with index.html via the SPA fallback, so the first
# version of this guard (a /.lane-id dotfile) never matched and run.sh always
# exited FATAL — it failed closed purely by luck of the string compare.
# run.sh below refuses to shoot unless the server answering on
# $PORT serves THIS file with THIS lane name. A previous wave's vite can still
# be listening on a reused port hours later, and the old check ("does anything
# answer on $PORT?") happily shot ANOTHER LANE'S BUILD — a wave-F builder
# captured two full pose sets of a wave-D lane before noticing. Silent evidence
# corruption is the worst failure this harness can have, so it is now fatal.
# (no served marker: see the guard in run.sh — it checks the listening
# process's cwd, which does not depend on how Vite serves static files.)
# --update: never clobber a file the lane has edited more recently than canonical.
rsync -a --update --exclude node_modules --exclude shots --exclude .git "$CANON/" "$DIR/"
[ -e "$DIR/node_modules" ] || ln -s "$CANON/node_modules" "$DIR/node_modules"
cat > "$DIR/tools/run.sh" <<INNER
#!/bin/bash
export PATH=/opt/homebrew/bin:\$PATH
cd "\$(dirname "\$0")/.."
# Per-lane Chrome profile. shoot.mjs defaults CHROME_PROFILE to a SINGLE shared
# /tmp/gauntlet-chrome-profile, and puppeteer refuses to launch a second browser
# against a userDataDir that is already live: "The browser is already running
# for ...". So two lanes capturing at the same time — the entire point of this
# script — made one of them die on launch. Wave M hit it with three lanes up at
# once. The port guard below protected the PNGs from cross-contamination but
# said nothing about this, because the collision is in the browser, not the
# server.
export CHROME_PROFILE="\${CHROME_PROFILE:-/tmp/gauntlet-chrome-$LANE}"
if ! curl -s -o /dev/null http://localhost:$PORT; then
  nohup npx vite --port $PORT --strictPort > /tmp/vite-$LANE.log 2>&1 &
  for i in \$(seq 1 60); do curl -s -o /dev/null http://localhost:$PORT && break; sleep 0.5; done
fi
SERVING=\$(lsof -a -p "\$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//')
if [ "\$SERVING" != "$DIR" ]; then
  echo "FATAL: port $PORT is served from '\$SERVING', not '$DIR'." >&2
  echo "A stale vite from an earlier wave is holding this port. Shooting it would" >&2
  echo "capture ANOTHER LANE'S BUILD and report it as yours. Kill it first:" >&2
  echo "  kill \$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t)" >&2
  exit 1
fi
GAME_URL=http://localhost:$PORT node tools/shoot.mjs "\$@"
INNER
cat > "$DIR/tools/burst-run.sh" <<INNER2
#!/bin/bash
export PATH=/opt/homebrew/bin:\$PATH
cd "\$(dirname "\$0")/.."
export CHROME_PROFILE="\${CHROME_PROFILE:-/tmp/gauntlet-chrome-$LANE}"
if ! curl -s -o /dev/null http://localhost:$PORT; then
  nohup npx vite --port $PORT --strictPort > /tmp/vite-$LANE.log 2>&1 &
  for i in \$(seq 1 60); do curl -s -o /dev/null http://localhost:$PORT && break; sleep 0.5; done
fi
SERVING=\$(lsof -a -p "\$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//')
if [ "\$SERVING" != "$DIR" ]; then
  echo "FATAL: port $PORT is served from '\$SERVING', not '$DIR' - refusing to shoot." >&2
  exit 1
fi
GAME_URL=http://localhost:$PORT node tools/burst.mjs "\$@"
INNER2
chmod +x "$DIR/tools/burst-run.sh"
chmod +x "$DIR/tools/run.sh"
echo "lane=$LANE dir=$DIR port=$PORT"
