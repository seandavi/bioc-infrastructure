"""Findings and per-source results; the shared vocabulary of every source."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class Status(enum.IntEnum):
    OK = 0
    INFO = 1
    WARN = 2
    FAIL = 3
    ERROR = 4

    def __str__(self) -> str:
        return self.name.lower()


@dataclass
class Finding:
    id: str  # f"{source}/{subject}/{check}", stable across runs
    source: str
    status: Status
    title: str
    detail: str | None = None
    evidence: dict = field(default_factory=dict)
    refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "source": self.source,
            "status": str(self.status),
            "title": self.title,
            "detail": self.detail,
            "evidence": self.evidence,
            "refs": self.refs,
        }


@dataclass
class SourceResult:
    name: str
    findings: list[Finding]
    data: dict
    duration_s: float = 0.0
    error: str | None = None

    @property
    def status(self) -> Status:
        return worst(self.findings)


def worst(findings) -> Status:
    return max((f.status for f in findings), default=Status.OK)
