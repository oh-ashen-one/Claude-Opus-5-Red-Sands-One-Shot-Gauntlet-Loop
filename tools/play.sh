#!/bin/bash
# Start the game and open it on this machine. Idempotent.
export PATH=/opt/homebrew/bin:$PATH
cd "$(dirname "$0")/.."
if ! curl -s -o /dev/null http://localhost:5810; then
  nohup npx vite --port 5810 --strictPort --host > /tmp/gauntlet-play.log 2>&1 &
  for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:5810 && break; sleep 0.5; done
fi
open -a "Google Chrome" "http://localhost:5810/"
echo "running at http://localhost:5810/"
