#!/bin/bash
# Boot the dev server if it isn't up, then render and analyse the audio.
# The name game/audio.js promises in its renderOffline() comment.
#   bash tools/audio-render.sh [scenario[,scenario...]] [seconds]
export PATH=/opt/homebrew/bin:$PATH
cd "$(dirname "$0")/.."
if ! curl -s -o /dev/null http://localhost:5810; then
  nohup npx vite --port 5810 --strictPort --host > /tmp/gauntlet-vite.log 2>&1 &
  for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:5810 && break; sleep 0.5; done
fi
node tools/audio-render.mjs "$@"
