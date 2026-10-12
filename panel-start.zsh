#!/bin/zsh
set -u

cd "$(cd "$(dirname "$0")" && pwd)" || exit 1
node="${NODE_BIN:-$(command -v node)}"
[[ -n "$node" ]] || { echo "未找到 node：请安装 Node.js ≥ 18，或用 NODE_BIN=/path/to/node 指定"; exit 1; }
child_pid=

cleanup() {
  trap - TERM INT
  if [[ -n "$child_pid" ]]; then
    kill "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
  fi
  "$node" add-to-codebuddy.mjs --remove
}

trap 'cleanup; exit 143' TERM INT
"$node" add-to-codebuddy.mjs &
child_pid=$!
wait "$child_pid"
exit_code=$?
child_pid=
if (( exit_code != 0 )); then
  cleanup
  exit "$exit_code"
fi

"$node" proxy.mjs &
child_pid=$!
wait "$child_pid"
exit_code=$?
child_pid=
cleanup
exit "$exit_code"
