"""Disk headroom and accumulating sync logs on the box that runs the units."""

from __future__ import annotations

import glob
import os
import shutil
from datetime import datetime

from .. import rules
from ..model import Finding, SourceResult, Status

NAME = "host"


def collect(cfg: dict, now: datetime) -> SourceResult:
    th = cfg["thresholds"]
    findings: list[Finding] = []
    disks, logs = [], []

    for raw in cfg["host"]["disk_paths"]:
        path = os.path.expanduser(raw)
        try:
            du = shutil.disk_usage(path)
        except OSError as exc:
            findings.append(Finding(f"{NAME}/{raw}/disk", NAME, Status.ERROR, f"cannot stat {path}: {exc}"))
            continue
        free_pct = 100 * du.free / du.total
        disks.append({"path": path, "total": du.total, "free": du.free, "free_pct": free_pct})
        findings.append(Finding(
            f"{NAME}/{raw}/disk", NAME, rules.disk_status(free_pct, th),
            f"{path}: {free_pct:.1f}% free ({du.free / 2**30:.0f} GiB)",
            evidence={"free_pct": free_pct, "free": du.free, "total": du.total},
        ))

    for raw in cfg["host"]["log_globs"]:
        files = glob.glob(os.path.expanduser(raw))
        n_bytes = 0
        for f in files:
            try:
                n_bytes += os.path.getsize(f)
            except OSError:
                pass  # rotated away between glob and stat
        logs.append({"glob": raw, "files": len(files), "bytes": n_bytes})
        findings.append(Finding(
            f"{NAME}/{raw}/logs", NAME, rules.log_accumulation_status(len(files), n_bytes, th),
            f"{raw}: {len(files)} files, {n_bytes / 2**20:.0f} MiB",
            evidence={"files": len(files), "bytes": n_bytes},
        ))

    return SourceResult(NAME, findings, {"disks": disks, "logs": logs})
