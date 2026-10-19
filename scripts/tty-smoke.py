#!/usr/bin/env python3
"""Drive the interactive CLI in a real pseudo-terminal (POSIX only).

Exercises the clack prompts end to end: manual commit, smart commit against a local mock
provider, and Ctrl-C during a slow request (must exit 130 and restore the index).

Usage: python3 scripts/tty-smoke.py            (after `npm run build`)
Exit code 0 means every scenario passed.
"""

import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import termios
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "dist", "cli.js")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r")
DOWN, ENTER, CTRL_C = "\x1b[B", "\r", "\x03"

DRAFT = {
    "type": "feat",
    "scope": "math",
    "gitmoji": ":sparkles:",
    "description": "add sum helper",
    "body": "Adds a helper for adding two numbers.",
    "breaking": False,
    "breakingDescription": "",
    "footers": [],
}
DELAY = {"seconds": 0.0}


class MockOpenAI(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers.get("content-length", 0)))
        time.sleep(DELAY["seconds"])
        body = json.dumps({
            "status": "completed",
            "model": "gpt-5.6-luna",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(DRAFT)}]}],
            "usage": {"input_tokens": 100, "output_tokens": 20},
        }).encode()
        try:
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_):
        pass


class Session:
    def __init__(self, args, cwd, env):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe("node", ["node", CLI, *args], env)
        # A fresh pty reports 0 columns; give it a realistic 120x40 window.
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.buffer = ""

    def expect(self, pattern, timeout=15):
        deadline = time.time() + timeout
        regex = re.compile(pattern)
        while time.time() < deadline:
            if regex.search(ANSI.sub("", self.buffer)):
                return
            ready, _, _ = select.select([self.fd], [], [], 0.1)
            if ready:
                try:
                    self.buffer += os.read(self.fd, 65536).decode("utf8", "replace")
                except OSError:
                    break
        raise AssertionError(f"timed out waiting for {pattern!r}\n--- screen ---\n{ANSI.sub('', self.buffer)[-3000:]}")

    def send(self, keys, pause=0.15):
        time.sleep(pause)
        os.write(self.fd, keys.encode())

    def wait(self, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            ready, _, _ = select.select([self.fd], [], [], 0.1)
            if ready:
                try:
                    self.buffer += os.read(self.fd, 65536).decode("utf8", "replace")
                except OSError:
                    pass
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return os.waitstatus_to_exitcode(status)
        os.kill(self.pid, 9)
        raise AssertionError("process did not exit")


def git(repo, *args, env):
    return subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True, text=True).stdout


def new_repo(base, env):
    repo = tempfile.mkdtemp(dir=base)
    git(repo, "init", "-q", "-b", "main", env=env)
    git(repo, "config", "user.email", "tester@example.com", env=env)
    git(repo, "config", "user.name", "Tester", env=env)
    with open(os.path.join(repo, "README.md"), "w") as f:
        f.write("# test\n")
    git(repo, "add", "-A", env=env)
    git(repo, "commit", "-q", "-m", "chore: initial", env=env)
    return repo


def main():
    if not os.path.exists(CLI):
        print("dist/cli.js missing: run `npm run build` first", file=sys.stderr)
        return 1
    base = tempfile.mkdtemp(prefix="ccli-tty-")
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAI)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    gitconfig = os.path.join(base, "gitconfig")
    open(gitconfig, "w").close()
    env = {
        **os.environ,
        "GIT_CONFIG_GLOBAL": gitconfig,
        "GIT_CONFIG_NOSYSTEM": "1",
        "CCLI_DISABLE_KEYCHAIN": "1",
        "TERM": "xterm-256color",
        "COLUMNS": "120",
        "LINES": "40",
    }
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "NO_COLOR"):
        env.pop(name, None)
    results = []
    try:
        # 1. Manual commit through every prompt.
        repo = new_repo(base, env)
        cfg = tempfile.mkdtemp(dir=base)
        with open(os.path.join(repo, "math.js"), "w") as f:
            f.write("export const sum = (a, b) => a + b;\n")
        git(repo, "add", "math.js", env=env)
        s = Session(["commit"], repo, {**env, "CCLI_CONFIG_DIR": cfg})
        s.expect(r"Type of change")
        s.send(DOWN * 4 + ENTER)  # build, chore, ci, docs, feat
        s.expect(r"Scope")
        s.send("math" + ENTER)
        s.expect(r"Gitmoji")
        s.send(ENTER)  # suggested ✨
        s.expect(r"Short description")
        s.send("add sum helper" + ENTER)
        s.expect(r"Body")
        s.send(ENTER + ENTER)
        s.expect(r"breaking change")
        s.send(ENTER)  # No
        s.expect(r"Related issues")
        s.send("#7" + ENTER)
        s.expect(r"What would you like to do")
        s.send(ENTER)  # Commit
        code = s.wait()
        message = git(repo, "log", "-1", "--format=%B", env=env).strip()
        assert code == 0, f"exit {code}"
        assert message == "feat(math): ✨ add sum helper\n\nRefs: #7", message
        results.append("manual commit")

        # 2. Smart commit: approve once, review, commit.
        repo = new_repo(base, env)
        cfg = tempfile.mkdtemp(dir=base)
        with open(os.path.join(cfg, "config.json"), "w") as f:
            json.dump({"providers": {"order": ["openai"], "openai": {"baseUrl": f"http://127.0.0.1:{port}/v1"}}}, f)
        with open(os.path.join(repo, "math.js"), "w") as f:
            f.write("export const sum = (a, b) => a + b;\n")
        git(repo, "add", "math.js", env=env)
        smart_env = {**env, "CCLI_CONFIG_DIR": cfg, "OPENAI_API_KEY": "sk-test-tty-000000000000"}
        s = Session(["smart", "commit"], repo, smart_env)
        s.expect(r"Allow sending diffs")
        s.send(ENTER)  # Yes
        s.expect(r"What would you like to do")
        s.send(ENTER)  # Commit
        code = s.wait()
        message = git(repo, "log", "-1", "--format=%B", env=env).strip()
        assert code == 0, f"exit {code}"
        assert message == "feat(math): ✨ add sum helper\n\nAdds a helper for adding two numbers.", message
        results.append("smart commit")

        # 3. Ctrl-C during a slow request cancels cleanly and restores staging done by ccli.
        with open(os.path.join(repo, "README.md"), "a") as f:
            f.write("more\n")
        DELAY["seconds"] = 10
        s = Session(["smart", "commit"], repo, smart_env)
        s.expect(r"Nothing is staged yet")
        s.send(ENTER)  # all tracked changes
        s.expect(r"Writing the message")
        s.send(CTRL_C, pause=0.5)
        code = s.wait()
        staged = git(repo, "diff", "--cached", "--name-only", env=env).strip()
        assert code == 130, f"exit {code}\n{ANSI.sub('', s.buffer)[-1500:]}"
        assert staged == "", f"index not restored: {staged!r}"
        results.append("ctrl-c cancels and restores the index")
    except AssertionError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    finally:
        server.shutdown()
        shutil.rmtree(base, ignore_errors=True)
    for name in results:
        print(f"PASS {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
