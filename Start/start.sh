#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$SCRIPT_DIR/.pid"
# Infrastructure service: port is pinned (launchd POLARPROCESS_PORT or 11055).
# Do NOT call PolarPort claim_port — sticky registry previously rebound us to 8000/8030.
PORT="${POLARPROCESS_PORT:-11055}"

cd "$PROJECT_DIR"

HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

# Outbound proxy for managed services (Hub → cursor-agent). Default: on (read macOS system proxy).
# Override: POLAR_PROXY_MODE=off|auto|on, --no-proxy, --proxy=auto
POLAR_PROXY_MODE="${POLAR_PROXY_MODE:-on}"
COMMAND="start"
SERVER_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --no-proxy) POLAR_PROXY_MODE=off ;;
        --proxy=*) POLAR_PROXY_MODE="${arg#--proxy=}" ;;
        start|stop|restart|status) COMMAND="$arg" ;;
        *) SERVER_ARGS+=("$arg") ;;
    esac
done

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

LOG_FILE="$SCRIPT_DIR/polarprocess.log"
MAX_LOG_BYTES=$((50 * 1024 * 1024)) # 50MB hard cap before rotate

rotate_log_if_huge() {
    if [ ! -f "$LOG_FILE" ]; then
        return 0
    fi
    local size
    size=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "${size:-0}" -lt "$MAX_LOG_BYTES" ]; then
        return 0
    fi
    local ts archive
    ts=$(date +%Y%m%d-%H%M%S)
    archive="${LOG_FILE}.${ts}"
    # copytruncate-style: rename active file so the next writer opens a fresh path
    mv "$LOG_FILE" "$archive"
    : > "$LOG_FILE"
    echo "[start.sh] rotated log size=${size} -> $(basename "$archive")" >> "$LOG_FILE"
    # keep newest 2 archives (+ active); compress older ones opportunistically
    local archives
    archives=$(ls -1t "$SCRIPT_DIR"/polarprocess.log.[0-9]* 2>/dev/null | tail -n +3 || true)
    if [ -n "$archives" ]; then
        while IFS= read -r old; do
            [ -n "$old" ] || continue
            rm -f "$old"
        done <<< "$archives"
    fi
    if command -v gzip >/dev/null 2>&1; then
        ls -1t "$SCRIPT_DIR"/polarprocess.log.[0-9]* 2>/dev/null | head -2 | while IFS= read -r a; do
            case "$a" in
                *.gz) ;;
                *) gzip -f "$a" 2>/dev/null || true ;;
            esac
        done
    fi
}

is_our_polarprocess() {
    local pid="$1"
    local cmd
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$cmd" in
        *PolarProcess*src/server.ts*|*PolarProcess*tsx*src/server.ts*) return 0 ;;
        *) return 1 ;;
    esac
}

stop_pid_graceful() {
    local pid="$1"
    [ -n "$pid" ] || return 0
    kill "$pid" 2>/dev/null || true
    local i
    for i in $(seq 1 15); do
        if ! kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
}

do_start() {
    rotate_log_if_huge

    OCCUPANT_PID=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t 2>/dev/null | head -1 || true)

    if [ "${LAUNCHD:-}" = "1" ]; then
        # Apple TN2083: under launchd we must foreground-exec. Never exit 0 while
        # leaving an orphan listener — that permanently detaches KeepAlive jobs.
        if [ -n "$OCCUPANT_PID" ]; then
            if is_our_polarprocess "$OCCUPANT_PID"; then
                echo "[start.sh] LAUNCHD reclaim: stopping orphan pid=$OCCUPANT_PID on port $PORT" >> "$LOG_FILE"
                stop_pid_graceful "$OCCUPANT_PID"
            else
                echo "[start.sh] LAUNCHD: port $PORT occupied by foreign pid=$OCCUPANT_PID" >> "$LOG_FILE"
                echo "Port $PORT occupied by foreign process pid=$OCCUPANT_PID" >&2
                exit 78
            fi
        fi
        if [ -f "$PID_FILE" ]; then
            OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
            if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
                if is_our_polarprocess "$OLD_PID"; then
                    stop_pid_graceful "$OLD_PID"
                fi
            fi
            rm -f "$PID_FILE"
        fi
    else
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
    fi

    if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules/.package-lock.json" ]; then
        echo "Installing dependencies..."
        npm ci 2>&1 || npm install 2>&1
    fi
    npm rebuild better-sqlite3 2>&1 || true

    NODE_BIN="$(which node)"
    TSX_BIN="$PROJECT_DIR/node_modules/.bin/tsx"
    echo "[start.sh] Using node: $NODE_BIN ($($NODE_BIN --version)) pinned port=$PORT LAUNCHD=${LAUNCHD:-0}" >> "$LOG_FILE"

    # Forward optional POLARPROCESS_SHARED_DB (recovery/tests). Avoid empty-array expand under `set -u`.
    if [ -n "${POLARPROCESS_SHARED_DB:-}" ]; then
        RUN_ENV=(env NODE="$NODE_BIN" POLARPROCESS_PORT="$PORT" POLAR_PROXY_MODE="$POLAR_PROXY_MODE" POLARPROCESS_SHARED_DB="$POLARPROCESS_SHARED_DB")
    else
        RUN_ENV=(env NODE="$NODE_BIN" POLARPROCESS_PORT="$PORT" POLAR_PROXY_MODE="$POLAR_PROXY_MODE")
    fi

    if [ "${LAUNCHD:-}" = "1" ]; then
        echo $$ > "$PID_FILE"
        exec "${RUN_ENV[@]}" "$NODE_BIN" "$TSX_BIN" src/server.ts >> "$LOG_FILE" 2>&1
    fi

    nohup "${RUN_ENV[@]}" "$NODE_BIN" "$TSX_BIN" src/server.ts >> "$LOG_FILE" 2>&1 &
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
            stop_pid_graceful "$OCCUPANT_PID"
            echo "Stopped"
        else
            echo "Not running (no PID file, no process on port $PORT)"
        fi
        exit 0
    fi

    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -z "$OLD_PID" ] || ! kill -0 "$OLD_PID" 2>/dev/null; then
        OCCUPANT_PID=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t 2>/dev/null | head -1 || true)
        rm -f "$PID_FILE"
        if [ -n "$OCCUPANT_PID" ]; then
            echo "Stopping pid=$OCCUPANT_PID (PID file stale)"
            stop_pid_graceful "$OCCUPANT_PID"
            echo "Stopped"
            exit 0
        fi
        echo "Not running (stale PID file)"
        exit 0
    fi

    echo "Stopping pid=$OLD_PID..."
    stop_pid_graceful "$OLD_PID"
    # also clear listener if wrapper left a child
    OCCUPANT_PID=$(lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t 2>/dev/null | head -1 || true)
    if [ -n "$OCCUPANT_PID" ]; then
        stop_pid_graceful "$OCCUPANT_PID"
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

case "$COMMAND" in
    start)   do_start   ;;
    stop)    do_stop    ;;
    restart) do_restart ;;
    status)  do_status  ;;
    *)
        echo "Usage: bash Start/start.sh [start|stop|restart|status] [--no-proxy] [--proxy=on|off|auto]" >&2
        exit 1
        ;;
esac
