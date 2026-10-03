#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb>=1.4"]
# ///
"""Collect a read-only health snapshot of the bioc-* stack into bundle.json + report.md.

    ./health/collect.py [--config PATH] [--out DIR] [--only a,b,...] [--now ISO8601]

Exit 0: nothing worse than warn. Exit 1: at least one fail or error finding.
Exit 2: bad command line or config; no source ran. See health/README.md.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import socket
import sys
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bioc_health import crossref, report  # noqa: E402
from bioc_health.model import Finding, SourceResult, Status, worst  # noqa: E402

HERE = Path(__file__).resolve().parent
# Order is the report's section order. Modules load lazily so a narrow --only run
# does not import duckdb.
SOURCE_NAMES = ("issues", "actions", "systemd", "checkouts", "access_logs", "host", "endpoints")
REQUIRED_KEYS = (
    "owner", "repos", "experimental_repos", "failure_issue_repo", "activity_window_days",
    "systemd", "access_logs", "host", "thresholds",
)


def _usage_error(msg: str):
    print(f"collect.py: {msg}", file=sys.stderr)
    sys.exit(2)


def _load_config(path: Path) -> dict:
    try:
        cfg = tomllib.loads(path.read_text())
    except (OSError, tomllib.TOMLDecodeError) as exc:
        _usage_error(f"cannot load config {path}: {exc}")
    missing = [k for k in REQUIRED_KEYS if k not in cfg]
    if missing:
        _usage_error(f"config {path} lacks: {', '.join(missing)}")
    return cfg


def _parse_now(s: str | None) -> datetime:
    if s is None:
        return datetime.now(timezone.utc)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        _usage_error(f"--now: not ISO 8601: {s!r}")
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _run_source(name: str, cfg: dict, now: datetime) -> SourceResult:
    t0 = time.monotonic()
    try:
        fn = importlib.import_module(f"bioc_health.sources.{name}").collect
        res = fn(cfg, now)
    except Exception as exc:  # one broken source must not sink the others
        res = SourceResult(
            name,
            findings=[Finding(f"{name}/collector/error", name, Status.ERROR,
                              f"{name} collector failed: {exc}")],
            data={},
            error=repr(exc),
        )
    res.duration_s = time.monotonic() - t0
    return res


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", type=Path, default=HERE / "config.toml")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--only", help=f"comma-separated subset of: {', '.join(SOURCE_NAMES)}")
    ap.add_argument("--now", help="pretend UTC time, ISO 8601 (default: now)")
    args = ap.parse_args(argv)

    selected = list(SOURCE_NAMES)
    if args.only:
        selected = [s.strip() for s in args.only.split(",") if s.strip()]
        unknown = [s for s in selected if s not in SOURCE_NAMES]
        if unknown or not selected:
            _usage_error(f"unknown source(s) {', '.join(unknown)}; valid: {', '.join(SOURCE_NAMES)}")
    cfg = _load_config(args.config)
    now = _parse_now(args.now)
    # The repo is public: the default output directory is never inside it.
    out = args.out or Path(os.environ.get("TMPDIR") or "/tmp") / "bioc-health" / now.strftime("%Y%m%dT%H%M%SZ")

    with ThreadPoolExecutor(max_workers=len(selected)) as pool:
        futures = {name: pool.submit(_run_source, name, cfg, now) for name in selected}
        results = {name: futures[name].result() for name in selected}

    findings = [f for r in results.values() for f in r.findings]
    findings += crossref.collect(results, cfg, now)
    findings.sort(key=lambda f: (-f.status, f.id))
    overall = worst(findings)

    bundle = {
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "host": socket.gethostname(),
        "config": cfg,
        "overall": str(overall),
        "sources": {
            name: {"status": str(r.status), "duration_s": round(r.duration_s, 2),
                   "error": r.error, "data": r.data}
            for name, r in results.items()
        },
        "findings": [f.to_dict() for f in findings],
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "bundle.json").write_text(json.dumps(bundle, indent=2, default=str) + "\n")
    # Round-trip so the report renders exactly what the bundle holds.
    (out / "report.md").write_text(report.render(json.loads((out / "bundle.json").read_text())))
    print((out / "report.md").resolve())
    return 1 if overall >= Status.FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
