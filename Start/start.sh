#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$SCRIPT_DIR/.pid"
SERVICE_NAME="polar-process"
PROJECT="PolarProcess"
PREFERRED_PORT=11055

cd "$PROJECT_DIR"

# ── Dynamic port allocation via PolarPort ────────────
source "$PROJECT_DIR/../Agent_core/scripts/port-claim.sh"
PORT=$(claim_port "$SERVICE_NAME" "$PROJECT" "$PREFERRED_PORT")

HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

# ── Node version alignment ──────────────────────────
if [ -f ".nvmrc" ]; then
    REQUIRED_NODE=$(cat .nvmrc)
elif [ -f "package.json" ]; then
    REQUIRED_NODE=$(node -e "try{const p=require('./package.json');const e=p.engines?.node||'';const m=e.match(/>=(\d+)/);console.log(m?m[1]:'')}catch{}" 2>/dev/null || true)
fi
if [ -n "${REQUIRED_NODE:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    NODE_DIR=$(ls -d "$HOME/.nvm/versions/node/v${REQUIRED_NODE}"* 2>/dev/null | sort -V | tail -1 || true)
    if [ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ]; then
        export PATH="$NODE_DIR/bin:$PATH"
    fi
fi

do_start() {
    OCCUPANT_PID=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t 2>/dev/null | head -1 || true)
    if [ -n "$OCCUPANT_PID" ]; then
        echo "Already running pid=$OCCUPANT_PID port=$PORT"
        exit 0
    fi

    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo "Already running pid=$OLD_PID port=$PORT"
            exit 0
        fi
        rm -f "$PID_FILE"
    fi

    if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules/.package-lock.json" ]; then
        echo "Installing dependencies..."
        npm ci 2>&1 || npm install 2>&1
    fi
    npm rebuild better-sqlite3 2>&1 || true

    LOG_FILE="$SCRIPT_DIR/polarprocess.log"
    NODE_BIN="$(which node)"
    TSX_BIN="$PROJECT_DIR/node_modules/.bin/tsx"
    echo "[start.sh] Using node: $NODE_BIN ($($NODE_BIN --version))" >> "$LOG_FILE"

    if [ "${LAUNCHD:-}" = "1" ]; then
        exec env NODE="$NODE_BIN" POLARPROCESS_PORT="$PORT" "$NODE_BIN" "$TSX_BIN" src/server.ts >> "$LOG_FILE" 2>&1
    fi

    nohup env NODE="$NODE_BIN" POLARPROCESS_PORT="$PORT" "$NODE_BIN" "$TSX_BIN" src/server.ts >> "$LOG_FILE" 2>&1 &
    DAEMON_PID=$!
    echo "$DAEMON_PID" > "$PID_FILE"

    for i in $(seq 1 30); do
        if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
            echo "Started pid=$DAEMON_PID port=$PORT"
            exit 0
        fi
        if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
            echo "Process exited immediately" >&2
            rm -f "$PID_FILE"
            exit 1
        fi
        sleep 1
    done

    echo "Timed out waiting for health endpoint on port $PORT" >&2
    rm -f "$PID_FILE"
    exit 1
}

do_stop() {
    if [ ! -f "$PID_FILE" ]; then
        OCCUPANT_PID=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t 2>/dev/null | head -1 || true)
        if [ -n "$OCCUPANT_PID" ]; then
            echo "Stopping pid=$OCCUPANT_PID (found by port)"
            kill "$OCCUPANT_PID" 2>/dev/null || true
            for i in $(seq 1 10); do
                if ! kill -0 "$OCCUPANT_PID" 2>/dev/null; then break; fi
                sleep 1
            done
            if kill -0 "$OCCUPANT_PID" 2>/dev/null; then
                kill -9 "$OCCUPANT_PID" 2>/dev/null || true
            fi
            echo "Stopped"
        else
            echo "Not running (no PID file, no process on port $PORT)"
        fi
        exit 0
    fi

    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -z "$OLD_PID" ] || ! kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Not running (stale PID file)"
        rm -f "$PID_FILE"
        exit 0
    fi

    echo "Stopping pid=$OLD_PID..."
    kill "$OLD_PID" 2>/dev/null || true
    for i in $(seq 1 10); do
        if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
        sleep 1
    done
    if kill -0 "$OLD_PID" 2>/dev/null; then
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "Stopped"
}

do_restart() { do_stop; do_start; }

do_status() {
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo "Running pid=$OLD_PID port=$PORT"
            exit 0
        fi
    fi
    OCCUPANT_PID=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t 2>/dev/null | head -1 || true)
    if [ -n "$OCCUPANT_PID" ]; then
        echo "Running pid=$OCCUPANT_PID port=$PORT (PID file stale)"
        echo "$OCCUPANT_PID" > "$PID_FILE"
        exit 0
    fi
    echo "Not running"
    exit 1
}

COMMAND="${1:-start}"
case "$COMMAND" in
    start)   do_start   ;;
    stop)    do_stop    ;;
    restart) do_restart ;;
    status)  do_status  ;;
    *)
        echo "Usage: bash Start/start.sh [start|stop|restart|status]" >&2
        exit 1
        ;;
esac
