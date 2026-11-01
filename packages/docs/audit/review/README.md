# Bioconductor web presence — review

**Audit date:** 2026-07-25 / 2026-07-26
**Site state at audit:** Bioconductor 3.23 release / 3.24 devel, 2,418 software packages
**Source audited:** `Bioconductor/bioconductor.org` @ `e2ae0a9` (2026-07-23), plus live probing of bioconductor.org and ten sibling properties

Six independent audits, one per axis. Each is standalone and evidence-tagged: claims are marked
verified (observed directly, with the URL/command/`file:line` that produced them) or inferred.
Where something could not be established, it says so rather than guessing.

| Document | Axis | Size |
|---|---|---|
| [architecture.md](architecture.md) | Component inventory, build pipeline, toolchain currency, operational risk | 42 KB |
| [design-system.md](design-system.md) | CSS architecture, visual language, cross-property consistency, responsive | 45 KB |
| [ux-ia.md](ux-ia.md) | Information architecture, seven task-based journey walkthroughs, content design | 49 KB |
| [findability.md](findability.md) | On-site search benchmark, package discovery, SEO, metadata hygiene | 50 KB |
| [perf-a11y.md](perf-a11y.md) | Measured performance, WCAG 2.2 AA, standards & security headers | 41 KB |
| [link-health.md](link-health.md) | Link rot, redirect behaviour, content staleness | 48 KB |

Supporting data: `screenshots/` (26 renders across 390–1440 px, plus dark-mode and print),
`data/` (raw crawl TSVs — page inventory, link edges, external-link status).

---

## The finding that reframes the rest

The site is **not** uniformly dated, and treating it as "needs a redesign" would be the wrong call.

There is a genuinely good 2023–24 redesign in production: flexbox layout, a design-token file,
Atkinson Hyperlegible (a typeface designed for legibility), clean axe-core results, negligible CLS,
and correct reflow down to 320 px. On the redesigned pages, axe-core finds only 2–3 moderate
violations — that is a better result than most commercial sites.

That redesign was applied to roughly twelve hand-written pages and stopped. It never reached the
~7,600 generated package landing pages, the build reports, or any of the ten sibling properties.
Underneath it, a 2011 JavaScript stack and a 2003-era build-report generator are still shipping.

So the diagnosis is **an unfinished migration, not a bad design**. The work is to finish the design
system that already exists and push it into the generators — not to start over. Most of the highest-
impact items below are configuration one-liners and template fixes, not design work.

---

## Top findings by severity

### P0 — the project is invisible to search engines for its core content

`robots.txt` contains `Disallow: /packages/release/`, `Disallow: /packages/devel/`,
`Disallow: /biocViews/`, and a `Disallow:` line for every numbered release from 1.8 through 3.24.
This blocks crawling of every package landing page, the entire biocViews browse tree, and every
rendered vignette.

Compounding it, `sitemap.xml` serves 20 bytes — the literal, unevaluated string `<%= xml_sitemap %>`.
The cause is `Rules:12-14`, where the `/sitemap/` compile rule has an empty body and never applies
`filter :erb`. The site publishes zero URLs in its sitemap.

The measurable consequence: a live search for "DESeq2 bioconductor package" returns stale third-party
mirrors — `bioconductor.uib.no` (release 3.22), `s3.jcloud.sjtu.edu.cn` (3.15), `ftp.gwdg.de` (3.17) —
because those mirrors are crawlable and the origin is not. Users are being sent to package
documentation up to eight releases out of date.

No page emits `rel=canonical`, and the same package page resolves at five or more URLs. Slash-doubled
variants (`/packages//release/...`) return HTTP 200 with byte-identical content *and* evade the
robots block, which is how a handful of pages leaked into search indexes while their correctly-spelled
equivalents stayed hidden.

### P0 — the primary discovery surface is inverted

The top-nav "Packages" link lands on `BiocViews.html#___Software`, a 2,418-row table captioned
*"Rank based on number of downloads: lower numbers are more frequently downloaded"* and sorted
ascending. Observed values: `BiocAzul` = 1, `RFGeneRank` = 2, `BatChef` = 3, against `edgeR` = 2393,
`DESeq2` = 2397, `limma` = 2401.

The first screen a new user sees after clicking the single most important navigation item is the
project's least-used packages. Either the caption or the sort direction is inverted.

### P0 — the course-materials archive returns 403 across 2,566 URLs

`/help/course-materials/` and its entire subtree return HTTP 403 (Apache, 11,922-byte body), not 404 —
index pages, year pages, session pages, and every PDF, PPT and R file underneath. Twenty-four years of
course and conference material is unreachable.

This was verified twice. All 2,567 URLs were re-checked at 3 concurrent requests with a 0.4 s delay,
and 2,567 of 2,567 still returned 403 — so it is not rate limiting. The content is present in the repo
at `content/help/course-materials/`, making this a build or deploy failure rather than missing content.

It is linked from the homepage Learn grid ("Courses"), `/about/`, `/help/`, `/help/support/`,
`/help/events/` and `/developers/developers-forum/`. The 403 page tells users to "contact the
webmaster" and provides no link and no recovery path.

### P1 — every trailing-slash redirect downgrades HTTPS to HTTP

`https://bioconductor.org/about` returns a 302 to `http://bioconductor.org/about/` — plaintext.
Confirmed on `/about`, `/developers`, `/help/faq`, `/install` and `/help/course-materials`. There is
no HSTS header on any host, so nothing prevents the downgrade from being observed or tampered with.

Any user who types or pastes a URL without a trailing slash — which is how URLs appear in papers,
slides and emails — is bounced through cleartext before landing. Fixing this is an Apache/CloudFront
redirect rule plus an HSTS header; no code change.

### P1 — nothing on the site is visually identifiable as a link

`assets/style/base/typography.css:59-61` sets `a { color: black }` globally. On the DESeq2 landing
page, 270 of 282 links compute to `rgb(0,0,0)` — identical to body text. Four different link
treatments coexist on that one page. `assets/style/sections/footer.css:16-19`
(`footer * { color:#fff; text-decoration:none }`) removes even the underline from every footer link.

This is likely the largest single contributor to the site "feeling confusing", and it is a one-line fix.

### P1 — mobile silently removes functionality

`assets/style/sections/header.css:181` sets the open mobile drawer to a hardcoded `height: 21rem`
with `overflow: hidden` (`:174`). At 390 px the six nav links fill it exactly: the last link ends at
y=463 and the drawer clips at y=472, so the search box (y=479–504) and the "Get Started" button
(y=520–568) render entirely below the clip. Both are in the DOM and unreachable. Mobile users have
no site search and no route to installation instructions.

Separately, `assets/style/base/layout.css:32` (`.content { overflow: hidden }`) clips 133 px off the
DESeq2 "Details" and "Package Archives" tables at 390 px — no scrollbar, no way to reach the content.

And `assets/style/pages/learn-and-dev.css:171-173` (`.page-container * { font-size: 1rem }`) flattens
the type scale on small screens: on `/help/`, `h2` drops 32 px → 16 px and `p` 20 px → 16 px, making
headings and body text typographically identical.

---

## Secondary findings

| Axis | Finding |
|---|---|
| Performance | Compression is enabled only for `text/html` and `text/css`. JS, SVG and fonts ship raw — the biocViews page transfers 1,396 KB of compressible assets that gzip to 434 KB, wasting 961 KB on one page load. Homepage wastes 208 KB, `/install/` 378 KB |
| Performance | Origin is HTTP/1.1 only despite sitting behind CloudFront (which supports h2/h3). With 24 unbundled render-blocking stylesheets, measured Slow-4G FCP is 11.1 s on the homepage; biocViews takes 38.3 s to load |
| Accessibility | `assets/js/bioc_views.js` applies `tabindex="0"` to every `<td>`, creating 12,169 tab stops on one page, plus redundant ARIA producing 2,418 critical `aria-required-parent` violations. Native table semantics were already correct |
| Accessibility | Generated legacy pages fail basics the redesigned pages pass: the build report has no `lang`, no viewport meta, 7,147 contrast violations, 62 tables with no `<th>`, and 2,423 inline event handlers. `support.bioconductor.org` renders in quirks mode (no doctype), with no `lang` and no `<h1>` |
| JavaScript | Three uncaught errors fire on every page, traced to `assets/js/bioconductor.js` running biocViews-specific code unconditionally site-wide. `layouts/components/sitescripts.html:20` contains a malformed regex literal — a hard `SyntaxError` that silently kills the mirror `<base href>` logic on every package landing page |
| Search | The header search (Apache Solr) placed the right answer in the top 5 for 2 of 10 realistic queries; both hits were exact package names. "convert gene symbols to Entrez" returns a package page from circa 2006; "which R version do I need" returns `dyebiasexamples`. The same 10 queries against the support forum scored 9/10 |
| Toolchain | `Dockerfile:1` pins Ruby 2.6.5, EOL 2022-03-31, on a Debian Buster base so dead the Dockerfile rewrites `sources.list` to `archive.debian.org` to build at all. Frontend ships jQuery 1.6.4 (2011), jQuery Tools 1.2.6 (abandoned), and `jquery.corner.js` v2.03 (2009) invoked on selectors present nowhere in the repo. Seven Dependabot PRs are open, the oldest from 2020-07-28 |
| Toolchain | `Gemfile:2` declares `source 'http://rubygems.org'` in plaintext. `Gemfile.lock` says `BUNDLED WITH 1.17.2` while `Dockerfile:24` installs bundler 2.4.22 |
| Link health | **475 of 1,732 unique external URLs are confirmed dead** (348 hard 404/410, 115 dead host / TLS / timeout, 12 persistent 5xx) — a 27.4% external break rate, two-pass verified. 415 sit on archival pages, but 60 are on live maintained pages, including three dead institutional bio pages for sitting advisory-board members. Two dead mirrors (`free.nchc.org.tw` NXDOMAIN, `bioconductor.unipi.it` TLS failure) are still listed as usable on `/about/mirrors/` |
| Staleness | The homepage Events carousel advertises three events that already happened, including EuroBioC2025 from ten months ago. This is a bug, not stale data: `lib/helpers.rb:452 top_events()` returns `sorted[-5..-1]` with no date filter, while its sibling `upcoming_events()` at `:426` filters correctly. `/help/events/` renders fine — only the homepage is wrong |
| Staleness | `/about/` shows a "Quick Stats" panel last updated 2023-12-18, citing 2023 download figures and "550 active **Slack** Members" — a platform the project has since left for Zulip, which the footer on the same page links. Hardcoded in `layouts/components/quickstats.html` |
| Consistency | Eleven-plus properties running ten different stacks with no shared header, search, auth, or release notion. Four of seven siblings have zero links back to bioconductor.org. Two still serve the bookdown scaffold description verbatim: *"This is a minimal example of using the bookdown package to write a book…"* |
| IA | Two of six top-nav slots (Funding, Donate) point at the same page, differing only by fragment. Fundraising occupies a third of the primary navigation; support occupies none. The footer uses a different four-column taxonomy that neither contains nor is contained by the header's |
| Security | None of `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` or `Permissions-Policy` is set on any host. Third-party scripts load without SRI |

---

## Recommended sequence

**Configuration one-liners, disproportionate payoff — do first:**

1. Remove the `Disallow:` lines for current release and devel from `robots.txt`
2. Add `filter :erb` to the `/sitemap/` rule at `Rules:12-14`
3. Enable gzip/brotli for JS, SVG and font MIME types in the Apache config
4. Enable HTTP/2 on the CloudFront distribution (a console setting, not a code change)
5. Make trailing-slash redirects preserve HTTPS, and add an HSTS header

**Template and CSS fixes, hours not days:**

6. Fix the `/help/course-materials/` 403 — the content is already in the repo, and this is 2,566 URLs
7. Correct the biocViews sort direction, or the caption that contradicts it
8. Give `a` a non-black colour in `typography.css:59`; stop `footer.css:16-19` stripping link affordance
9. Remove the `height: 21rem` clip at `header.css:181` so mobile search and Get Started are reachable
10. Add a date filter to `top_events()` at `lib/helpers.rb:452`, matching `upcoming_events()` at `:426`
11. Add `rel=canonical` to the package landing page template
12. Fix the `SyntaxError` at `sitescripts.html:20`; scope `bioconductor.js` biocViews code to biocViews pages
13. Remove the hand-written `tabindex`/ARIA from `bioc_views.js`
14. Regenerate or retire the hardcoded Quick Stats panel in `layouts/components/quickstats.html`
15. Drop the two dead mirrors from `/about/mirrors/`, and fix the 60 dead external links on live pages

**Structural, worth planning:**

16. Push the design system into the page generators so the ~7,600 generated pages inherit it
17. Prune unused gems, convert the single remaining `.sass` file, then move to Ruby 3.2 + nanoc 4.14
18. Replace the 2009-era jQuery plugins with platform equivalents (`border-radius`,
    `Intl.RelativeTimeFormat`), which removes the jQuery 1.6.4 dependency from those paths
19. Add automated link checking to CI — the 27.4% external rot rate will not fix itself
16. Give the sibling properties a shared header, or at minimum a link home

---

## Open questions for the core team

- **`captcha/` (1.9 MB) — is any of it deployed to a web root?** It is a vendored copy of Securimage:
  PHP and Python in a Ruby static-site repo, including a Flash `.swf` and `send_mail.php` /
  `start_instance.php`. Nothing in the build references it. If it is reachable, it is live remote
  attack surface; if it is not, it is 1.9 MB of confusing dead code. This was not resolvable from
  outside and is worth an urgent answer.
- **Which sibling properties are actually load-bearing?** Traffic data would settle which of the ten
  are worth investing in and which are effectively abandoned. The site runs GA4 (`G-WJMEEH1J58`, wired
  in `layouts/components/sitescripts.html`) but no analytics access was available for this audit, so
  every prioritisation here is based on structural severity rather than measured usage. Landing-page
  and site-search-term data would meaningfully re-rank this list — in particular, if most sessions
  arrive deep on package pages from search rather than through the homepage, the P0 SEO items become
  even more dominant and the navigation findings less so.
- **What is the patch status of `git.bioconductor.org`?** It reports Apache 2.4.18 (Ubuntu 16.04 vintage) and is the only Bioconductor host that cannot negotiate TLS 1.3 — two independent signals of a genuinely old userland. It is also the supply-chain root for every package in the project. *This is not a vulnerability report:* Ubuntu backports security fixes without changing the version string, so a fully-patched box reports 2.4.18 indefinitely, and nothing here was determinable from outside. It is a request that someone with shell access confirm patch level and ESM status, and review the SSH-side configuration that actually governs Git access. Separately, `chat.bioconductor.org` shares that machine solely to issue a redirect to Zulip — a vhost that could be retired for free.
- **Who owns `code.bioconductor.org` long-term?** It runs on EMBL Heidelberg hardware (`EMBL-NET`, DE) while the rest of the estate is AWS us-east-1 or GitHub Pages. It works fine; the question is continuity, since the arrangement isn't documented in the repo and the source repo has been untouched since 2025-08-12.
- **Was the 2023–24 redesign intended to reach the generated pages?** If yes, that stalled work is the
  single highest-leverage thing to resume. If no, the split experience is permanent and should at
  least be made deliberate.
