#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  DungeonForge — one-click launcher
#  Works on macOS, Linux, and Windows (Git Bash / WSL)
#
#  First run: creates a virtual environment, installs deps, prompts for your
#  Graydient API key. Subsequent runs just start the server and open the browser.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
AMBER='\033[0;33m'
AMBER_B='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC}  $*"; }
info() { echo -e "  ${AMBER}·${NC}  $*"; }
warn() { echo -e "  ${AMBER}!${NC}  $*"; }
die()  { echo -e "  ${RED}✗  $*${NC}"; exit 1; }

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${AMBER_B}  ╔══════════════════════════════════════╗"
echo -e "  ║        D U N G E O N  F O R G E      ║"
echo -e "  ╚══════════════════════════════════════╝${NC}"
echo ""

# ── Working directory = script location ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 1. Find Python 3.10+ ─────────────────────────────────────────────────────
info "Checking Python..."

PYTHON=""
for cmd in python3 python python3.12 python3.11 python3.10; do
  if command -v "$cmd" &>/dev/null; then
    ver=$("$cmd" -c "import sys; print(sys.version_info[:2])" 2>/dev/null || echo "(0, 0)")
    # Check >= (3, 10)
    if "$cmd" -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" 2>/dev/null; then
      PYTHON="$cmd"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  die "Python 3.10 or newer is required but was not found.\n     Download it from https://www.python.org/downloads/"
fi

PY_VER=$("$PYTHON" -c "import sys; v=sys.version_info; print(f'{v.major}.{v.minor}.{v.micro}')")
ok "Python $PY_VER  ($PYTHON)"

# ── 2. Virtual environment ────────────────────────────────────────────────────
VENV_DIR="$SCRIPT_DIR/.venv"

if [ ! -d "$VENV_DIR" ]; then
  info "Creating virtual environment..."
  "$PYTHON" -m venv "$VENV_DIR"
  ok "Virtual environment created"
fi

# Activate — path differs on Windows vs Unix
if [ -f "$VENV_DIR/Scripts/activate" ]; then
  # shellcheck disable=SC1091
  source "$VENV_DIR/Scripts/activate"
else
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
fi
ok "Virtual environment active"

# ── 3. Install / verify dependencies ─────────────────────────────────────────
info "Checking dependencies..."

# Detect whether we need to install (no fastapi = first run or broken venv)
if ! python -c "import fastapi" &>/dev/null; then
  echo ""
  warn "Installing packages from requirements.txt — this takes a minute on first run."
  warn "rembg will also download a ~170 MB segmentation model the first time it runs."
  echo ""
  pip install --quiet --upgrade pip
  pip install --quiet -r requirements.txt
  echo ""
  ok "Dependencies installed"
else
  # Quick check that everything listed is present (non-fatal, just warn)
  if ! pip install --quiet --dry-run -r requirements.txt &>/dev/null 2>&1; then
    warn "Some packages may be out of date — run 'pip install -r requirements.txt' to update"
  else
    ok "Dependencies up to date"
  fi
fi

# ── 4. API key (.env) ─────────────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo ""
  echo -e "  ${AMBER_B}⚙  First-time setup${NC}"
  echo ""
  echo -e "  ${DIM}Your Graydient API key is needed to generate sprites."
  echo -e "  It will be saved to .env (next to this script) and never shared.${NC}"
  echo ""
  printf "  Paste your Graydient API key and press Enter: "
  read -r GRAYDIENT_KEY </dev/tty

  if [ -z "$GRAYDIENT_KEY" ]; then
    die "No key entered. Add GRAYDIENT_KEY=your-key to a .env file and re-run."
  fi

  printf "GRAYDIENT_KEY=%s\n" "$GRAYDIENT_KEY" > "$ENV_FILE"
  ok ".env created"
else
  if ! grep -q "GRAYDIENT_KEY" "$ENV_FILE"; then
    die ".env exists but GRAYDIENT_KEY is missing.\n     Add: GRAYDIENT_KEY=your-key-here"
  fi
  ok ".env found"
fi

# ── 5. Check nothing is already running on :8000 ─────────────────────────────
PORT=8000
if command -v lsof &>/dev/null; then
  if lsof -ti :"$PORT" &>/dev/null; then
    warn "Port $PORT is already in use — the Forge may already be running."
    info "Opening browser anyway..."
    SKIP_SERVER=1
  fi
elif command -v netstat &>/dev/null; then
  if netstat -an 2>/dev/null | grep -q ":$PORT "; then
    warn "Port $PORT is already in use — the Forge may already be running."
    info "Opening browser anyway..."
    SKIP_SERVER=1
  fi
fi

SKIP_SERVER=${SKIP_SERVER:-0}

# ── 6. Start forge.py ─────────────────────────────────────────────────────────
if [ "$SKIP_SERVER" = "0" ]; then
  info "Starting DungeonForge server..."
  python forge.py &
  SERVER_PID=$!
  echo ""
  echo -e "  ${DIM}Server PID: $SERVER_PID  (Ctrl-C to stop)${NC}"
  echo ""

  # Trap Ctrl-C to cleanly kill the server
  trap 'echo ""; info "Shutting down..."; kill "$SERVER_PID" 2>/dev/null; exit 0' INT TERM
fi

# ── 7. Wait for server to be ready ───────────────────────────────────────────
URL="http://127.0.0.1:$PORT"
info "Waiting for server to be ready..."

MAX_WAIT=60
WAITED=0
printf "  "
while ! curl -sf "$URL" -o /dev/null 2>/dev/null; do
  if [ "$SKIP_SERVER" = "0" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo ""
    die "Server process exited unexpectedly. Check the output above for errors."
  fi
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo ""
    die "Server didn't respond within ${MAX_WAIT}s. Try running 'python forge.py' manually."
  fi
  printf "${AMBER}·${NC}"
  sleep 1
  WAITED=$((WAITED + 1))
done
echo ""
ok "Server ready at $URL"

# ── 8. Open browser ───────────────────────────────────────────────────────────
info "Opening browser..."

if command -v xdg-open &>/dev/null; then
  xdg-open "$URL" &>/dev/null &          # Linux
elif command -v open &>/dev/null; then
  open "$URL"                             # macOS
elif command -v start &>/dev/null; then
  start "$URL"                            # Windows (Git Bash)
elif command -v cmd.exe &>/dev/null; then
  cmd.exe /c start "$URL" &>/dev/null &  # Windows (WSL)
else
  info "Could not detect a browser opener — visit ${AMBER_B}$URL${NC} manually"
fi

ok "Browser opened"

# ── 9. Stay alive so the server keeps running ─────────────────────────────────
if [ "$SKIP_SERVER" = "0" ]; then
  echo ""
  echo -e "  ${AMBER_B}DungeonForge is running.${NC}"
  echo -e "  ${DIM}Press Ctrl-C to stop the server and exit.${NC}"
  echo ""
  wait "$SERVER_PID" 2>/dev/null || true
fi
