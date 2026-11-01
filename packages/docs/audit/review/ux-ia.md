# Bioconductor.org — UX & Information Architecture Audit

**Date of audit:** 2026-07-25 / 2026-07-26 UTC
**Site state:** Bioconductor 3.23 (release), 3.24 (devel), 2418 software packages
**Method:** live site driven through Chrome DevTools Protocol (headless Chrome 149) at 1440×900 and 390×844; `curl` for status codes and redirects; source cross-checked against a shallow clone of the site repo.

> **Verification convention used throughout.** "Observed" = I loaded the URL and read the DOM/rendered output. "Inferred" = reasoning from observed evidence. Repo paths refer to the local clone of the site source.

---

## Executive summary — the five things that matter most

**1. The top-nav "Packages" link lands on a list that presents the 25 *least*-used packages as the most popular.**
`https://bioconductor.org/packages/release/BiocViews.html#___Software` renders a 2,418-row table captioned *"Rank based on number of downloads: lower numbers are more frequently downloaded."* Observed rank values: `BiocAzul` = 1, `RFGeneRank` = 2, `BatChef` = 3 — versus `edgeR` = 2393, `DESeq2` = 2397, `limma` = 2401. The three most-downloaded packages in the project sit at the bottom of a list sorted ascending by a column whose caption says lower = more downloaded. The first screen a new user sees after clicking the single most important nav item is `BiocAzul`, `queeems`, `wavFeatExt`, `jvecfor`. Either the caption or the sort is inverted; either way the site's primary discovery surface is actively misleading. **(Observed — see §2b.)**

**2. Mobile users have no site search and no "Get Started" button.** `assets/style/sections/header.css:181` sets the open mobile drawer to a hard-coded `height: 21rem` with `overflow: hidden` (`:174`). At 390px the six nav links fill it exactly: the last link "Donate" ends at y=463, the drawer clips at y=472, the search box renders at y=479–504 and the "Get Started" button at y=520–568 — both entirely below the clip and invisible. They are in the DOM and unreachable. **(Observed, measured via `getBoundingClientRect`.)**

**3. The `Courses` link on the homepage is a 403, and so is the entire 16-year course archive.** `https://bioconductor.org/help/course-materials/` returns `HTTP/1.1 403 Forbidden` (Apache, 11,922-byte body). So do `/help/course-materials/2018/` and `/help/course-materials/2013/BioC2013/`. The content exists in the repo (`content/help/course-materials.html`, plus `content/help/course-materials/2002…2018/`) — this is a build/deploy failure, not missing content. The dead link is reached from the homepage Learn grid ("Courses"), `/help/` ("Courses and Conference Materials"), `/help/support/` ("courses") and `/help/events/` ("Course material"). The 403 page shows a raw Apache string: *"There is either no index document or the directory is read-protected… please contact the webmaster"* — with no webmaster link and no recovery path. **(Observed, 4 URLs.)**

**4. One page, five names — the Learn/Help/Support/Get-Started label system has no spine.** `/help/` has nav label **Learn**, `<title>` **Bioconductor - Help**, breadcrumb **Help**, `<h1>` **Learn**. `/help/support/` is labelled **Get Help** (footer, homepage, /help/), **Support Forums** (homepage, /help/), **Support Site** (breadcrumb), and carries `<h1>` **💬 Support and Community Forum** over `<h2>` **Get Help or Connect with the Community**. `/install/` is **Get Started** (header button), **Get started** (footer heading + `<h1>`), **Install** (breadcrumb + `<title>`). Meanwhile "workflows" resolves to three different URLs from three different menus. **(Observed — see §1.2.)**

**5. Four of seven sibling properties have zero links back to bioconductor.org.** Checked every `<a>` on each landing page: `support.bioconductor.org` links only to itself and github.com; `blog.`, `code.` and `anvil.` likewise link nowhere on the parent domain. `support.` is also where every "get help" path terminates — and posting requires an account (`/accounts/signup/`). The user's help journey ends on a login wall on a property with no route home. Each sibling runs a different framework (Biostar, Quarto, bookdown, pkgdown, Carpentries-Jekyll) with a different visual system. **(Observed — see §3.)**

---

## 1. Information architecture

### 1.1 The actual tree

**Top navigation** (`layouts/components/header.html:17-22`), flat, no dropdowns:

| Label | Destination |
|---|---|
| About | `/about/` |
| Learn | `/help/` |
| Packages | `/packages/release/BiocViews.html#___Software` |
| Developers | `/developers/` |
| Funding | `/about/funding/` |
| Donate | `/about/funding/#donate` |
| *(search box)* | `/help/search/index.html` |
| Get Started *(button)* | `/install/` |

**Two of six nav slots point at the same page.** Funding and Donate differ only by fragment. Fundraising occupies a third of the primary navigation; *support*, the highest-frequency user need on any software project site, occupies none.

**Footer** (`layouts/components/footer.html`) uses a *different* four-column taxonomy: About / Developers / **Learn** / **Get started**. `Packages`, `Funding` and `Donate` vanish; `Get started` appears. So the site has two competing top-level models and neither contains the other.

**Content tree depth** (from `content/`): `.md`/`.html` files sit at depths 1 through 9. The deepest branches are `content/help/course-materials/<year>/<event>/<file>` (currently all 403) and `content/help/publications/…`. `content/news/` holds 33 release-announcement pages, one per release back to Bioc 2.5 (2009).

### 1.2 Label collisions — verified list

| Concept | Labels in use | URLs in use |
|---|---|---|
| Learning hub | Learn (nav, footer, `<h1>`), Help (`<title>`, breadcrumb) | `/help/`, `/help/index.html` |
| Getting help | Get Help, Support Forums, Support Site, "Support and Community Forum", "Get Help or Connect with the Community" | `/help/support/`, `support.bioconductor.org` |
| Installing | Get Started, Get started, Install | `/install/`, `/install/index.html` |
| Workflows | "Common Workflows" (homepage, `/help/`), "Workflows" (footer), "Workflow packages" (`/help/`) | `BiocViews.html#___Workflow`, `/packages/release/workflows/`, `/help/workflows/` |
| Community blog | Community Blog | `blog.bioconductor.org` (footer icon, `/help/support/`), `bioconductor.github.io/biocblog` (homepage "Connect", `/help/`) — the latter 301s to the former |
| AnVIL | AnVIL | `anvil.bioconductor.org` (homepage card, footer, `/install/`), `anvilproject.org` (homepage About prose) |
| Package submission | Package Submission, New Package Submission, "Guidelines for Package Development, Submission, and Peer Review" | `contributions.bioconductor.org/submission-overview.html`, `…/bioconductor-package-submissions.html` (from the orphan stub), `contributions.bioconductor.org/` |
| Bioc↔R version map | "Release Announcements" (footer, `/about/` sidebar), "Bioconductor releases and R versions" (`/help/`, `/developers/`) | `/about/release-announcements/` |

`/help/workflows/` deserves a callout: its **entire body content** is one sentence — *"Workflows vignettes are now available as packages. View all current workflows."* It is a live, indexed, breadcrumbed, fully chromed page that exists only to point elsewhere. Same pattern at `/developers/package-submission/`, whose source (`content/developers/package-submission.md`) is three lines: `This page has moved to http://contributions.bioconductor.org/bioconductor-package-submissions.html` — over plaintext HTTP, and to a filename nothing else on the site uses.

### 1.3 Same content, three paths — or none

Reachable three-plus ways: **Get Started/install** (9 links on the homepage alone, 5 of them labelled exactly "Get started"/"Get Started"); **Bioconductor Books** (homepage card, homepage Learn grid, `/help/`, footer); **Support** (homepage purple bar, homepage Learn grid, homepage Connect card, `/help/` ×2, footer, every package landing page).

Reachable essentially **no** way from where it's needed:
- **The FAQ** (`/help/faq/`) is the best task-shaped page on the site — its headings are literally *"ERROR: No Package Called"*, *"BiocManager::install() warns that a package is not available"*, *"How To Cite Bioconductor"*, *"Where to Ask Help"*. It is **not linked from `/install/`** (where install errors happen) and **not linked from `/help/support/`** (where people go when stuck). Verified by dumping every `<a>` on both pages. It is item #10 of 10 in the homepage Learn grid.
- **Package submission.** `/developers/` — the destination of the top-nav "Developers" link — contains **no link to the submission process**. Verified: `document.querySelector('main').innerHTML.includes('submission-overview')` → `false`. The homepage's "For Developers" tab and the footer both have it; the developers landing page does not.
- **The Bioc↔R compatibility table** lives at `/about/release-announcements/` under **About**, named after news announcements. `/install/` never links to it.

### 1.4 Orientation: breadcrumbs and sidebar

Breadcrumbs are present and correct on `/help/`, `/install/`, `/about/`, `/developers/` and package pages (`Home > Bioconductor 3.23 > Software Packages > DESeq2`). They are **absent** on `/checkResults/` and its subtree.

The sidebar (`layouts/components/subnav.html:91`) sorts children with `@pages.sort{|a, b| a[:title] <=> b[:title]}` — plain alphabetical. The consequence is visible on `/about/`: the sidebar opens with *"Advisory Board -- Community"*, *"Advisory Board -- Scientific"*, *"Advisory Board -- Technical"* — three governance pages at the top of the About menu, above "Annual Reports" and far above "Core Team". The titles have evidently been reworded (`Advisory Board -- X` rather than `X Advisory Board`) to force them to cluster, which is a sort-order workaround leaking into user-facing labels. Those sidebar labels also disagree with the footer ("Code of Conduct Policy" vs "Code of Conduct"; "Logos" vs `/about/logo`).

The sidebar is also **stale on at least one page**: `/developers/release-schedule/` renders a sidebar headed *"Source Code & Build Reports: … All / Release / Development / Package Download Statistics / Browsable code base / Development Version …"* — a build-system module with nothing to do with the release calendar. In DOM order it precedes the breadcrumbs and the `<h1>`, so screen-reader and mobile users hit it first.

### 1.5 The release/devel axis

Four addressing schemes coexist for one package:

```
/packages/release/bioc/html/DESeq2.html     ← canonical
/packages/devel/bioc/html/DESeq2.html
/packages/3.23/bioc/html/DESeq2.html        ← breadcrumb uses this
/packages/DESeq2/                           ← short URL, 302s to release
```

On the DESeq2 page the switcher reads: *"This is the released version of DESeq2; for the devel version, see **DESeq2**."* The link text is the package name again — there is nothing in the link to tell you where it goes. On BiocViews the switcher is a bare *"Go to 3.24 (Devel)"* with no explanation of what devel is; the word "devel" appears unglossed on `/developers/`, `/help/`, `/install/`, and `/packages/`.

The cost of this axis is most visible in site search (§2b): **every result appears twice**, once for `/release/` and once for `/devel/`, so half the 23,625 results for "single cell integration" are duplicates the user has to visually deduplicate without knowing what the difference is.

---

## 2. Task-based journey walkthroughs

*Each is a transcript of what I actually did. Click counts are from the homepage unless stated.*

### (a) New R user: "I have RNA-seq counts, what do I install and how do I start?"

1. **bioconductor.org.** Hero: *"Open source software for Bioinformatics"* + two sentences of mission statement + **Get started**. Nothing on the page says what Bioconductor *is* in operational terms (R packages) or names a single assay type. I searched the full rendered homepage text for "RNA" — **zero occurrences**. Same for `/install/`.
2. **Click "Get started" → `/install/`.** Good news: the hero answers a question I did not yet know I had — *"The current release of Bioconductor is version 3.23; it works with R version 4.6.0."* Then "1. Install R", "2. Get the latest version of Bioconductor" with the `BiocManager::install(version = "3.23")` snippet. That is a genuinely well-built top-of-page.
3. **Scroll.** Immediately below step 2, the section "Install Bioconductor Packages" repeats **the identical BiocManager bootstrap snippet** already shown 200px above. Then, verbatim:
   > To install core packages, type the following in an R command window:
   > `if (!require("BiocManager"…)) …; BiocManager::install(version = "3.23")`
   > **To install core packages**, type the following in an R command window:
   > `BiocManager::install(c("GenomicFeatures", "AnnotationDbi"))`

   Two consecutive blocks with the **same lead-in sentence** and different code. The second must mean "specific packages". Also on this page: heading **"Updgrading** Installed Bioconductor Packages"; body text "R **pacakges**".
4. **Keep scrolling** — the page runs to 9,098px at 390px width. The bottom half is a "Why use BiocManager::install()?" essay whose worked examples are pinned to **Bioconductor 3.9 / 3.10 and R 3.6.0 Patched (2019-05-02)**, and which states *"the Bioconductor 3.0 release is available for R.3.1.x"*. Current release is 3.23. A new user reads console transcripts seven years out of date immediately after being told the current version is 3.23.
5. **Dead end.** `/install/` never mentions RNA-seq, differential expression, DESeq2, edgeR, or limma. There is no link to the FAQ, no link to a worked example, no "what next".
6. **Back out and hunt.** The only viable route is homepage Learn grid → **"Common Workflows"** → `BiocViews.html#___Workflow` → a 28-row unordered table. Scanning it: row 26 is `rnaseqGene — RNA-seq workflow: gene-level exploratory analysis and differential expression`. That is the right answer. Getting to it took **3 clicks plus visual scan of a 28-row table**, and nothing distinguished it from `RnaSeqGeneEdgeRQL`, `RNAseq123`, `maEndToEnd`, `BP4RNAseq` or `recountWorkflow` — five other RNA-seq workflows in the same table with no guidance on which to pick. Row 4 of that same table is `SingscoreAMLMutations — **ERROR**`: a package whose public Title field is the literal string "ERROR" (confirmed on its landing page too).

**Verdict: fails.** A new user can install Bioconductor in two clicks and cannot find out what to do next without already knowing a package name.

### (b) Find a package by capability: "single-cell integration"

1. **Click "Packages" in the top nav.** Lands on `BiocViews.html#___Software`, `<h1>` *"Packages found under Software:"*, table of **2,418 rows all injected into the DOM at once** (`Showing 1 to 2,418 of 2,418 entries`).
2. The caption reads *"Rank based on number of downloads: lower numbers are more frequently downloaded."* Top of the list: `BiocAzul` (1), `RFGeneRank` (2), `BatChef` (3), `LRDE` (3), `toppgene` (3), `queeems` (6), `ClonalSim` (7), `immLynx` (7), `wavFeatExt` (9)… I looked up the packages I would expect at the top: **`edgeR` = 2393, `DESeq2` = 2397, `limma` = 2401** out of 2418. The list is inverted relative to its own caption. A first-time visitor's first impression of the Bioconductor package ecosystem is a screen of packages nobody uses.
3. **Try the "Find biocViews:" box.** It is an unlabelled `<input id="autocompleter">` with **no placeholder text and no example**. Typed `single cell` → **zero suggestions**. Typed `Integration` → **zero suggestions**. Typed `SingleCell` → three suggestions (`SingleCell`, `SingleCellData`, `SingleCellWorkflow`). The field only matches the closed CamelCase controlled vocabulary; it tolerates neither spaces nor synonyms, and nothing on the page says so or explains what "biocViews" is.
4. **Fall back to site search.** `/help/search/index.html?search-bar=single+cell+integration` → *"Your search for single cell integration returned **23625 results**."* 23 results per page (≈1,027 pages), navigation is a lone `Next >` — no page numbers, no jump, no result-type filter, no facets.
5. The results themselves: every single one is duplicated for `/release/` and `/devel/`. Result 1–2 are the same GRaNIE vignette twice. Results 3–4 are `scpdata … /packages/devel/data/experiment/manuals/scpdata/man/scpdata.pdf` and the release twin — i.e. **the top hits are PDFs of Rd manual pages**. Result 15–16 (`corralm`, "Alignment & batch integration of single cell data") is the first genuinely on-target hit. **Not one result on page 1 is a package landing page.** The URLs are shown as raw file paths.

**Verdict: fails.** Neither the controlled vocabulary nor the full-text search can answer a capability question phrased the way a biologist phrases it.

### (c) A specific package's docs, vignette, version compatibility, and citation

Tested on `/packages/release/bioc/html/DESeq2.html`. **This journey succeeds, and the landing page is the best-designed artefact on the site.** Breadcrumb `Home > Bioconductor 3.23 > Software Packages > DESeq2`; a DOI; the `citation("DESeq2")` output rendered as the formatted Genome Biology reference with a resolvable `doi:` link; a version-correct install snippet ("start R (version 4.6)"); the vignette in HTML + R script + PDF reference manual + NEWS; `Version 1.52.0`; `In Bioconductor since BioC 2.12 (R-3.0) (13.5 years)`; full dependency graph with links; source and binary archives for Windows and both macOS arches; a link to the build report.

Three defects:
- **"Download Stats" is a 404 on every package page.** The link is `http://bioconductor.org/packages/stats/bioc/DESeq2/`; that URL and every variant I tried (`…/DESeq2`, `…/DESeq2_stats.tab`) return **404**.
- Every CRAN dependency links to **`http://cran.rstudio.com/…`** — plaintext HTTP, and an RStudio mirror rather than `cran.r-project.org`. Dozens of instances per page.
- The "See More" `<details>` conceals ~200 reverse-dependency links. Reasonable, but it means the page ships ~250 anchors.

The only real problem is **finding** this page: nothing in journeys (a) or (b) leads to it.

### (d) Get help with an error

1. **Homepage.** The support entry point is a purple bar reading *"Need some help? Ask our community on the Bioconductor Support site!"*, placed below the For Users card. There is no "Support" or "Help" in the top nav.
2. **Click it →** straight to `support.bioconductor.org`, off-domain, in one hop. Bioconductor's own guidance page (`/help/support/`) is skipped entirely.
3. If instead you take the nav route: **Learn → `/help/` → "Get Help" → `/help/support/`**. (Note "Get Help" and "Support Forums" on `/help/` are two labels pointing at the same URL.)
4. `/help/support/` is ~900 words of continuous prose. To reach the actionable instruction you read past a Code-of-Conduct paragraph and into paragraph 3: *"For almost all questions about Bioconductor software please use the Bioconductor Support Site."* Typos in this passage: *"a great way to search **fo** answers"*, *"share **you** knowledge"*, later *"git.**biconductor**.org"* and *"**instrucions**"*. The page then continues into bioc-devel, Developers' Forum, New Developer Program, Help Wanted, Zulip, Mastodon, YouTube, GitHub Issues, vignettes and the blog — a single page carrying both the "I have an error" audience and the "I want to join the project" audience.
5. **The FAQ is not linked from this page.** `/help/faq/` has a section literally titled *"ERROR: No Package Called"* and another titled *"Where to Ask Help"*. Neither `/help/support/` nor `/install/` links to it.
6. **Arrive at `support.bioconductor.org`.** Different framework (Biostar), different look, and — checked exhaustively — the only external host it links to is `github.com`. **No link back to bioconductor.org anywhere on the page.** To post you need an account: `Log In` / `Sign Up` → `/accounts/signup/`.

**Verdict: partially fails.** The destination is correct and one click away, but the journey drops the user on a login-walled property with no way back, and the one page that actually answers common errors is unreachable from anywhere in the flow.

### (e) First-time package contributor

1. **Homepage → "Developers" in the top nav → `/developers/`.** The intro paragraph is right on point ("Bioconductor is an open development project… Packages contributed must meet Bioconductor guidelines and undergo a peer review process"), and correctly warns that development targets the devel branch.
2. **Then the link list — and there is no "Submit a package" link in it.** The list is: Bioconductor 'Devel' Packages / Guidelines for Package Development and Maintenance / Use Bioconductor 'Devel' Version / Git Source Control / Git FAQ / Git Credentials App / Troubleshooting Build Report / Dashboard / Help Wanted / Release Schedule / Bioconductor releases and R versions / Build Reports / RSS Feeds / Browsable Code Base / Package Download Statistics. Verified programmatically: the string `submission-overview` does not occur in `<main>`. The nearest thing is "Guidelines for Package Development and Maintenance" → `contributions.bioconductor.org/` (the book root).
3. Also on this page: `<a class="format-underline">Source code is stored in Git.</a>` — **an anchor with no `href` attribute at all**. It is styled as a link, underlined, and does nothing. Typos: *"new features of **exisiting** packages"*, *"newly **submited** packages"*, and *"**BiocCodingCollabortions**"* (the homepage spells the same thing "BiocCodingCollaborations").
4. **The submission link does exist elsewhere** — homepage "For Developers" tab, and footer "Package Submission" — both → `contributions.bioconductor.org/submission-overview.html`. So the contributor's success depends on not clicking the nav item named after them.
5. **Cross onto `contributions.bioconductor.org`.** Bookdown. Own TOC replaces the Bioconductor nav; no Bioconductor logo image; three text links back to bioconductor.org exist, so this is the *best*-connected sibling.
6. **"Git Credentials App"** → `git.bioconductor.org/BiocCredentials/` → **302 to `/BiocCredentials/login/?next=…`**. A login wall. The contributor has no account yet and nothing on `/developers/` warns them.
7. `/developers/package-submission/` is still live and serves a "This page has moved" stub — an orphan that will keep collecting inbound links and search traffic.

**Verdict: fails at step 2.** The single action the page's own opening paragraph describes has no link on the page.

### (f) Which Bioconductor version works with which R version, and how to upgrade

**Partly succeeds, entirely by accident of the `/install/` hero.** The hero states plainly: *"The current release of Bioconductor is version 3.23; it works with R version 4.6.0"* and *"The development version of Bioconductor is version 3.24; it works with R version 4.6.0."* That answers the common case in one click.

The historical mapping — what a user upgrading from an old install actually needs — is at **`/about/release-announcements/`**, `<h1>` *"Bioconductor releases"*, a clean 40-row table (Release / Date / Software packages / R): 3.23 / April 29 2026 / 2418 / 4.6, back to Bioc 1.0. It is:
- filed under **About**;
- named **"Release Announcements"** in the footer and the About sidebar, which reads as news, not compatibility;
- named **"Bioconductor releases and R versions"** on `/help/` and `/developers/` (accurate, but those are two different labels for one URL);
- **not linked from `/install/` at all**, where the question is asked.

Upgrading: `/install/` has an "Updgrading Installed Bioconductor Packages" section [sic] whose advice — run `BiocManager::install()` — is correct but sits under a misspelled heading between five other similar-looking sections ("Update Installed…", "Updgrading Installed…", "Recompiling Installed…", "Troubleshoot Package Installations", "Troubleshoot BiocManager"). Distinguishing *Update* from *Updgrade* from *Recompile* from three headings alone is not possible.

### (g) Date of the next release, and the next conference

**Conference: succeeds.** `/help/events/` splits Upcoming from Previous correctly and puts **BioC2026, 10–12 August 2026, Seattle WA** first. Two clicks (Learn → Upcoming and Past Events), or one from the homepage "See all events".

**Release: fails.** Footer → "Release Schedule" → `/developers/release-schedule/`. The page's `<h1>` is **"Bioconductor 3.23 Release Schedule"** and its body says *"The release date for Bioc 3.23 is schedule for Wednesday April 29"* [sic]. **3.23 was released on April 29, 2026** — per the table on `/about/release-announcements/`. Today is 2026-07-25. The page linked as "Release Schedule" from the footer and from `/developers/` describes a release that happened three months ago; the *next* release (3.24, due ~October 2026) has no date anywhere I could find.

Worse: **the page contains no year at all.** I extracted every `20\d\d` match from `<main>` — the result is an empty array. Every deadline is "Friday March 20", "Wednesday April 22", "Wednesday April 29". A reader has no way to tell from the page whether it is describing the past or the future. (Also on this page: *"initial review of the **pacakge**"*.)

**Homepage events strip is a third source and disagrees with both.** It renders, in order: BiocAsia2026 (Nov 2026) · BioC2026 (Aug 2026) · **EuroBioC2026 (June 2026 — past)** · **Seminar Series (Dec 2025 — past)** · **EuroBioC2025 (Sep 2025 — past)**. Three of five cards are past events, and the ordering is reverse-chronological, so the event happening in 16 days is card #2 while card #1 is four months out. `/help/events/` filters past events correctly; the homepage carousel does not.

---

## 3. Cross-property handoffs

Every sibling property's landing page, audited by enumerating all `<a>` hosts:

| Property | Platform | Bioconductor nav? | Links back to bioconductor.org | Bioc logo | Login needed |
|---|---|---|---|---|---|
| `contributions.` | bookdown | no — book TOC | **3** | no | no |
| `workinggroups.` | bookdown | no — book TOC | **1** | no | no |
| `training.` | Carpentries/Jekyll | no — "Carpentries", "Physalia" | **1** (logo only) | yes | no |
| `support.` | Biostar | none | **0** | yes | **yes, to post** |
| `blog.` | Quarto | own | **0** | yes | no |
| `code.` | custom | "About" only | **0** | yes | no |
| `anvil.` | pkgdown | own pkgdown nav | **0** | no | no |
| `git.…/BiocCredentials/` | Django | none | — | — | **yes, immediately** |
| `chat.` | — | 302 → `community-bioc.zulipchat.com/join/…` | — | — | **yes** |
| `/checkResults/` *(same domain!)* | static gen | **none — no header, no footer, no breadcrumbs** | via relative links only | no | no |

Three observations that matter:

1. **`/checkResults/` is on `bioconductor.org` itself yet has no site chrome.** `document.querySelector('#site-masthead')` → `null`; `document.querySelector('footer')` → `null`. It is linked from the footer ("Build Reports"), `/developers/`, `/help/` and every package landing page. A user following "Build Reports" leaves the site's navigation without leaving its domain.

2. **The support site is the terminus of every help journey and the most isolated property.** Zero links home, and the primary action requires signup.

3. **Seven frameworks, seven visual languages.** contributions/workinggroups are bookdown (identical to each other, unlike everything else), training is Carpentries, blog is Quarto, anvil is pkgdown, support is Biostar, code is bespoke, checkResults is 1990s table HTML on a grey background. There is no shared header, no shared footer, no shared type scale.

**Protocol downgrade on every directory URL.** Any `https://bioconductor.org/<dir>` without a trailing slash 302-redirects to **`http://`**:

```
https://bioconductor.org/about              → 302 → http://bioconductor.org/about/
https://bioconductor.org/install            → 302 → http://bioconductor.org/install/
https://bioconductor.org/developers         → 302 → http://bioconductor.org/developers/
https://bioconductor.org/help/docker        → 302 → http://bioconductor.org/help/docker/
https://bioconductor.org/help/seminar-series→ 302 → http://bioconductor.org/help/seminar-series/
```

This is systemic (Apache canonical-name configuration, inferred). The site's own pages emit such links — the homepage links `Help Wanted → /developers/help_wanted` (no slash), `/help/support/` links `Help Wanted → …/help_wanted`, `/developers/` links `Developers' Forum → …/developers-forum`. Each of those clicks routes the user through plaintext HTTP.

---

## 4. Content design

### 4.1 Homepage (`/`)

Above the fold at 1440×900: a hero with a two-line title, two sentences of mission statement, and a button — roughly 330px of vertical space that conveys no information a returning user needs and no operational information a new user needs (the words "R", "package", "genomics", "RNA-seq" do not appear in the hero).

Below it, a "For Users" / "For Developers" tab pair opening onto a bordered card containing **an undifferentiated bullet list of ten links**: Software/Annotation/Experiment Packages · Docker Containers · AnVIL · Bioconductor Books · Latest Release Announcement · Bioconductor Dashboard · Community Chat · Support Forums · **Learn More** · Get Involved. "Learn More" is a link with no object. Two hand-drawn doodle annotations — *"Start using Bioconductor now!"* and *"Learn more about Bioconductor."* — point at this card, duplicating link text that is already inside it.

The "Learn" section is a 2×5 grid of **bare labels with no descriptions**: Education and Training · Package Vignettes · Bioconductor Books · Common Workflows · Get Help · Community Resources · **Courses (403)** · FAQ · Videos · Community Blog. "Connect With the Community" adds a further 12-item link list. **The homepage's dominant content type is undescribed links** — I count ~55 distinct destinations on one page, and 9 of them go to `/install/`, 5 of those labelled identically "Get started".

Then a "Start Using Bioconductor" carousel whose only content is a third "Get started" button, then the events strip discussed in §2g.

Iconography is literal emoji characters in the content (`📖 Bioconductor Books`, `📣 Latest Release Announcement`, `💬 Community Chat`, `💡 Support Forums`, `🗓️ Events`). In my headless environment these render as tofu boxes; on any client without a colour emoji font (common on Linux workstations and locked-down corporate images) real users will see the same. *(Observed in-environment; the generalisation to end users is inferred.)*

### 4.2 `/install/`

Covered in §2a. Summary: excellent hero, then a 9,000px scroll of duplicated code blocks, three typos, and worked examples pinned to 2019 (Bioc 3.9, R 3.6.0). Six sibling headings that a reader cannot tell apart (Update / Updgrade / Recompile / Troubleshoot Package Installations / Troubleshoot BiocManager / Why use BiocManager). No link to the FAQ, no link to the version table, no link to a worked analysis.

### 4.3 `/help/`

A pure link index: **41 links, zero descriptions**, in six groups (Get Started, Learn, Packages, Developers, Connect With the Community, contact). It duplicates the footer almost exactly and the homepage Learn grid almost exactly, with just enough drift to be confusing — e.g. `/help/` has "Tutorials" (→ `support.bioconductor.org/t/Tutorials/`, an off-site tag page) which appears nowhere else, and "Upcoming and Past Events" where the homepage says "Bioconductor Related Events". The heading and the nav label disagree with the title and breadcrumb (§1.2). The intro copy — *"our knowledge base provides you with the necessary tools and insights to navigate Bioconductor packages effortlessly"* — is content-free.

`/help/` also carries the developer material (Build Reports, Guidelines, Use Devel, Git Source Control, Git FAQ, Release Schedule, Browsable Code Base, Help Wanted) as a section, so the "Learn" hub is simultaneously the developer hub, duplicating `/developers/`.

### 4.4 `/developers/`

Covered in §2e. Two paragraphs of good orienting prose, then 15 links, missing the one link the prose is about, one anchor with no `href`, three typos.

### 4.5 Package landing page

Covered in §2c — the strongest page on the site. Defects: 404 "Download Stats" link, `http://cran.rstudio.com` dependency links, unlabelled devel/release switcher.

### 4.6 Unexplained jargon, in order of first exposure

**biocViews** — the label on the input at the top of the site's main package browser, never defined on that page; the term is also a breadcrumb (`Home > BiocViews`) and a table row on every package page. **devel** — appears on `/developers/`, `/help/`, `/install/`, `/packages/`, and in the search results (`/packages/devel/…`), never glossed on first use. **landing page** — used as a noun in `/help/support/` ("check the package landing page") and in build reports, addressing users who have no reason to know the term. **AnVIL** — three homepage/footer links, no one-line explanation, and two different destinations (§1.2). **BBS** / **Single Package Builder** / **nebbiolo1** — appear on `/dashboard/` and build reports unglossed. **manifest** — used on the release schedule page as though it were common knowledge.

### 4.7 Site-wide head/meta (`layouts/_sitehead.html`)

- **Duplicate `<meta name="viewport">`** at lines 3 and 7 with different `initial-scale` values, on every page.
- **The same generic `<meta name="description">`** on every page (line 8), so every page in Google's index shares one snippet.
- **Open Graph tags are emitted only for package pages** (lines 10–18), and those use `http://` for `og:url` and `og:image`. Verified on the homepage: `document.querySelectorAll('meta[property^=og]')` → empty. Sharing bioconductor.org anywhere produces no preview card.
- **No skip-to-content link** (`a.skip-link` / `a[href^="#main"]` → none). First heading in DOM order is an `<h6>` ("Menu"), before the `<h1>`.
- All stylesheets are `media="screen"`, so printed pages lose all styling.

### 4.8 Stale and duplicate content inventory

| Item | Evidence |
|---|---|
| `/developers/release-schedule/` describes an already-shipped release, no year anywhere | §2g |
| `/install/` examples reference Bioc 3.9/3.10, R 3.6.0 (2019), "Bioc 3.0 … for R.3.1.x" | §2a |
| Homepage events strip shows 3 past events of 5 | §2g |
| `/help/course-materials/` — entire 2002–2018 archive 403s; newest material is 8 years old even when served | §Exec-3 |
| `/help/workflows/` — one-sentence redirect stub, still indexed | §1.2 |
| `/developers/package-submission/` — "This page has moved" stub, still indexed | §1.2 |
| `/help/cabig/`, `/help/elasticmapreduce/`, `/help/bioconductor-cloud-ami/` — all live (200); caBIG ended in 2012, and the AMI/EMR guidance predates the Docker/AnVIL story the homepage now tells | observed 200s; obsolescence inferred |
| `/about/` prose describes scope as "DNA microarray, sequence, flow, SNP" — microarrays first, no single-cell or spatial | observed |
| `SingscoreAMLMutations` Title = `ERROR` in the public workflow list and on its landing page | observed |
| Typos: *Updgrading, pacakges, pacakge, exisiting, submited, BiocCodingCollabortions, is schedule for, search fo, share you, git.biconductor.org, instrucions, Bioconductorproject* | observed, 5 pages |

---

## 5. Mobile UX (390×844)

**Navigation — broken (Exec §2).** Tapping "Menu" opens a drawer fixed at `height: 21rem` (`assets/style/sections/header.css:181`) with `overflow: hidden` (`:174`). Measured positions with the drawer open:

```
drawer          top=136  bottom=472   (336px, clipped)
last link Donate top=426 bottom=463   ✓ visible
search box       top=479 bottom=504   ✗ below the clip
Get Started btn  top=520 bottom=568   ✗ below the clip
```

**There is no other search entry point on mobile.** `/help/search/` is reachable only by typing the URL. The drawer is also `position: absolute` rather than a full overlay, so page content ("…collaborative community of developers and data scientists") shows through directly beneath "Donate", making the menu look truncated rather than closed.

**Desktop nav can vanish on real desktops.** The breakpoint is `@media (max-device-width: 1080px), (width <= 1080px)` (`assets/style/sections/header.css:158`). `max-device-width` is a deprecated feature keyed to the **physical screen**, not the viewport. I confirmed the mechanism by driving the same 1440px-wide viewport with `screen.width` set to 800 and to 1440: at 800 the media query matched and `.header-nav` collapsed to `height: 2px; opacity: 0` with the hamburger `display: flex`, even though the window was 1440 wide; at 1440 the normal 42px nav bar rendered. **Any user whose display reports ≤1080 CSS px** — a 1600×900 laptop panel, or a 1080p/1440p panel at 200% OS scaling — **gets the hamburger permanently, and therefore loses the site search entirely, no matter how wide they make the window.** *(Mechanism observed; the population affected is inferred from how OS display scaling reports `screen.width`.)* The first clause is redundant with the second and should simply be deleted.

**Code blocks — fine.** On `/install/` at 390px, `document.documentElement.scrollWidth === window.innerWidth === 390`; each `<code>` block has its own `overflow-x: auto` and scrolls independently. No page-level horizontal scroll. This is done correctly.

**Page length.** `/install/` is 9,098px tall at 390px; the homepage is 5,644px. Both are long but coherent; the homepage carousels and the events strip degrade to swipeable single cards with dot indicators, which works.

**Build reports — unusable.** `/checkResults/` and `/checkResults/release/bioc-LATEST/<pkg>/` have **no `<meta name="viewport">` at all** (verified: `document.querySelector('meta[name=viewport]')` → `null`). Mobile browsers therefore fall back to the 980px default viewport — `window.innerWidth` reported **980 at a 390px device width** — and render the page zoomed out to ~40%, which puts the INSTALL/BUILD/CHECK status text at roughly 5–6pt. The index page carries 43 tables at that scale. There is no site header, no footer, no breadcrumb, and no link back to bioconductor.org; the only escape is the browser Back button. This page is where every "my package failed" journey ends.

**Package tables.** `BiocViews.html` inserts all 2,418 rows into the DOM at once (`Showing 1 to 2,418 of 2,418 entries`) with no default page size — a single DOM containing the full package catalogue, delivered to phones.

---

## 6. Prioritized recommendations

Ranked by (user impact ÷ effort). Every item names the file or URL to change.

### Tier 1 — broken things, hours to days of work, large impact

| # | Action | Where | Why |
|---|---|---|---|
| 1 | **Fix the package rank sort or its caption.** Sort descending, or relabel the column "Download rank (higher = more downloaded)". Better: default the table to descending popularity so `DESeq2`/`limma`/`edgeR` head the list. | `BiocViews.html` generator | The top-nav "Packages" link currently misrepresents the ecosystem to every first-time visitor. |
| 2 | **Un-break the mobile menu.** Replace `height: 21rem` with `max-height: 80vh; overflow-y: auto` (or `height: auto`). | `assets/style/sections/header.css:181`, `:174` | Restores site search and the primary CTA to all mobile users. One-line fix. |
| 3 | **Delete the `(max-device-width: 1080px)` clause**, keeping `(width <= 1080px)`. | `assets/style/sections/header.css:158` | Stops the desktop nav and search box disappearing on scaled displays. One-line fix. |
| 4 | **Restore `/help/course-materials/`** (build/deploy — the content is in the repo) or, if it is being retired, 301 the whole subtree to `training.bioconductor.org` and remove the four inbound links. | `content/help/course-materials*`, server config | A homepage link currently returns 403. Either outcome beats the current one. |
| 5 | **Fix the HTTPS→HTTP redirect** on trailing-slash-less directory URLs. | Apache `ServerName`/`UseCanonicalName` (inferred) | Every internal link that omits the trailing slash downgrades the user to plaintext. Also fix the site's own no-slash links (`/developers/help_wanted`, `/developers/developers-forum`, `/developers/new-developer-program`, `/developers/bioccommits`). |
| 6 | **Add a "Submit a new package" link to `/developers/`**, above the fold, pointing at `contributions.bioconductor.org/submission-overview.html`. Give the orphan `<a class="format-underline">Source code is stored in Git.</a>` an `href` or delete it. | `content/developers/index.html` | The developers landing page is missing the one action its own intro paragraph describes. |
| 7 | **Fix "Download Stats"** (404) on every package landing page. | package-page template | Broken on 2,418 pages. |
| 8 | **Update `/developers/release-schedule/` to the 3.24 schedule and put years on every date.** Add a rendered "next release: <date>" to the homepage and `/install/`. | `content/developers/release-schedule.md` | The page linked as "Release Schedule" describes a release three months past and contains no year at all. |
| 9 | **Add `<meta name="viewport">` to the build-report generator**, and re-attach the site header/footer. | build-report generator (out of this repo) | The terminus of every developer debugging journey renders at 40% zoom with no way home. |

### Tier 2 — content and copy, days of work

| # | Action | Where |
|---|---|---|
| 10 | **Rewrite `/install/`:** delete the duplicated BiocManager block; fix "To install core packages" → "To install specific packages"; fix *Updgrading*, *pacakges*; regenerate every console transcript against 3.23 / R 4.6; move the "Why use BiocManager" essay to its own page. | `content/install.html` |
| 11 | **Add a "What next?" block to `/install/`** linking `rnaseqGene`, OSCA, the FAQ, and `/about/release-announcements/`. | `content/install.html` |
| 12 | **Sweep the typos** listed in §4.8 across `/install/`, `/developers/`, `/developers/release-schedule/`, `/help/support/`, `/about/`. | 5 files |
| 13 | **Split `/help/support/`** into "I have a problem" (support site, FAQ, posting guide, package bug reports — link the FAQ prominently) and "I want to get involved" (bioc-devel, forum, new-developer program, Help Wanted). | `content/help/support.html` |
| 14 | **Fix `SingscoreAMLMutations`'s `ERROR` title**, and add a guard so a failed build never publishes a package Title of "ERROR". | package-page generator |
| 15 | **Retire the redirect stubs** `/help/workflows/` and `/developers/package-submission/` — convert to server 301s. Audit `/help/cabig/`, `/help/elasticmapreduce/`, `/help/bioconductor-cloud-ami/` for retirement. | `content/help/`, `content/developers/` |
| 16 | **Filter past events out of the homepage strip and sort ascending by start date** (the `/help/events/` template already does this correctly — reuse it). | homepage events component |
| 17 | **Fix `layouts/_sitehead.html`:** delete the duplicate viewport meta (line 3 or 7); emit per-page `<meta name="description">`; emit Open Graph tags on all pages over `https`; add a skip-to-content link. | `layouts/_sitehead.html:3,7,8,10-18` |
| 18 | **Gloss the jargon on first use** — one clause each for *biocViews*, *devel*, *landing page*, *AnVIL*. Give the biocViews autocompleter a label, a placeholder (`e.g. SingleCell, RNASeq`), and a one-line "what is this". | `BiocViews.html`, `/help/`, `/developers/` |

### Tier 3 — structural, weeks of work

| # | Action |
|---|---|
| 19 | **Replace the full-text search** or, cheaply, add two filters to `/help/search/`: a "Packages only" toggle and a release/devel toggle that collapses the duplicate pairs. Rank package landing pages above vignette PDFs. Add page numbers alongside `Next >`. Currently 23,625 results, 23 per page, no facets, every result duplicated. |
| 20 | **Give the sibling properties a shared header.** A single 40-line HTML/CSS partial (logo + the five top-level links + "back to bioconductor.org") injected into `support.`, `blog.`, `code.`, `anvil.`, `contributions.`, `workinggroups.`, `training.` and `/checkResults/` would fix the isolation problem in §3 without touching any of their frameworks. |
| 21 | **Build a real package finder.** A search box over package Title + Description + biocViews with synonym tolerance ("single cell" → `SingleCell`), returning landing pages ranked by downloads. This is the single highest-value missing feature; §2b is currently unanswerable. |
| 22 | **Curate `/help/bioconductor-books/`.** 13 bare links with `BiocBookDemo` and `scrapbook` given the same visual weight as OSCA and MSMB. Add one-line descriptions and separate "canonical" from "community". |
| 23 | **Consolidate the three "workflows" URLs** into one, and decide whether `/help/` or `/developers/` owns developer material (currently both do). |

### Proposed top-level IA

The current six slots spend two on fundraising, none on support, and split "learn" across `/help/` and the footer's "Get started". A concrete alternative:

```
Get Started    → /install/            Install R + Bioconductor, version table, first analysis, Docker/AnVIL
Packages       → /packages/           NEW landing page: search box, popular packages,
                                      browse by biocViews, workflows, annotation, experiment data
                                      (BiocViews.html becomes "browse all", not the front door)
Learn          → /learn/              Books · Workflows · Vignettes · Courses · Videos · Training
Support        → /support/            FAQ first, then support site, then chat, then how to report a bug
Develop        → /developers/         Submit a package (first) · Guidelines · Git · Build reports · Release schedule
About          → /about/              Project · Governance · Funding · Donate · Code of Conduct · Community
```

What changes and why:

- **`Support` gets a top-level slot.** It is the highest-frequency need and currently has none. It absorbs the FAQ, which is the site's most useful page and is presently buried.
- **`Funding` and `Donate` fold into `About`** with a persistent "Donate" button in the header if fundraising visibility matters. They currently consume two of six slots for one page.
- **`Packages` points at a real landing page, not an anchor into a 2,418-row table.** The table stays, as "browse all".
- **`Learn` moves off `/help/`.** The URL `/help/` carrying an `<h1>` of "Learn" is the root of the label confusion in §1.2; splitting learning (`/learn/`) from support (`/support/`) resolves it and lets each page have one audience.
- **`Get Started` moves from a header button into the nav proper**, since it is where 9 homepage links already point.
- **Footer mirrors these six exactly.** The current footer's independent taxonomy (About/Developers/Learn/Get started) is a second, competing IA.

Redirects needed: `/help/` → `/learn/`, `/help/support/` → `/support/`, `/help/faq/` → `/support/faq/`, keeping the old URLs alive as 301s (they have 20 years of inbound links).

---

## Appendix — verification artefacts

Reproduce the headline findings:

```bash
# Exec-1: rank inversion
curl -s https://bioconductor.org/packages/release/BiocViews.html   # table is JS-loaded; inspect in a browser
#   DESeq2 rank 2397 / limma 2401 / edgeR 2393 vs BiocAzul 1, of 2418

# Exec-3: course materials 403
curl -sI https://bioconductor.org/help/course-materials/   | head -1   # HTTP/1.1 403 Forbidden
curl -so /dev/null -w '%{http_code}\n' https://bioconductor.org/help/course-materials/2018/          # 403
curl -so /dev/null -w '%{http_code}\n' https://bioconductor.org/help/course-materials/2013/BioC2013/ # 403

# §2c: Download Stats 404 on every package page
curl -so /dev/null -w '%{http_code}\n' https://bioconductor.org/packages/stats/bioc/DESeq2/          # 404

# §3: HTTPS -> HTTP downgrade
curl -so /dev/null -w '%{http_code} %{redirect_url}\n' https://bioconductor.org/about
#   302 http://bioconductor.org/about/

# §5: build reports have no viewport meta
curl -s https://bioconductor.org/checkResults/ | grep -c 'name="viewport"'   # 0
```

Repo lines cited: `assets/style/sections/header.css:158,174,181` · `layouts/components/header.html:17-22` · `layouts/components/footer.html:6-46` · `layouts/components/subnav.html:91` · `layouts/_sitehead.html:3,7,8,10-18` · `content/developers/package-submission.md` · `content/help/course-materials.html`.
