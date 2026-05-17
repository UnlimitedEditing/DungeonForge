#!/usr/bin/env python3
"""
DungeonForge Launcher
Handles first-run setup (deps, .env) and server lifecycle via a GUI.
"""

import os
import re
import subprocess
import sys
import threading
import tkinter as tk
import webbrowser
from pathlib import Path

BASE_DIR = Path(__file__).parent
FORGE_URL = "http://127.0.0.1:8000"
ENV_FILE  = BASE_DIR / ".env"
REQ_FILE  = BASE_DIR / "requirements.txt"

# Amber CRT palette — matches the game
BG         = "#1a1208"
FG         = "#d4880a"
FG_DIM     = "#7a4d06"
FG_BRIGHT  = "#ffb347"
BTN_BG     = "#2a1c0a"
BTN_ACTIVE = "#3a2810"
COL_OK     = "#5a9e3a"
COL_ERR    = "#cc3300"


def _read_env_key():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            m = re.match(r"^\s*GRAYDIENT_KEY\s*=\s*(.+)", line)
            if m:
                return m.group(1).strip()
    return ""


def _write_env_key(key):
    ENV_FILE.write_text(f"GRAYDIENT_KEY={key}\n")


class LauncherApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("DungeonForge")
        self.configure(bg=BG)
        self.resizable(False, False)
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self._server_proc = None
        self._build_ui()
        existing_key = _read_env_key()
        if existing_key:
            self._key_var.set(existing_key)
            self._log("API key loaded.", "dim")

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------

    def _build_ui(self):
        pad = dict(padx=20, pady=6)

        tk.Label(
            self, text="DUNGEONFORGE", bg=BG, fg=FG_BRIGHT,
            font=("Courier", 20, "bold"),
        ).pack(pady=(24, 2))

        tk.Label(
            self, text="Powered by Graydient", bg=BG, fg=FG_DIM,
            font=("Courier", 9),
        ).pack(pady=(0, 18))

        # API key
        key_frame = tk.Frame(self, bg=BG)
        key_frame.pack(fill="x", **pad)
        tk.Label(
            key_frame, text="Graydient API Key", bg=BG, fg=FG,
            font=("Courier", 10),
        ).pack(anchor="w")
        self._key_var = tk.StringVar()
        self._key_entry = tk.Entry(
            key_frame, textvariable=self._key_var, show="●", width=44,
            bg=BTN_BG, fg=FG_BRIGHT, insertbackground=FG_BRIGHT,
            relief="flat", font=("Courier", 11), bd=4,
        )
        self._key_entry.pack(fill="x", pady=(4, 0))

        # Status log
        log_frame = tk.Frame(self, bg=BG)
        log_frame.pack(fill="both", expand=True, padx=20, pady=(14, 0))
        self._log_box = tk.Text(
            log_frame, height=9, width=50, bg=BTN_BG, fg=FG,
            font=("Courier", 9), relief="flat", bd=4,
            state="disabled", cursor="arrow",
        )
        self._log_box.pack(fill="both", expand=True)
        self._log_box.tag_config("ok",  foreground=COL_OK)
        self._log_box.tag_config("err", foreground=COL_ERR)
        self._log_box.tag_config("dim", foreground=FG_DIM)

        # Buttons
        btn_frame = tk.Frame(self, bg=BG)
        btn_frame.pack(fill="x", padx=20, pady=18)

        self._launch_btn = tk.Button(
            btn_frame, text="LAUNCH GAME", command=self._on_launch,
            bg=FG, fg=BG, activebackground=FG_BRIGHT, activeforeground=BG,
            font=("Courier", 13, "bold"), relief="flat", bd=0,
            padx=12, pady=10, cursor="hand2",
        )
        self._launch_btn.pack(fill="x")

        self._stop_btn = tk.Button(
            btn_frame, text="STOP SERVER", command=self._on_stop,
            bg=BTN_BG, fg=FG_DIM, activebackground=BTN_ACTIVE,
            font=("Courier", 10), relief="flat", bd=0,
            padx=12, pady=6, cursor="hand2", state="disabled",
        )
        self._stop_btn.pack(fill="x", pady=(8, 0))

    # ------------------------------------------------------------------
    # Logging (thread-safe via after())
    # ------------------------------------------------------------------

    def _log(self, text, tag=None):
        def _append():
            self._log_box.configure(state="normal")
            self._log_box.insert("end", text + "\n", tag or "")
            self._log_box.see("end")
            self._log_box.configure(state="disabled")
        self.after(0, _append)

    # ------------------------------------------------------------------
    # Launch flow
    # ------------------------------------------------------------------

    def _on_launch(self):
        key = self._key_var.get().strip()
        if not key:
            self._log("Enter your Graydient API key first.", "err")
            return
        _write_env_key(key)
        self._launch_btn.configure(state="disabled")
        self._key_entry.configure(state="disabled")
        threading.Thread(target=self._setup_then_start, daemon=True).start()

    def _setup_then_start(self):
        self._log("Checking dependencies…")
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-q", "-r", str(REQ_FILE)],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            self._log("Dependency install failed:", "err")
            output = (result.stderr or result.stdout or "").strip()
            for line in output.splitlines()[-8:]:
                self._log("  " + line, "err")
            self.after(0, self._restore_launch_btn)
            return

        self._log("Dependencies ready.", "ok")
        self._log("Starting server…")

        self._server_proc = subprocess.Popen(
            [sys.executable, str(BASE_DIR / "forge.py")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, cwd=str(BASE_DIR),
        )

        threading.Thread(target=self._open_browser_when_ready, daemon=True).start()
        threading.Thread(target=self._tail_server_log, daemon=True).start()
        self.after(0, self._on_server_started)

    def _open_browser_when_ready(self):
        import time
        time.sleep(3)
        if self._server_proc and self._server_proc.poll() is None:
            webbrowser.open(FORGE_URL)
            self._log(f"Browser opened → {FORGE_URL}", "ok")

    def _tail_server_log(self):
        for line in self._server_proc.stdout:
            line = line.rstrip()
            if line:
                self._log(line, "dim")
        self.after(0, self._on_server_stopped)

    # ------------------------------------------------------------------
    # Server state
    # ------------------------------------------------------------------

    def _on_server_started(self):
        self._log("Server running.", "ok")
        self._stop_btn.configure(state="normal", fg=COL_ERR)

    def _on_server_stopped(self):
        self._log("Server stopped.", "dim")
        self._server_proc = None
        self.after(0, self._restore_launch_btn)
        self._stop_btn.configure(state="disabled", fg=FG_DIM)

    def _restore_launch_btn(self):
        self._launch_btn.configure(state="normal")
        self._key_entry.configure(state="normal")

    def _on_stop(self):
        if self._server_proc:
            self._server_proc.terminate()

    def _on_close(self):
        if self._server_proc:
            self._server_proc.terminate()
        self.destroy()


if __name__ == "__main__":
    app = LauncherApp()
    app.mainloop()
