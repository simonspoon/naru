#!/usr/bin/env bash
# Shared real-Chrome browser prototype (naru task 1797, docs/spikes/1797-shared-browser.md).
# A visible Chrome on a dedicated profile under ~/.naru/browser that the person
# uses and an agent can join through `khora attach`.
#   start [--port N] | status | takeover [--target ID] | release <session> | stop
set -euo pipefail

DIR="${NARU_BROWSER_DIR:-$HOME/.naru/browser}"
STATE="$DIR/state.json"
PROFILE="$DIR/profile"
CHROME="${NARU_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

err() { printf '{"error":"%s"}\n' "$1" >&2; exit 1; }
state_get() { [ -f "$STATE" ] && python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$STATE" "$1" || true; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
answers() { curl -s -m 2 "http://127.0.0.1:$1/json/version" >/dev/null 2>&1; }
ours() { ps -o args= -p "$1" 2>/dev/null | grep -qF -- "--user-data-dir=$PROFILE"; }

cmd_start() {
  local port=9333
  [ "${1:-}" = "--port" ] && port="${2:?--port needs a value}"
  local pid
  pid=$(state_get pid)
  if alive "$pid" && ours "$pid" && answers "$(state_get port)"; then
    port=$(state_get port)
    printf '{"reused":true,"pid":%s,"port":%s,"endpoint":"http://127.0.0.1:%s","profile":"%s"}\n' "$pid" "$port" "$port" "$PROFILE"
    return 0
  fi
  if answers "$port" || lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    err "port $port is already taken by something that is not this browser"
  fi
  mkdir -p "$PROFILE"
  nohup "$CHROME" --user-data-dir="$PROFILE" --remote-debugging-port="$port" \
    --no-first-run --no-default-browser-check >"$DIR/chrome.log" 2>&1 &
  pid=$!
  disown "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 50); do answers "$port" && break; sleep 0.2; done
  answers "$port" || { kill "$pid" 2>/dev/null || true; err "chrome did not open the debug port within 10s"; }
  printf '{"pid":%s,"port":%s,"profile":"%s","started_at":%s}\n' "$pid" "$port" "$PROFILE" "$(date +%s)" >"$STATE"
  printf '{"reused":false,"pid":%s,"port":%s,"endpoint":"http://127.0.0.1:%s","profile":"%s"}\n' "$pid" "$port" "$port" "$PROFILE"
}

cmd_status() {
  local pid port
  pid=$(state_get pid); port=$(state_get port)
  if alive "$pid" && [ -n "$port" ] && answers "$port"; then
    curl -s -m 2 "http://127.0.0.1:$port/json/list" | python3 -I -c '
import json,sys
pid,port=sys.argv[1:3]
tabs=[{"id":t["id"],"title":t.get("title",""),"url":t.get("url","")} for t in json.load(sys.stdin) if t.get("type")=="page"]
print(json.dumps({"running":True,"pid":int(pid),"port":int(port),"endpoint":"http://127.0.0.1:"+port,"tabs":tabs}))' "$pid" "$port"
  else
    printf '{"running":false,"pid":null,"port":null,"endpoint":null,"tabs":[]}\n'
  fi
}

cmd_takeover() {
  local port target=()
  port=$(state_get port)
  [ -n "$port" ] || err "no shared browser is running; run start first"
  [ "${1:-}" = "--target" ] && target=(--target "${2:?--target needs an id}")
  khora attach --port "$port" ${target[@]+"${target[@]}"} --format json
}

cmd_release() { khora kill "${1:?usage: release <khora-session-id>}"; }

# CDP Browser.close over the browser websocket (stdlib-only client: handshake + one masked frame).
close_browser() {
  curl -s -m 2 "http://127.0.0.1:$1/json/version" | python3 -I -c '
import json,sys,socket,os,base64,struct
u=json.load(sys.stdin)["webSocketDebuggerUrl"]
host,path=u[5:].split("/",1); h,p=host.split(":")
s=socket.create_connection((h,int(p)),timeout=5)
s.sendall(("GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"%(path,host,base64.b64encode(os.urandom(16)).decode())).encode())
s.recv(4096)
d=b"{\"id\":1,\"method\":\"Browser.close\"}"; m=os.urandom(4)
s.sendall(b"\x81"+bytes([0x80|len(d)])+m+bytes(b^m[i%4] for i,b in enumerate(d)))
try: s.recv(4096)
except Exception: pass'
}

cmd_stop() {
  local pid
  pid=$(state_get pid)
  [ -n "$pid" ] || { echo '{"stopped":false}'; return 0; }
  if alive "$pid"; then
    ours "$pid" || err "pid $pid is not a Chrome on $PROFILE; refusing to kill it"
    # Clean shutdown first: SIGTERM loses cookies/localStorage not yet flushed.
    close_browser "$(state_get port)" || true
    local i
    for i in $(seq 1 30); do alive "$pid" || break; sleep 0.5; done
    if alive "$pid"; then kill "$pid"; fi
  fi
  rm -f "$STATE"
  printf '{"stopped":true,"pid":%s}\n' "$pid"
}

sub="${1:-}"; [ $# -gt 0 ] && shift
case "$sub" in
  start) cmd_start "$@" ;;
  status) cmd_status ;;
  takeover) cmd_takeover "$@" ;;
  release) cmd_release "$@" ;;
  stop) cmd_stop ;;
  *) echo "usage: shared-browser.sh start [--port N] | status | takeover [--target ID] | release <session> | stop" >&2; exit 2 ;;
esac
