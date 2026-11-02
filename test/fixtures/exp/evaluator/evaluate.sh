#!/bin/sh
set -eu

score=0
if test -f /candidate/value.txt && value=$(cat /candidate/value.txt) && test "$value" = 7; then
  score=1
fi
printf '{"score":%s}\n' "$score" > /result/metrics.json
