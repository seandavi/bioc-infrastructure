#!/usr/bin/env python3
"""Draw the unified-search proposal's figures as SVG. Stdlib only.

    python3 diagrams/unified-search/make_figures.py   # writes <name>-light.svg and <name>-dark.svg

Same helpers and colour roles as the 2026-10-01 TAB deck (talks repo,
talks/2026-10-01-bioc-tab/figures/make_figures.py). Each figure is drawn twice, once
for the site's light theme and once for its dark theme; the page shows the matching one
with Quarto's .light-content / .dark-content classes. Backgrounds are transparent.

Colour roles: violet = data plane, green = builds, packages and community sources,
blue = serving and consumers, amber = external data, coral = out of scope or broken.
"""
from pathlib import Path
from html import escape

OUT = Path(__file__).parent

PALETTES = {
    "light": dict(BG="#ffffff", TEXT="#14202e", MUTED="#4a5a6c", BLUE="#1f7fc4",
                  GREEN="#4f8f17", AMBER="#b87a00", CORAL="#cc4733", VIOLET="#6e4fd0"),
    "dark": dict(BG="#020617", TEXT="#e8eef6", MUTED="#a9b8ca", BLUE="#4aa8e8",
                 GREEN="#9fd05a", AMBER="#f2b441", CORAL="#ff7a66", VIOLET="#b49cff"),
}
SANS = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"
MONO = "'JetBrains Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"
P = {}  # the active palette, set by use()


def use(name):
    P.clear()
    P.update(PALETTES[name])


def svg(w, h, body, title):
    marks = "".join(
        f'<marker id="ah-{r}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        f'markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{P[r]}"/></marker>'
        for r in ("MUTED", "BLUE", "GREEN", "AMBER", "CORAL", "VIOLET")
    )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'role="img" aria-label="{escape(title)}">\n<title>{escape(title)}</title>\n'
            f"<defs>{marks}</defs>\n" + "".join(body) + "</svg>\n")


def text(x, y, s, size=18, role="TEXT", weight=400, anchor="start", mono=False):
    fam = MONO if mono else SANS
    return (f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" fill="{P[role]}" '
            f'font-weight="{weight}" text-anchor="{anchor}" xml:space="preserve">{escape(s)}</text>\n')


def box(x, y, w, h, title, lines=(), role="BLUE", title_size=20, line_size=15, anchor="start"):
    c = P[role]
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{c}1a" stroke="{c}" stroke-width="2"/>\n']
    tx = x + w / 2 if anchor == "middle" else x + 16
    out.append(text(tx, y + 30, title, title_size, "TEXT", 650, anchor))
    for i, ln in enumerate(lines):
        out.append(text(tx, y + 38 + (i + 1) * (line_size + 7), ln, line_size, "MUTED", 400, anchor, mono=True))
    return "".join(out)


def group(x, y, w, h, label, role):
    c = P[role]
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16" fill="none" stroke="{c}" '
            f'stroke-width="1.5" stroke-dasharray="4 6"/>\n'
            + text(x + 16, y - 10, label.upper(), 14, role, 700, mono=True))


def arrow(pts, role="MUTED", label=None, lpos=None, width=2.2, lsize=13):
    c = P[role]
    d = "M" + " L".join(f"{a},{b}" for a, b in pts)
    out = [f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{width}" marker-end="url(#ah-{role})"/>\n']
    if label:
        lx, ly = lpos if lpos else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
        lines = label.split("\n")
        wmax = max(len(s) for s in lines) * lsize * 0.62 + 16
        hh = len(lines) * (lsize + 5) + 8
        out.append(f'<rect x="{lx - wmax / 2}" y="{ly - hh / 2}" width="{wmax}" height="{hh}" rx="6" '
                   f'fill="{P["BG"]}" stroke="{c}" stroke-width="1"/>\n')
        for i, s in enumerate(lines):
            out.append(text(lx, ly - hh / 2 + (i + 1) * (lsize + 5), s, lsize, role, 500, "middle", mono=True))
    return "".join(out)


def pill(x, y, s, role, size=14):
    c = P[role]
    w = len(s) * size * 0.62 + 20
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{size + 12}" rx="{(size + 12) / 2}" '
            f'fill="{c}22" stroke="{c}"/>\n' + text(x + w / 2, y + size + 3, s, size, role, 600, "middle", mono=True))


# --------------------------------------------------------------------------
def data_plane():
    b = []
    rows = [
        (("r-universe, bioc-build", ["DESCRIPTION, builds, checks"], "GREEN"),
         ("bioc-registry", ["facts: versions, builds,", "checks, Authors@R"])),
        (("bioconductor.org edge", ["every request, logged"], "BLUE"),
         ("bioc-traffic", ["usage: downloads, client", "classes, search events"])),
        (("Literature (cdsci-lake)", ["OpenAlex, iCite, RePORTER"], "AMBER"),
         ("bioc-intelligence", ["interpretation: papers,", "citations, people, funders"])),
        (("Community", ["Contributions trackers,", "Discourse, YouTube"], "GREEN"),
         ("bioc-contrib-intelligence", ["submissions and reviews"])),
    ]
    for i, ((st, sl, sr), (pt, pl)) in enumerate(rows):
        y = 70 + i * 135
        b.append(box(30, y, 300, 110, st, sl, sr))
        b.append(box(430, y, 360, 110, pt, pl, "VIOLET"))
        b.append(arrow([(330, y + 55), (425, y + 55)], sr))
    b.append(group(410, 50, 400, 555, "Logical data plane", "VIOLET"))
    b.append(text(610, 640, "open, versioned files (Parquet, JSON), joined on the package", 15, "VIOLET", 600, "middle", mono=True))
    cons = [
        ("Search", ["quick search, package finder,", "guided paths, sitemap, JSON-LD"], "BLUE"),
        ("Analytics", ["dashboards, reports,", "grant and board numbers"], "BLUE"),
        ("Integration", ["website build, API, mirrors,", "BiocPkgTools, other projects"], "BLUE"),
        ("Agents", ["MCP, llms.txt, Parquet,", "events agents act on"], "VIOLET"),
    ]
    for i, (t, ls, r) in enumerate(cons):
        y = 70 + i * 135
        b.append(box(1000, y, 400, 110, t, ls, r))
        b.append(arrow([(810, 330), (995, y + 55)]))
    return svg(1430, 660, b, "The logical data plane. Four sources feed four producers, each owning one slice: bioc-registry for package facts, bioc-traffic for usage, bioc-intelligence for interpretation, bioc-contrib-intelligence for submissions. They publish open, versioned Parquet and JSON joined on the package, which search, analytics, integration and agents all read.")


def index_lifecycle():
    b = []
    b.append(box(30, 150, 280, 120, "Registry propagates", ["a package version", "passes the gate"], "GREEN"))
    b.append(box(380, 150, 260, 120, "Change event", ["index.json changes;", "consumers key off it"], "VIOLET"))
    b.append(arrow([(310, 210), (375, 210)], "GREEN"))
    rebuilds = [
        ("Website build (CI)", ["pages, Pagefind shards,", "sitemap, JSON-LD"], "BLUE"),
        ("Finder index (CI)", ["Parquet subset for", "the package finder"], "VIOLET"),
        ("Intelligence refresh", ["marts: people, funders,", "papers, impact"], "VIOLET"),
    ]
    for i, (t, ls, r) in enumerate(rebuilds):
        y = 30 + i * 130
        b.append(box(720, y, 320, 110, t, ls, r))
        b.append(arrow([(640, 210), (715, y + 55)], "VIOLET"))
        b.append(arrow([(1040, y + 55), (1115, 210)]))
    b.append(box(1120, 130, 340, 160, "Immutable files on R2", ["site/<sha>/, data/<date>/", "served by the edge", "rollback = move a pointer"], "BLUE"))
    b.append(text(745, 440, "Every index is derived and disposable: delete it and rebuild it from the source of truth.", 17, "MUTED", 500, "middle"))
    return svg(1490, 470, b, "Index lifecycle. A registry propagation is the event. CI rebuilds the website (pages, Pagefind shards, sitemap, JSON-LD) and the package finder's Parquet, and bioc-intelligence refreshes its marts. Everything lands as immutable files on R2, served by the edge; rolling back means moving a pointer. Every index can be rebuilt from the source of truth.")


def agents_loop():
    b = []
    ev = [("New version propagates", "GREEN"), ("Build breaks on a platform", "CORAL"),
          ("Submission gets a review", "GREEN"), ("Zero-result searches spike", "BLUE"),
          ("A person asks a question", "BLUE")]
    for i, (t, r) in enumerate(ev):
        y = 40 + i * 92
        b.append(box(30, y, 360, 72, t, [], r, title_size=18))
        b.append(arrow([(390, y + 36), (495, 255)], width=1.8))
    b.append(box(500, 150, 360, 210, "Agent", ["reads the data plane", "(MCP, Parquet, pages)", "cites stable URLs", "", "same data people see"], "VIOLET", title_size=22, anchor="middle"))
    out = [("Answer, with citations", "to the person asking"), ("Draft maintainer note", "build failure triage"),
           ("Draft issue or PR", "synonym, guided-path fix"), ("Review precedent", "similar past submissions")]
    for i, (t, sub) in enumerate(out):
        y = 40 + i * 115
        b.append(box(960, y, 360, 90, t, [sub], "BLUE", title_size=18))
        b.append(arrow([(860, 255), (955, y + 45)], width=1.8))
    b.append(group(950, 25, 380, 455, "Human review before anything ships", "CORAL"))
    return svg(1370, 510, b, "Agents in the loop. Events from the data plane (a version propagates, a build breaks, a submission is reviewed, zero-result searches spike, a person asks a question) reach an agent that reads the same data people see and cites stable URLs. It produces answers with citations, draft maintainer notes, draft issues or pull requests, and review precedent. Anything that changes the project passes human review.")


def cost_ladder():
    b = []
    rows = [
        ("Google, with crawlable pages", "none", "none", "in scope", "GREEN"),
        ("Static index in the browser (Pagefind)", "R2 files", "rebuilt in CI", "in scope", "GREEN"),
        ("SQL in the browser over Parquet (DuckDB-WASM)", "R2 files", "rebuilt in CI", "in scope", "GREEN"),
        ("Small API on a Worker", "per request", "low", "when needed", "BLUE"),
        ("Managed semantic search (Vectorize, Workers AI)", "per use", "embeddings, model churn", "only if tests show a gain", "AMBER"),
        ("Hosted search cluster (Elasticsearch, OpenSearch)", "monthly, always on", "patching, upgrades, on-call", "out of scope", "CORAL"),
        ("Self-hosted LLM or vector database", "GPUs or servers", "a team to run it", "out of scope", "CORAL"),
    ]
    for x, h in ((30, "Option"), (650, "Standing cost"), (880, "Upkeep"), (1210, "Verdict")):
        b.append(text(x, 40, h, 15, "MUTED", 700, mono=True))
    for i, (opt, cost, ops, verdict, r) in enumerate(rows):
        y = 60 + i * 66
        c = P[r]
        b.append(f'<rect x="20" y="{y}" width="1500" height="56" rx="10" fill="{c}12" stroke="{c}" stroke-width="1.2"/>\n')
        b.append(text(36, y + 35, opt, 18, "TEXT", 600))
        b.append(text(650, y + 35, cost, 15, "MUTED", 400, mono=True))
        b.append(text(880, y + 35, ops, 15, "MUTED", 400, mono=True))
        b.append(pill(1210, y + 14, verdict, r))
    b.append(arrow([(1550, 70), (1550, 515)], width=2))
    b.append(text(1565, 300, "more to run", 15, "MUTED", 600, mono=True))
    return svg(1680, 540, b, "Cost and upkeep, qualitative, from least to most to run: Google with crawlable pages; a static Pagefind index; SQL in the browser over Parquet; a small Worker API; managed semantic search; a hosted Elasticsearch or OpenSearch cluster; a self-hosted LLM or vector database. The first three are in scope, a Worker API when needed, managed semantic search only if tests show a gain, and the last two are out of scope.")


def traffic_mix():
    # traffic-2026-09-30.qmd, "Who is asking" (bioc-traffic v0 classes).
    rows = [("R and package clients", 32.6, "GREEN"), ("Other automation", 32.5, "MUTED"),
            ("Browser-like", 20.8, "BLUE"), ("Search crawlers", 5.7, "VIOLET"),
            ("Mirrors", 3.2, "MUTED"), ("AI crawlers", 2.3, "VIOLET"),
            ("CI systems", 1.6, "MUTED"), ("Unknown", 0.7, "MUTED"), ("Monitoring", 0.5, "MUTED")]
    b = []
    for i, (lab, pct, r) in enumerate(rows):
        y = 20 + i * 52
        b.append(text(330, y + 26, lab, 17, "TEXT", 500, "end"))
        b.append(f'<rect x="350" y="{y + 6}" width="{pct * 22}" height="30" rx="5" fill="{P[r]}"/>\n')
        b.append(text(360 + pct * 22, y + 28, f"{pct}%", 16, r, 700, mono=True))
    return svg(1150, 500, b, "Requests by client type on bioconductor.org and www, 2026-09-30 UTC, 5.8 million requests (bioc-traffic v0 classes): R and package clients 32.6%, other automation 32.5%, browser-like 20.8%, search crawlers 5.7%, mirrors 3.2%, AI crawlers 2.3%, CI systems 1.6%, unknown 0.7%, monitoring 0.5%.")


FIGS = {"data-plane": data_plane, "index-lifecycle": index_lifecycle, "agents-loop": agents_loop,
        "cost-ladder": cost_ladder, "traffic-mix": traffic_mix}

if __name__ == "__main__":
    for theme in PALETTES:
        use(theme)
        for name, fn in FIGS.items():
            s = fn()
            assert s.count("<svg") == 1 and "<title>" in s, name
            (OUT / f"{name}-{theme}.svg").write_text(s)
            print("wrote", f"{name}-{theme}.svg")
