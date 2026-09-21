#!/usr/bin/env bash
# run.sh — start/stop the Lumon refinement labeller from any machine that has this repo
# checked out and /snlkt mounted. The server binds to loopback; reach it from your laptop
# with:  ssh -L 8752:127.0.0.1:8752 <user>@<host>   then open http://127.0.0.1:8752/
#
# Usage:
#   ./run.sh start          # launch (detached; survives logout)
#   ./run.sh stop           # stop whatever is on the port
#   ./run.sh restart
#   ./run.sh status
#
# Env overrides:
#   PORT=8752               # listen port
#   SOURCE=                 # empty = use config.json (aggression_corpus); or demo / approach
#   LABELLER_PYTHON=python3 # interpreter (must have numpy; cv2+pandas for real corpus)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8752}"
HOST="127.0.0.1"
PY="${LABELLER_PYTHON:-python3}"
SOURCE="${SOURCE:-}"
LOG="$HERE/logs/server.log"
CMD="${1:-start}"

pid_on_port() { ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true; }

tunnel_hint() {
  echo "  reach it:  ssh -L $PORT:$HOST:$PORT $(whoami)@$(hostname)"
  echo "  then open  http://$HOST:$PORT/"
}

start() {
  local pid; pid="$(pid_on_port)"
  if [ -n "$pid" ]; then
    echo "already running on :$PORT (pid $pid)"; tunnel_hint; return 0
  fi
  "$PY" -c 'import numpy' 2>/dev/null || { echo "ERROR: '$PY' has no numpy — set LABELLER_PYTHON=/path/to/python"; exit 1; }
  command -v ffmpeg >/dev/null 2>&1 || { echo "ERROR: ffmpeg not on PATH"; exit 1; }
  mkdir -p "$HERE/logs"
  local args=(--host "$HOST" --port "$PORT")
  [ -n "$SOURCE" ] && args+=(--source "$SOURCE")
  # setsid + </dev/null detaches it from this shell/SSH session
  setsid "$PY" -u "$HERE/server.py" "${args[@]}" >"$LOG" 2>&1 </dev/null &
  # loading pandas + the corpus index takes a few seconds; poll up to 20s
  for _ in $(seq 1 20); do sleep 1; [ -n "$(pid_on_port)" ] && break; done
  if [ -n "$(pid_on_port)" ]; then
    echo "labeller up on http://$HOST:$PORT/  (source: ${SOURCE:-config})   log: $LOG"
    tunnel_hint
  else
    echo "FAILED to start — last log lines:"; tail -8 "$LOG" 2>/dev/null || true; exit 1
  fi
}

stop() {
  local pid; pid="$(pid_on_port)"
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; sleep 1
    [ -z "$(pid_on_port)" ] && echo "stopped :$PORT (was pid $pid)" || { kill -9 "$pid" 2>/dev/null || true; echo "force-stopped :$PORT"; }
  else echo "nothing running on :$PORT"; fi
}

status() {
  local pid; pid="$(pid_on_port)"
  if [ -n "$pid" ]; then echo "RUNNING on :$PORT (pid $pid)"; tunnel_hint
  else echo "not running on :$PORT"; fi
}

case "$CMD" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  *) echo "usage: $0 {start|stop|restart|status}   [PORT=N SOURCE=demo|approach LABELLER_PYTHON=py]"; exit 2 ;;
esac
