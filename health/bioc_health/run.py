"""Subprocess wrapper: every external command the sources run goes through here."""

from __future__ import annotations

import json
import subprocess


class CommandError(Exception):
    def __init__(self, cmd: list[str], returncode: int, stderr: str):
        self.cmd = cmd
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(f"{' '.join(cmd)} exited {returncode}: {stderr.strip()}")


def run(cmd: list[str], timeout: float = 120) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise CommandError(cmd, p.returncode, p.stderr[-2000:])
    return p.stdout


def run_json(cmd: list[str], timeout: float = 120):
    return json.loads(run(cmd, timeout=timeout))


def gh_json(*args: str):
    return run_json(["gh", *args])
