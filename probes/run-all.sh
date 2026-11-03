#!/bin/sh
# Run every phone probe. The result is saved in probes/out/ and copied to the clipboard.
# Keep the stick plugged in. Probes 1 and 2 ask you to do things on the phone.
# Extra options go to the runner, e.g.: sh probes/run-all.sh --only 3,4
cd "$(dirname "$0")/.." || exit 1
timeout 10 termux-wake-lock 2>/dev/null
node probes/run-all.mjs "$@"
status=$?
timeout 10 termux-wake-unlock 2>/dev/null
exit $status
