#!/bin/zsh
# WorkBuddy 账号池网关 —— 手动管理（已从开机启动项移除）
#
# 网关不常驻。开 = 启动网关 + 把 wb-* 模型注册进 CodeBuddy；关 = 移除 wb-* 模型 + 关网关。
# 这样不会出现「选了 wb-* 但网关没开」→ 请求静默卡死。
#
#   zsh gw.sh start     开网关 + 注册 wb-* 模型
#   zsh gw.sh stop      移除 wb-* 模型 + 关网关
#   zsh gw.sh restart   重启
#   zsh gw.sh status    状态 + 账号池 + 已注册模型
#   zsh gw.sh log       看日志
set -u
SELF="$0"; case "$SELF" in /*) ;; *) SELF="$PWD/$SELF" ;; esac

DIR="$(cd "$(dirname "$SELF")" && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"
[ -n "$NODE" ] || { echo "未找到 node：请安装 Node.js ≥ 18，或用 NODE_BIN=/path/to/node 指定"; exit 1; }
PORT="${WB_GATEWAY_PORT:-7863}"
LOG="$DIR/state/gateway.log"

pid_of() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }
models() { cd "$DIR" || exit 1; "$NODE" add-to-codebuddy.mjs "$@"; }

case "${1:-status}" in
  start)
    if [ -n "$(pid_of)" ]; then
      echo "网关已在运行 (pid $(pid_of))"
    else
      mkdir -p "$DIR/state"; cd "$DIR" || exit 1
      WB_GATEWAY_DEBUG=1 nohup "$NODE" proxy.mjs >> "$LOG" 2>&1 &
      sleep 2
      if [ -z "$(pid_of)" ]; then echo "❌ 网关启动失败，日志："; tail -8 "$LOG"; exit 1; fi
      echo "✅ 网关已启动 (pid $(pid_of))  http://127.0.0.1:$PORT"
    fi
    echo
    models
    echo
    echo "用法：codebuddy 里 /model 选「WorkBuddy · xxx」"
    ;;
  stop)
    echo "== 移除 wb-* 模型 =="
    models --remove
    echo
    echo "== 关闭网关 =="
    P=$(pid_of)
    if [ -z "$P" ]; then
      echo "（网关本来就没在运行）"
    else
      kill "$P" 2>/dev/null; sleep 1
      P2=$(pid_of); [ -n "$P2" ] && kill -9 "$P2" 2>/dev/null
      echo "已关闭"
    fi
    echo
    echo "你原来的模型不受影响，CodeBuddy 照常可用。"
    ;;
  restart) "$SELF" stop; sleep 1; "$SELF" start ;;
  status)
    P=$(pid_of)
    if [ -n "$P" ]; then
      echo "网关：运行中 (pid $P)"
      echo -n "  health: "; curl -s --max-time 5 "http://127.0.0.1:$PORT/health"; echo
      echo -n "  pool  : "; curl -s --max-time 20 "http://127.0.0.1:$PORT/pool"; echo
    else
      echo "网关：未运行（用 wb-* 模型前先 zsh gw.sh start）"
    fi
    echo
    echo "已注册的 wb-* 模型："
    models --list
    ;;
  log) tail -30 "$LOG" 2>/dev/null || echo "（还没有日志）" ;;
  *) sed -n '2,12p' "$SELF" ;;
esac
