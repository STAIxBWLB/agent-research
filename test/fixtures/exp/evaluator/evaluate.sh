#!/bin/sh
set -eu

score=0
if test -f /candidate/value.txt && value=$(cat /candidate/value.txt); then
  case "$value" in
    7|8|9) score=$value ;;
  esac
fi
printf '{"score":%s}\n' "$score" > /result/metrics.json
