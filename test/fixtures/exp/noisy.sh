#!/bin/sh
set -eu

printf '7\n' > /out/value.txt
index=0
while test "$index" -lt 1025; do
  printf '%16384s' ''
  index=$((index + 1))
done
