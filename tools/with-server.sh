#!/bin/bash
# Boot the canonical dev server if it is not already up, then run whatever
# follows against it. run.sh and burst-run.sh each carried their own copy of this
# preamble, so the probe tools had none and failed whenever the server had exited.
#   bash tools/with-server.sh node tools/probe-campitch.mjs 06-forest
export PATH=/opt/homebrew/bin:$PATH
cd "$(dirname "$0")/.."
if ! curl -s -o /dev/null http://localhost:5810; then
  nohup npx vite --port 5810 --strictPort --host > /tmp/gauntlet-vite.log 2>&1 &
  for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:5810 && break; sleep 0.5; done
fi
exec "$@"
