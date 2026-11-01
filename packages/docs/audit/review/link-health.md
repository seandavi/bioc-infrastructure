# Bioconductor website — link health and content staleness audit

**Date of crawl:** 2026-07-25 / 2026-07-26 (UTC)
**Target:** `https://bioconductor.org` (production, behind CloudFront + Apache/2.4.52)
**Source tree audited:** shallow clone of the site repo (`content/`, `layouts/`, `config.yaml`, `lib/`), HEAD = `e2ae0a9` (2026-07-23)
**Raw data:** `review/data/` — every claim below is reproducible from those files.
**Release context:** Bioconductor 3.23 (release), 3.24 (devel), R 4.6.0.

Every finding is labelled **Verified** (I observed it directly, in the saved crawl data or a
cited live request) or **Inferred** (reasoned from the source tree, not directly observed).
Broken-link findings were confirmed by a **two-pass check**: an initial HEAD/GET pass with a
bot user-agent, then a second pass with a browser user-agent following redirects. Only links
that failed *both* passes are reported as broken; 14 first-pass failures were false positives
(bot blocking) and have been dropped.

---

## 1. Executive summary — the five things that matter

1. **The entire `/help/course-materials/` tree — 24 years of course and conference material —
   returns HTTP 403 Forbidden.** Not one page, the whole subtree: index pages, year pages,
   session pages, and every PDF/PPT/R file underneath. 2,566 distinct URLs in the crawl set
   are affected. It is linked from the homepage, `/about/`, `/help/`, `/help/support/`,
   `/help/events/` and `/developers/developers-forum/`. This is by far the largest single
   defect on the site. *Verified twice* — flagged in the main pass at 12 concurrent requests,
   then **all 2,567 re-checked at 3 concurrent requests with a 0.4 s delay: 2,567 of 2,567
   still returned 403**, so it is not rate limiting. (In the same re-check the 38 URLs that had
   returned 429 in the fast pass came back 200 — those were rate-limit artifacts and are *not*
   counted as broken anywhere in this report.) (`data/internal-link-check.tsv`,
   `data/internal-recheck.tsv`)

2. **Every trailing-slash redirect on the site downgrades HTTPS → HTTP, and there is no HSTS
   header.** `https://bioconductor.org/about` → `302` → `http://bioconductor.org/about/`.
   Confirmed on `/about`, `/developers`, `/help/faq`, `/install`, `/help/course-materials`.
   Any user who types or pastes a URL without a trailing slash is bounced through plaintext.
   *Verified* (§4.3).

3. **The homepage "Events" carousel advertises three events that have already happened**,
   including EuroBioC2025 from September 2025 — ten months ago. Root cause is a real bug, not
   stale data: `lib/helpers.rb:452 top_events()` returns `sorted[-5..-1]` with **no date
   filter**, unlike its sibling `upcoming_events()` at `lib/helpers.rb:426` which does filter.
   `/help/events/` renders correctly (2 genuine upcoming events); only the homepage is wrong.
   *Verified* against the live homepage.

4. **`/about/` shows a "Quick Stats" panel last updated 2023-12-18** — 2½ years stale — citing
   "3691 total Release Packages", "45546715 Software Downloads in **2023**" and, most tellingly,
   "550 active **Slack** Members", a platform the project left for Zulip (the footer on the same
   page links Zulip). Hardcoded in `layouts/components/quickstats.html`. *Verified* live.

5. **475 external links are confirmed dead** (348 hard 404/410, 115 dead host / TLS / timeout,
   12 persistent 5xx) out of 1,732 unique external URLs — a **27.4 % external break rate**.
   415 of those sit only on archival pages; **60 are on live, currently-maintained pages**,
   including three dead institutional bio pages for sitting advisory-board members and the
   posting guide's link to ESR's "How To Ask Questions The Smart Way". Two dead mirrors
   (`free.nchc.org.tw`, NXDOMAIN; `bioconductor.unipi.it`, TLS failure) are still listed as
   usable on `/about/mirrors/`. *Verified* (§3, §5).

---

## 2. Method and coverage

| Activity | Tool | Scope | Requests |
|---|---|---|---|
| Link extraction from source | `scratchpad/work/extract.py` | all `.html`/`.md`/`.yaml`/`.xml` under `content/` | — |
| Link extraction from templates | inline script | `config.yaml` + `layouts/**` | — |
| Live spider (hand-authored space) | `scratchpad/work/spider.py` | BFS from `/`, excluding `/packages/`, `/checkResults/`, `/books/`, `/help/bioc-views/`, `/shields/` | 122 pages |
| Live spider (first run, incl. `/books/`) | same | BFS from `/`, `/books/` included | 703 pages |
| Internal link check | `scratchpad/work/check.py` | 3,346 unique internal URLs | 3,346 |
| Internal re-check (403/429 subset, low rate) | same | 2,608 URLs @ 3 concurrent | 2,608 |
| External link check | same | 1,732 unique external URLs, 407 hosts | ~3,000 (HEAD+GET) |
| External verification pass | `scratchpad/work/verify.sh` | all 508 non-OK results, browser UA, follow redirects | 508 |
| Generated-space sample | `check.py` | 100 random release package landing pages + 15 vignettes + 15 build-report URLs + 60 package URLs cited in `content/` | 190 |

Politeness: identifying User-Agent (`BioconductorLinkCheck/1.0 … contact seandavi@gmail.com`),
per-host concurrency cap (2–6), inter-request delay, 12–25 s timeouts, HEAD-before-GET.

**Counts extracted:** 14,212 link instances in `content/`; 6,842 unique internal URLs;
1,732 unique external URLs across 407 hosts; 99 additional external URLs in `config.yaml`
and `layouts/`; 20,513 live link edges from the spider.

### Break rates

| Set | Checked | Confirmed broken | Rate |
|---|---:|---:|---:|
| **Internal** (non-`/packages/` URLs referenced by `content/` + live crawl) | 3,346 | 2,621 (2,567× 403, 24× 404, 30× DNS) | **78.3 %** |
| Internal, excluding the `/help/course-materials/` 403 block | 780 | 55 | **7.1 %** |
| **External** (unique URLs) | 1,732 | 475 | **27.4 %** |
| External, on live (non-archival) pages | — | 60 | — |
| **Generated space** (package landing pages, vignettes, build reports) | 190 | 2 | **1.1 %** |

The generated space is *healthy*. All the damage is in the hand-authored tree and its
external references.

### Coverage limits, stated honestly

- The live spider reached **122 pages** of the hand-authored space. It cannot reach more,
  because `/help/course-materials/` — the gateway to ~250 further archived pages — returns
  403, so those pages are unreachable by navigation and by search-engine crawlers alike.
  Their links were still audited, from the local `content/` tree.
- The repo clone is **shallow (1 commit)**, so per-file "last modified" dates from git are
  unavailable. Staleness below is argued from page content, not commit dates.
- 19 external URLs return 403 to automated clients in both passes (Cloudflare/WAF-style
  blocking, e.g. `astrazeneca.com`, `mirrors.westlake.edu.cn`). These are listed in
  `data/external-classified.tsv` as `BLOCKED_403` and are **not** counted as broken.

---

## 3. Hard-broken links — the actionable list

### 3.1 Internal: the `/help/course-materials/` 403 block (2,566 URLs)

**Verified.** Every URL under `/help/course-materials/` returns 403 with the site's own styled
403 page. Sample confirmations with a browser user-agent, one request at a time:

| URL | Status |
|---|---|
| `https://bioconductor.org/help/course-materials/` | 403 |
| `https://bioconductor.org/help/course-materials/2018/` | 403 |
| `https://bioconductor.org/help/course-materials/2017` | 403 |
| `https://bioconductor.org/help/course-materials/2018/index.html` | 403 |
| `https://bioconductor.org/help/course-materials/2015/BioC2015/` | 403 |
| `https://bioconductor.org/help/course-materials/2002/Heidelberg02/annotation.pdf` | 403 |
| `https://bioconductor.org/help/course-materials/2019/BSS2019/04_Practical_CoreApproachesInBioconductor.html` | 403 |

Note that the year pages (`2017.md`, `2018.md`, …) are ordinary generated pages that exist in
`content/help/course-materials/`, not directory listings — they 403 too. So this is not a
missing-`index.html` problem; something denies the whole path prefix.

**Live pages that link into it** (from `data/spider2-edges.tsv`):

| Referring page | Repo file |
|---|---|
| `https://bioconductor.org/` (homepage, "Courses" in the Learn block) | `layouts/components/homepage/learn.html:45` |
| `https://bioconductor.org/help/` | `content/help/index.html:82` |
| `https://bioconductor.org/help/support/` | `content/help/support.html:295` |
| `https://bioconductor.org/help/events/` (plus 4 deep links to BioC2015/2016/2017, BiocAsia2015) | `content/help/events.html:41` and the event YAMLs |
| `https://bioconductor.org/about/` | via `content/about/index.md` |
| `https://bioconductor.org/developers/developers-forum/` | `content/developers/developers-forum.md` |
| `https://bioconductor.org/help/bioconductor-cloud-ami/` (deep link to a `.pptx`) | `content/help/bioconductor-cloud-ami.md` |

There is also a dead partial, `layouts/_course_materials.html`, which links to it twice but is
referenced by nothing (§6.4).

### 3.2 Internal: dead Bioconductor subdomains (30 URLs)

**Verified NXDOMAIN** for `secure.bioconductor.org` and `register.bioconductor.org` — the old
conference-registration hosts. 28 links point at them, and **11 of those are rendered on the
live `/help/events/` page** (each past event's registration link).

| Dead host | URLs | Example referrer |
|---|---:|---|
| `secure.bioconductor.org` | 25 | `content/help/events/BioC2010.yaml`, `BioC2011.yaml`, `BioC2013.yaml`, `SeattleDec10.yaml`, `SeattleMay12.yaml`, `Seattle-Oct-2012.yaml`, `SeattleFeb2012.yaml`, `SeattleFeb2014.yaml`, `SeattleMay2013.yaml`, `SeattleOct2013.yaml`, `SeattleOct2011.yaml`, … — all surfaced on `/help/events/` |
| `register.bioconductor.org` | 3 | `content/help/events/BioC2014.yaml`, `Seattle-Apr-2015.yaml`, `SeattleOct2014.yaml` — all surfaced on `/help/events/` |
| `bioconductor.org/bioc2013` (host resolves, path DNS-level failure in first pass; 404 confirmed) | 1 | `content/help/course-materials/2013/BioC2013/developer-day.md` |

Full list: `grep DNS_FAIL review/data/internal-link-check.tsv`.

### 3.3 Internal: hard 404s (24 URLs)

**All verified.** The ones on live, non-archival pages are marked ★.

| URL | Status | Referring page / repo file | Root cause |
|---|---|---|---|
| ★ `https://bioconductor.org/docs.docker.com/engine/docker-overview/` | 404 | live `/help/docker/` — `content/help/docker.md:3` | `https:/docs.docker.com/...` — **one slash instead of two**, so it resolves as a site-relative path |
| ★ `https://bioconductor.org/about/mirrors/mirrors.tuna.tsinghua.edu.cn` | 404 | live `/about/mirrors/` — `config.yaml:322` | `institution_url: mirrors.tuna.tsinghua.edu.cn` — **missing `https://` scheme** |
| ★ `https://bioconductor.org/help/faq/4` | 404 | live `/help/faq/` — `content/help/faq.md:154` | `[installed](4)` — a section number used as a link target |
| ★ `https://bioconductor.org/developers/how-to/long-tests` → `https://contributions.bioconductor.org/long-tests.html` | 404 after 3 hops | `content/developers/how-to/unitTesting-guidelines.md:363` | server-side redirect lands on a page that does not exist in the Contributions book (see §3.5) |
| `https://bioconductor.org/help/workflows/annotation/Annotation_Resources/` | 404 | `content/help/course-materials/2013/BioC2013.md`, `2014/BioC2014.md` | workflows relocated |
| `https://bioconductor.org/help/workflows/annotation/Annotating_Genomic_Ranges/` | 404 | `content/help/course-materials/2013/BioC2013.md` | workflows relocated |
| `http://www.bioconductor.org/help/workflows/proteomics/` | 404 | `content/help/newsletters/2015_April.md` | workflows relocated |
| `https://bioconductor.org/help/newsletters/2014_April/vobencha@fhcrc.org` (and 6 siblings for `2014_July`, `2014_October`, `2015_January`, `2015_April`, `2015_July`, `2016_January`) | 404 ×7 | `content/help/newsletters/*.md` | bare email addresses written as markdown link targets without `mailto:` |
| `https://bioconductor.org/.BRFSS-subset.csv` | 404 | `content/help/course-materials/2014/summerx.md` | stray leading dot |
| `https://bioconductor.org/bioc2014` | 404 | `content/help/course-materials/2014/BioC2014/developer-day.md` | retired path |
| `https://bioconductor.org/news/bioc_3_4_release/Methyl\|Ratio` | 404 | `content/news/bioc_3_4_release.md` | a pipe character in prose parsed as a link |
| `http://bioconductor.org/spb_reports/regutools_buildreport_20200302121040.html` | 404 | `content/news/bioc_3_11_release.md` | expired build report |
| `http://bioconductor.org/bin/macosx/2.1/{affy_1.6.7,Biobase_1.5.12,xtable_1.2-5}.tgz` | 404 ×3 | `content/help/course-materials/2005/BioC2005/labs/lab01.html` | Bioc 2.1 binaries removed |
| `http://bioconductor.org/data/experimental.html`, `/data/metaData.html`, `/repository/devel/vignette/factDesign.pdf` | 404 ×3 | `content/help/course-materials/2005/BioC2005/labs/lab01/estrogen.html` | pre-2010 paths |

### 3.4 Internal: `/news/` returns 403

**Verified.** `https://bioconductor.org/news/` → 403. There is no `content/news/index.*`, so
nothing generates an index for the 36 release-announcement pages that live under it. The
individual pages are fine (`/news/bioc_3_23_release/` → 200).

The homepage's "See all News" button that pointed there is **commented out** in
`layouts/components/homepage/info.html:183-184` — someone worked around the 403 by hiding the
link rather than creating the index. Net effect: **there is no way to browse Bioconductor
release news from the site.** (Verified: a fresh fetch of the homepage with HTML comments
stripped contains zero `href="/news/"`.)

### 3.5 The generated space is fine — with two exceptions

190 sampled package/vignette/build-report URLs: 188× 200. The two failures are stale
references from `content/`, not defects in the generated tree:

| URL | Status |
|---|---|
| `http://bioconductor.org/packages/release/bioc/html/cisPath.html` | 404 (package removed) |
| `https://bioconductor.org/packages/bioc/1.5/src/contrib/html/` | 404 (Bioc 1.5 repo path) |

### 3.6 External links confirmed broken on live (non-archival) pages — 60

The complete list is `review/data/broken-external-actionable.tsv` (60 rows, with referring
file and both check results). The highest-value subset:

| URL | Result | Repo file |
|---|---|---|
| `https://www.deduveinstitute.be/fr/research/computational-biology/laurent-gatto` | 404 | `content/about/technical-advisory-board.md` |
| `http://www.eurac.edu/en/research/health/biomed/staff/Pages/staffdetails.aspx?persId=34084` | 404 | `content/about/community-advisory-board.md` |
| `https://www.thekids.org.au/contact-us/our-people/p/stephen-stevie-pederson/` | 404 | `content/about/community-advisory-board.md` |
| `http://www.catb.org/%7Eesr/faqs/smart-questions.html` | timeout, both passes | `content/help/support/posting-guide.md` |
| `https://vincebuffalo.com/blog/2012/03/12/using-bioconductor-to-analyze-your-23andme-data.html` | 404 | `content/help/community.md` |
| `https://azure.microsoft.com/en-us/services/container-instances/` | 404 | `content/help/docker.md` |
| `https://github.com/richierocks/runittotestthat]` | 404 | `content/developers/how-to/unitTesting-guidelines.md` — **stray `]` inside the URL**, a markdown typo |
| `http://journal.r-project.org/archive/2011-1/RJournal_2011-1_Wickham.pdf` | 404 | `content/developers/how-to/unitTesting-guidelines.md` |
| `https://bioconductor.github.io/EuroBioc2016`, `…/EuroBioc2017/`, `…/EuroBioc2018`, `…/BiocAsia/` | 404 ×4 | `content/help/events/BioCEurope201{6,7}.yaml`, `EuroBioc2018.yaml`, `BioCAsia201{8,9}.yaml` — **Bioconductor's own GitHub Pages sites**, surfaced on live `/help/events/` |
| `https://www.iscb.org/ismbeccb2023-programme/tutorials` | 404 | `content/help/events/ISMB2023.yaml` |
| `https://microbiome.github.io/course_2023_oulu/` | 404 | `content/help/events/course_2023_oulu.yaml` |
| `https://abacbs.org/conference-workshops` | 404 | `content/help/events/BiocAsia2017.yaml` |
| `https://cabig.nci.nih.gov/`, `http://cagrid-portal.nci.nih.gov`, `https://gforge.nci.nih.gov/…` (×2) | NXDOMAIN ×4 | `content/help/cabig.md` (see §5.4) |
| `http://s3.amazonaws.com/bioconductor-mapreduce-example/{mapper,reducer}-emr.R`, `http://bioconductor-emr-bootstrap-scripts.s3.amazonaws.com/bootstrap.sh`, `…-inputdir.s3.amazonaws.com/file{1,2}` | 404 ×5 | `content/help/elasticmapreduce.md` (see §5.4) |
| 33 dead conference/workshop homepages | 404 / NXDOMAIN / 5xx | `content/help/events/*.yaml`, all rendered in the "Previous (recent)" list on `/help/events/` |

Two entries in that file are **expected, not defects**: `http://localhost:8787` and
`http://127.0.0.1:8787` in `content/help/docker.md` are deliberate local URLs in the RStudio
instructions.

By area, the 60 break down as: `help/events` 33, `help/*` 13, `developers/how-to` 4,
`about/*` 3, `help/course-materials/*` 4 (linked from live year pages), `help/support` 1,
`help/publications` 1, `help/community` 1.

### 3.7 External links broken only on archival pages — 415

Also verified broken, but reachable only from the 2002–2018 course archive, the news archive
and the newsletters. Full list: `review/data/external-classified.tsv`, filter
`context == archival` and `verify_result` starting `CONFIRMED_`. Notable dead hosts:

| Host | URLs | What it was |
|---|---:|---|
| `marray.economia.unimi.it` | 9 | CSAMA/Brixen course site (Milan) |
| `bioinformatics.fmrp.usp.br` | 4 | Brazilian course sites |
| `wiki.fhcrc.org` | 3 | Fred Hutch wiki |
| `gforge.nci.nih.gov` | 2 | NCI GForge (retired) |
| `permalink.gmane.org` / `comments.gmane.org` | 4 | Gmane mailing-list archive (defunct 2016) |
| `genomics.jhu.edu`, `hopkinsworkshop.org` | 3 | JHU workshop sites |
| `gentleman.fhcrc.org`, `watson.nci.nih.gov`, `rana.lbl.gov`, `biosun1.harvard.edu`, `daisy.prevmed.northwestern.edu`, `wiki.biostat.berkeley.edu`, `www-lmc.imag.fr`, `www.bio.ri.ccf.org`, `biostat.mc.vanderbilt.edu` | 1 each | personal/lab pages of former contributors |
| `weka.wikispaces.com` | 1 | Wikispaces (shut down 2018) |
| `bioc2017.updog.co`, `user2014.stat.ucla.edu`, `stat2016.china-r.org`, `tengfei.github.com` | 1 each | one-off conference sites |

These are lower priority — but they are the reason the archive should be either restored *and*
maintained, or explicitly framed as a frozen historical archive.

---

## 4. Redirects, protocol and host hygiene

### 4.1 HTTPS → HTTP downgrade on every directory redirect — **Verified**

```
https://bioconductor.org/about       302 -> http://bioconductor.org/about/
https://bioconductor.org/developers  302 -> http://bioconductor.org/developers/
https://bioconductor.org/help/faq    302 -> http://bioconductor.org/help/faq/
https://bioconductor.org/install     302 -> http://bioconductor.org/install/
https://bioconductor.org/help/course-materials 302 -> http://bioconductor.org/help/course-materials/
```

`Strict-Transport-Security` is **absent** from the response headers on `https://bioconductor.org/`.
This is Apache `DirectorySlash` building the redirect from the origin's own (HTTP) scheme
behind the CloudFront TLS termination. Every no-trailing-slash link — the majority of links
people paste and type — takes a plaintext hop.

### 4.2 Internal hostname leaked in public redirects and in browser JavaScript — **Verified**

- `https://bioconductor.org/developers/how-to/git-mirrors/` → 2 hops →
  `http://master.bioconductor.org/about/mirrors/mirror-how-to/`. The build/deploy host is
  exposed to end users, over plain HTTP, and it answers (`http://master.bioconductor.org/` → 200).
- `assets/js/search.js:18` issues the site-search query to
  `//master.bioconductor.org/solr/default/select?…` — so every visitor who uses the search box
  talks directly to `master`. (The search itself works: a live query for `limma` returned
  `numFound: 5785`.)
- `scripts/get_json.rb:88` and `Rakefile:405` fetch from `http://master.bioconductor.org/` at
  build time over plaintext.

### 4.3 Redirect chains and protocol upgrades in the link corpus

| Pattern | Count | Note |
|---|---:|---|
| `http://` external links that 301 to `https://` | 170 | should be written as `https://` in source |
| `http://` external links that stay HTTP (no upgrade offered) | 51 | includes `http://cdn.mathjax.org/mathjax/latest/MathJax.js` in `content/developers/how-to/workflows.md` — the MathJax CDN was retired in 2017 and an `http://` `<script src>` is blocked as mixed content on an HTTPS page |
| Chains longer than 2 hops | 6 | worst: `http://sites.google.com/site/bcbostoned/` → 4 hops ending at a Google sign-in wall; `http://aws.amazon.com/developertools/2264` → 4 hops ending at `builder.aws.com` |

Full detail in `review/data/external-classified.tsv` columns `n_redirects` / `redirect_chain`.

### 4.4 Mirrors — **Verified**, all 47 mirror URLs in `config.yaml` checked

`review/data/mirror-check.tsv`.

| Mirror | Problem |
|---|---|
| **NCHC, Taiwan** — `free.nchc.org.tw/bioconductor/` | **NXDOMAIN** (both `http` and `https`). Its `institution_url: https://www.nchc.org.tw/` is also NXDOMAIN. The site's own dashboard already reports Release=no, Devel=no for it. Still listed on `/about/mirrors/` as a usable mirror. |
| **Università di Pisa** — `https://bioconductor.unipi.it` | **TLS handshake failure.** The plain-HTTP URL works, so the advertised `https_mirror_url` is broken. Dashboard: Release=no, Devel=no. |
| **RIKEN, Japan** | Mirror itself is healthy (`bioconductor.riken.jp` → 200), but `institution_url: https://accc.riken.jp/en/` is **NXDOMAIN**. |
| **Tsinghua TUNA, China** | `institution_url` at `config.yaml:322` is written as `mirrors.tuna.tsinghua.edu.cn` with **no scheme** → renders as a site-relative link → 404 (§3.3). |
| **AARNet, Australia** | `https://mirror.aarnet.edu.au/pub/bioconductor` **301s down to `http://`**. Dashboard: Release=no, Devel=no. |
| **University of Bergen** — `bioconductor.uib.no` | Reachable, but dashboard reports Release=no, Devel=no. |
| **Westlake University** | Returns 403 to non-Chinese clients ("您的访问请求可能对网站造成安全威胁"). Probably fine in-region; noting it, not counting it broken. |
| **Academic Computer Club, Sweden** — `mirror.accum.se` | **Not broken.** It is IPv6-only; my first-pass checker timed out, `curl` over IPv6 returned 200. Worth documenting, since IPv4-only clients cannot reach it. |

So 5 of 17 listed mirrors are not serving current release/devel content, and the mirrors page
presents all 17 identically with no health indication — even though the project already
computes exactly that health data on `/dashboard/`.

---

## 5. Content staleness

### 5.1 Highest-value fixes

| # | Issue | Evidence | Exact file to fix |
|---|---|---|---|
| S1 | Homepage Events carousel shows 3 past events (EuroBioC2025 Sep 2025, Seminar Dec 2025, EuroBioC2026 Jun 2026). *Verified* live. | `top_events()` takes the 5 latest-starting events with no date filter; `upcoming_events()` at line 426 does filter | **`lib/helpers.rb:452-459`** |
| S2 | "Quick Stats" panel on `/about/`: "Last updated 2023-12-18", "45546715 Software Downloads in 2023", "550 active **Slack** Members" (project uses Zulip), "3691 total Release Packages". *Verified* live. | hardcoded literals | **`layouts/components/quickstats.html:5-13`** (rendered from `content/about/index.md:181`) |
| S3 | `/help/seminar-series/` lists **"Upcoming Seminars — March 2026 — Topic TBC · Registration opens February 2026"**. It is July 2026. The "quarterly" series has exactly one past session (Dec 2025). | page text | **`content/help/seminar-series.md`** |
| S4 | `/about/awards/` still reads, in the present tense, "The deadline to nominate a candidate for the Bioc2024 Awards **is** Wednesday May 15 th, 2024" (also a typo: "15 th"). Latest awardees: 2024. *Verified* live. | page text | **`content/about/awards.md:46-47,60,63`** |
| S5 | `/developers/release-schedule/` still documents the **completed 3.23** schedule (released April 2026); no 3.24 schedule three months before the October release. Every date is given **without a year** ("Wednesday April 29th"). Typos: "is schedule for", "pacakge". | page text | **`content/developers/release-schedule.md:1-5`** |
| S6 | `/help/newsletters/` says the newsletter "summarizes core developments and community events **on a quarterly basis**" — present tense. Last issue: **January 2016**, ten years ago. | page text | **`content/help/newsletters.md:3-4`** |
| S7 | `/about/annual-reports/` lists 2002–2024. The **2025 report is missing** seven months into 2026. *Verified* live. | generated from a directory of PDFs | asset directory behind `content/about/annual-reports.html` |
| S8 | `/developers/new-developer-program/` heading reads **"Mentors (First Cycle, Nov 2021)  TBA"** — a five-year-old "to be announced" that is immediately followed by the announced list. Also "initiative **from by** CAB members". | page text | **`content/developers/new-developer-program.md:45,43`** |
| S9 | `/developers/bioccommits/`: a section that says only **"Coming soon!"**; two entries marked "TBD". | page text | **`content/developers/bioccommits.md:140,145,194`** |
| S10 | `/news/template/` is **publicly served**: the release-announcement template, still containing the verbatim October 25, 2023 / Bioconductor 3.18 announcement text. *Verified* 200. | live | **`content/news/template.md`** |
| S11 | `/examples/` and `/examples/markdown/` are **publicly served Lorem ipsum** — a design/style demo left in `content/`, with the caption "An example of a gallery (illustrations are placeholders)". *Verified* 200. | live | **`content/examples/index.html`, `content/examples/markdown.md`** |
| S12 | `/help/education-training/` renders a literal escaped `<!DOCTYPE html>` as visible page text. The file is a full HTML document with a meta-refresh saved as `.md`, so kramdown escapes the doctype and wraps the rest in the site layout. *Verified* in the live HTML. | live | **`content/help/education-training.md`** |
| S13 | Two retired-technology pages are still published and orphaned: `/help/cabig/` (NCI **caBIG**, retired 2012 — all four of its external links are NXDOMAIN) and `/help/elasticmapreduce/` (a ~2010 Amazon EMR tutorial — all five of its S3 assets 404). *Verified* 200 for the pages, dead for the assets. | live | **`content/help/cabig.md`, `content/help/elasticmapreduce.md`** |
| S14 | `/help/bioconductor-cloud-ami/` opens with a bold **"start the AMI"** call to action; the note that AMIs were **deprecated in Bioc 3.13 (2021)** appears *below* it. `config.yaml` still carries `ami_ids` back to `bioc2_8`. | page text | **`content/help/bioconductor-cloud-ami.md:1-13`**, `config.yaml` |
| S15 | The `bioconductor@stat.ethz.ch` mailing list is gone (`https://stat.ethz.ch/mailman/listinfo/bioconductor` → **404**, verified) though `bioc-devel` is alive (200). References to the old list remain. | verified | `content/developers/index.html:162`, `content/help/support.html:71,103`, `content/help/faq.md:256`, `content/help/support/posting-guide.md:151` |
| S16 | Stale example output presented as current: `content/install.html:295-300` shows `R version 3.6.0 Patched (2019-05-02)` and `Bioconductor version '3.9'` — 14 releases old. `content/help/faq.md:44` shows `Bioconductor version 3.18 … R 4.3.2 (2023-11-07)` — 5 releases old. | page text | **`content/install.html:295`**, **`content/help/faq.md:44`** |

### 5.2 Things that are *not* stale — checked and clear

- **`biocLite()`** appears in 25 files, but **every one is an archival page** (course materials,
  news archive, 2015–2016 newsletters). No current install/help/developer page uses it.
  `content/install.html` uses `BiocManager` throughout and templates the release version from
  `config.yaml`. Good.
- **Copyright year** is dynamic: `Copyright © 2003 - <%= Time.now.year %>` in both
  `layouts/_footer.html:7` and `layouts/components/footer.html:53`.
- **Twitter/X** has been cleanly removed. The only occurrences are two links inside archived
  news posts and one inside a 2016 newsletter. The footer and homepage link LinkedIn, Bluesky,
  Mastodon, YouTube and Zulip. (`https://bsky.app/profile/bioconductor.bsky.social` returns
  404 to bot user-agents but **200 to a browser** — a false positive, not a dead account.)
- **`/help/events/` "Upcoming"** correctly filters by date and shows only BioC2026 and
  BiocAsia2026. The bug is confined to the homepage carousel.
- **Site search** works end to end.
- **`config.yaml`** release/devel/R versions are correct for 3.23/3.24/R-4.6.

### 5.3 Old docs shadowed by server-side redirects

30 pages under `content/developers/how-to/` are still maintained in this repo but are
**unreachable** — the server 301s each one to `contributions.bioconductor.org`. Verified for
all 32 how-to URLs; 31 redirect successfully, 1 does not (`long-tests`, §3.3). Examples:

```
/developers/how-to/mavericks-howto/  -> contributions.bioconductor.org/cmavericks-best-practices.html
/developers/how-to/troubleshoot-build-report/ -> …/troubleshooting-build-report.html
/developers/how-to/unitTesting-guidelines/    -> …/tests.html
```

So the badly stale content in those files — `mavericks-howto.md` is entirely about **macOS 10.9
Mavericks (2013)**, and `troubleshoot-build-report.md` is written against **Bioconductor 3.11 /
R 4.0 (2020)** — is not user-visible. It is, however, ~30 files of duplicated documentation
that contributors will find, read and edit by mistake. *Inferred* impact; *verified* redirects.

### 5.4 Orphan pages

45 of 155 hand-authored pages (course-materials excluded) have **no inbound link** from either
`content/` or the live crawl — `review/data/orphan-pages.tsv`. 22 of them are the redirect
shadows above. The rest, all live and serving 200:

```
content/developers/gitlog.md            content/help/cloud.html
content/developers/new_packages.html    content/help/cloud/badcaptcha.md
content/examples/index.html             content/help/cloud/launch.md
content/examples/markdown.md            content/help/cloud/started.html
content/help/cabig.md                   content/help/elasticmapreduce.md
content/help/newsletters.md             content/help/publications/tech-reports.md
content/help/publications/compendia/{CompStatViz,genemetaex,golubrr}.md
content/help/publications/2003/Chiaretti/chiaretti2.md
content/help/publications/papers/pubmed.html
content/news/RinNYT.md                  content/news/template.md
```

`content/help/403.html`, `content/help/404.html` and `content/help/bioc-views/packageDetail.html`
also appear in the raw output but are error pages and a template — expected orphans, not
findings. `content/help/search.html` is a **false positive**: it is reachable via the header's
`<form action="/help/search/index.html">`, which my href/src extractor does not see.

### 5.5 Dead template partials

15 partials under `layouts/` are referenced by nothing:

```
_community_help.html  _compendia.html   _course_materials.html  _faq.html
_footer.html          _help_using_R.html _literature_search.html _main_top_panel.html
_mlwidget2.html       _package_vignettes.html _publications.html  _registration.html
_release_announcements.html _technical_reports_and_working_papers.html _temporaryAnnouncement.html
```

Relevant to this audit because `layouts/_community_help.html:37` contains a link to
`http://watson.nci.nih.gov/~sdavis/` (NXDOMAIN) and `layouts/_footer.html` is a second,
superseded footer. **These are dead code and are not served** — I checked the live pages and
the URL does not appear. Reported so they are not double-counted as live breakage.

Also at repo root: `test.txt` ("this is a test file") and `TODO.org`, whose two open TODOs are
"setup local server for deployment" and "setup chron based build/deploy from **svn**" —
Bioconductor left SVN for git in 2017.

### 5.6 `/dashboard/` renders two visibly broken sections — **Verified**

- Under "Recent Commits", the release column prints the literal error string
  **"Can't read / no records in rss feed, not report last git commit time"** followed by ten
  rows containing only ".". The devel column works.
- Under "Build System Status", the **Release / Software** and **Release / Experiment Data**
  slots contain `<p>&nbsp;</p>` where the corresponding devel slots contain
  `<iframe src="/dashboard/build_devel_bioc.html">`. The status iframes for release software
  and release experiment data are simply absent, so the legend renders above an empty table.

---

## 6. Prioritized fix list

**P0 — user-visible, high blast radius**

1. Restore `/help/course-materials/**` (or, if the archive is deliberately being retired,
   replace it with a real page and fix the ~6 live inbound links). 2,566 URLs; the largest
   defect on the site. §3.1
2. Fix the HTTPS→HTTP downgrade on directory redirects and add HSTS. Apache side:
   `UseCanonicalName`/`RequestHeader`-aware redirect, or force the scheme from
   `X-Forwarded-Proto`. §4.1
3. Add a date filter to `top_events()` — `lib/helpers.rb:452`, mirroring `upcoming_events()`
   at line 426 — so the homepage stops advertising last year's conferences. §5.1 S1
4. Refresh or remove the 2023 "Quick Stats" panel; it names Slack, a platform the project no
   longer uses. `layouts/components/quickstats.html`. §5.1 S2

**P1 — small diffs, immediate correctness**

5. `content/help/docker.md:3` — `https:/` → `https://`. §3.3
6. `config.yaml:322` — add `https://` to the TUNA `institution_url`. §3.3
7. `content/help/faq.md:154` — `[installed](4)` → a real anchor. §3.3
8. `content/developers/how-to/unitTesting-guidelines.md` — remove the stray `]` from the
   `runittotestthat` URL; repoint the dead R Journal PDF; fix or remove the `long-tests`
   cross-reference that 404s at `contributions.bioconductor.org`. §3.3, §3.6
9. Create `content/news/index.*` and un-comment the homepage "See all News" button
   (`layouts/components/homepage/info.html:183`). §3.4
10. `content/help/education-training.md` — replace the doctype-in-markdown hack with a proper
    server redirect or a normal one-line page. §5.1 S12
11. Remove the dead Taiwan mirror and fix the Pisa HTTPS URL and RIKEN institution URL in
    `config.yaml`; surface the health data `/dashboard/` already computes on `/about/mirrors/`. §4.4
12. Update the three dead advisory-board member bio links in
    `content/about/{technical,community}-advisory-board.md`. §3.6

**P2 — content maintenance**

13. Seminar series, awards page, release schedule, newsletters framing, 2025 annual report,
    new-developer-program "TBA", bioccommits "Coming soon!". §5.1 S3–S9
14. Unpublish or clearly archive `/news/template/`, `/examples/*`, `/help/cabig/`,
    `/help/elasticmapreduce/`; put the deprecation notice at the *top* of
    `/help/bioconductor-cloud-ami/`. §5.1 S10–S14
15. Rewrite the `secure.bioconductor.org` / `register.bioconductor.org` registration links in
    `content/help/events/*.yaml` — 28 dead links, 11 of them on the live events page. §3.2
16. Delete the 15 dead layout partials, `test.txt`, and the SVN-era `TODO.org`; decide whether
    the 30 redirect-shadowed `how-to` docs should be deleted or kept as the editing source. §5.3, §5.5
17. Fix the two broken `/dashboard/` sections. §5.6

**P3 — archive policy**

18. Decide the policy for the 415 dead external links on archival pages. Either (a) declare
    2002–2018 course materials and pre-2020 event pages a frozen archive, banner them as such,
    and exclude them from link checking; or (b) run them through the Wayback Machine and
    rewrite to `web.archive.org` snapshots. Doing neither means the archive stays 27 % rotten
    and the link checker stays too noisy to act on. §3.7

---

## 7. Recommendation: automated link checking

**There is currently no link checking of any kind.** The repo has four GitHub Actions workflows
(`.github/workflows/`): `linter.yaml` (super-linter — HTML/CSS/JS lint, with markdown and
natural-language validation explicitly disabled), `pr_deploy.yaml` (builds with nanoc and
publishes a preview to an S3 bucket per PR), `pr_close.yaml` (tears the bucket down), and
`staging.yaml`. Nothing checks a URL.

Two useful hooks already exist: the PR workflow **already builds the whole site into `output/`**,
and it **already publishes a preview URL**. A link check is close to free to add.

**Tool: [lychee](https://github.com/lycheeverse/lychee) via `lycheeverse/lychee-action`.** It is
the right fit here — a single static binary, fast, handles the ~14k links in this repo without
trouble, understands markdown and HTML, has first-class exclude/cache/retry configuration, and
`--offline` mode for the internal-only check.

**Wire it in at three points:**

1. **Per-PR, internal links only, blocking.** In `pr_deploy.yaml`, after the nanoc build and
   before the S3 upload:
   ```yaml
   - name: Check internal links
     uses: lycheeverse/lychee-action@v2
     with:
       args: --offline --include-fragments --no-progress --root-dir "$GITHUB_WORKSPACE/output" "output/**/*.html"
       fail: true
   ```
   `--offline` means no network, so it is fast and deterministic and cannot flake. This would
   have caught `https:/docs.docker.com/...`, `[installed](4)`, the schemeless TUNA URL, the
   stray `]`, and the `vobencha@fhcrc.org` link targets — all of them, at review time.

2. **Weekly scheduled run against production, non-blocking, opens an issue.** A new
   `.github/workflows/linkcheck.yaml`:
   ```yaml
   on:
     schedule: [{cron: "0 6 * * 1"}]
     workflow_dispatch:
   ```
   with `--cache --max-cache-age 1w`, `--max-concurrency 8`, `--user-agent`, `--accept 200,206,429`,
   and `lycheeverse/lychee-action`'s `fail: false` plus `peter-evans/create-issue-from-file` so
   the report lands as a tracked issue rather than a red X nobody reads. Exclude the generated
   trees — `/packages/`, `/checkResults/`, `/books/`, `/shields/`, `/help/bioc-views/` — they
   are 1.1 % broken and enormous.

3. **A `.lycheeignore` that encodes the archive decision.** Until §6 P3 is decided, exclude
   `content/help/course-materials/`, `content/news/`, `content/help/newsletters/` from the
   external check. Otherwise the 415 archival breakages will drown the 60 that matter and the
   check will be muted within a month. Also exclude `localhost`/`127.0.0.1` (deliberate, in
   `docker.md`) and the handful of WAF-blocking hosts listed as `BLOCKED_403` in
   `review/data/external-classified.tsv`.

One caveat worth designing around: several of this site's real defects are **server-side**, not
in the built output — the `/help/course-materials/` 403, the `/news/` 403, the HTTPS→HTTP
downgrade, and the `long-tests` redirect that lands on a 404. An `--offline` check of `output/`
will never see any of them. The weekly production run is what catches that class, so it should
be treated as load-bearing rather than optional.

---

## 8. Data files

All under `review/data/`.

| File | Rows | Contents |
|---|---:|---|
| `content-links-all.tsv` | 14,212 | every link in `content/`: source file, source page URL, raw link, resolved URL |
| `config-layout-links.tsv` | 132 | external links in `config.yaml` and `layouts/**` |
| `external-urls.txt` | 1,732 | unique external URLs |
| `external-hosts.tsv` | 407 | external hosts by link count |
| `external-link-check.tsv` | 1,732 | first-pass result: status, redirect chain, final URL, content-type, page title |
| `external-classified.tsv` | 1,732 | first pass + classification + referrers + **second-pass verification** columns |
| `broken-external-actionable.tsv` | 60 | verified-broken external links on live pages, with referring file |
| `external-check-config-layouts.tsv` | 99 | `config.yaml` + `layouts/**` external results |
| `mirror-check.tsv` | 47 | every mirror and institution URL from `config.yaml` |
| `internal-urls-from-content.txt` | 6,842 | unique internal URLs referenced by `content/` |
| `internal-check-list.txt` | 3,346 | internal URLs actually checked (content ∪ live crawl, minus generated trees) |
| `internal-link-check.tsv` | 3,346 | first-pass internal results |
| `internal-recheck.tsv` | 2,608 | 403/429 subset re-checked at 3 concurrent / 0.4 s delay |
| `spider-pages.tsv` / `spider-edges.tsv` | 703 / 138,113 | first spider run, `/books/` included |
| `spider2-pages.tsv` / `spider2-edges.tsv` | 122 / 20,513 | second spider run, generated trees excluded — the referrer source for live-page attribution |
| `sample-package-pages.txt`, `sample-buildreport-vignette.txt`, `internal-pkg-sample.txt`, `sample-check.tsv` | 100 / 30 / 60 / 190 | generated-space sample and results |
| `orphan-pages.tsv` | 45 | hand-authored pages with no inbound link |

Crawler scripts are checked in alongside the data at `review/data/scripts/`:

| Script | Role |
|---|---|
| `extract.py` | walks `content/`, extracts and resolves every `href`/`src`/markdown link, splits internal vs external |
| `spider.py` | polite BFS spider of the live hand-authored page space; records pages and referrer edges |
| `check.py` | link checker — HEAD then GET, per-host concurrency cap, redirect chains, page titles for soft-404 detection |
| `analyze.py` | classifies checker output and joins each URL back to its referring source files |
| `verify.sh` | second-pass browser-user-agent verification of every non-OK result |

Reproduce with, e.g.:
```
python3 scripts/extract.py
python3 scripts/check.py external-urls.txt external-link-check.tsv 16 0.2 3 --body
python3 scripts/analyze.py external-link-check.tsv
```
`check.py` takes `<in> <out> <workers> <delay> <per-host-cap> [--body]`. Note that the paths
inside `extract.py` and `analyze.py` point at the clone location used for this audit and need
adjusting if the source tree moves.
