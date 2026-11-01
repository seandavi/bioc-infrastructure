# Bioconductor web presence — architecture audit

Date of survey: 2026-07-25 (all live probes on this date).
Repo surveyed: `Bioconductor/bioconductor.org` @ `e2ae0a9` (branch `devel`, tip commit "remove temporary fix for rankings when stats was down", 2026-07-23), shallow clone at
`/data/davsean/tmp/.../scratchpad/bioc-site-src`. Repo paths below are relative to that clone root.

Evidence convention: **[V]** = directly observed (file line, HTTP response, API result). **[I]** = inference from observed evidence. **[U]** = unverified / could not confirm.

---

## Executive summary — the 5 things that matter

1. **All CI/CD on the main site repo is switched off.** All four GitHub Actions workflows report `state: disabled_manually` (`gh api repos/Bioconductor/bioconductor.org/actions/workflows`) **[V]**. Two of them (`.github/workflows/staging.yaml:5-7`, `.github/workflows/linter.yaml:26`) were in any case wired to branch `redesign2023`, which no longer exists — the branch list is `devel, master-main, nearform-redesign2023, …` and the default branch is `devel` **[V]**. So the *only* path to production is the undocumented-in-repo cron on `staging.bioconductor.org` described in `README.md:524-573`: `git pull && rake real_clean default deploy_staging deploy_production` every 20 minutes, rsyncing to `webadmin@master.bioconductor.org:/extra/www/bioc` (`config.yaml:7`) **[V from README + config; the cron itself is U]**. There is no build gate, no test, no lint, no preview, and one machine plus one person's crontab is the deploy pipeline.

2. **`/sitemap.xml` ships raw, unevaluated ERB.** `https://bioconductor.org/sitemap.xml` returns 20 bytes, literally `<%= xml_sitemap %>` **[V]**. Cause is `Rules:13-15` — `compile '/sitemap/' do #/ nothing end` applies no filter, while `Rules:61-63` still routes it to `sitemap.xml`. Compounding it, `robots.txt` has no `Sitemap:` line **[V]** and `Disallow`s `/packages/release/`, `/packages/devel/` and every `/packages/<ver>/` prefix (`assets/robots.txt:46-49` and the 40-odd sibling lines) **[V]** — which is exactly where all ~2,400 package landing pages live (2,418 distinct `html/*.html` links on `https://bioconductor.org/packages/release/bioc/` **[V]**). The project is actively telling crawlers not to index its single most valuable content set.

3. **Site search only works by bypassing the CDN, and the CDN-fronted copy is silently broken.** `assets/js/search.js:18` hardcodes `//master.bioconductor.org/solr/default/select…` **[V]**. That direct-to-origin URL works: `?q=limma` → `numFound: 5785` **[V]**. The same query through the CDN, `https://bioconductor.org/solr/default/select?q=limma`, returns `<lst name="params"/>` and `numFound="0"` — CloudFront is not forwarding the query string for that path, so the params never reach Solr **[V]**. Every search therefore skips the CDN and lands on the origin Apache. The backend is Apache Solr proxied by `ProxyPass /solr/default/select` (`README.md:749`), configured from `etc/solr/schema.xml`, started by hand from `/etc/rc.local` (`README.md:733-736`) **[V, from repo]**.

4. **The toolchain is a decade behind and carries seven unmerged security bumps.** Ruby 2.6.5 (`Dockerfile:1`), EOL 2022-03-31 **[V via endoflife.date]**, on a Debian Buster base so dead the Dockerfile has to rewrite `sources.list` to `archive.debian.org` to build at all (`Dockerfile:4-5`) **[V]**. nanoc 4.9.9 vs current 4.14.7; nokogiri 1.10.8 vs 1.19.4; rack 2.1.2 vs 3.2.6; kramdown 2.1.0 vs 2.5.2; addressable 2.5.2 vs 2.9.0 **[V, `Gemfile.lock` vs rubygems.org API]**. Seven dependabot PRs are open, the oldest from 2020-07-28 (#64 json), the newest 2023-03-16 (#208 rack 2.1.2 → 2.2.6.4) **[V]**. Frontend: jQuery **1.6.4** (2011) with jQuery Tools 1.2.6, jquery.corner 2.03 (2009), timeago 0.9.2 (2010) **[V, banner comments in `assets/js/*.js`]**. `Gemfile:2` fetches gems over **plaintext `http://rubygems.org`** **[V]**.

5. **Eleven+ properties, ten different stacks, zero shared chrome.** Main site is bespoke nanoc + hand-written CSS; everything else is a Bootstrap derivative from a different generator (bookdown, quarto ×2 versions, pkgdown, Hugo ×2 versions, Django/Biostar, Galaxy+Keycloak) **[V, see inventory]**. Two of them still serve the bookdown scaffold text verbatim: contributions.bioconductor.org and workinggroups.bioconductor.org both emit `<meta name="description" content="This is a minimal example of using the bookdown package to write a book…">` **[V]**. There is no shared header, no shared search, no shared auth, and no shared release notion across the constellation.

---

## 1. Component inventory

All rows below verified by `curl -I -L` and/or fetching the HTML on 2026-07-25 unless marked.

| Property | Purpose | Stack (evidence) | Source | Deploy | Active? |
|---|---|---|---|---|---|
| **bioconductor.org** | Main site: docs, package landing pages, biocViews, install, news, courses | `Server: Apache/2.4.52 (Ubuntu)`, `Via: … cloudfront.net`, `X-Cache: Hit from cloudfront`. Static output from nanoc 4.9.9 **[V]** | `Bioconductor/bioconductor.org` (this repo) | rsync from staging cron → `master.bioconductor.org:/extra/www/bioc`, fronted by CloudFront (`config.yaml:6-8`, `README.cloudfront.md`) **[V]** | Yes — `pushed_at` 2026-07-24 **[V]** |
| **master.bioconductor.org** | CDN-origin bypass host; also the Solr host | `Server: Apache/2.4.52 (Ubuntu)`, 200, no CloudFront headers **[V]** | same | same box | Yes |
| **www.bioconductor.org** | Alias | Returns **200, not a redirect**, `X-Cache: Hit from cloudfront` **[V]** | — | same distribution | Yes (see §5 — duplicate host) |
| **support.bioconductor.org** | Q&A forum | `Server: nginx/1.18.0 (Ubuntu)`, `Set-Cookie: csrftoken=…; SameSite=Lax` → Django; body contains "biostar" **[V]** | `Bioconductor/support.bioconductor.org` ("support site code base. Based on Biostars.", Python, default branch `master`) **[V]** | **[U]** | Repo `pushed_at` 2026-01-13 **[V]** — low activity |
| **contributions.bioconductor.org** | Package-submission / developer handbook | `server: GitHub.com` + Fastly (`via: 1.1 varnish`); `<meta name="generator" content="bookdown 0.47 with bs4_book()">` **[V]** | `Bioconductor/pkgrevdocs` **[V]** | GitHub Pages, `gh-pages` branch, `build_type: workflow` **[V]** | Yes — 2026-07-20 **[V]** |
| **blog.bioconductor.org** | Project blog | GitHub Pages + Fastly; `<meta name="generator" content="quarto-1.9.38">` **[V]** | `Bioconductor/biocblog` **[V]** | GH Pages, `gh-pages`, `build_type: legacy` **[V]** | Yes — 2026-07-23 **[V]** |
| **code.bioconductor.org** | Cross-package code browser/search | `server: nginx`, hand-rolled HTML, Bootstrap 4.1.3 + FontAwesome 5 + Google Fonts, all from third-party CDNs **[V]** | `Bioconductor/code.bioconductor.org` (CSS, default `main`) **[V]** | **[U]** — not GH Pages (nginx, no GitHub headers) | **Stale** — repo `pushed_at` 2025-08-12, ~11 months **[V]** |
| **git.bioconductor.org** | Canonical package git (gitolite) | `Server: Apache/2.4.18 (Ubuntu)`; body: `gitolite3 v3.6.6-6-g7c8f0ab on git 2.33.0` **[V]** | — (`BBS`, `bioconductor_salt` repos adjacent) | **[U]** | Serving; **Apache 2.4.18 = Ubuntu 16.04 vintage** **[I]** |
| **chat.bioconductor.org** | Chat entry point | `Server: Apache/2.4.18 (Ubuntu)` → **302 to a hardcoded Zulip invite URL** `https://community-bioc.zulipchat.com/join/4k2tpsy7h6zjbaduydwm2n56/` **[V]** | **[U]** — a vhost redirect, not in this repo | Apache vhost **[I]** | Works, but see §5 |
| **training.bioconductor.org** | Training/carpentries material | GitHub Pages; `<meta name="generator" content="quarto-1.10.18">` **[V]** | `Bioconductor/bioconductor-training` **[V]** | GH Pages `gh-pages`, legacy **[V]** | Yes — 2026-07-26 **[V]** |
| **workshop.bioconductor.org** | Hosted workshop compute | **Galaxy** — `Set-Cookie: galaxysession=…`, `galaxytoolrunnersession=…`, `/tool_runner` path **[V]** | `Bioconductor/workshop-contributions` (2026-07-13) **[I]** | **[U]** | Yes — live login flow **[V]** |
| **workshopauth.bioconductor.org** | SSO for the above | **Keycloak** — `/auth/realms/bioc/protocol/openid-connect/auth`, `AUTH_SESSION_ID`, `KC_RESTART` JWT cookie **[V]** | **[U]** | **[U]** | Yes **[V]** |
| **anvil.bioconductor.org** | AnVIL/cloud R package docs | GitHub Pages; **pkgdown**; `<title>Bioconductor AnVIL Projects • BiocAnVIL</title>` **[V]** | `Bioconductor/BiocAnVIL` (links in page) **[V]** | GH Pages **[V]** | Yes — 2026-07 activity in AnVIL* repos **[V]** |
| **workinggroups.bioconductor.org** | Working-group handbook | GitHub Pages; `bookdown 0.47 with bs4_book()` **[V]** | `Bioconductor/BiocWorkingGroups` **[V]** | GH Pages `gh-pages`, legacy **[V]** | Yes — 2026-07-09 **[V]** |
| **bioc2026.bioconductor.org** | BioC2026 conference | `server: Netlify`; `<meta name="generator" content="Hugo 0.144.0">`; `<title>Bioconductor</title>` (unchanged template title) **[V]** | `Bioconductor/BioC2026` (CSS, default `devel`, **no GH Pages**) **[V]** | **Netlify** **[V]** | Yes — 2026-07-17 **[V]** |
| **biocasia2026.bioconductor.org** | BiocAsia2026 | Netlify + Hugo 0.144.0; `<title>Bioconductor</title>` **[V]** | `Bioconductor/BiocAsia2026` **[V]** | Netlify **[V]** | Yes — 2026-07-20 **[V]** |
| **biocasia2025.bioconductor.org** | BiocAsia2025 (archive) | Netlify + **Hugo 0.128.0** **[V]** | `Bioconductor/BiocAsia2025` **[V]** | Netlify **[V]** | Frozen — 2025-11-21 **[V]** |
| **eurobioc2026.bioconductor.org** | EuroBioC2026 | GitHub Pages; **quarto-1.9.38**; proper `<title>` **[V]** | `Bioconductor/EuroBioC2026` (R) **[V]** | GH Pages `gh-pages`, legacy **[V]** | Yes — 2026-06-26 **[V]** |
| **eurobioc2025.bioconductor.org** | EuroBioC2025 (archive) | GitHub Pages; **quarto-1.5.57** **[V]** | `Bioconductor/EuroBioC2025` **[V]** | GH Pages **[V]** | Frozen — 2025-12-16 **[V]** |
| **status.bioconductor.org** | Status page (cstate/Hugo) | **DNS/TLS not wired**: `curl https://status.bioconductor.org/` → `SSL: no alternative certificate subject name matches`. Content lives at `https://bioconductor.github.io/status.bioconductor.org/` (200) **[V]** | `Bioconductor/status.bioconductor.org` — "Status page for Bioconductor based on cstate hugo site", `has_pages: true` **[V]** | GH Pages **[V]** | **In progress / mis-wired** — pushed 2026-07-26 but the vanity domain does not serve **[V]** |
| **bioconductor.github.io** | Org Pages root | **404** at `/`; hosts many project sub-paths (`/workflows/`, `/BiocManager/`, `/classes.bioconductor.org/devel/`, `/ai-agent-skills/`, …) **[V]** | various | GH Pages **[V]** | Sub-paths active; root is dead |
| **BBS build reports** (`/checkResults/…`) | Nightly build/check matrix | Served from the main Apache doc root; **HTML 4.01 Transitional**, `report.css` + `report.js`, no site chrome, uppercase tags **[V]** | `Bioconductor/BBS` (Shell, 2026-07-17) **[V]** | Written into `/extra/www/bioc` by the build system **[I]** | Yes — report timestamp 2026-07-24 11:32 **[V]** |
| **Package repos / mirrors** | CRAN-style package trees | Main: `bioconductor.org/packages/…`. 17 mirrors declared in `config.yaml:260-425` **[V]**; TU Dortmund mirror returns 200 **[V]** | `config.yaml` is the registry; `rake mirror_csv` (`Rakefile:711-748`) emits `assets/BioC_mirrors.csv` **[V]** | rsync from master (`rsync: secure_mirror_from_master`) **[V, config]** | Yes |
| **Archive (OSN)** | Old package tarballs | `mghp.osn.xsede.org/bir190004-bucket01` — 200, `application/xml` (S3-compatible) **[V]** | — | Redirects from `assets/.htaccess:66-83` **[V]** | Yes |
| **Container binaries** | Prebuilt binaries | `storage.googleapis.com/bioconductor-packages/…` via `assets/.htaccess:112-113` **[V]** | `r-container-binaries-k8s-builder` (2026-07-20) **[V]** | GCS **[V]** | Yes |
| **packagemanager.posit.co / bioconductor.posit.co** | Third-party mirror | 200 **[V]** | Posit **[V, `config.yaml:272-280`]** | Posit-operated | Yes |

Also discovered in the org but not on a `bioconductor.org` subdomain: `classes.bioconductor.org` (repo exists, marked "⚠️ Unofficial", published at `bioconductor.github.io/classes.bioconductor.org/devel/`), `Bioconductor/workflows` → `bioconductor.github.io/workflows/`, `bioc-core-sops`, `ai-agent-skills`, `agentic-ai-workshop-2026-boston`, `bio-web-stats`, `download_stats` → `bioconductor.org/packages/oldstats/` **[V, `gh api orgs/Bioconductor/repos`]**.

### Notable gaps
- **No single place lists these.** The main site homepage links out to 11 of them (`contributions`, `chat`, `support`, `training`, `code`, `blog`, `anvil`, `git`, `workinggroups`, `bioc2026`, `eurobioc2025/2026`, `biocasia2026`, `bioconductor.github.io` — counted from the homepage HTML **[V]**), but there is no inventory, no ownership table, and no consistent deploy story.
- **Three different hosting providers** for static content that is architecturally identical: GitHub Pages (6 sites), Netlify (3 sites), self-hosted Apache+CloudFront (1 site). **[V]**

---

## 2. Main site build pipeline

### Shape
nanoc 4.9.9 static generator, driven by `rake` (`Rakefile:119-123`, `task :default => :build`).

`rake build` = `compile` → `copy_config` → `copy_assets` → `write_version_info` → `write_version_number` **[V, `Rakefile:120-121`]**, where `compile` = `pre_compile` → `real_compile` (`bundle exec nanoc co`) → `post_compile` **[V, `Rakefile:53-54`, `:76`]**.

### Authored vs generated

| Content | Origin | Where |
|---|---|---|
| Prose pages (about, help, developers, install, news) | Hand-written; each page is a **pair** of `.md`/`.html` + `.yaml` attributes file | `content/` — 207 `.md`, 329 `.html`, **696 `.yaml`** **[V]** |
| **Package landing pages** | Generated at compile time by the `bioc_views` nanoc data source from `assets/packages/json/<ver>/<repo>/packages.json` | `lib/data_sources/bioc_views.rb` (227 lines), `config.yaml:98-105`; routed by `Rules:91-95` to `/packages/<ver>/<repo>html/<Pkg>.html` **[V]** |
| Package index pages | Same data source | `Rules:81-88`, mapping `Software→bioc`, `AnnotationData→data/annotation`, `ExperimentData→data/experiment`, `Workflow→workflows` **[V]** |
| biocViews tree page | `assets/help/bioc-views.html` copied per-version by `rake pre_compile`, then routed | `Rakefile:57-73`, `Rules:70-78` **[V]** |
| The JSON feeding all of the above | `rake prepare_json` → `GetJson` per version; `rake json2js` converts to `var bioc_packages = {…}` script payloads | `Rakefile:281-291`, `:224-279`, `scripts/get_json.rb` **[V]** |
| Manifest of packages per release | `git -C ../manifest checkout RELEASE_x_y` in the nanoc **preprocess** step — the build shells out to git and flips branches on a *sibling checkout* | `Rules:111-166` **[V]** |
| Build/status badges (SVG) | Downloaded from `master.bioconductor.org/checkResults/<ver>/<repo>-LATEST/BUILD_STATUS_DB.txt` and turned into SVGs | `Rakefile:399-432` (`get_build_dbs`), `:462-495` (availability), `:562-672` (last-commit), `:677-698` (dependencies), all gathered by `:get_all_shields` `Rakefile:701-706` **[V]** |
| Download stats | `rake process_downloads_data` → `downloadBadge` | `Rakefile:436-457` **[V]** |
| Support-site activity | `rake get_supportsite_info_shield` → live scrape of support.bioconductor.org | `Rakefile:499-503`, `scripts/get_support_tag_info.rb` **[V]** |
| "Latest support posts" on `/dashboard/` | **Fetched at every build** from `https://support.bioconductor.org/feeds/latest/` | `lib/data_sources/biostar_list.rb:18-20`; rendered at `content/dashboard.html:173`; 7 `support.bioconductor.org` links present in the live page **[V]** |
| PubMed publication list | Fetched at build from `eutils.ncbi.nlm.nih.gov` | `config.yaml:106-122`, `lib/data_sources/pubmed.rb` (204 lines) **[V]** |
| Mirror list CSV | Generated from `config.yaml` | `Rakefile:711-748` **[V]** |

### Release-cycle mutation
`config.yaml` is the release switchboard, with five separate "CHANGE THIS WHEN WE RELEASE" comments **[V, `config.yaml:10,15,18,30,38`]**:
`release_version: "3.23"` / `devel_version: "3.24"` (`:11`, `:16`), the `versions:` list that determines which package-page sets get regenerated (`:26-28`), `devel_repos:` (`:32-36`), the builder hostnames (`:40-48`), `single_package_builder` (`:52-54`), plus hand-maintained `r_ver_for_bioc_ver`, `release_dates`, and `release_last_built_dates` maps that must each gain a row (`:125-259`). `rake post_compile` then recreates the `release`/`devel` symlinks under `output/packages/` (`Rakefile:94-102`) **[V]**.

Bumping a release therefore means editing ~7 places in one YAML file by hand, with no validation. `Rakefile:701-706` and the badge tasks are documented as crontab entries, not as pipeline steps.

### Scale
- `content/` 15 MB, 1,237 files; the two heavy directories are `content/news/` 7.1 MB and `content/help/` 6.3 MB **[V]**.
- `assets/` 71 MB, 933 files; dominated by `assets/images/` 31 MB and `assets/about/` 29 MB **[V]**.
- `layouts/` 68 files, 304 KB **[V]**.
- `lib/` 2,703 lines of Ruby, of which **`lib/helpers.rb` alone is 1,924 lines** **[V]**.
- Output scale: 2,418 package landing pages in `release/bioc` alone **[V]**, ×2 versions (`config.yaml:26-28`) ×4 repos.

---

## 3. Toolchain currency and risk

### Ruby / gems

`Dockerfile:1` — `FROM ruby:2.6.5`. Ruby 2.6 EOL **2022-03-31** **[V, endoflife.date API]**. `.github/workflows/staging.yaml` and `pr_deploy.yaml` also pin `ruby-version: "2.6.5"` **[V]**. `README.md:117` still says "requires ruby 2.2.2 or newer".

`Dockerfile:4-5` rewrites `/etc/apt/sources.list` to `archive.debian.org` and deletes the security repo — the base image's distro is past archive, and **security updates are explicitly removed from the build** **[V]**.

`Gemfile:2` — `source 'http://rubygems.org'`, **plaintext**. RubyGems redirects to HTTPS in practice, but the declared source is a downgrade-attack surface on the build host **[V]**.

Gem currency (`Gemfile.lock` vs rubygems.org API, both checked 2026-07-25) **[V]**:

| Gem | Locked | Current | Δ |
|---|---|---|---|
| nanoc | 4.9.9 | 4.14.7 (2026-03) | 5 minor versions |
| nokogiri | 1.10.8 | 1.19.4 (2026-06) | 9 minor versions |
| rack | 2.1.2 | 3.2.6 (2026-04) | major |
| kramdown | 2.1.0 | 2.5.2 (2026-01) | 4 minor |
| addressable | 2.5.2 | 2.9.0 (2026-04) | 4 minor |
| httparty | 0.16.0 | 0.24.2 (2026-01) | 8 minor |
| mechanize | 2.7.5 | 2.14.0 (2025-01) | 7 minor |
| sass | 3.5.5 | **3.7.4, last release 2019-04-04** | Ruby Sass is dead upstream |
| hpricot | 0.8.6 | **0.8.6, last release 2012-01-17** | abandoned 14 years |
| descriptive_statistics | 2.5.1 | **2.5.1, last release 2014-12-19** | abandoned 11 years |
| uuid | 2.3.8 | **2.3.9, last release 2018-05-15** | abandoned 8 years |
| twitter | 6.2.0 | 8.3.1 | 2 majors; nothing in the repo uses it (see dead code) |

Seven dependabot PRs sit open and unmerged, all of them security bumps **[V, `gh api …/pulls?state=open`]**:
`#208` rack 2.1.2→2.2.6.4 (2023-03-16), `#194` httparty (2023-01-03), `#182` nokogiri 1.10.8→1.13.9 (2022-10-19), `#177` addressable 2.5.2→2.8.1 (2022-10-05), `#89` kramdown 2.1.0→2.3.1 (2021-03-29), `#83` mechanize (2021-02-02), `#64` json (2020-07-28). Corresponding `dependabot/bundler/*` branches still exist **[V]**.

`Gemfile.lock:188` — `BUNDLED WITH 1.17.2`, while `Dockerfile:24` installs `bundler -v 2.4.22`. Mismatched **[V]**.

Three gems are declared but nothing in the tree uses them: `redis`, `sequel`, `pg` are referenced only by `scripts/make_build_rss_feeds.rb` **[V, grep]**; `twitter`, `hpricot`, `uuid`, `rgl`, `sqlite3`, `descriptive_statistics` have no hit outside `Rakefile:17`'s bare `require 'descriptive_statistics'`. Each is an unnecessary native-extension build in a Ruby-2.6 container.

### Vendored JavaScript (`assets/js/`, 588 KB)

All identified from the files' own banner comments **[V]**:

| File | Version | Upstream status |
|---|---|---|
| `jquery.js` | **jQuery v1.6.4** (2011) | Predates every jQuery security fix of the last decade; the 1.x line ends at 1.12.4. Versions <3.5.0 are the ones affected by the `htmlPrefilter` XSS class of issues **[I]** |
| `jquery.tools.min.js` | jQuery Tools v1.2.6 | Banner: *"NO COPYRIGHTS OR LICENSES. DO WHAT YOU LIKE. http://flowplayer.org/t…"* — project dead **[V]** |
| `jquery.corner.js` | 2.03, dated **05-DEC-2009** in the banner | Solves a problem CSS `border-radius` solved in 2010 **[V]** |
| `jquery.timeago.js` | 0.9.2, dated **2010-09-14** | Replaceable by `Intl.RelativeTimeFormat` **[V]** |
| `tree-widget/jquery.jstree.js` + 4 themes (apple/classic/default/default-rtl, each with `dot_for_ie.gif`, `throbber.gif`) | jsTree, old | `dot_for_ie.gif` is an IE6 hack **[V]** |
| `jsnetworkx.js` | 91 KB | **[U]** whether still referenced |
| `jquery.cookie.js`, `jquery.hotkeys.js`, `encrypt.min.js` | — | **[U]** usage |

The homepage loads, in order: `/js/jquery.js`, `/js/jquery.tools.min.js`, `/js/bioconductor.js`, `/js/jquery.corner.js`, `/js/jquery.timeago.js`, `/js/bioc-style.js`, `/js/versions.js`, `/js/code_blocks.js`, `/js/sidebar.js` **[V, homepage HTML]**.

### Third-party runtime hosts

| Host | Used by | Status |
|---|---|---|
| `cdnjs.cloudflare.com` (highlight.js 11.7.0 CSS + JS) | Every page, via `layouts/` — loaded **protocol-relative** `//cdnjs.cloudflare.com/…` and **without SRI** **[V, homepage HTML]** | Live (200) |
| `www.googletagmanager.com/gtag/js?id=G-WJMEEH1J58` | Every page, `layouts/components/sitescripts.html:4` **[V]** | Live |
| `ajax.aspnetcdn.com` (jquery.dataTables 1.9.4 JS+CSS) | `content/developers/how-to/workflows.md` **[V]** | 200 today, but this is Microsoft's retired Ajax CDN — a single third-party decision from breaking **[I]** |
| `cdn.mathjax.org/mathjax/latest/MathJax.js` | `content/help/course-materials.html` **[V]** | **Already dead** — returns a shim that rewrites the script tag to `cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.1/MathJax.js`. Verified by fetching the body **[V]** |
| `stackpath.bootstrapcdn.com` (Bootstrap 4.1.3), `fonts.googleapis.com`, `cdnjs.cloudflare.com` (FontAwesome 5.15.3) | **code.bioconductor.org** head **[V]** | 200 today; StackPath's CDN business has been wound down — a hard dependency of a Bioconductor property on a third party's continued goodwill **[I]** |
| `pubsubhubbub.appspot.com` | `config.yaml:56` (`rss_hub_url`), `scripts/ping_hub.rb`, `scripts/PubSubHubbub-master/` | 200, but vendored copy of an abandoned gem **[V]** |
| `rss.gmane.org` | `config.yaml:94` (`gmane_rss_url`) | **DNS does not resolve** — `Could not resolve host` **[V]** |

Every one of these is a third-party host that can inject script into `bioconductor.org` pages. None use Subresource Integrity on the main site **[V — no `integrity=` attribute on the cdnjs tags in the homepage HTML]**.

### Node toolchain
`package.json` has only linters (eslint 8, stylelint 15, htmlhint, markdownlint) **[V]**. eslint 8 is out of support. Nothing in `package.json` builds anything — the frontend is unbundled, unminified, hand-maintained CSS across 24 separate `<link>` tags on the homepage **[V]**.

### CI actions
`.github/workflows/*` pin `actions/checkout@v3`, `actions/cache@v3`, `actions/setup-node@v3.7.0`, `super-linter/super-linter/slim@v5`, and third-party actions `danburtenshaw/s3-website-pr-action@v2.0.1`, `Reggionick/s3-deploy@v4.0.0`, `mshick/add-pr-comment@v2`, `8398a7/action-slack@v2` — all pinned by mutable tag, not SHA, except one `ruby/setup-ruby@ec02537…` **[V]**. Two of the third-party actions receive `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` **[V, `pr_deploy.yaml`, `staging.yaml`]**. Moot while disabled, but this is what gets re-enabled.

---

## 4. Coupling and duplication

### Navigation and branding: shared nothing
The main site's header (`layouts/components/header.html:15-25`) is a hand-written `<nav>` with six links (About / Learn / Packages / Developers / Funding / Donate) plus a search form **[V]**. It exists only in this repo. Every other property renders its generator's default chrome:

| Property | Header source |
|---|---|
| bioconductor.org | bespoke, `layouts/components/header.html` |
| contributions / workinggroups | bookdown `bs4_book()` sidebar |
| blog / training / eurobioc* | Quarto navbar |
| anvil | pkgdown navbar |
| bioc2026 / biocasia2026 / biocasia2025 | Hugo theme header |
| support | Biostar/Django template |
| code | hand-written Bootstrap 4 |
| BBS reports | none — `<H1>` on bare HTML 4.01 |

CSS-framework scan across the constellation confirms: main site is the **only** one not on Bootstrap **[V]**. Two Hugo versions (0.144.0 and 0.128.0) and two Quarto versions (1.9.38 and 1.10.18, plus 1.5.57 on the 2025 archive) are in production simultaneously **[V]**.

The bookdown default description leaks on two production sites: `"This is a minimal example of using the bookdown package to write a book. The output format for this example is bookdown::gitbook."` on both contributions.bioconductor.org and workinggroups.bioconductor.org **[V]**. Both Hugo conference sites ship `<title>Bioconductor</title>` — the theme's placeholder, not the conference name **[V]** (contrast eurobioc2026, which has a real title).

### Search: four disjoint systems
- Main site: Solr, via `assets/js/search.js:18` pointing at `master.bioconductor.org` **[V]**.
- support: Django/Biostar's own search (search input present) **[V]**.
- contributions, workinggroups: bookdown's client-side index (search input present) **[V]**.
- blog, training, code: **no search input found in the served HTML** **[V]**.

None of them index each other. Searching "how do I submit a package" on bioconductor.org will not find contributions.bioconductor.org, which is where that content now lives.

### Auth: three disjoint systems
Keycloak realm `bioc` for workshop.bioconductor.org **[V]**; Biostar/Django accounts for support **[V]**; gitolite SSH keys for git.bioconductor.org **[V, gitolite banner]**; GitHub identities for everything Pages-hosted. No SSO between them.

### Content duplication and migration debt
`assets/.htaccess:229-282` is **54 redirect rules** moving `/developers/*` content to `contributions.bioconductor.org` **[V]** — a whole documentation section was relocated to a different property, different stack, different repo, and the main site now serves only redirects for it. Meanwhile `content/developers/` is still 468 KB of live pages **[V]**, and the header still has a "Developers" link pointing into it **[V]**. Both surfaces exist; which is canonical for a given topic is unknowable from the outside.

`content/help/course-materials/` (inside the 6.3 MB `content/help/`) overlaps in intent with training.bioconductor.org and with the per-conference sites, all three of which host workshop material **[V, from the inventory]**.

`www.bioconductor.org` and `bioconductor.org` both serve 200 with no canonical link and no redirect **[V]** — every page is duplicated across two hostnames. `assets/.htaccess:52-53` *does* have a www→non-www rule, but it is not taking effect at the CDN (the live host returns 200, not 302) **[V]**, and the rule as written redirects to `http://` — a TLS downgrade — because it hardcodes the scheme instead of using the `%{ENV:proto}` variable defined four lines above at `:7-10` **[V]**.

---

## 5. Operational concerns

### Redirect / rewrite layer
Three separate, overlapping redirect corpora:
1. `assets/.htaccess` — 290 lines: cache headers (`:14-44`), www/trailing-slash normalisation (`:52-63`), OSN archive redirects for BioC 1.8–3.22 (`:66-83`) with a **commented-out S3 fallback kept inline** (`:88-106`) "if ever OSN is unavailable", GCS container redirects (`:112-113`), ~90 Plone-era rules (`:116-223`), 54 contributions.bioconductor.org rules (`:229-282`), and a trailing `## Broken?` `Redirect /bioc2013 https://secure.bioconductor.org/BioC2013` (`:287`) **[V]**.
2. `workshop_rewrites.txt` — **331 additional `RewriteRule` lines**, oldest targets dating to 2002 (`^workshops/2002/Heidelberg02/…`) **[V]**. Not referenced by any build task in the `Rakefile` **[V, grep]** — how it reaches Apache is **[U]**.
3. `migration/redirects.txt` (40 lines) and `migration/plone-sitemap.txt` (1,551 lines) / `migration/sitemap.txt` (2,186 lines) — artefacts of the Plone→nanoc migration documented in `migration/migration.org`, which describes wget-mirroring the old site **[V]**.

`README.md:698-714` ("Optimize redirects") notes the `.htaccess` approach is suboptimal and should be folded into the vhost "before the site is launched". The site launched; the note remains.

### CDN / caching
CloudFront in front of Apache, per `README.cloudfront.md` — but that file's worked example shows `Server: Apache/2.2.12 (Linux/SUSE)` and a date of **19 May 2015**, and points at a specific distribution ID `E1TVLJONPTUXV3` **[V]**. Live headers show `Apache/2.4.52 (Ubuntu)` **[V]** — the doc is a decade stale on the platform it describes.

Cache TTLs are set per file-type in `assets/.htaccess:14-42`: HTML/JS 600s, `PACKAGES*`/`VIEWS` 30s, `.json`/`.js` 600s, `.svg` 30s, `.rss` 300s, `config.yaml` 30s **[V]**. Reasonable. The problem is the paths that bypass it entirely (Solr, §1.3).

### TLS and headers
- `http://bioconductor.org/` → 301 to `https://` **[V]**. Good.
- **No `Strict-Transport-Security` header** on the main site **[V, grep of response headers = 0 matches]**.
- **Zero** of `X-Frame-Options`, `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` **[V, grep = 0 matches]**. With jQuery 1.6.4 and un-SRI'd third-party scripts, a CSP is the one control that would actually contain a compromised CDN.
- `lib/data_sources/biostar_list.rb:20` — `HTTParty.get(url, :verify => false)`. **TLS verification disabled** on a build-time fetch whose output is rendered into `/dashboard/` **[V]**.
- `status.bioconductor.org` presents a certificate that does not cover the name **[V]** — a broken vanity domain in front of a working GH Pages site.
- `git.bioconductor.org` and `chat.bioconductor.org` both report `Apache/2.4.18 (Ubuntu)` **[V]**, the version shipped with Ubuntu 16.04 (standard support ended April 2021, ESM April 2026) **[I]**. They also resolve to **the same IP, 34.192.48.227** **[V, dig]** — one machine serving both. `chat.` does nothing but 302 to a Zulip invite URL, so an EOL-vintage Apache vhost is being kept in the serving path of the canonical package Git host purely to issue a redirect that a DNS CNAME could do.

  **Corroborating signal, and its limit.** `git.bioconductor.org` is the only Bioconductor host probed that **cannot negotiate TLS 1.3** (TLS 1.2 only), while `master.`, `support.` and the apex all do 1.3 **[V, `openssl s_client` against each]**. That is consistent with OpenSSL 1.0.2, i.e. genuinely a 16.04-era userland — a real capability difference, not a banner artifact. **However: the version string alone does NOT establish that the host is unpatched.** Debian/Ubuntu backport security fixes without bumping the upstream version, so a fully-patched ESM box reports `2.4.18` indefinitely. Patch level, ESM status, and the SSH-side configuration (which is what actually matters for Git access — the HTTPS vhost is only the read-only browse interface) are **[U]** and not determinable externally. The defensible statement is: *the supply-chain root of the entire project appears to run an OS past its ESM window, and this warrants an explicit check by someone with shell access.* It should not be reported as a known vulnerability.
- TLS 1.0 and 1.1 are **refused** on `bioconductor.org`, `master.`, `support.` and `git.` **[V]** — the hosts are being maintained at the TLS-config level, so "abandoned" is not the right reading of the above.
- `git.bioconductor.org` serves the **complete gitolite repository listing** — every `packages/<Name>` entry — unauthenticated over HTTPS **[V]**. Public information, but it is an unintended enumeration endpoint.

### Versioned content strategy
Release/devel live as sibling directory trees under `/packages/<x.y>/`, with `release` and `devel` **symlinks** recreated on every build (`Rakefile:94-102`) **[V]**. Consequences: (a) every URL exists in at least three forms (`/packages/3.23/…`, `/packages/release/…`, and after the next release `/packages/3.23/…` becomes the *old* release) — with no `rel=canonical` anywhere in the served HTML **[V, grep of homepage = no match]**; (b) `robots.txt` blocks all three **[V]**; (c) `config.yaml:26-28` limits regeneration to two versions, so anything older is frozen output on disk that no current build could reproduce.

`assets/2.0/` … `assets/2.14/` are still committed in the repo (96 KB for 2.0, ~8 KB each for the rest) **[V]** — landing-page assets for releases from 2007–2014.

### `migration/` and `captcha/` — dead weight
- `migration/` (224 KB) documents a Plone→nanoc migration whose "Result is 1533596 bytes" note and wget script are historical **[V, `migration/migration.org:1-30`]**. `migration/workshop.rb` is executable. Nothing in the `Rakefile` references any of it **[V]**.
- `captcha/` (**1.9 MB**) is a vendored copy of **Securimage** — `securimage.php`, `securimage_play.swf` (**Flash**, dead since 2020), `securimage_show_example.php`, an `audio/` set of 0–9 wav+mp3, a `words/` dictionary, `AHGBold.ttf`, `gdfonts/`, and helper scripts `get_auth_key.cgi`, `get_auth_string.php`, `send_mail.php`, `start_instance.php`, `start_instance.py`, `expire_instances.py`, `update_posters_list.py`, `push.sh` **[V, directory listing]**. This is **PHP and Python in a Ruby static-site repo**, with a `captcha/database/.htaccess` **[V]**. Nothing in the build touches it **[V, grep]**. If any of it is still deployed to a web root, `send_mail.php` and `start_instance.php` are a live remote-attack surface; if it is not deployed, it is 1.9 MB of confusing dead code. Which of the two is the case is **[U]** and worth an urgent answer.

### Other dead code
- `lib/data_sources/gmane_list.rb` (145 lines) + `config.yaml:94` pointing at `rss.gmane.org`, which **does not resolve** **[V]**. Also `lib/data_sources/pipermail_list.rb` (80 lines) for the retired mailing list **[V]**.
- The `biostar_list` data source is registered in `config.yaml:89-97` under a config block whose only key is `gmane_rss_url` — a key the class never reads, since `biostar_list.rb:18` hardcodes the support-site URL **[V]**. Copy-paste residue.
- `Rakefile:295-317` `generate_cf_templates` reads a `cloud_formation/` directory **that does not exist in the repo** **[V]** — and does `eval(s)` on strings extracted from those JSON files **[V, `Rakefile:307`]**.
- `config.yaml:58-79` — 21 hardcoded EC2 AMI IDs for BioC 2.8 through 3.13 (2011–2021) **[V]**.
- `Rakefile:328-337` `task :my_task` — a debugging scratch task **[V]**. `test.txt` (19 bytes) and `TODO.org` (98 bytes) at repo root **[V]**.
- `Rakefile:150`, `:175` branch on `hostname == 'merlot2'` — a machine referenced in `README.md:772` as "transition from merlot2", i.e. already historical **[V]**.
- `layouts/_bioc2015_sponsors.html` … `_bioc2018_sponsors.html` are still referenced (by the archived course-material pages) **[V]** — retained, not dead, but illustrative of the layout directory's accretion (68 files, 46 of them `_partials`).
- `scripts/PubSubHubbub-master/` — a vendored gem source tree, complete with its own `Rakefile`, `spec/`, `VERSION` **[V]**.

---

## 6. Recommendations, ranked

### Tier 1 — broken in production, cheap to fix

| # | Action | Where | Effort |
|---|---|---|---|
| 1 | **Fix the sitemap.** Add `filter :erb` to the sitemap compile rule; add a `Sitemap: https://bioconductor.org/sitemap.xml` line to `robots.txt`. | `Rules:13-15`, `assets/robots.txt` | ~2 lines |
| 2 | **Stop blocking package pages from search engines.** Remove `Disallow: /packages/release/`, `/packages/devel/`, and the current-version entries; keep only genuinely archival prefixes. This is the highest-leverage SEO change available. | `assets/robots.txt:46-49` + siblings | ~5 lines |
| 3 | **Make search work through the CDN**, or make the bypass deliberate. Either configure the CloudFront behaviour for `/solr/*` to forward query strings, or leave `search.js` on the origin and document that `master.bioconductor.org` must stay reachable. Currently it is neither documented nor consistent. | CloudFront config + `assets/js/search.js:18` | hours |
| 4 | **Fix the www→non-www rule's TLS downgrade** — use `%{ENV:proto}` (already defined at `:7-10`) instead of literal `http://`, and confirm it actually fires at the CDN, since `https://www.bioconductor.org/` currently returns 200 rather than a redirect. | `assets/.htaccess:52-53` | 1 line + CDN check |
| 5 | **Re-enable TLS verification** on the build-time support-site fetch. | `lib/data_sources/biostar_list.rb:20` | 1 line |
| 6 | **Decide whether `captcha/` is deployed.** If yes, remove it from the web root today (PHP + Flash + `send_mail.php`). If no, `git rm -r captcha/` (−1.9 MB). | `captcha/` | 1 hour to determine, minutes to act |
| 7 | **Fix or retire `status.bioconductor.org`'s certificate/DNS.** A status page that fails TLS is worse than none. | DNS/GH Pages custom domain | minutes |

### Tier 2 — structural risk, days of work

| # | Action | Where | Rationale |
|---|---|---|---|
| 8 | **Decide the CI story.** Either re-enable the four workflows with their branch triggers corrected from `redesign2023` to `devel`, or delete them and document the staging cron as the pipeline. Leaving four disabled workflows referencing a deleted branch guarantees the next person assumes CI exists. | `.github/workflows/*.yaml` (`staging.yaml:5-7`, `linter.yaml:26`) | Right now a bad commit reaches production in ≤20 minutes with zero gates |
| 9 | **Merge the seven dependabot PRs**, in the order rack → nokogiri → addressable → kramdown → httparty → mechanize → json. They are the cheapest security work available and they are already written. | PRs #208, #182, #177, #89, #194, #83, #64 | Oldest has been open 6 years |
| 10 | **Add `Strict-Transport-Security` and a `Content-Security-Policy`** at the CloudFront/Apache layer. Even a report-only CSP would surface what actually loads. Add SRI to the cdnjs tags. | vhost / `assets/.htaccess`, `layouts/` | The only control that contains a compromised third-party CDN |
| 11 | **Replace the 2009-era jQuery plugins with platform features and delete them.** `jquery.corner.js` → CSS `border-radius`; `jquery.timeago.js` → `Intl.RelativeTimeFormat`; `jquery.tools.min.js` (tooltips) → CSS/`popover`. That removes the hard dependency on jQuery 1.6.4 from those code paths. | `assets/js/`, `layouts/` | −4 unmaintained libraries; jQuery itself can then be upgraded or dropped |
| 12 | **Prune the Gemfile**: drop `twitter`, `hpricot`, `uuid`, `rgl`, `sqlite3`, `descriptive_statistics`, `redis`, `sequel`, `pg`, `pry`, `pry-byebug` unless a caller is identified. Switch `Gemfile:2` to `https://`. Each removed native gem is one less thing blocking a Ruby upgrade. | `Gemfile:2,20,22-24,26-29` | Prerequisite for #13 |
| 13 | **Get off Ruby 2.6.5 / Debian Buster.** Target Ruby 3.2+ and nanoc 4.14. The blockers are `sass` (dead — move to `dart-sass` or plain CSS, and note `content/style/style.sass` is the *only* sass file, 3.4 KB) and `hpricot`. | `Dockerfile:1`, `Gemfile`, `content/style/style.sass` | The Dockerfile already has to point at `archive.debian.org` to build |
| 14 | **Delete the dead build inputs**: `lib/data_sources/gmane_list.rb`, `lib/data_sources/pipermail_list.rb`, `config.yaml:89-97` gmane block, `config.yaml:58-79` AMI IDs, `Rakefile:295-317` (`generate_cf_templates`, whose input directory does not exist and which `eval`s file content), `Rakefile:328-337` (`my_task`), `scripts/PubSubHubbub-master/`, `migration/`, `test.txt`, `TODO.org`. | as listed | ~250 KB and several hundred lines of misleading code |

### Tier 3 — the disjointness, weeks of work

| # | Action | Rationale |
|---|---|---|
| 15 | **Publish a shared header/footer as a versioned artifact** (a CSS+HTML snippet, or a tiny web component) that bookdown/quarto/pkgdown/Hugo sites can each `include`. This is the single change that would make the constellation read as one project. Every one of those generators supports a custom header include. | 10 properties currently render 8 different headers **[V]** |
| 16 | **Consolidate hosting.** Six properties on GitHub Pages, three on Netlify, for identical static output. Pick one. Netlify's only differentiator here is being used by the Hugo conference sites, which could equally be Pages. | Reduces the number of dashboards, DNS records, and failure modes |
| 17 | **Standardise the conference-site template.** Right now BioC/BiocAsia are Hugo (two versions, both shipping the placeholder `<title>Bioconductor</title>`) and EuroBioC is Quarto (two versions). One template, forked per year, would let a fix land once. | **[V]** |
| 18 | **Federate search**, or at minimum add contributions/support/blog to the Solr index. The developer documentation that was moved off the main site (54 redirect rules at `assets/.htaccess:229-282`) is currently unreachable from the main site's search box. | **[V]** |
| 19 | **Fix the bookdown placeholder metadata** on contributions and workinggroups — set `description:` in `_bookdown.yml`/`index.Rmd`. Two production sites currently advertise themselves to search engines and social cards as "a minimal example of using the bookdown package". | **[V]**, 2 lines each |
| 20 | **Resolve the `content/developers/` vs contributions.bioconductor.org split.** Either finish the migration (redirect the rest, delete `content/developers/`, repoint the nav) or stop. 468 KB of live pages coexist with 54 redirect rules pointing elsewhere. | **[V]** |
| 21 | **Reduce `config.yaml`'s release-cycle edit surface** — seven hand-edited locations with no validation (`config.yaml:11,16,26-28,32-36,40-48,52-54,168-169,220,259`). A `rake release:bump 3.24` task that edits them all and validates internal consistency would remove a recurring class of release-day error. | **[V]** |
| 22 | **Break up `lib/helpers.rb` (1,924 lines).** It is the single largest piece of logic in the build and there is no test for any of it. Not urgent, but it is where the next subtle release-time bug will live. | **[V]** |

---

## Appendix: things I could not verify

- ~~Who operates `support.bioconductor.org`, `code.bioconductor.org`, … at the infrastructure level~~ — **partially resolved by DNS/RDAP after this report was drafted; see "Hosting footprint" below.** What remains **[U]** is who *administers* each box and how they deploy, which no external probe can answer.

### Hosting footprint (resolved post-draft)

| Host | Resolves to | Network owner | Note |
|---|---|---|---|
| `bioconductor.org` | 13.226.251.x | **AWS CloudFront** | Only property behind a CDN |
| `master.bioconductor.org` | 52.71.54.154 | **AWS EC2, us-east-1** | True origin; rsync target; Solr host |
| `support.bioconductor.org` | 54.164.10.157 | **AWS EC2, us-east-1** | nginx/1.18.0, Biostar/Django |
| `git.bioconductor.org` | 34.192.48.227 | **AWS EC2** | Apache 2.4.18 + gitolite |
| `chat.bioconductor.org` | 34.192.48.227 | **same machine as git** | Redirect-only vhost |
| `code.bioconductor.org` | 194.94.45.72 | **EMBL Heidelberg, DE** (`EMBL-NET`, RIPE, 194.94.44.0/22) | Not AWS, not GitHub — different institution, different continent |
| `blog.bioconductor.org` | → `bioconductor.github.io` | **GitHub Pages** (Fastly) | Hugo |
| `contributions.bioconductor.org` | → `bioconductor.github.io` | **GitHub Pages** (Fastly) | bookdown |

All verified by `dig` and RDAP on 2026-07-26 **[V]**.

Two structural consequences:

1. **`code.bioconductor.org` is a single-institution dependency.** A user-facing Bioconductor service runs on EMBL Heidelberg hardware while the rest of the estate is AWS us-east-1 or GitHub Pages. Nothing is wrong with it operationally — it responds fine — but continuity rests on one institution's budget and presumably one person's goodwill, and that arrangement does not appear to be written down anywhere in the repo. Combined with the repo being stale since 2025-08-12 and its hard dependency on the wound-down StackPath CDN (§ third-party table), this is the property most exposed to silent disappearance. **Bus-factor question, not a defect.**
2. **CloudFront fronts only the apex.** Every other property is served direct from origin — no edge caching, no shared TLS termination. The HTTP/2 recommendation in `perf-a11y.md` therefore improves `bioconductor.org` and nothing else; the other seven need their own answer. Note that the two GitHub Pages properties are the only ones already getting modern transport, and that is GitHub's doing, not the project's.
- Whether `workshop_rewrites.txt` (331 rules) is actually loaded by Apache, and by what mechanism — nothing in the `Rakefile` installs it.
- Whether `captcha/` is present in any live web root.
- Whether the staging crontab described in `README.md:565-573` still exists as written (the `MAILTO` and paths in that section are the only record).
- Exact CloudFront behaviours/cache-policy configuration — inferred from response headers and `assets/.htaccess` only.
- Whether `assets/js/jsnetworkx.js`, `encrypt.min.js`, `jquery.cookie.js`, `jquery.hotkeys.js` are still referenced by any page.
