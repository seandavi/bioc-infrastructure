"""The git trees the units execute: on the default branch, at GitHub's tip, clean.

Never fetches; the collector mutates nothing. "Tip" is read from the GitHub API.
"""

from __future__ import annotations

import re
from datetime import datetime

from .. import rules
from ..model import Finding, SourceResult, Status
from ..run import CommandError, run
from .systemd import discover_units, show

NAME = "checkouts"
SLUG = re.compile(r"github\.com[:/]([^/]+)/([^/.]+?)(?:\.git)?$")


def _git(d: str, *args: str) -> str:
    return run(["git", "-C", d, *args]).strip()


def collect(cfg: dict, now: datetime) -> SourceResult:
    dirs: dict[str, list[str]] = {}
    for svc in discover_units(cfg):
        # `show` prefixes "!" for WorkingDirectory=~ and "-" for missing-ok; drop both.
        wd = show(svc, "WorkingDirectory").get("WorkingDirectory", "").lstrip("!-")
        if wd:
            dirs.setdefault(wd, []).append(svc)

    findings: list[Finding] = []
    rows = []
    for d, units in sorted(dirs.items()):
        row = {"dir": d, "units": units, "head": None}
        rows.append(row)
        try:
            top = _git(d, "rev-parse", "--show-toplevel")
        except (CommandError, OSError):
            findings.append(Finding(f"{NAME}/{d}/git", NAME, Status.INFO,
                                    f"{d} is not a git checkout", evidence={"units": units}))
            continue
        try:
            branch = run(["git", "-C", d, "symbolic-ref", "--short", "-q", "HEAD"]).strip() or None
        except CommandError:  # exit 1 when detached
            branch = None
        head = _git(d, "rev-parse", "HEAD")
        dirty = len(_git(d, "status", "--porcelain", "--untracked-files=no").splitlines())
        m = SLUG.search(_git(d, "remote", "get-url", "origin"))
        if not m:
            raise ValueError(f"{d}: origin is not a GitHub remote")
        slug = f"{m.group(1)}/{m.group(2)}"
        default = run(["gh", "api", f"repos/{slug}", "-q", ".default_branch"]).strip()
        tip = run(["gh", "api", f"repos/{slug}/commits/{default}", "-q", ".sha"]).strip()
        row |= {"toplevel": top, "slug": slug, "branch": branch, "default_branch": default,
                "head": head, "tip": tip, "dirty": dirty}
        st, title = rules.checkout_status(branch, default, head, tip, dirty)
        findings.append(Finding(f"{NAME}/{d}/tree", NAME, st, f"{d}: {title}",
                                evidence=row, refs=[f"https://github.com/{slug}/commits/{default}"]))

    return SourceResult(NAME, findings, {"checkouts": rows})
