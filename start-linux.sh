#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  PG Replication Manager -- Linux local runner (no Docker)
#  Requirements: Python 3.10+, Node.js 18+
#  Usage: ./start-linux.sh
# ============================================================

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
VENV_DIR="$ROOT/.venv"
DATA_DIR="$ROOT/data"
BACKEND_PORT=8000
FRONTEND_PORT=3000

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}[OK]${NC}    $*"; }
fail() { echo -e "  ${RED}[ERROR]${NC} $*"; exit 1; }
step() { echo -e "  ${BLUE}[...]${NC}   $*"; }

cleanup() {
    echo ""
    step "Stopping services..."
    [[ -n "${BACKEND_PID:-}"  ]] && kill "$BACKEND_PID"  2>/dev/null || true
    [[ -n "${FRONTEND_PID:-}" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    ok "Stopped."
}
trap cleanup EXIT INT TERM

echo ""
echo -e "  ${BLUE}PG Replication Manager - local start${NC}"
echo "  ========================================="
echo ""

# -- 1. Python ------------------------------------------------
PYTHON=""
# Prefer 3.12 or 3.11 — asyncpg/pydantic-core have no wheels for 3.13+ yet
for cmd in python3.12 python3.11 python3.10 python3 python; do
    if command -v "$cmd" &>/dev/null; then
        ver=$("$cmd" --version 2>&1)
        minor=$(echo "$ver" | sed 's/Python 3\.\([0-9]*\).*/\1/')
        if [[ -n "$minor" && "$minor" -ge 10 && "$minor" -le 12 ]]; then
            PYTHON="$cmd"; break
        fi
    fi
done
if [[ -z "$PYTHON" ]]; then
    # Check if only 3.13+ is available and warn
    for cmd in python3 python; do
        if command -v "$cmd" &>/dev/null; then
            ver=$("$cmd" --version 2>&1)
            minor=$(echo "$ver" | sed 's/Python 3\.\([0-9]*\).*/\1/')
            if [[ -n "$minor" && "$minor" -ge 13 ]]; then
                fail "Found $ver but asyncpg requires Python 3.10-3.12.
    Install Python 3.12:
      macOS:         brew install python@3.12
      Ubuntu/Debian: sudo apt install python3.12
      RHEL/Fedora:   sudo dnf install python3.12"
            fi
        fi
    done
    fail "Python 3.10-3.12 not found.
    macOS:         brew install python@3.12
    Ubuntu/Debian: sudo apt install python3.12
    RHEL/Fedora:   sudo dnf install python3.12"
fi
ok "$($PYTHON --version)"

# -- 2. Node --------------------------------------------------
if ! command -v node &>/dev/null; then
    fail "Node.js not found. Install via:
    Ubuntu/Debian: sudo apt install nodejs npm  (or use nvm: https://github.com/nvm-sh/nvm)
    RHEL/Fedora:   sudo dnf install nodejs"
fi
ok "Node.js $(node --version)"

# -- 3. Data directory ----------------------------------------
mkdir -p "$DATA_DIR"
ok "Data directory: $DATA_DIR"

# -- 4. Python venv -------------------------------------------
# Recreate if venv Python version doesn't match selected interpreter
if [[ -f "$VENV_DIR/bin/python" ]]; then
    VENV_VER=$("$VENV_DIR/bin/python" --version 2>&1)
    WANT_VER=$($PYTHON --version 2>&1)
    if [[ "$VENV_VER" != "$WANT_VER" ]]; then
        step "Venv is $VENV_VER but selected interpreter is $WANT_VER — recreating..."
        rm -rf "$VENV_DIR"
    fi
fi

if [[ ! -f "$VENV_DIR/bin/activate" ]]; then
    step "Creating Python virtual environment..."
    "$PYTHON" -m venv "$VENV_DIR"
    ok "Virtual environment created."
else
    ok "Virtual environment exists ($("$VENV_DIR/bin/python" --version 2>&1))."
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# -- 5. Python deps -------------------------------------------
step "Checking Python dependencies..."
pip install -q -r "$BACKEND_DIR/requirements.txt"
ok "Python dependencies ready."

# -- 6. Node deps ---------------------------------------------
if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    step "Installing Node dependencies (first run)..."
    npm --prefix "$FRONTEND_DIR" install --silent
    ok "Node dependencies installed."
else
    ok "Node dependencies already present."
fi

# -- 7. Start backend -----------------------------------------
echo ""
step "Starting backend  ->  http://localhost:$BACKEND_PORT"

export CONFIG_PATH="$DATA_DIR/config.json"
export PROFILES_PATH="$DATA_DIR/profiles.json"

cd "$BACKEND_DIR"
uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" --reload \
    > "$DATA_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
cd "$ROOT"

# -- 8. Wait for backend --------------------------------------
step "Waiting for backend to start..."
TRIES=0
until curl -sf "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1; do
    sleep 1
    TRIES=$((TRIES + 1))
    if [[ $TRIES -ge 30 ]]; then
        echo ""
        fail "Backend did not start within 30 seconds. Check $DATA_DIR/backend.log"
    fi
done
ok "Backend ready."

# -- 9. Start frontend ----------------------------------------
step "Starting frontend ->  http://localhost:$FRONTEND_PORT"

VITE_BACKEND_URL="http://localhost:$BACKEND_PORT" \
    npm --prefix "$FRONTEND_DIR" run dev -- --port "$FRONTEND_PORT" \
    > "$DATA_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!

# -- 10. Open browser -----------------------------------------
sleep 2
if command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:$FRONTEND_PORT" &>/dev/null &
elif command -v open &>/dev/null; then
    open "http://localhost:$FRONTEND_PORT" &>/dev/null &
fi

# -- Summary --------------------------------------------------
echo ""
echo "  ========================================="
echo -e "  ${GREEN}App is running!${NC}"
echo "  Frontend : http://localhost:$FRONTEND_PORT"
echo "  Backend  : http://localhost:$BACKEND_PORT"
echo "  API docs : http://localhost:$BACKEND_PORT/docs"
echo "  Data dir : $DATA_DIR"
echo "  Logs     : $DATA_DIR/backend.log"
echo "             $DATA_DIR/frontend.log"
echo "  ========================================="
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to stop all services.${NC}"
echo ""

# Keep running until Ctrl+C
wait "$BACKEND_PID" "$FRONTEND_PID"
