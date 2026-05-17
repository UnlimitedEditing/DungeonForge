#!/usr/bin/env bash
# Finds Python 3.8+ and launches the GUI launcher.
# macOS: double-click in Finder requires this file to be executable (chmod +x launch.sh).
# Linux: run with  bash launch.sh  or mark executable and double-click in a file manager.

PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        ok=$("$cmd" -c "import sys; print(sys.version_info >= (3,8))" 2>/dev/null)
        if [ "$ok" = "True" ]; then
            PYTHON="$cmd"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo "Python 3.8+ not found."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "Install with Homebrew:  brew install python"
    else
        echo "Install with apt:       sudo apt install python3 python3-pip python3-tk"
    fi
    echo "Or download from: https://www.python.org/downloads/"
    read -rp "Press Enter to exit..."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$PYTHON" "$SCRIPT_DIR/launcher.py"
