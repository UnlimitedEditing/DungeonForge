#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  DungeonForge — one-click launcher
#  Works on macOS, Linux, WSL, and Windows (Git Bash)
#
#  First run: installs Python if missing, creates a virtual environment,
#  installs deps, prompts for your Graydient API key.
#  Subsequent runs: just start the server and open the browser.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
AMBER='\033[0;33m'
AMBER_B='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC}  $*"; }
info() { echo -e "  ${AMBER}·${NC}  $*"; }
warn() { echo -e "  ${AMBER}!${NC}  $*"; }
die()  { echo -e "\n  ${RED}✗  $*${NC}\n"; exit 1; }

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${AMBER_B}  ╔══════════════════════════════════════╗"
echo -e "  ║        D U N G E O N  F O R G E      ║"
echo -e "  ╚══════════════════════════════════════╝${NC}"
echo ""

# ── Working directory = script location ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── OS detection ──────────────────────────────────────────────────────────────
detect_os() {
  local raw
  raw="$(uname -s 2>/dev/null || echo "unknown")"
  case "$raw" in
    Darwin*)
      echo "macos" ;;
    Linux*)
      # WSL reports Linux kernel but runs on Windows
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
    MSYS*|MINGW*|CYGWIN*)
      echo "windows-bash" ;;
    *)
      echo "unknown" ;;
  esac
}
OS="$(detect_os)"

# ── Python installation helper ────────────────────────────────────────────────
try_install_python() {
  echo ""
  warn "Python 3.10+ not found — attempting automatic installation..."
  echo ""

  case "$OS" in

    macos)
      if command -v brew &>/dev/null; then
        info "Installing Python via Homebrew..."
        brew install python3
      else
        echo -e "  ${AMBER_B}Python is not installed and Homebrew was not found.${NC}"
        echo ""
        echo "  Fastest fix — paste this into a new Terminal window:"
        echo ""
        echo -e "  ${DIM}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${NC}"
        echo -e "  ${DIM}brew install python3${NC}"
        echo ""
        echo "  Or download the macOS installer directly:"
        echo "  https://www.python.org/downloads/macos/"
        echo ""
        exit 1
      fi
      ;;

    linux|wsl)
      if command -v apt-get &>/dev/null; then
        info "Installing Python via apt..."
        sudo apt-get update -qq
        sudo apt-get install -y python3 python3-venv python3-pip
      elif command -v dnf &>/dev/null; then
        info "Installing Python via dnf..."
        sudo dnf install -y python3 python3-pip python3-virtualenv
      elif command -v yum &>/dev/null; then
        info "Installing Python via yum..."
        sudo yum install -y python3 python3-pip
      elif command -v pacman &>/dev/null; then
        info "Installing Python via pacman..."
        sudo pacman -S --noconfirm python python-pip
      elif command -v zypper &>/dev/null; then
        info "Installing Python via zypper..."
        sudo zypper install -y python3 python3-pip
      else
        die "No supported package manager found.\nInstall Python 3.10+ manually: https://www.python.org/downloads/"
      fi
      ;;

    windows-bash)
      echo -e "  ${AMBER_B}Python not found on Windows.${NC}"
      echo ""
      if command -v winget &>/dev/null; then
        info "Installing Python via winget..."
        winget install --id Python.Python.3.12 \
          --source winget \
          --accept-package-agreements \
          --accept-source-agreements \
          --silent \
          || die "winget install failed.\nDownload Python manually: https://www.python.org/downloads/windows/"
        echo ""
        ok "Python installed!"
        echo ""
        warn "Git Bash needs to be restarted before it can see the new Python."
        echo ""
        echo -e "  ${DIM}1. Close this window"
        echo -e "  2. Reopen Git Bash"
        echo -e "  3. Run:  ${NC}${AMBER_B}bash launch.sh${NC}"
        echo ""
        exit 0
      else
        echo -e "  ${AMBER_B}Manual install required (takes ~2 minutes):${NC}"
        echo ""
        echo "  1. Open:  https://www.python.org/downloads/windows/"
        echo "  2. Download the latest Python 3.x installer"
        echo "  3. Run it — tick ✅ 'Add Python to PATH'"
        echo "  4. Reopen Git Bash and run:  bash launch.sh"
        echo ""
        # Try to open the download page automatically
        if command -v cmd.exe &>/dev/null; then
          cmd.exe /c start "https://www.python.org/downloads/windows/" &>/dev/null || true
        fi
        exit 1
      fi
      ;;

    *)
      die "Unknown OS. Install Python 3.10+ from https://www.python.org/downloads/ then re-run this script."
      ;;
  esac
}

# ── 1. Find Python 3.10+ ──────────────────────────────────────────────────────
info "Checking Python..."

find_python() {
  for cmd in python3 python python3.13 python3.12 python3.11 python3.10; do
    if command -v "$cmd" &>/dev/null; then
      if "$cmd" -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" 2>/dev/null; then
        echo "$cmd"
        return 0
      fi
    fi
  done
  return 1
}

PYTHON="$(find_python || true)"

if [ -z "$PYTHON" ]; then
  # Check if Python exists at all but is just too old
  OLD_PY=""
  for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
      OLD_PY="$cmd"
      break
    fi
  done

  if [ -n "$OLD_PY" ]; then
    OLD_VER=$("$OLD_PY" -c "import sys; v=sys.version_info; print(f'{v.major}.{v.minor}')" 2>/dev/null || echo "?")
    warn "Found Python $OLD_VER but DungeonForge requires 3.10 or newer."
    try_install_python
    # Reload PATH after package manager install
    hash -r 2>/dev/null || true
    PYTHON="$(find_python || true)"
  else
    try_install_python
    hash -r 2>/dev/null || true
    PYTHON="$(find_python || true)"
  fi
fi

# Final check
if [ -z "$PYTHON" ]; then
  die "Python 3.10+ installation did not appear on PATH.\nReopen your terminal and run this script again."
fi

PY_VER=$("$PYTHON" -c "import sys; v=sys.version_info; print(f'{v.major}.{v.minor}.{v.micro}')")
ok "Python $PY_VER  ($PYTHON)"

# ── 2. Virtual environment ────────────────────────────────────────────────────
VENV_DIR="$SCRIPT_DIR/.venv"

if [ ! -d "$VENV_DIR" ]; then
  info "Creating virtual environment..."
  # Some Linux distros need python3-venv; detect and retry if it fails
  if ! "$PYTHON" -m venv "$VENV_DIR" 2>/dev/null; then
    warn "'python3 -m venv' failed — trying to install python3-venv..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y python3-venv
    fi
    "$PYTHON" -m venv "$VENV_DIR"
  fi
  ok "Virtual environment created"
fi

# Activate — Scripts/ on Windows, bin/ on Unix
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

if ! python -c "import fastapi" &>/dev/null; then
  echo ""
  warn "Installing packages — this takes a minute on first run."
  warn "rembg will download a ~170 MB model the very first time a prop is processed."
  echo ""
  pip install --quiet --upgrade pip
  pip install --quiet -r requirements.txt
  echo ""
  ok "Dependencies installed"
else
  ok "Dependencies up to date"
fi

# ── 4. API key (.env) ─────────────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo ""
  echo -e "  ${AMBER_B}⚙  First-time setup${NC}"
  echo ""
  echo -e "  ${DIM}Your Graydient API key is needed to render sprites."
  echo -e "  It will be saved to .env beside this script and never shared.${NC}"
  echo ""
  printf "  Paste your Graydient API key and press Enter: "
  read -r GRAYDIENT_KEY </dev/tty

  if [ -z "$GRAYDIENT_KEY" ]; then
    die "No key entered. Add  GRAYDIENT_KEY=your-key  to a .env file and re-run."
  fi

  printf "GRAYDIENT_KEY=%s\n" "$GRAYDIENT_KEY" > "$ENV_FILE"
  ok ".env created"
else
  if ! grep -q "GRAYDIENT_KEY" "$ENV_FILE"; then
    die ".env found but GRAYDIENT_KEY is missing.\nAdd:  GRAYDIENT_KEY=your-key-here"
  fi
  ok ".env found"
fi

# ── 5. Port check ─────────────────────────────────────────────────────────────
PORT=8000
SKIP_SERVER=0

port_in_use() {
  if command -v lsof &>/dev/null; then
    lsof -ti :"$PORT" &>/dev/null
  elif command -v netstat &>/dev/null; then
    netstat -an 2>/dev/null | grep -q ":${PORT}[[:space:]]"
  else
    return 1  # Can't tell — assume free
  fi
}

if port_in_use; then
  warn "Port $PORT already in use — the Forge may already be running."
  SKIP_SERVER=1
fi

# ── 6. Start forge.py ─────────────────────────────────────────────────────────
if [ "$SKIP_SERVER" = "0" ]; then
  info "Starting DungeonForge..."
  python forge.py &
  SERVER_PID=$!

  echo -e "  ${DIM}PID $SERVER_PID — press Ctrl-C to stop${NC}"
  echo ""

  trap 'echo ""; info "Shutting down..."; kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; exit 0' INT TERM
fi

# ── 7. Wait for the server to respond ────────────────────────────────────────
URL="http://127.0.0.1:$PORT"
info "Waiting for server"

MAX_WAIT=60
WAITED=0
printf "  "
until curl -sf "$URL" -o /dev/null 2>/dev/null; do
  if [ "$SKIP_SERVER" = "0" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo ""
    die "Server exited unexpectedly. Check the output above for errors."
  fi
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo ""
    die "Server didn't respond within ${MAX_WAIT}s.\nTry running  python forge.py  directly to see the error."
  fi
  printf "${AMBER}·${NC}"
  sleep 1
  WAITED=$((WAITED + 1))
done
echo ""
ok "Server ready → $URL"

# ── 8. Open browser ───────────────────────────────────────────────────────────
info "Opening browser..."
case "$OS" in
  macos)         open "$URL" ;;
  linux)         xdg-open "$URL" &>/dev/null & ;;
  wsl)           cmd.exe /c start "$URL" &>/dev/null & ;;
  windows-bash)
    # 'start' is a shell built-in in Git Bash; cmd.exe /c start is more reliable
    cmd.exe /c start "$URL" &>/dev/null \
      || start "$URL" \
      || info "Visit ${AMBER_B}$URL${NC} in your browser" ;;
  *)
    if command -v xdg-open &>/dev/null; then
      xdg-open "$URL" &>/dev/null &
    else
      info "Visit ${AMBER_B}$URL${NC} in your browser"
    fi
    ;;
esac
ok "Browser opened"

# ── 9. Keep the process alive (server stays up until Ctrl-C) ─────────────────
if [ "$SKIP_SERVER" = "0" ]; then
  echo ""
  echo -e "  ${AMBER_B}DungeonForge is running.${NC}"
  echo -e "  ${DIM}Press Ctrl-C to stop the server and exit.${NC}"
  echo ""
  wait "$SERVER_PID" 2>/dev/null || true
fi
