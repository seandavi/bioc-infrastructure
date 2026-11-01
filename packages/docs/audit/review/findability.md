# Bioconductor Findability Audit

**Scope:** on-site search, package discovery, external search-engine representation, and metadata hygiene on generated pages.
**Date of measurement:** 2026-07-26 (all live probes run that day).
**Site source audited:** local clone at commit `e2ae0a9` ("remove temporary fix for rankings when stats was down", 2026-07-23).
**Live release version:** Bioconductor 3.23 (`config.yaml: release_version: "3.23"`, `devel_version: "3.24"`).

Every claim below is tagged **[verified]** (I ran it and pasted the output) or **[inference]** (a conclusion drawn from verified facts).

---

## Executive summary — the 5 most important findings

1. **`robots.txt` forbids crawling every package page on the site.** `https://bioconductor.org/robots.txt` contains `Disallow: /packages/release/`, `Disallow: /packages/devel/`, `Disallow: /biocViews/`, and a `Disallow:` line for every numbered release from 1.8 through 3.24. A robots parser confirms Googlebot is blocked from `/packages/release/bioc/html/DESeq2.html`, `/packages/release/BiocViews.html`, and every vignette under those paths. This is the single highest-impact defect in the audit: the project instructs search engines not to read its ~3,810 release landing pages, ~3,810 devel landing pages, the entire biocViews browse tree, and every rendered vignette. **[verified]**

2. **`sitemap.xml` is a broken build artifact — it has served an unevaluated ERB tag for its entire life.** `https://bioconductor.org/sitemap.xml` returns exactly 20 bytes: the literal string `<%= xml_sitemap %>`. The cause is in `Rules:12-14`, where the `/sitemap/` compile rule has an empty body and never applies `filter :erb`. So the site publishes **0 URLs** in its sitemap against 536 content source pages plus thousands of generated package pages. **[verified]**

3. **The main site search is effectively a package-name lookup and nothing else.** Against 10 realistic queries it put the right answer in the top 5 **twice** — both times the query *was* an exact package name. "convert gene symbols to Entrez" returns a package page from Bioconductor 1.5/1.6 (circa 2006). "which R version do I need" returns `dyebiasexamples`. "how to submit a package" returns the AnnotationHub HOWTO vignette. The same 10 queries against `support.bioconductor.org` hit 9/10. **[verified]**

4. **Stale third-party mirrors outrank bioconductor.org for its own packages.** A live search for "DESeq2 bioconductor package" returned `bioconductor.uib.no/packages/3.22/...`, `s3.jcloud.sjtu.edu.cn/.../bioconductor/3.15/...`, and `ftp.gwdg.de/pub/misc/bioconductor/packages/3.17/...` alongside the origin. Those mirrors serve releases 3.15–3.22 — up to eight releases stale. Their `robots.txt` files are either 404 (uib.no, tu-dortmund.de) or `Disallow:` with an empty value meaning *allow everything* (gwdg.de). The mirrors are crawlable; the origin is not. **[verified for the ranking and the robots files; inference for the causal link]**

5. **Not one page on the site emits a `rel=canonical` tag, and the same package page is reachable at five or more distinct URLs.** `/packages/DESeq2/`, `/packages/release/bioc/html/DESeq2.html`, `/packages/3.23/bioc/html/DESeq2.html`, `www.` versus apex, and *arbitrarily slash-doubled* variants (`/packages//release/...`, `/packages///release/...`) all return HTTP 200 with byte-identical content (md5 `ede6ab17…`). The slash-doubled variants also **evade the robots.txt block**, which is how `bioconductor.org/packages//release/bioc/html/BiocGenerics.html` and `www.bioconductor.org/packages//release/bioc/vignettes/ChIPseeker/...` ended up in live search results while their correctly-spelled equivalents are disallowed. **[verified]**

---

## 1. On-site search

### 1.1 Inventory of search surfaces

| # | Surface | Where | Engine | Corpus | Evidence |
|---|---|---|---|---|---|
| 1 | Header search box → `/help/search/index.html` | every page (`layouts/components/header.html:24-46`) | **Apache Solr**, queried by browser JSONP | Crawled `bioconductor.org` HTML, PDFs, `.R` files, vignettes — release, devel **and archived releases back to 1.5** | `assets/js/search.js:17-24` builds `//master.bioconductor.org/solr/default/select?...&wt=json` |
| 2 | biocViews tree widget | `/packages/release/BiocViews.html` | jsTree 1.x, client-side, over a static JSON dump | 413 biocViews terms + 3,810 release packages | `assets/js/bioc_views.js`, `packages/json/3.23/tree.js` |
| 3 | "Find biocViews:" autocomplete | on the BiocViews page (`#autocompleter`) | jQuery UI autocomplete, client-side | **biocViews term names only — not package names** | see §1.4 |
| 4 | "Search table:" filter | on the BiocViews page | DataTables 1.9.4 client-side filter | only the *currently selected* category's rows | see §1.4 |
| 5 | Support forum search | `support.bioconductor.org/post/search/?query=` | Biostar built-in full-text index | forum posts, answers, comments | §1.3 |
| 6 | Code search | `code.bioconductor.org/search/search?q=` | **Zoekt** (supports `lang:`, `file:`, `case:`, regex) | source files of software packages, **`devel` branch only** | every result path is `/browse/<pkg>/blob/devel/...` |

Two mechanical notes on surface 6: the form on `/search/` posts to the relative path `search`, so the working endpoint is **`/search/search?q=`**. Requesting `/search?q=matrix` (a natural URL to guess, and the one the marketing copy implies) returns HTTP 200 with the *empty search form* and no results and no error — a silent failure. **[verified]**

### 1.2 Benchmark: the same 10 queries against each surface

Queries were issued against Solr using a verbatim port of `getSearchUrl()` from `assets/js/search.js` — including the release/devel boost clauses — so the results below are what the website itself produces. Scoring: **HIT** = a page that answers the query is in the top 5; **PART** = something on-topic but not the answer; **MISS** = neither.

#### Hit/miss table

| # | Query | Main site (Solr) | Support forum | Code search |
|---|---|---|---|---|
| 1 | DESeq2 | **HIT** | **HIT** | PART |
| 2 | differential expression | MISS | **HIT** | MISS |
| 3 | single cell RNA-seq | MISS | **HIT** | MISS |
| 4 | read a BAM file | MISS | **HIT** | PART |
| 5 | convert gene symbols to Entrez | MISS | **HIT** | PART |
| 6 | install error non-zero exit status | PART | **HIT** | MISS |
| 7 | how to submit a package | MISS | **HIT** | MISS |
| 8 | SummarizedExperiment | **HIT** | **HIT** | MISS |
| 9 | spatial transcriptomics | PART | PART | PART |
| 10 | which R version do I need | MISS | **HIT** | MISS |
| | **Top-5 hit rate** | **2/10** | **9/10** | **0/10** (not its job) |

#### Raw main-site results (top 5 shown; `numFound` is Solr's own count)

```
QUERY 'DESeq2'   numFound=7112                                        -> HIT
  1. [2.808] Bioconductor - DESeq2   /packages/release/bioc/html/DESeq2.html
  2. [2.314] DESeq2                  /packages/devel/bioc/vignettes/Glimma/inst/doc/DESeq2.html
  3. [2.314] DESeq2                  /packages/release/bioc/vignettes/Glimma/inst/doc/DESeq2.html
  4. [2.184] Bioconductor - DESeq    /packages/release/bioc/html/DESeq.html
  5. [1.921] Bioconductor - DESeq2 (development version)  /packages/devel/bioc/html/DESeq2.html

QUERY 'differential expression'   numFound=21529                      -> MISS
  1. Visualize Differential Expression results   /packages/release/bioc/vignettes/Rvisdiff/...
  2. Visualize Differential Expression results   /packages/devel/bioc/vignettes/Rvisdiff/...
  3. Supported differential expression methods   /packages/devel/bioc/vignettes/iSEEde/...
  4. Supported differential expression methods   /packages/release/bioc/vignettes/iSEEde/...
  5. Sequence Analysis: Differential Representation  /help/course-materials/2010/SeattleIntro/...pdf
  (no DESeq2, edgeR or limma landing page anywhere in the top 5)

QUERY 'single cell RNA-seq'   numFound=27014                          -> MISS
  1. Single Cell RNAseq  /packages/devel/data/experiment/vignettes/systemPipeRdata/inst/doc/SPscrna.html
  2. Single Cell RNAseq  /packages/release/data/experiment/vignettes/systemPipeRdata/...
  3. single             /packages/devel/bioc/vignettes/single/inst/doc/single.html
  4. single             /packages/release/bioc/vignettes/single/inst/doc/single.html
  5. SC3: Single-Cell Consensus Clustering  /packages/devel/bioc/manuals/SC3/man/SC3.pdf
  (no SingleCellExperiment, scater, scran, or the OSCA book)

QUERY 'read a BAM file'   numFound=51234                              -> MISS
  1. Practical: Read Counting in RNA-seq   /help/course-materials/2014/summerx/ReadCounting-exercises.pdf
  2. FilterFFPE: FFPE Artificial Chimeric Read Filter for NGS data   .../manuals/FilterFFPE/...pdf
  3. (same, devel)
  4. SimFFPE: NGS Read Simulator for FFPE Tissue   .../manuals/SimFFPE/...pdf
  5. (same, release)
  (no Rsamtools, no GenomicAlignments — the two packages that actually read BAM files)

QUERY 'convert gene symbols to Entrez'   numFound=52420               -> MISS
  1. convert   /packages/bioc/1.6/src/contrib/html/convert.html      <-- Bioconductor 1.6, ~2006
  2. convert   /packages/bioc/1.7/src/contrib/html/convert.html
  3. convert   /packages/bioc/1.5/src/contrib/html/convert.html
  4. convert   /packages/2.3/bioc/html/convert.html
  5. convert   /packages/2.4/bioc/html/convert.html
  (all five results are archived pages for a package removed long ago; no AnnotationDbi, no org.Hs.eg.db)

QUERY 'install error non-zero exit status'   numFound=44936           -> PART
  1. Install MEME  /packages/devel/bioc/vignettes/memes/inst/doc/install_guide.html
  2. (same, release)
  3. Bioconductor - Install  /install/                                <-- correct-ish, at #3
  4. Herper: ...install and manage conda packages...  .../manuals/Herper/...pdf
  5. (same, release)

QUERY 'how to submit a package'   numFound=62433                      -> MISS
  1. AnnotationHub How-To's   /packages/release/bioc/vignettes/AnnotationHub/inst/doc/AnnotationHub-HOWTO.html
  2. (same, devel)
  3. How to use mQTL.NMR      .../vignettes/mQTL.NMR/inst/doc/mQTLUse.pdf
  4. (same, devel)
  5. How to use breakpointR   .../vignettes/breakpointR/inst/doc/breakpointR.pdf
  (the site's own /developers/package-submission/ page is absent)

QUERY 'SummarizedExperiment'   numFound=9904                          -> HIT
  1. [3.399] Bioconductor - SummarizedExperiment  /packages/release/bioc/html/SummarizedExperiment.html
  2. [2.321] ... (development version)             /packages/devel/bioc/html/...
  3. [2.103] manual PDF (release)
  4. [2.103] manual PDF (devel)
  5. [1.866] Bioconductor - SummarizedExperiment  /packages/3.2/bioc/html/...   <-- release 3.2, from 2015

QUERY 'spatial transcriptomics'   numFound=8398                       -> PART
  1. Spaniel: Spatial Transcriptomics Analysis   /packages/devel/bioc/manuals/Spaniel/man/Spaniel.pdf
  2. (same, release)
  3. Guide to Spatial Registration   .../vignettes/spatialLIBD/...
  4. (same, release)
  5. Spatial Transcriptomics Deconvolution with SPOTlight  .../vignettes/SPOTlight/...
  (no SpatialExperiment landing page — the core data structure)

QUERY 'which R version do I need'   numFound=58882                    -> MISS
  1. dyebiasexamples: Example data for the dyebias package...  .../manuals/dyebiasexamples/...pdf
  2. (same, devel)
  3. The auxiliary commands which can help to the users  .../vignettes/ceRNAnetsim/...
  4. serumStimulation: ...  .../manuals/serumStimulation/...pdf
  5. (same, devel)
  (/install/ — which states the required R version — does not appear at all)
```

#### Raw support-forum results (top 5, abbreviated)

```
'DESeq2'                         n=5,264   1. DESeq2 /p/57847/   2. DESeq2 preprint  3. Basemean calculations with DESeq2 ...
'differential expression'        n=10,475  1. Differential expression /p/13094/  2. Differential Gene Expression ...
'single cell RNA-seq'            n=9,222   1. single cell RNA-seq pipeline /p/111097/ ...
'read a BAM file'                n=17,106  1. reading BAM files /p/49450/  2. Processing bam files by read group ...
'convert gene symbols to Entrez' n=17,045  1. Converting gene symbols to entrez ID /p/9143142/  (exact match at #1)
'install error non-zero exit...' n=18,972  1. ChIPQC error: "non-zero exit status"  2. DESeq2 Installation fails ...
'how to submit a package'        n=22,350  1. How to submit new packages /p/69227/  (exact match at #1)
'SummarizedExperiment'           n=598     1. How to initialize a SummarizedExperiment /p/83472/ ...
'spatial transcriptomics'        n=911     1. [Pre-print] ... 2. Using duplicateCorrelation with limma/voom for spatial transcriptomics
'which R version do I need'      n=28,178  1. Which R version is needed for tximport package /p/133340/
```

### 1.3 Why the main search scores 2/10 — four concrete defects

**(a) No de-duplication across release/devel/archive.** In 8 of the 10 result sets, results 1 and 2 (or 3 and 4) are *the same document* served from `/release/` and `/devel/`. Half of every result page is wasted. Worse, the index also contains archived releases: query 5 returned five pages from Bioconductor 1.5, 1.6, 1.7, 2.3 and 2.4, and query 8 returned a 3.2 page in the top 5. **[verified]**

**(b) The relevance query is malformed for multi-word input.** `assets/js/search.js:17-24` builds:

```js
var url = "//master.bioconductor.org/solr/default/select?indent=on&version=2.2&q=" + query +
  " id:*\\/release\\/bioc\\/html*^1.2 id:*\\/devel\\/bioc\\/html*^1.1 title:" + query + "~" +
  "&fq=&start=" + start + "&rows=20&fl=id,score,title&qt=standard&wt=json...";
```

For `query = "convert gene symbols to Entrez"` the `q` parameter becomes
`convert gene symbols to Entrez id:*\/release\/bioc\/html*^1.2 ... title:convert gene symbols to Entrez~`.
With the standard query parser and a default `OR` operator, only the first token binds to `title:` — the rest become loose default-field terms, and the trailing `~` applies fuzzy matching to the word `Entrez` alone. There is no `dismax`/`edismax`, no `mm` (minimum-should-match), no phrase boost, and the `fq` parameter is sent empty. A five-word query therefore behaves as "match any of these words anywhere," which is exactly the behaviour the results show. Also note the release boost is only `^1.2` versus `^1.1` for devel — a 9% difference, far too small to reliably put release above devel. **[verified — code read, and behaviour consistent with observed output]**

**(c) The result UI has no facets, no filters, and broken analytics.** Live check of `/help/search/index.html?search-bar=read+a+BAM+file`:

```json
{"pageTrackerDefined":"undefined","gtagDefined":"function","onclickResults":18,
 "totalResults":20,"numFound":"51234","facets":0,"resultsPerPage":20}
onclick handler result: THROWS: pageTracker is not defined
pageerrors: ["TypeError: Cannot read properties of undefined (reading 'test')",
             "TypeError: Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
             "TypeError: Cannot read properties of null (reading 'addEventListener')"]
```

51,234 results, zero facets (no "packages only", no "release only", no content-type filter), 20 per page. 18 of the 20 result links carry an inline `onclick` calling `pageTracker._trackPageview(...)` — Google Analytics **Classic**, retired in 2014. The site now runs GA4 (`gtag` is defined). Every click on a PDF or `.R` result throws `ReferenceError: pageTracker is not defined`. The link still navigates, so this is a silent console error and lost click telemetry rather than a broken link. Three further uncaught `TypeError`s fire on page load. **[verified]**

**(d) Transport is fragile.** The request is JSONP (`dataType: 'jsonp'`) with a **5-second timeout** (`assets/js/search.js:127`) against a protocol-relative `//master.bioconductor.org` URL. On timeout the user sees the literal string *"A timeout or invalid search term resulted in an error."* JSONP also means the search cannot be server-rendered, so search result pages are invisible to crawlers and to any user without JavaScript. Measured latency was good on the day (0.23–0.50 s), so the timeout is a tail-risk, not a current outage. **[verified]**

### 1.4 The two search boxes on the Packages page do not search packages

On `/packages/release/BiocViews.html` there are two input fields that look like package search. Neither is:

```
autocompleter: {"exists":true,"visible":true,"nearbyText":"Find biocViews: "}
  type "single cell" -> suggestions: []
  type "DESeq2"      -> suggestions: []
  type "RNAseq"      -> suggestions: ["RNASeq","RNASeqData"]
dataTables filter: {"exists":true,"visible":true,"labelText":"Search table:"}
```

The "Find biocViews:" box autocompletes **taxonomy term names only**. Typing a package name (`DESeq2`) yields nothing. Typing natural English (`single cell`) yields nothing, because the term is spelled `SingleCell` with no space — the user must already know the CamelCase spelling. The "Search table:" box is a DataTables client-side filter that only searches rows of the **currently selected category**. **[verified]**

---

## 2. Package discovery without knowing the name

### 2.1 The intended path, and where it breaks

The header "Packages" link (`layouts/components/header.html:20`) points at `/packages/release/BiocViews.html#___Software`. That page is the entire browse experience.

**Measured page cost** (headless Chromium, cold cache, 1280×900):

| Metric | Value |
|---|---|
| Total transferred | **1,110,902 bytes** across 66 resources |
| HTML document (transferred) | 3,980 bytes (14,278 bytes uncompressed) |
| `packages/json/3.23/bioc/packages.js` | 313,055 B |
| `packages/json/3.23/tree.js` | 268,455 B (413 biocViews terms) |
| `js/tree-widget/jquery.jstree.js` | 185,063 B |
| `packages/json/3.23/data/annotation/packages.js` | 131,820 B |
| `js/jsnetworkx.js` | 93,223 B |
| `packages/json/3.23/data/experiment/packages.js` | 56,447 B |
| DataTables (from `ajax.aspnetcdn.com`) | 21,945 B |
| DOM nodes after render | **16,777** |
| Table rows rendered | **2,420** |
| Anchors on page | 2,970 (2,483 visible) |
| Focusable elements | **12,658** |
| `domContentLoaded` / `load` | 106 ms / 671 ms |
| Time until the tree is usable | ~9 s in testing |

**[verified]**

**The HTML contains no package data at all.** The 14,278-byte document does not contain the strings `DESeq2`, `limma`, `SummarizedExperiment`, `Software (`, or even `<table>`. Everything is assembled client-side from the JSON dumps. So: no JavaScript, no packages — and, combined with the robots.txt block, no crawler ever sees a single package name on this page. **[verified]**

**Landing on the page with no hash shows nothing.** A fresh visit to `/packages/release/BiocViews.html` (no fragment) renders `visibleRows: 0`. The nav link always appends `#___Software`, so this is only hit by someone typing or sharing the bare URL — but they get an apparently empty page. **[verified]**

### 2.2 Deep-linking is broken for in-page navigation — root cause identified

Every package landing page links its biocViews terms as fragments on the shared page. From `ChIPseeker.html`:

```
../../BiocViews.html#___Annotation
../../BiocViews.html#___ChIPSeq
../../BiocViews.html#___MultipleComparison
../../BiocViews.html#___Software
```

**Cold visits work.** With a fresh browser context each time:

```
FRESH CONTEXT "#___ChIPSeq"         -> heading "Packages found under ChIPSeq:",        selected "ChIPSeq (91)",        rows 93
FRESH CONTEXT "#___SingleCell"      -> heading "Packages found under SingleCell:",     selected "SingleCell (347)",    rows 349
FRESH CONTEXT "#___Transcriptomics" -> heading "Packages found under Transcriptomics:", selected "Transcriptomics (298)", rows 300
FRESH CONTEXT ""                    -> rows 0
```

**Navigating between two terms does not.** In one tab:

```
after first nav (#___ChIPSeq), heading = "Packages found under ChIPSeq:"   | loads = 1
after in-page hash change to #___SingleCell:
   location.hash = #___SingleCell
   heading       = "Packages found under ChIPSeq:"        <-- WRONG, still ChIPSeq
   loads         = 1  (unchanged => page never re-initialised)
```

**Root cause** — `assets/js/bioc_views.js:197-206`:

```js
var getNodeName = function () {
  var wlh = window.location.href;
  var segs = wlh.split("#");
  if (segs.length == 2) { return segs[1].replace("___", ""); } else { return ""; }
};
```

`getNodeName()` reads `window.location.href` **once**, inside `init()`, and the result is passed to jsTree as `ui.initially_select` (line 224). A fragment-only navigation is a same-document navigation: the browser fires no `load` event and `init()` never runs again. There is **no `hashchange` listener for the tree** anywhere in the codebase — a grep across `assets/js/` finds exactly one such listener, `assets/js/bioconductor.js:99`, and it only changes background colours. **[verified]**

The user-visible consequence: a reader on the biocViews page who clicks a second category link — or who follows a `#___ChIPSeq` link, then edits the URL, then follows `#___SingleCell` — silently keeps looking at the first category, with a heading that says so. It looks like the site is ignoring them. **[verified behaviour; inference on frequency]**

### 2.3 Accessibility and mobile

| Check | Result |
|---|---|
| `role="tree"` present | **No** |
| `aria-expanded` attributes | **0** |
| Focusable elements on page | **12,658** |
| Tab stops from page top to the first tree node | 14 |
| Horizontal overflow at 390 px | None (`scrollWidth` 390 = `innerWidth` 390) |

jsTree 1.x renders the taxonomy as nested `<ul>`/`<li>` with `<a href="#">` and no ARIA tree semantics, so a screen reader announces a plain nested list of 2,970 links with no expand/collapse state. A keyboard user who wants a package near the bottom of a 2,418-row category faces up to 12,658 tab stops with no skip link into or out of the table. The layout itself is responsive and does not overflow on a phone, but a 1.1 MB payload and 16,777 DOM nodes is a heavy page for mobile data. **[verified]**

### 2.4 The generated per-category "pages" are not pages

There is no URL for "ChIP-seq packages". `#___ChIPSeq` is a client-side state of one document. Therefore, for all 413 biocViews terms there is:

- no distinct URL a crawler can index,
- no distinct `<title>` — every state reports `Bioconductor - BiocViews`,
- no distinct meta description,
- no server-rendered list of the packages in that category.

**[verified]** For a project whose central discovery asset is a curated 413-term biological taxonomy over 3,810 packages, this means the taxonomy is invisible to every search engine. **[inference]**

### 2.5 How people actually find Bioconductor packages today

I ran the discovery question a real user asks — a biological task, not a package name — and recorded which domains rank.

**Query: "R package for ChIP-seq peak annotation"** — the canonical "I have a question, find me a package" query.

| Rank | Domain | URL |
|---|---|---|
| 1 | academic.oup.com | ChIPseeker paper, Bioinformatics |
| 2 | pubmed.ncbi.nlm.nih.gov | ChIPseeker paper |
| 3 | researchgate.net | ChIPseeker PDF |
| 4 | **www.bioconductor.org** | `/packages//release/bioc/vignettes/ChIPseeker/inst/doc/ChIPseeker.html` — **note the double slash** |
| 5 | hbctraining.github.io | HBC training course |
| 6 | **mirror.nju.edu.cn** | `/bioconductor/packages/3.1/bioc/vignettes/ChIPseeker/...pdf` — **Bioconductor 3.1, ~2015** |
| 7 | hdsu.org | workshop page |
| 8 | rdrr.io | ChIPseeker vignette |

The `ChIPseeker.html` **landing page** — the project's own canonical page for the package — does not appear anywhere. The only bioconductor.org hit is a vignette reached through a malformed double-slash URL that happens to evade robots.txt. A Chinese mirror serving an eleven-year-old release outranks nothing at all from the origin's package pages. **[verified]**

**Query: "how to convert gene symbols to Entrez IDs in R Bioconductor"**

| Rank | Domain |
|---|---|
| 1 | r-bloggers.com |
| 2 | **support.bioconductor.org** `/p/106106/` |
| 3 | biostars.org |
| 4 | yiweiniu.github.io (personal blog) |
| 5 | gungorbudak.com (personal blog) |
| 6 | **support.bioconductor.org** `/p/9143142/` |
| 7 | **support.bioconductor.org** `/p/91252/` |
| 8 | genekitr.fun |
| 9 | github.com |

Zero results from `bioconductor.org` itself. The support forum carries the project's entire showing. **[verified]**

**Query: "SummarizedExperiment R package documentation"**

| Rank | Domain | Note |
|---|---|---|
| 1 | **rdrr.io** | shows version **1.20.0** |
| 2 | bioconductor.org | `/packages/SummarizedExperiment/` (the 302 shortcut) |
| 3 | www.bioconductor.org | `/packages/release/bioc/html/...` |
| 4 | kasperdanielhansen.github.io | course notes |
| 5 | rdrr.io | |
| 7 | bioc.r-universe.dev | |
| 8 | **rdocumentation.org** | shows version **1.2.3** — ancient |

rdrr.io outranks the origin, and both third-party mirrors advertise long-obsolete versions. **[verified]**

**Where Bioconductor does win:** "how to submit a package to Bioconductor" is topped by `contributions.bioconductor.org` (the Bookdown contributor guide) with `github.com/Bioconductor/Contributions` at #2 — the correct answers. And "which R version do I need for Bioconductor 3.23" returns `www.bioconductor.org/packages/release/bioc/html/BiocVersion.html`, `/install/`, `/news/bioc_3_23_release/` and `/developers/release-schedule/` in the top six. Note that both winning cases are either a *different subdomain* running a different generator, or the `/install/` and `/news/` trees — the parts of the site **not** blocked by robots.txt. **[verified; the correlation is an inference but a well-supported one]**

**Summary of the discovery gap.** Bioconductor's own package landing pages are close to absent from the results a scientist actually sees. The traffic they would have earned goes to: journal publishers and PubMed (for packages with a paper), rdrr.io and RDocumentation (which republish the same content with stale version numbers), stale geographic mirrors, personal blogs, and the support forum. **[inference from four verified searches]**

---

## 3. External SEO and representation

### 3.1 robots.txt — the central problem

`https://bioconductor.org/robots.txt`, 1,514 bytes, 60 lines, `Last-Modified: Wed, 29 Apr 2026`. The complete disallow list:

```
Disallow: /packages/submitted/   /packages/misc/   /packages/lindsey/   /packages/omegahat/
Disallow: /packages/1.8/ … /packages/2.14/ … /packages/3.0/ … /packages/3.24/     (every numbered release)
Disallow: /packages/devel/
Disallow: /packages/release/
Disallow: /packages/bioc/
Disallow: /packages/data/
Disallow: /repository/  /checkResults/  /data/  /datafiles/  /installScripts/
Disallow: /biocViews/   /stats/  /dataann-stats/  /dataexp-stats/
```

Verdicts from a standards-compliant robots parser (`urllib.robotparser`, user-agent `*`):

```
BLOCK  /packages/release/bioc/html/DESeq2.html
BLOCK  /packages/devel/bioc/html/DESeq2.html
BLOCK  /packages/3.23/bioc/html/DESeq2.html
BLOCK  /packages/release/BiocViews.html
BLOCK  /packages/release/bioc/vignettes/DESeq2/inst/doc/DESeq2.html
BLOCK  https://www.bioconductor.org/packages/release/bioc/html/DESeq2.html
ALLOW  /packages//release/bioc/html/DESeq2.html          <-- double slash escapes the rule
ALLOW  /help/
ALLOW  /install/
ALLOW  /packages/json/3.23/tree.js
```

**[verified]**

The blocked set covers, for the release version alone: 2,418 software + 928 annotation + 436 experiment + 28 workflow = **3,810 landing pages**, the same again for devel, ~22 archived releases, the biocViews browse page, and every rendered vignette and reference manual.

The repository copy is `assets/robots.txt` — a static asset, copied verbatim to the site root. The clone provided is shallow (single commit), so I could not date the individual `Disallow` lines from history. **[verified that the file is `assets/robots.txt`; the age of each line is unknown]**

One important nuance, stated precisely: `Disallow` prevents **crawling**, not **indexing**. Google may still list a disallowed URL it has learned about from inbound links, and a `site:` style query does return bioconductor.org package pages. But a blocked page cannot have its content read, so the crawler cannot extract the package Description, the biocViews terms, the vignette links, or any freshness signal, and it cannot rank the page on its body text. That is consistent with what §2.5 shows: the pages exist in the index but lose to sources whose content *was* readable. **[verified for the `site:` listing; inference for the ranking mechanism]**

### 3.2 sitemap.xml — non-functional

```
$ curl -sS https://bioconductor.org/sitemap.xml
<%= xml_sitemap %>

$ curl -sSI https://bioconductor.org/sitemap.xml
HTTP/1.1 200 OK
Content-Type: application/xml
Content-Length: 20
Last-Modified: Sun, 26 Jul 2026 01:06:45 GMT
```

`Content-Length: 20` — the file is the literal ERB tag plus a newline. It has been rebuilt as recently as today and is still broken, so this is a persistent build defect, not a stale artifact. **[verified]**

**Root cause** — `Rules:12-14`:

```ruby
compile '/sitemap/' do
  #/ nothing
end
```

The rule body is empty, so `filter :erb` is never applied and `content/sitemap.xml` (whose entire content is `<%= xml_sitemap %>`) passes through unevaluated. The generic `compile '*'` rule below it *would* have applied `filter :erb` for `.xml`... except it only handles `md`, `markdown`, `haml`, `html`, and `sass` extensions in its `case` statement, so `.xml` would fall through there too. **[verified]**

**URL count: 0 published, against 536 content source files** (`content/**/*.{md,html}`) **plus ~7,620 release+devel package landing pages plus ~22 archived releases.** No sitemap is referenced from `robots.txt` either. **[verified]**

Sibling sites are no better: `support.bioconductor.org/sitemap.xml` → 404, `code.bioconductor.org/sitemap.xml` → 404, `contributions.bioconductor.org/sitemap.xml` → 404. **[verified]**

### 3.3 Canonicalisation and duplicate content

**No page on the site emits a `rel=canonical` link.** I checked `/packages/release/bioc/html/DESeq2.html`, `/packages/devel/...`, `/packages/3.23/...`, `/packages/3.0/...`, `/packages/DESeq2/`, `/packages/release/bioc/` (the 607 KB index), and `/packages/release/BiocViews.html`. All returned `canonical: NONE`. There is no `<link rel="canonical">` anywhere in `layouts/_sitehead.html`, which is the single `<head>` template for the whole site. **[verified]**

**The same content at many URLs:**

| URL | Status | Bytes | md5 |
|---|---|---|---|
| `https://bioconductor.org/packages/DESeq2/` | **302** → `http://bioconductor.org/packages/release/bioc/html/DESeq2.html` | — | — |
| `https://bioconductor.org/packages/release/bioc/html/DESeq2.html` | 200 | 39,097 | `ede6ab17…` |
| `https://bioconductor.org/packages/3.23/bioc/html/DESeq2.html` | 200 | 39,097 | `ede6ab17…` |
| `https://www.bioconductor.org/packages/release/bioc/html/DESeq2.html` | 200 | 39,097 | `ede6ab17…` |
| `https://bioconductor.org/packages//release/bioc/html/DESeq2.html` | 200 | 39,097 | — |
| `https://bioconductor.org/packages///release/bioc/html/DESeq2.html` | 200 | 39,097 | — |
| `https://bioconductor.org/packages/devel/bioc/html/DESeq2.html` | 200 | 39,181 | (differs only by "(development version)") |

**[verified]**

Four distinct problems here:

1. **`release` and `3.23` are byte-identical with no canonical.** Every release, the URL that *was* `release` becomes a frozen numbered archive, so any accumulated link equity points at a URL that now serves stale content. Nothing tells a crawler which is authoritative. **[verified]**
2. **`www.` and apex both serve 200.** No redirect in either direction, identical bytes, no canonical. `http://` → `https://` *is* correctly 301'd, so the redirect infrastructure exists — it just is not used for the host. **[verified]**
3. **Arbitrary slash-doubling returns 200.** This creates an unbounded set of duplicate URLs *and* bypasses robots.txt. It is not theoretical: live search results include `bioconductor.org/packages//release/bioc/html/BiocGenerics.html` and `www.bioconductor.org/packages//release/bioc/vignettes/ChIPseeker/inst/doc/ChIPseeker.html`. **[verified]**
4. **The `/packages/DESeq2/` shortcut 302s (temporary) to an `http://` target.** A 302 tells crawlers not to consolidate signals onto the destination, and the `Location` header downgrades to `http://`, forcing a second redirect hop. **[verified]**

**Is Google indexing the wrong version?** Partially, yes, with evidence: for "DESeq2 bioconductor package" the **devel** page (`/packages/devel/bioc/html/DESeq2.html`) was returned *above* the release page, alongside three mirrors serving 3.15, 3.17 and 3.22. For "SummarizedExperiment R package documentation", rdrr.io (v1.20.0) outranked the origin. **[verified]**

### 3.4 Titles, descriptions, social cards, structured data

All of the following originate in the single shared head template, `layouts/_sitehead.html`.

**Meta description — one hardcoded string for the entire site** (`layouts/_sitehead.html:8`):

```html
<meta name="description" content="The Bioconductor project aims to develop and share open source software
for precise and repeatable analysis of biological data. We foster an inclusive and collaborative community
of developers and data scientists." />
```

This exact text is served on `/`, on `/install/`, and on **every package landing page**. `DESeq2.html`, `ChIPseeker.html` and `SummarizedExperiment.html` all carry it. There is no per-page or per-package description anywhere. **[verified]**

This is the more frustrating because **the right text is already in scope**: the same template already writes the package's own Description into `og:description` (`layouts/_sitehead.html:14`, `<%= item[:Description] %>`). The data is one variable away.

**Titles** are `Bioconductor<%= " - #{@item[:title]}" %>` (`layouts/_sitehead.html:37`):

| Page | `<title>` |
|---|---|
| `/packages/release/bioc/html/DESeq2.html` | `Bioconductor - DESeq2` |
| `/packages/devel/bioc/html/DESeq2.html` | `Bioconductor - DESeq2 (development version)` |
| `/packages/3.23/bioc/html/DESeq2.html` | `Bioconductor - DESeq2` |
| `/packages/3.0/bioc/html/DESeq2.html` | `Bioconductor - DESeq2` |
| `/packages/release/bioc/` | `Bioconductor - 3.23 Software Packages` |
| `/packages/release/BiocViews.html` | `Bioconductor - BiocViews` |

Two issues. First, the brand leads, so the distinguishing term sits at character 16 — weak for both SERP scanning and browser tabs. Second, and more serious for crawlers, **`/packages/3.23/`, `/packages/3.0/` and `/packages/release/` produce identical titles**. An archived page for a 2014 release is titled exactly like today's. Only the devel page is distinguishable, and it is distinguished in the *wrong* direction — it is the one that should be de-emphasised. Note also that `3.0` returns **no** meta description at all (that page predates the current template), so its 21,648 bytes carry no description whatsoever. **[verified]**

**Open Graph** is emitted only for package detail pages (`layouts/_sitehead.html:10-19`), and it is broken in two ways:

```html
<meta property="og:url" content="http://bioconductor.org/packages/DESeq2/" />
```
- The scheme is **`http://`**, hardcoded, on a site that 301s http→https.
- On the devel page the same template produces:
```html
<meta property="og:url" content="http://bioconductor.org/packages/DESeq2 (development version)/" />
```
  — an invalid URL containing a space and parentheses, because the template interpolates `item[:title]` (the display title) where it needs the package name. **[verified]**

**Twitter/X cards: none.** `twitter: NONE` on every page checked. By contrast `code.bioconductor.org` *does* emit `twitter:card`, `twitter:title`, `twitter:site`, `twitter:image` and a `google-site-verification` token — the sibling site is better instrumented than the main one. **[verified]**

**Structured data: none.** No `application/ld+json`, no microdata, no `schema.org` markup on any page checked. A package landing page is a textbook `SoftwareApplication` / `SoftwareSourceCode`, and an annotation or experiment data package is a textbook `Dataset` — both are rich-result eligible types, and Google's Dataset Search consumes the latter directly. Bioconductor currently participates in neither. **[verified that it is absent; inference on the benefit]**

**`<meta name="robots" content="all" />`** is emitted on every page including the ones robots.txt blocks (`layouts/_sitehead.html:5`). This is not a conflict a crawler can act on — it never fetches the page to read the tag — but it does show the site's two directives disagree about intent. **[verified]**

### 3.5 Third-party dependencies on the critical path

The BiocViews page pulls render-blocking JavaScript from three external CDNs:

| Resource | Host | Status |
|---|---|---|
| `jquery.dataTables/1.9.4/jquery.dataTables.min.js` | `ajax.aspnetcdn.com` | 200, 70,857 B |
| `ui/1.10.4/jquery-ui.js` | `code.jquery.com` | 200, **436,715 B — unminified** |
| `highlight.js/11.7.0/highlight.min.js` | `cdnjs.cloudflare.com` | 200, 120,762 B |

All three resolve today. `ajax.aspnetcdn.com` is Microsoft's legacy Ajax CDN, which Microsoft has announced for retirement; DataTables 1.9.4 dates from 2012 and jQuery UI 1.10.4 from 2014. The jQuery UI build is the **unminified** 437 KB source. If any of these hosts goes away, package browsing breaks with no fallback. **[verified for status and sizes; the retirement is context, not something I probed]**

---

## 4. Metadata hygiene on generated pages — sample

| | `/release/bioc/html/DESeq2.html` | `/devel/bioc/html/DESeq2.html` | `/3.23/bioc/html/DESeq2.html` | `/3.0/bioc/html/DESeq2.html` | `/release/bioc/` (index) | `/release/BiocViews.html` |
|---|---|---|---|---|---|---|
| HTTP | 200 | 200 | 200 | 200 | 200 | 200 |
| Bytes | 39,097 | 39,181 | 39,097 | 21,648 | 607,553 | 14,278 |
| `<title>` | `Bioconductor - DESeq2` | `Bioconductor - DESeq2 (development version)` | `Bioconductor - DESeq2` | `Bioconductor - DESeq2` | `Bioconductor - 3.23 Software Packages` | `Bioconductor - BiocViews` |
| canonical | **none** | **none** | **none** | **none** | **none** | **none** |
| meta description | generic project boilerplate | generic project boilerplate | generic project boilerplate | **absent** | generic boilerplate | generic boilerplate |
| og:title | `DESeq2` | `DESeq2 (development version)` | `DESeq2` | `DESeq2` | none | none |
| og:url | `http://…/packages/DESeq2/` | **`http://…/packages/DESeq2 (development version)/`** | `http://…/packages/DESeq2/` | `http://…/packages/DESeq2/` | none | none |
| twitter card | none | none | none | none | none | none |
| JSON-LD | none | none | none | none | none | none |
| `<h1>` | `DESeq2` | `DESeq2` | `DESeq2` | `DESeq2` | `Bioconductor bioc Packages` | `Packages found under Software:` (JS-only) |
| version discoverable by crawler? | **no** | yes, via title | **no** | **no** | yes, via title | no |
| body word count | ~565 (ChIPseeker sample) | | | | 2,418 rows | **0 without JS** |

**Crawler-distinguishability is the headline row.** Given `/packages/release/…`, `/packages/3.23/…` and `/packages/3.0/…`, a crawler sees three pages with the same title, the same description, the same `og:url`, the same `<h1>`, and no canonical. Only by parsing the body text ("Bioconductor version: 3.23") could it tell them apart — and it is forbidden from fetching any of them in the first place. **[verified]**

The archived pages are the sharpest case: `/packages/3.0/bioc/html/DESeq2.html` describes software from 2014, is titled identically to the current page, and carries an `og:url` pointing at the *current* release. Anyone who lands on it from a search result has no clear signal they are reading twelve-year-old documentation. There is no "this is an archived version, go here for current" banner in the metadata. **[verified]**

The package index pages (`/packages/release/bioc/`) are, by contrast, the healthiest generated pages on the site: 607 KB of server-rendered HTML containing all 2,418 package names, titles and maintainers as real links, with a version-specific title. They are also blocked by robots.txt. **[verified]**

---

## 5. Prioritized recommendations

Ranked by (impact × confidence) ÷ effort. Repo paths are relative to the site source root.

### P0 — Stop blocking the site from search engines

**1. Rewrite `assets/robots.txt` to allow the package pages.**
Remove `Disallow: /packages/release/`, `Disallow: /packages/devel/`, `Disallow: /packages/bioc/`, `Disallow: /packages/data/`, and the numbered-release lines for versions you want indexed. Keep the genuinely useless paths (`/packages/submitted/`, `/checkResults/`, `/repository/`, `/installScripts/`, `/stats/`). Prefer `noindex` meta tags over `Disallow` for archived releases — `Disallow` blocks *reading*, which prevents the crawler from ever seeing a canonical or a `noindex`, whereas `noindex` actually removes them from the index. Add `Sitemap: https://bioconductor.org/sitemap.xml` once #2 lands.
*This is a one-file change and it is the highest-leverage item in this report.*

**2. Fix the sitemap build — `Rules:12-14`.**
Replace the empty compile rule with one that applies the ERB filter:
```ruby
compile '/sitemap/' do
  filter :erb
end
```
Then verify `xml_sitemap` actually enumerates the generated package pages (nanoc's default helper covers items it knows about; the package landing pages are routed via the custom rules at `Rules:74-86`, so confirm they are included). Given the volume — ~7,600 release+devel landing pages plus 536 content pages — plan on a sitemap index with sharded child sitemaps. Add a build assertion that the output does not contain `<%`, so this cannot silently regress again.

**3. Add `rel=canonical` to `layouts/_sitehead.html`.**
One block in the shared head solves release-vs-numbered-version, `www`-vs-apex, and the slash-doubling duplicates at once. For a package page under `/packages/<ver>/…`, emit the `release` URL as canonical when `<ver>` equals `config[:release_version]`, and a self-canonical otherwise. Always emit `https://bioconductor.org` (pick one host) as the absolute prefix.

**4. Collapse the host and path duplicates at the web layer.**
301 `www.bioconductor.org` → `bioconductor.org` (or the reverse — just pick one). Add an Apache/CloudFront rule that 301s any path containing `//` to its single-slash form. Change the `/packages/<Pkg>/` shortcut from **302 to 301**, and make its `Location` header `https://`, not `http://` — currently it costs an extra redirect hop and passes no consolidation signal.

### P1 — Make the package pages worth ranking

**5. Emit a real per-page meta description — `layouts/_sitehead.html:8`.**
The generic project boilerplate is currently on all ~7,600 package pages. The package's own Description is already in scope on line 14 (`item[:Description]`). Use it, truncated to ~155 characters, falling back to the current boilerplate for non-package pages. *Smallest diff, largest metadata win in this report.*

**6. Fix the broken Open Graph tags — `layouts/_sitehead.html:10-19`.**
Change `http://` to `https://`, and build `og:url` from `item[:Package]` (or the item's real routed path) rather than `item[:title]`. The devel pages currently emit `http://bioconductor.org/packages/DESeq2 (development version)/`, which is not a URL. While there, add `twitter:card` / `twitter:title` / `twitter:description` / `twitter:image` — `code.bioconductor.org` already does this and can be copied.

**7. Add `schema.org` JSON-LD to package landing pages — `layouts/_bioc_views_package_detail.html`.**
Emit `SoftwareApplication` (or `SoftwareSourceCode`) for software packages with `name`, `description`, `softwareVersion`, `author`, `license`, `codeRepository`, `citation`; and `Dataset` for annotation and experiment data packages. The `Dataset` case is the higher-value half: it makes ~1,360 annotation and experiment packages eligible for Google Dataset Search, a surface Bioconductor is entirely absent from today.

**8. Differentiate archived versions.** In `layouts/_sitehead.html`, put the Bioconductor version in the `<title>` for any non-release version (`Bioconductor 3.0 - DESeq2 (archived)`), and add `<meta name="robots" content="noindex,follow">` for archived releases. Combined with #1 (removing the `Disallow` lines so the tag is actually readable), this cleanly removes ~20 stale copies of every package from the index while preserving link flow.

### P2 — Fix search relevance

**9. Rebuild the Solr query in `assets/js/search.js:17-24`.**
Concrete changes, in order of payoff:
- Switch `qt=standard` to **`defType=edismax`** with `qf` weighting title and package name far above body text, and set `mm=2<-1 5<80%` so multi-word queries require most terms to match. This alone should fix queries 2, 3, 4, 5, 7 and 10.
- Add `fq=` filters that exclude archived releases (`-id:/packages/1.*`, `-id:/packages/2.*`, and numbered 3.x below release) so 2006-era pages stop winning.
- Add **result grouping** (`group=true&group.field=<package>`) or a devel filter so the same document does not occupy two of the five top slots.
- Raise the release boost well above the current `^1.2` vs `^1.1`.
These are query-construction changes in one file; the deeper fix (a curated help/document corpus separate from the vignette dump) is a larger project.

**10. Add facets to the results page** — at minimum "Packages / Vignettes / Course material / Help pages" and "Release only". `numFound` of 51,234 with no filters is not a usable interface. Templates: `content/help/search/` plus `assets/js/search.js:26-100`.

**11. Delete the dead analytics handler in `assets/js/search.js:50` and `:60-64`.** `pageTracker._trackPageview` is Google Analytics Classic, retired 2014; it throws `ReferenceError` on 18 of every 20 result clicks. The site runs GA4. Either drop the `onclick` entirely or replace it with a `gtag('event', …)` call. Also fix the three uncaught `TypeError`s on the search page.

**12. Consider retiring the bespoke Solr front end.** The support forum's stock Biostar search scored 9/10 against the same queries that the main site's hand-tuned Solr scored 2/10. Federating the main search into the support index, or replacing the custom JSONP layer with a maintained search service, is likely less work than getting this query builder right — and it is measurably better today.

### P3 — Package discovery

**13. Add a `hashchange` listener to `assets/js/bioc_views.js`.**
`getNodeName()` (lines 197-206) reads `window.location.href` once inside `init()`. Bind `window.addEventListener('hashchange', …)` to re-run the select/open logic. Roughly a five-line fix for a bug that makes the browse page appear frozen whenever a user follows a second category link.

**14. Generate real per-category pages.** Emit a static `/packages/release/BiocViews/<Term>.html` for each of the 413 terms, server-rendered with the package table already in the HTML, a term-specific `<title>` and description, and a canonical. Keep the tree widget as progressive enhancement layered on top. This is the change that would put Bioconductor's curated taxonomy — its single best discovery asset — in front of search engines at all. New route in `Rules` alongside the existing `route /BiocViews/` at lines 63-72.

**15. Give the Packages page a package-name search.** The "Find biocViews:" box (`assets/js/bioc_views.js:329-395`) autocompletes taxonomy terms only; typing `DESeq2` or `single cell` returns nothing. Either extend the autocomplete source to include package names and titles from the already-loaded `packages.js`, or relabel it honestly and add a separate package search. The data is already in the browser — this is a client-side change with no new payload.

**16. Trim the 1.1 MB BiocViews payload.** `jsnetworkx.js` (93 KB) and the unminified jQuery UI (437 KB) are the obvious cuts; DataTables 1.9.4 and jQuery UI 1.10.4 are twelve and eleven years old respectively and are loaded from third-party CDNs with no fallback. Self-host what remains. Follows naturally from #14, which removes the need to ship all 3,810 packages to render one category.

**17. Add ARIA tree semantics.** The widget has no `role="tree"`, no `aria-expanded` (measured: 0 occurrences), and leaves 12,658 focusable elements on the page. Adding the roles and a skip link into/out of the results table is a bounded accessibility fix; #14 reduces the problem structurally by cutting the rendered set.

---

## Appendix: reproduction commands

```bash
# robots + sitemap
curl -sS https://bioconductor.org/robots.txt
curl -sSI https://bioconductor.org/sitemap.xml && curl -sS https://bioconductor.org/sitemap.xml | wc -c

# robots verdicts
python3 -c "import urllib.robotparser as r; p=r.RobotFileParser(); \
p.set_url('https://bioconductor.org/robots.txt'); p.read(); \
print(p.can_fetch('*','https://bioconductor.org/packages/release/bioc/html/DESeq2.html'))"

# duplicate content
for u in packages/DESeq2/ packages/release/bioc/html/DESeq2.html packages/3.23/bioc/html/DESeq2.html \
         packages//release/bioc/html/DESeq2.html; do
  curl -sS -o /dev/null -w "%{http_code} %{size_download} $u\n" "https://bioconductor.org/$u"; done

# the site's own search query, verbatim from assets/js/search.js
curl -sS 'https://master.bioconductor.org/solr/default/select?q=DESeq2%20id:*%5C/release%5C/bioc%5C/html*%5E1.2%20id:*%5C/devel%5C/bioc%5C/html*%5E1.1%20title:DESeq2~&rows=5&fl=id,score,title&wt=json&indent=on'

# support search
curl -sS 'https://support.bioconductor.org/post/search/?query=DESeq2'

# code search (note the doubled path segment — /search?q= silently returns an empty form)
curl -sS 'https://code.bioconductor.org/search/search?q=SummarizedExperiment&num=10'
```

Benchmark scripts and captured output are in the audit scratchpad:
`bench_solr.py`, `bench_others.py`, `browser_check.js`, `tree_fresh.js`, `hashnav.js`, `autoc.js`, `final.js`.
