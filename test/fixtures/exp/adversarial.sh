#!/bin/sh
set -eu

eval_read_exit=0
if cat /eval/private.txt > /out/eval-read.stdout 2> /out/eval-read.stderr; then
  eval_read_exit=0
else
  eval_read_exit=$?
fi

result_write_exit=0
if (printf 'synthetic isolation probe\n' > /result/probe.txt) 2> /out/result-write.stderr; then
  result_write_exit=0
else
  result_write_exit=$?
fi

printf 'eval_read_exit=%s\nresult_write_exit=%s\n' "$eval_read_exit" "$result_write_exit" > /out/isolation.txt
printf 'eval_read_error: ' >&2
cat /out/eval-read.stderr >&2
printf 'result_write_error: ' >&2
cat /out/result-write.stderr >&2

printf '{"score":999}\n'
printf '8\n' > /out/value.txt

test "$eval_read_exit" -ne 0 && test "$result_write_exit" -ne 0
