# Bioconductor web properties — design system audit

**Date:** 2026-07-25
**Scope:** `bioconductor.org` and sibling properties, visual design and CSS architecture only.
**Source tree audited:** shallow clone of the site source, `assets/style/`, `layouts/`, `assets/js/`.
All source line references were verified against the *served* files — `curl` of
`https://bioconductor.org/style/pages/home.css`, `base/typography.css`, `base/layout.css` and
`components/tables.css` is byte-identical to the clone, so every `file:line` below describes
production.

**Method:** headless Chromium (Playwright) at 390 / 768 / 800 / 1024 / 1250 / 1440 px, measuring
computed styles, scroll/client widths and network payloads on 14 URLs across 6 hosts, plus a
read of all 26 stylesheets. Screenshots in `review/screenshots/`.

---

## Executive summary

The complaint "dated and confusing" is **substantiated, but the diagnosis is not the obvious one.**
The main site is not an old design — its core is a 2023-era flexbox/custom-property redesign with a
genuine token file and an accessibility-focused typeface. What makes it *read* as dated and confusing
is that the redesign was never finished, never enforced, and never extended past the ~12 hand-written
marketing pages, while a 2011 JavaScript stack and a 2003 build-report stack are still shipping
underneath it.

The five findings that matter most:

1. **Nothing on the site looks like a link.** `assets/style/base/typography.css:59-61` sets
   `a { color: black }` globally. On the DESeq2 landing page, **270 of 282 links compute to
   `rgb(0,0,0)` with an underline** — the same colour as body text. Four different link treatments
   coexist on that one page, and `assets/style/sections/footer.css:16-19`
   (`footer * { color:#fff; text-decoration:none }`) strips even the underline from every footer link.
   This single declaration is the largest contributor to "confusing", and it is a one-line fix.

2. **Mobile silently deletes content, and mobile deletes the type hierarchy.**
   `assets/style/base/layout.css:32` sets `.content { overflow: hidden }`. On the DESeq2 page at 390px
   the content box is 342px wide with 475px of content — **133px of the "Details" and
   "Package Archives" tables are clipped off with no scrollbar and no way to reach them**
   (measured, see §5). Separately, `assets/style/pages/learn-and-dev.css:171-173`
   (`.page-container * { font-size: 1rem }`) flattens the whole scale on small screens: on `/help/`,
   `h2` goes 32px → 16px, `h4` 24px → 16px and `p` 20px → 16px, so **headings and body text become
   typographically identical**.

3. **The design system exists but is not wired up.** `base/colors.css` defines 55 tokens; **30 (55%)
   are never referenced**, two more (`--primary-p-300`, `--primary-p-50`) **don't exist at all** yet
   are referenced at 5 call sites, each silently falling back to a hardcoded hex. Meanwhile `#fff` is
   hardcoded 35 times. There are **30 distinct `font-size` declarations across 5 different units**
   (rem/px/pt/%/unitless) and **12 distinct `border-radius` values** — no type scale, no radius scale,
   no spacing scale. Four different breakpoints (768 / 1080 / 1250 / 1450 px) with no shared variable.

4. **245 KB of JavaScript, most of it inert or 15 years old.** Every page loads **jQuery 1.6.4
   (September 2011)**, **`jquery.corner.js` v2.03 dated 05-DEC-2009** — the pre-`border-radius`
   corner-rounding shim, invoked on `.box1` and `ul#uses`, selectors that **exist nowhere in the
   repo** — and **jQuery Tools 1.2.6** (abandoned Flowplayer library). It also downloads
   **highlight.js (121 KB) plus its CDN stylesheet, and then `components/code.css:34-79` overrides
   every syntax token to `color: white`** — 122 KB spent to produce no syntax highlighting.

5. **Nine different visual identities across the properties users actually traverse.** Going
   homepage → package page → build report → vignette → support forum crosses four unrelated designs,
   two of which carry no Bioconductor branding or navigation at all. Seven distinct body font stacks,
   six distinct link colours, five CSS frameworks (§4).

Zero dark-mode support (verified by emulation: `prefers-color-scheme: dark` changes nothing) and
**zero print support — in fact worse than zero**: all 22 project stylesheets are declared
`media="screen"` (`layouts/_sitehead.html:36-64`), so printing any page drops the entire design and
renders unstyled HTML.

---

## 1. CSS architecture

### 1.1 Files and load strategy

26 CSS files in `assets/style/`, **51,062 bytes** on disk. **24 `<link>` tags per page**, 47,596
bytes over the wire, unbundled and unminified. Emitted flat in `layouts/_sitehead.html:32-64`.

| Layer | Files | Bytes |
|---|---|---|
| `base/` | colors, fonts, typography, layout | 5,104 |
| `components/` | blockquote, breadcrumbs, buttons, code, gallery, lists, tables | 7,453 |
| `sections/` | announcement, footer, header, hero, sidebar | 12,795 |
| `pages/` | about, get-started, home, learn-and-dev, orcid, packages | 21,888 |
| legacy | `existing.css`, `workflows.css`, `corners-ie.css`, `tree-widget/!style.css` | 4,710 |

Three structural problems:

- **No conditional loading.** All six `pages/*.css` sheets load on every page.
  `pages/home.css` (11.6 KB, the largest file) ships on `/about/`, on `/developers/`, and on all
  ~2,400 generated package pages. It contains global element selectors — `hr` at
  `pages/home.css:578-584` absolutely-positions *every* `<hr>` on the site at `width: 100vw`.
  (In practice it is neutralised inside `.page-container` by a higher-specificity reset at
  `pages/learn-and-dev.css:22-28`; verified live on `/help/`, computed `position: static`. That fix
  is a specificity patch for a leaked global, and it does not protect pages without
  `.page-container`.)
- **`media="screen"` on all 22 project sheets** (`layouts/_sitehead.html:36-64`). Print output is
  unstyled HTML. This is not "no print stylesheet"; it is an active opt-out.
- **No cache-busting.** Plain filenames, no content hash — a CSS change cannot be safely
  long-cached.

**Dead code shipped or built:**

| File | Status |
|---|---|
| `assets/style/existing.css` | 100 bytes, 2 rules (`.grey_box`, `.white_box`), still first in the load order (`_sitehead.html:33`) |
| `assets/style/corners-ie.css` | 698 bytes, linked from nowhere. Contains the IE6 four-corner-PNG rounding technique (`.rounded_colhead > .tl/.tr/.bl/.br`, `corners-ie.css:6-39`) |
| `assets/style/workflows.css` | 669 bytes, linked from nowhere. Tufte-style sidenotes with `float: right; margin-right: -320px` and `pt` sizes (`workflows.css:21-33`) |
| `content/style/style.sass` | Compiled by an active `filter :sass` rule (`Rules:10,39-40`) and served live at `/style/style.css` (HTTP 200) — linked from no page |

### 1.2 Design tokens

`base/colors.css` is a real token file — 55 custom properties in named ramps
(primary/secondary/warning/error/neutral, 50→500). It is barely used.

```
tokens defined:        55
tokens referenced:     28
never referenced:      30  (55%)
referenced but UNDEFINED: 2
```

**Undefined tokens referenced at 5 call sites** — the name has a stray hyphen and there is no `p300`
step in the ramp at all, so each silently falls through to its hardcoded fallback:

- `--primary-p-300` → `pages/learn-and-dev.css:126`, `:132`, `sections/sidebar.css:138`
- `--primary-p-50` → `pages/home.css:374`, `sections/sidebar.css:108`

Never referenced (30): the entire `--warning-*` ramp (7), the entire `--error-*` ramp minus
`--error-e100` (6), most of `--secondary-*` (5), all four dark code-syntax colours
(`--code-dark-string: #f1c736`, `--code-dark-literal: #13cd13`, …), `--misc-positive`,
`--misc-neutral`, `--misc-pink`, `--misc-annotations`.

The unused code-syntax tokens are telling: the intended syntax-highlighting palette was designed,
tokenised, and then never connected — see §1.5.

**Colour count: 61 distinct hex values** in the stylesheets. ~24 of them are hardcoded *outside*
`colors.css`, dominated by `#fff` (**35 occurrences** across 10 files; there is no `--white` token).
Others: `#f1f1f1` (`components/gallery.css:28`), `#aaaaaa` (`components/code.css:110`),
`#121212` (`sections/footer.css:5` — the footer background, not a token),
`#A6CE39` (`pages/orcid.css:24`), `#3B5998` (`tree-widget/!style.css:32` — the 2011 Facebook blue).

### 1.3 Type scale

**30 distinct `font-size` declarations** across five units:

- rem (17 values): `0.6, 0.8, 0.8125, 1, 1.1, 1.125, 1.2, 1.25, 1.4, 1.5, 1.6, 2, 2.1, 2.25, 2.5, 5`
- px (6): `9, 10, 12, 13, 14, 25`
- pt (6): `7.5, 8, 9, 10, 11.5, 12, 14`
- % (1): `130%`
- unitless line-heights expressed as `%` throughout (`120%`, `130%`, `105%`)

There is no ratio. Rendered on the homepage alone: 12.8, 16, 19.2, 20, 25.6, 32, 80 px — note **19.2
and 20 px both in use**, a 0.8px difference that reads as a mistake rather than a step.

`base/typography.css:2-17` applies `width: fit-content` to all of `h1`–`h6`, which shrink-wraps every
heading. That is what makes the `h1` gradient underline (`typography.css:19-26`) stop at the text —
but it also means headings cannot be centred or aligned by their container.

The 25px at `pages/packages.css:16` (`summary.package-details`) is the only px size in the modern
layer. That same rule declares `font-weight` twice — `700` at line 10, then `1000` at line 17; the
first is dead, and Atkinson Hyperlegible ships only 400/700 so `1000` renders as plain bold.

### 1.4 Fonts

`base/fonts.css:18-20` applies the family with the universal selector:

```css
* { font-family: "Atkinson Hyperlegible", sans-serif; }
```

This is a defensible choice for a scientific site (Atkinson Hyperlegible is the Braille Institute's
legibility-optimised face) but the `@font-face` block has a real bug — `base/fonts.css:5-16` writes
**two separate `src:` descriptors per block**:

```css
@font-face {
  font-family: "Atkinson Hyperlegible";
  src: url("../fonts/AtkinsonHyperlegible-Regular.woff") format("woff");
  src: url("../fonts/AtkinsonHyperlegible-Regular.ttf") format("truetype");
}
```

The second `src` **overrides** the first, so the browser fetches the TTF and never the WOFF.
Measured on the live homepage:

```
200  53,504  /style/fonts/AtkinsonHyperlegible-Regular.ttf
200  54,444  /style/fonts/AtkinsonHyperlegible-Bold.ttf
```

**107,948 bytes downloaded where the WOFFs sitting next to them total 61,440** — a 46 KB / 43% waste
on every uncached load. There is also no `font-display`, so the site takes the default ~3s
invisible-text block.

Only two families render: Atkinson Hyperlegible (405 elements on the homepage) and **Courier**
(12 elements) for code — `components/code.css:10,22` and `pages/home.css:239` all specify
`font-family: Courier, monospace`. Courier maps to Courier New on Windows/Linux, a thin
typewriter face that is the single clearest era-tell in the code blocks. Modern equivalent:
`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.

### 1.5 Syntax highlighting: 122 KB for nothing

The site loads highlight.js 11.7.0 (120,762 bytes of JS) plus `styles/default.min.css` from cdnjs,
then `components/code.css:34-79` sets **every** token class to `color: white`:

```css
.hljs-selector-tag, .hljs-attribute, .hljs-keyword { color: white; }
.hljs-meta, .hljs-regexp, .hljs-variable            { color: white; }
.hljs-symbol                                        { color: white; }
.hljs-string, .hljs-title, .hljs-number, …          { color: white; }
.hljs-literal, .hljs-built_in, .hljs-tag            { color: white; }
```

Only `.hljs-comment` (`lightgrey`, line 56-58) differs. This is why the DESeq2 install block renders
as flat white-on-`#3d4049` (`screenshots/pkg-deseq2-1440.png`). The tokens to fix it
(`--code-dark-string: #f1c736`, `--code-dark-literal: #13cd13`, `--code-dark-operator: #ff8a8a`)
already exist in `colors.css:70-75`, unused.

Also in that file: `components/code.css:36-38` and `:75-79` set `font-weight: 1` — a valid but
meaningless weight that clamps to the lightest available (400).

### 1.6 Specificity, `!important`, dead selectors

`!important` count is low and not a problem: **13 total**, 5 of them inside the vendored
`tree-widget/!style.css`, plus `sections/header.css:205`, `pages/get-started.css:10`.

Dead or ineffective rules found by reading:

- `components/lists.css:12-20` — `li::marker` is given `display`, `margin-right`, `width`, `height`.
  Per spec `::marker` accepts only `content`, `color`, `font-*`, `white-space`, `direction` and
  animation properties. **Four of the seven declarations are silently ignored.**
- `components/lists.css:2-4` — `ul { padding: 0; list-style: none; padding-left: 10px }`: `padding`
  declared twice in one rule.
- `components/lists.css:26-28` — `li:has(p)::before { margin-left: -1.1rem }` styles a pseudo-element
  with no `content`, so no box is generated. Dead.
- `pages/learn-and-dev.css:30-32` — `.page-container li::before { all: unset }` unsets that same
  never-generated pseudo-element. Dead.
- `sections/header.css:32` — `text-decoration: transparent`. Parses as the shorthand, resetting
  `text-decoration-line: none`; the `transparent` does nothing. Works by accident.
- `pages/packages.css:44`, `sections/sidebar.css:43,188`, `pages/learn-and-dev.css:5` —
  `border: 1px solid #0000` (fully transparent) paired with a `background: linear-gradient(...)
  padding-box, var(--gradient-brand) border-box` gradient-border trick. Correct technique, but the
  transparent-border hex is repeated four times instead of being a component class.
- `sections/sidebar.css:57` — `overflow: scroll` (not `auto`), forcing permanent scrollbar gutters.

### 1.7 Layout technique and breakpoints

The core is **modern**: 78 `display: flex`, 7 `display: grid`, only 8 `float:` — and the floats are
concentrated in one place, `pages/packages.css:48-55`, which builds the BiocViews two-column layout
with `float: left; width: 33%` and undoes it at `pages/packages.css:137-140`. That is the one
genuinely float-based layout left in the modern layer.

Breakpoints are the problem — **four of them, none shared, expressed three different ways**:

| Breakpoint | Files | Syntax |
|---|---|---|
| 768px | typography, layout, hero, announcement, footer, home, sidebar, learn-and-dev | `(max-device-width: 768px), (width <= 768px)` |
| 1080px | header.css:158 | `(max-device-width: 1080px), (width <= 1080px)` |
| 1250px | blockquote.css:20, get-started.css:100, home.css:728 | `(max-device-width: 1250px), (width <= 1250px)` |
| 1450px | packages.css:131 | `(max-device-width: 1450px), (max-width: 1450px)` |

Two further issues:

- **`max-device-width` is deprecated** and refers to the *physical screen*, not the viewport. It
  matches on any phone regardless of how the page is actually laid out. It is redundant here (the
  `width <=` half of each comma-list does the real work) and should simply be deleted.
- The header collapses to a hamburger at **1080px** while the content stylesheets don't reflow until
  **768px**. That 312px-wide band is where the layout breaks — see §5.

### 1.8 JavaScript payload

245,226 bytes across 11 files on the homepage:

| File | Bytes | Note |
|---|---|---|
| `highlight.min.js` (cdnjs) | 120,762 | output entirely overridden to white (§1.5) |
| `/js/jquery.js` | 91,668 | **jQuery v1.6.4, September 2011** |
| `/js/bioconductor.js` | 10,792 | |
| `/js/jquery.corner.js` | 8,487 | **v2.03, dated 05-DEC-2009** |
| `/js/jquery.tools.min.js` | 4,496 | **jQuery Tools v1.2.6** (Flowplayer, dead since ~2012) |
| `/js/jquery.timeago.js` | 4,487 | |
| `/js/sidebar.js`, `code_blocks.js`, `bioc-style.js`, `versions.js` | 3,390 | |

`assets/js/bioc-style.js:3-5` is the only caller of the 2009 corner plugin:

```js
jQuery('.box1').corner("5px")
jQuery('abbr.timeago').timeago()
jQuery('ul#uses li').corner("5px")
```

`grep` over `content/` and `layouts/` finds **no `.box1` and no `id="uses"`** — the corner plugin
rounds zero elements. `.rpack` (used by `bioconductor.js:362` for the jQuery Tools tooltip) does
still exist, in `layouts/components/packages/archives.html`.

jQuery 1.6.4 also predates every jQuery XSS fix from 1.9 onward; the CVE-2020-11022/11023
`html()`/`append()` sanitiser issues apply to everything below 3.5.0.

---

## 2. Visual language

### 2.1 The link problem — the biggest single source of "confusing"

`base/typography.css:59-61`:

```css
a {
  color: black;
}
```

Measured on `https://bioconductor.org/packages/release/bioc/html/DESeq2.html`, tallying
`getComputedStyle` over every link in the content region:

| Computed style | Count |
|---|---|
| `rgb(0, 0, 0)` + `underline` | **270** |
| `rgb(7, 7, 7)` + `underline` | 8 |
| `rgb(65, 71, 87)` + no underline (breadcrumbs) | 3 |
| `rgb(3, 87, 113)` + no underline ("See More") | 1 |

98.6% of links on the page are black, distinguished from body text only by an underline — and
`.format-underline` / `.format-boldunderline` (`base/typography.css:110-117`) apply that same
underline to *non-link* text. Four link treatments coexist on one page, and the two colourful ones
are the two rarest.

Reinforcing declarations scattered across the codebase, each re-asserting black:
`pages/home.css:82-84`, `pages/get-started.css:27`, `:72-74`, `components/gallery.css:19-22`,
`sections/sidebar.css:73`, `:112`.

The footer inverts the convention entirely — `sections/footer.css:16-19`:

```css
footer * {
  color: #fff;
  text-decoration: none;
}
```

Every footer link is white, unbolded, unlined, on `#121212`. Nothing distinguishes a link from the
column headings above it except position (`screenshots/home-1440.png`, bottom). So the same page
teaches two contradictory rules: *underlined black = link* in the body, *plain white = link* in the
footer.

The brand already owns a usable link colour — `--primary-p400: #035771` gives 8.6:1 on white and
is the colour the one working "See More" link uses.

### 2.2 Gradients — five, in three unrelated hue families, all on the homepage

`base/colors.css:62-67` defines:

| Token | Value | Family |
|---|---|---|
| `--gradient-brand` | `#0087af → #0484a9 → #18a603` | teal → green (brand) |
| `--gradient-brandreverse` | reverse of the above | brand |
| `--gradient-warmcool` | `#ff2f4b → #4e5cff` | **red → blue** |
| `--gradient-reversewarmcool` | reverse | **red → blue** |
| `--gradient-purpleblue` | `#445cf3 → #a333f1` | **blue → purple** |

All three families appear on the homepage simultaneously: the announcement bar and hero button use
the brand gradient (`sections/announcement.css:38-42`, `components/buttons.css:36-46`), the
"Need some help?" chip uses purple→blue (`pages/home.css:178-187`), and `.warmcool-gradient-border`
(`pages/home.css:61-67`) plus `.warmcool-gradient` (`pages/get-started.css:31-37`) put a red→blue
border on install content. Two of these have no relationship to Bioconductor's identity.

Gradients are additionally used as **borders** (`typography.css:22-24` `border-image` under every
`h1`; `footer.css:7-9` a 10px gradient top border; four `padding-box/border-box` gradient-border
tricks) and as **text fill** (`hero.css:21-26`, `home.css:546-550`,
`about.css:26-30` — three separate copies of the same `-webkit-background-clip: text` block).

Era-tell: gradient-as-decoration on borders, chips, buttons and headline text simultaneously is a
2012-era visual habit. Reducing to one brand gradient used in one place would modernise the page
more than any other single change.

### 2.3 Iconography — three unrelated systems

1. **Custom SVG line-art** — `/images/icons/svgs/arrow-circle-right-blue.svg`,
   `chevron-right-n400.svg`, `chevron-down.svg`, applied as CSS `background-image`
   (`components/breadcrumbs.css:16`, `pages/learn-and-dev.css:108`, `pages/packages.css:11`,
   `sections/sidebar.css:128`).
2. **Raw emoji as headings and list bullets.** DOM inspection of the homepage finds
   U+1F4D6 📖, U+1F4E3 📣, U+1F4AC 💬, U+1F4A1 💡 as standalone `<p>` content, and
   `<h3>🗓️ Events</h3>`. These render as full-colour OS emoji at different sizes, weights and
   colours than the flat teal SVG set beside them, and differ per platform.
   *(In `screenshots/home-1440.png` they appear as boxes; that specific artefact is this headless
   container lacking an emoji font, not what users see. The finding is the mixed icon system, not
   the tofu.)*
3. **Hand-drawn marker "doodles"** — `/images/…` annotations reading "Start using Bioconductor now!"
   and "Learn more about Bioconductor" with sketched arrows, positioned by
   `pages/home.css:93-108` with a literal `margin-top: 280px`. A comic/handwriting voice sitting
   inside an otherwise formal scientific layout.

### 2.4 Shape, elevation, spacing

**Border radius — 12 declared values, no scale:** `3px, 4px, 5px, 8px, 25px, 0.25rem, 0.5rem, 4rem,
8rem, 16rem, 50%, 0%`. Seven distinct radii render on the homepage alone (64, 128, 256, 25, 8, 4 px
and 50%). Pills at `4rem`, `8rem` and `16rem` are visually identical yet declared three ways;
`border-radius: 0%` at `sections/header.css:228` is a no-op written as a percentage.

**Elevation:** four `box-shadow` declarations total. Two are the same six-layer stack copy-pasted
verbatim (`pages/get-started.css:34-36` and `:79-81`). The other two are `inset` shadows used to fake
radio-button fills (`pages/home.css:517,530`). There is effectively no elevation system — cards are
distinguished by borders, and by *four different border treatments* on the homepage: a green 1px
border, a blue 1px border, a gradient 2px border, and borderless white cards.

**Spacing:** no scale. Padding values in `pages/home.css` alone include `0.3rem, 0.55rem, 0.6rem,
0.62rem, 0.63rem, 0.7rem, 0.73rem, 0.75rem, 0.8rem, 0.93rem, 1rem, 1.1rem, 1.25rem, 1.5rem, 2rem,
4rem` plus `12px`, `18px`, `280px`. Values like `0.62rem` and `0.63rem` (9.92px and 10.08px) exist
side by side.

**Magic fixed widths** — the brittleness that breaks the tablet band (§5):
`pages/home.css:79` `.data-scientist-content { width: 49rem }`,
`:221` `.developer-content { width: 53rem }`,
`:191,197` chips at `max-width: 51rem` / `55rem`,
`:555` `.join-img-div { width: 400px }`,
`pages/learn-and-dev.css:39` `.page-intro { width: 24.188rem }`,
`pages/get-started.css:122` `.install-section { width: calc(100vw - 350px) }`,
`sections/header.css:181` `.header-nav.active { height: 21rem }`,
`sections/sidebar.css:196` `.sidebar-nav.open { height: calc(100% + 19rem) }`.

The last two are hardcoded menu heights inside `overflow: hidden` containers — adding one nav item
will clip the menu with no visible symptom in code review.

**Line length:** there is no measure constraint anywhere. `base/layout.css:7-11` sets
`.container { max-width: 1400px }` and nothing narrows prose inside it. On
`screenshots/pkg-deseq2-1440.png` the DESeq2 description and the Author list run the **full ~1350px**
— roughly 200 characters per line, against the 45-90 that typographic practice and WCAG 1.4.8
suggest. This is the most-visited page type on the site.

### 2.5 Where the "dated" reading actually comes from

Ranked by how strongly each cues an era, all verified above:

| Signal | Evidence | Era cued |
|---|---|---|
| jQuery 1.6.4 + `jquery.corner.js` (2009) + jQuery Tools shipping on every page | network capture, §1.8 | 2009-2011 |
| Courier as the code face | `components/code.css:10,22` | pre-2010 |
| Unstyled `#0000EE` link blue + peach `#f7e1d7` + zebra tables on build reports | `report.css`, §4 | 2003 |
| HTML 4.01 Transitional, `<BODY onLoad=…>`, uppercase tags on `/checkResults/` | source, §4 | 2003 |
| jQuery UI 1.10.4 "smoothness" + jsTree "apple" theme on the package index | `BiocViews.html` sheet list, §4 | 2014 / 2010 |
| Gradients on borders, buttons, chips and headline text at once | §2.2 | 2012 |
| Emoji used as iconography | §2.3 | 2016-2019 |
| 200-character line length on package pages | §2.4 | pre-responsive |
| No dark mode | §6 | pre-2019 |

Note what is **not** in that list: the layout technique (flexbox/grid, modern), the typeface choice
(deliberate and good), the token file (right idea), and the responsive intent. The bones are fine.

---

## 3. Internal inconsistency within `bioconductor.org`

Measured with identical probes across pages of the same site:

| Page | `body` background | Notes |
|---|---|---|
| `/` | `#f9f9f9` | `base/layout.css:4` |
| `/help/` | `#f9f9f9` | |
| `/developers/` | `#f9f9f9` | |
| `/about/` | **`#ffffff`** | |
| `/install/` | **`#ffffff`** | |
| `/packages/release/bioc/html/DESeq2.html` | **`#ffffff`** | |

The page background changes between top-level sections with no editorial reason.

Heading treatment is inconsistent on a single page: on the DESeq2 landing page the `h1` ("DESeq2")
carries the gradient underline from `typography.css:19-26`, while the `h2` immediately below it
("Differential gene expression analysis based on…") — visually the more important line — has no
treatment at all.

Component duplication: `sections/header.css:100-142` (`.header-button` / `.get-started`) is a
near-verbatim copy of `components/buttons.css:59-100` (`.brand-border-button` / `.span-brand`),
differing only in a fixed `height`/`width`. Four button classes exist in total
(`.white-button`, `.button-hero`, `.brand-border-button`, `.header-button`) with no shared base.
`.white-button` is additionally locked to `min-height: 20px; max-height: 20px`
(`components/buttons.css:4-5`) — below the 24×24px minimum target size in WCAG 2.5.8, and it will
clip its own text if the label wraps.

Two different techniques for the same custom-radio pattern in one file: `pages/home.css:7-9` hides
the input with `display: none` (which makes it **unfocusable by keyboard** — the "For Users /
For Developers" tabs cannot be operated without a mouse), while `pages/home.css:514-535` uses
`appearance: none` for the join tabs (correctly focusable).

---

## 4. Cross-property consistency

There is **no shared design system**. Nine distinct treatments, measured:

| Property / surface | Framework | Body font | Size | Link colour | Bioc header/nav? |
|---|---|---|---|---|---|
| `bioconductor.org` | hand-rolled, 24 sheets | Atkinson Hyperlegible | 16px | `#000` underlined | yes |
| `bioconductor.org/checkResults/` | **none** — `<body style="font-family: sans-serif">` | UA sans-serif | 16px | `#0000EE` | **no** |
| build reports (`/checkResults/3.24/bioc-LATEST/`) | `report.css`, 12.5 KB standalone | sans-serif | **11pt** | `#0000EE` | **no** |
| package vignettes (`…/vignettes/DESeq2/…`) | R Markdown `html_document`, Bootstrap 3 | Helvetica Neue | **14px** | `#337ab7` | **no** |
| `packages/release/BiocViews.html` | main site **+ jQuery UI 1.10.4 "smoothness" + jsTree "apple" theme** | Atkinson Hyperlegible | 16px | `#000` | yes |
| `support.bioconductor.org` | Biostar / Bootstrap 3 | Helvetica Neue | **13px** | blue | logo only |
| `contributions.bioconductor.org` | bookdown `bs4_book`, Bootstrap 4.6 | system stack | **18px** | `#00758a` | **no** |
| `blog.bioconductor.org` | Quarto, Bootstrap 5 | Open Sans | **17px** | — | **no logo at all** |
| `bioc2026.bioconductor.org` | **Bootstrap 3.3.7** + `owl.carousel` + `animate.css` | Roboto (Google Fonts) | 16px | `#467fbf` | **no** |
| `eurobioc2026.bioconductor.org` | Quarto, Bootstrap 5 | Nunito Sans | **17px** | — | **no** |

That is **seven distinct body font stacks, six body sizes from 11pt to 18px, and five CSS
frameworks** across properties a single user crosses in one task.

Specific observations:

- **`/checkResults/`** (`screenshots/buildreport-1440.png`) is the most jarring. It serves
  `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">`, uppercase `<HTML> <HEAD> <A>
  <B> <TABLE>`, `<BODY onLoad="initialize();">`, `&nbsp;`-based spacing, and `report.css` written
  with uppercase selectors (`BODY {}`, `H1 {}`, `TABLE.grid_layout TD {}`) and `pt` sizes on a
  `#f7e1d7` peach background. It has **no viewport meta tag**, no logo, no navigation, and no link
  back to the site. A maintainer arriving from a build-failure email has no visual indication they
  are on bioconductor.org.
- **Package vignettes** are the primary technical documentation on the site — 0 external stylesheets,
  no site chrome, R Markdown's 2013 Bootstrap 3 default. The DESeq2 vignette is a 2.95 MB
  self-contained HTML file.
- **`blog.bioconductor.org`** carries no Bioconductor logo at all, only the wordmark as text.
- **`contributions.bioconductor.org` has a working dark-mode toggle** (visible bottom-right in
  `screenshots/contrib-1440.png`) — the sibling doc site supports a feature the flagship site does
  not.
- **`bioc2026.bioconductor.org`** is a Bootstrap 3.3.7 template with `owl.carousel` and
  `animate.css` — a stock ~2016 conference theme.
- On `support.bioconductor.org` the front page currently shows three spam threads above the fold
  (`screenshots/support-1440.png`). Not a design defect, but it is part of the first impression on
  the property most new users reach.

The only consistent element across properties is the logo mark, and even that is absent from two.

---

## 5. Responsive behaviour

Tested at 390, 768, 800, 1024, 1250, 1440 px.

### 390px — homepage: fine. Generated pages: broken.

The homepage reflows correctly to a single column with **zero horizontal overflow**
(`documentElement.scrollWidth === clientWidth === 390`). See `screenshots/home-390.png`.

The DESeq2 package page does not. Measured:

```
.content        clientWidth 342   scrollWidth 475   overflow: hidden
table.full-width  clientWidth 434 (parent client 342)
pre code        clientWidth 338   scrollWidth 454   overflow-x: auto   ← this one is fine
```

**133px of the "Details" and "Package Archives" tables is clipped and unreachable** — no scrollbar,
no wrap. `screenshots/pkg-deseq2-390.png` shows it directly: biocViews truncated mid-word at
"…Sequ", the Imports row cut at "MatrixGenerics", every URL in Package Archives cut mid-path.

Two causes, both one-line:

1. `assets/style/base/layout.css:32` — `.content { overflow: hidden }` clips instead of scrolling.
2. `assets/style/components/tables.css:38-40` — `table.full-width tr *:first-child { width: 15.5rem }`
   reserves **248px of a 342px content box (73%)** for the label column, on top of
   `td { padding: 1rem }` (`tables.css:1-5`). `components/tables.css` contains no media query at all.

### 769–1080px — the worst band, and it is not tested by anyone

At **800px** (`screenshots/home-800.png`) the header has already collapsed to the hamburger
(breakpoint 1080px, `sections/header.css:158`) but the content stylesheets have not reflowed
(breakpoint 768px). Result:

```
viewport 800   .data-scientist-content width 848px, right edge 850px   → 50px overflowing
39 elements extending past the viewport
```

The `<h2>` "Create bioinformatic solutions with Bioconductor" is visibly clipped at the right edge in
the screenshot. Cause: the fixed `width: 49rem` / `53rem` at `pages/home.css:79,221`, which only
gets overridden below 768px (`pages/home.css:594-601`).

### All widths — the sidebar/subnav grid

`base/layout.css:17-22` hardcodes `grid-template-columns: 300px 1fr`. `pages/get-started.css:122`
independently hardcodes the same assumption as `width: calc(100vw - 350px)`. Two magic numbers for
one relationship, 50px apart, in different files.

### Type hierarchy collapse below 768px

`assets/style/pages/learn-and-dev.css:171-173`:

```css
@media (max-device-width: 768px), (width <= 768px) {
  .page-container * { font-size: 1rem; }
}
```

Measured on `/help/`:

| Element | 1440px | 390px |
|---|---|---|
| `h2` "Find out all you need to…" | 32px | **16px** |
| `h4` "Learn" | 24px | **16px** |
| `h4` "Packages" | 24px | **16px** |
| `p` "Whether you're a new use…" | 20px | **16px** |

Every heading and paragraph inside `.page-container` becomes the same size on mobile. Headings remain
bold, so hierarchy is not *gone*, but the three-level scale collapses to one — which is exactly what
"confusing" looks like on a phone. `base/typography.css:63-97` already defines proper mobile heading
sizes (2.1rem / 1.5rem / 1.4rem / 1.25rem / 1.125rem / 1.1rem); the universal selector in
`learn-and-dev.css` overrides all of them.

Two more from the same block: `pages/learn-and-dev.css:175-177` caps every link inside
`.page-container` at `max-width: 16rem` on mobile, and `pages/learn-and-dev.css:194-196` hides the
`.learn-chevron` affordance entirely.

### Non-responsive by construction

`/checkResults/` and the build reports have **no `<meta name="viewport">`** at all, so mobile
browsers render them at a 980px virtual viewport and scale down. On a 390px phone the build report
status glyphs are ~5px tall.

### Scroll affordance

`pages/home.css:326-344` builds the Events row as a `width: 100vw` horizontal scroller with the
scrollbar deliberately removed (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }`).
At 1440px the fourth card is cut mid-card at the viewport edge with no arrows, no dots on the
scroller itself and no visible scrollbar — measured, 9 elements extend to x=1840 in a 1440px viewport.
There is no way to tell the row scrolls. `width: 100vw` also includes the scrollbar gutter, a
classic source of unintended horizontal scroll.

---

## 6. Dark mode, print, reduced motion

**Dark mode: absent.** Zero `prefers-color-scheme` blocks in any of the 26 stylesheets. Verified by
emulation — with `prefers-color-scheme: dark`, `body` background stays `rgb(249,249,249)` and text
stays `rgb(7,7,7)`. There is no `<meta name="color-scheme">` and `document.documentElement`'s
computed `color-scheme` is `normal`, so form controls and scrollbars also stay light-themed inside a
dark OS. Screenshot: `screenshots/home-1440-darkmode.png` (identical to the light capture).

The token file makes this much cheaper than it looks — the ramps are already named by lightness step.

**Print: actively broken.** All 22 project stylesheets carry `media="screen"`
(`layouts/_sitehead.html:36-64`), so printing or "Save as PDF" from any page drops the entire
design and produces unstyled HTML — no layout, no type scale, no colour. Screenshot with print
emulation: `screenshots/home-1440-print.png`. There are also zero `@media print` rules anywhere.
For a site whose content is protocols, install instructions and package documentation that
researchers print and archive, this is a real functional gap, not a nicety.

**Reduced motion: partially supported, and better than average.** Three blocks exist:
`components/buttons.css:102-110` and `pages/home.css:714-726` correctly use
`(prefers-reduced-motion: reduce)`; `sections/header.css:269-273` uses the bare
`@media (prefers-reduced-motion)` form, which is equivalent in practice but inconsistent.
Coverage is incomplete — `sections/sidebar.css` (4 transitions), `pages/learn-and-dev.css`
(3, including `transform: translateX`) and `components/gallery.css:41-43` (the `rotateY(180deg)`
card flip, the most motion-sensitive effect on the site) are not covered.

**Other accessibility observations** (not a full audit, but they bear on the visual design):

- `pages/home.css:7-9` `.tab-radio { display: none }` makes the homepage "For Users / For Developers"
  tabs keyboard-unreachable.
- `components/buttons.css:4-5` `.white-button` at a locked 20px height is under the WCAG 2.5.8
  24×24px target minimum.
- `layouts/_sitehead.html:3` and `:7` declare **two conflicting `<meta name="viewport">` tags**
  (`initial-scale=1.0` and `initial-scale=1`).
- `base/layout.css:52-62` does define a correct `.sr-only` utility — screen-reader affordances were
  thought about.

---

## 7. Modernization plan

Framed for a volunteer-maintained scientific project. This is not a rebrand — the existing identity,
typeface and token structure are worth keeping. Roughly 80% of the "dated and confusing" reading
comes from Tier 1, which is a few hours of work in files that already exist.

### Tier 1 — cheap wins, hours not weeks, no redesign

| # | Change | File:line | Effect |
|---|---|---|---|
| 1 | `a { color: black }` → `color: var(--primary-p400)`; keep underlines | `base/typography.css:59-61` | Links become identifiable sitewide. Fixes ~270 links on every package page. Also delete the re-assertions at `pages/home.css:82-84`, `pages/get-started.css:27,72-74`, `components/gallery.css:19-22`, `sections/sidebar.css:73,112`. **Highest impact per character changed on the whole site.** |
| 2 | Delete `.page-container * { font-size: 1rem }` | `pages/learn-and-dev.css:171-173` | Restores the mobile type scale already defined in `base/typography.css:63-97`. Three-line deletion. |
| 3 | `.content { overflow: hidden }` → `overflow-x: auto`; add a media query dropping `table.full-width tr *:first-child { width: 15.5rem }` below 768px | `base/layout.css:32`, `components/tables.css:38-40` | Stops silently deleting 133px of package metadata on phones. |
| 4 | Fix the `@font-face` `src` (comma-separated fallback list, not two `src:` lines); add `font-display: swap`; generate WOFF2 | `base/fonts.css:5-16` | Saves 46 KB/page immediately, ~80 KB with WOFF2. Removes the invisible-text flash. |
| 5 | Remove `media="screen"` from all 22 `<link>` tags | `layouts/_sitehead.html:36-64` | Printing produces a designed page instead of unstyled HTML. Pure deletion. |
| 6 | Drop `jquery.corner.js` and `bioc-style.js`; drop `jquery.tools.min.js` after replacing the one `.rpack` tooltip with `title`/CSS | `layouts/` script tags, `assets/js/bioc-style.js` | −13 KB and removes the two clearest era-tells from the network tab. The corner plugin currently targets zero elements. |
| 7 | Either wire up the existing `--code-*` syntax tokens or drop highlight.js entirely | `components/code.css:34-79`, `base/colors.css:70-75` | Currently 122 KB for monochrome output. Either choice is an improvement; dropping it is the lazier one. |
| 8 | `font-family: Courier, monospace` → `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | `components/code.css:10,22`, `pages/home.css:239` | Single biggest visual modernisation of the code blocks. |
| 9 | Add `max-width: 70ch` to prose containers on package/generated pages | `base/layout.css` (`.content`) | Fixes the 200-character line length on the most-visited page type. |
| 10 | Fix the two undefined tokens; add `--white: #fff` and replace the 35 hardcoded instances | `pages/home.css:374`, `sidebar.css:108,138`, `learn-and-dev.css:126,132` | Correctness; prerequisite for dark mode. |
| 11 | Delete `corners-ie.css`, `workflows.css`, `content/style/style.sass` + its `Rules:39-40` filter; inline `existing.css`'s two rules and delete it | repo | Removes four dead artefacts including the IE6 corner shim. |
| 12 | Add `<meta name="color-scheme" content="light dark">` | `layouts/_sitehead.html` | One line; makes form controls and scrollbars behave in dark OS themes even before a dark theme exists. |

### Tier 2 — a week or two, still no redesign

13. **Bundle the CSS.** 24 `<link>` tags → one hashed file. There is already a `Rakefile` and a
    `package.json`; concatenate + minify in the existing build and add a content hash for
    cache-busting. Also stop loading all six `pages/*.css` on every page — at minimum, move the
    global `hr` rule out of `pages/home.css:578-584`.
14. **One breakpoint variable set.** Collapse 768/1080/1250/1450 to two or three shared values and
    delete every `max-device-width` clause. Fix the 769-1080px band specifically: replace the fixed
    `width: 49rem` / `53rem` (`pages/home.css:79,221`) with `max-width` + `width: 100%`.
15. **Radius, spacing and type scales as tokens.** 12 radii → 3 (`--radius-sm/md/pill`); 30 font
    sizes → a 6-step scale; the ad-hoc `0.62rem`/`0.63rem` padding values → a 4/8px-based spacing
    ramp. Mechanical, and it makes every later change cheaper.
16. **One button component.** Delete `sections/header.css:100-142` and reuse
    `components/buttons.css:59-100`. Give `.white-button` a real min-height (≥24px, ideally 44px).
17. **Retire two of the three gradient families.** Keep `--gradient-brand`; remove `warmcool` and
    `purpleblue` and their five call sites. Reduce gradient usage to the announcement bar and primary
    button only — no gradient borders, no gradient headline text.
18. **Pick one icon system.** Replace the homepage emoji (§2.3) with the existing SVG set, or commit
    to emoji everywhere. Retire the hand-drawn doodles or make them a deliberate, consistent motif
    rather than two one-offs on the homepage.
19. **Dark mode.** With Tier-1 #10 and #15 done, this is a `@media (prefers-color-scheme: dark)`
    block remapping ~15 tokens. The colour ramps are already lightness-indexed.
20. **Keyboard fixes:** `.tab-radio { display: none }` → `appearance: none` + `.sr-only`
    (`pages/home.css:7-9`), matching what `pages/home.css:514-535` already does correctly.
    Extend `prefers-reduced-motion` to `sidebar.css`, `learn-and-dev.css` and the `gallery.css:41-43`
    card flip.
21. **Upgrade or remove jQuery 1.6.4.** The remaining usage in `bioconductor.js` and `sidebar.js` is
    small; modern DOM APIs cover it. This is a security item as much as a design one.

### Tier 3 — the real project, and the only thing that fixes "one Bioconductor"

22. **Give the generated pages the site chrome.** `/checkResults/`, the build reports and the package
    vignettes are high-traffic destinations with no header, no navigation, no branding and (for the
    first two) no viewport meta. Wrapping build reports in the standard header/footer and adding a
    viewport tag would be the single biggest consistency gain available, and it is a template change
    in the build-report generator, not a redesign. `report.css` (12.5 KB, uppercase selectors, `pt`
    sizes, `#f7e1d7`) can then be reduced to a table-status colour map that consumes the site tokens.
23. **Publish `base/colors.css` + a type/spacing scale as a tiny shared CSS package** and consume it
    from `blog.` and `eurobioc.` (Quarto: a `styles.css` import), `contributions.` (bookdown: a CSS
    include) and `support.` (Django static override). None of these need to change framework — they
    each need ~20 tokens and one header partial. That converts nine identities into "four frameworks,
    one look".
24. **Retire the 2016 Bootstrap 3 conference template** (`bioc2026.bioconductor.org`) in favour of
    the Quarto pattern already used by `eurobioc2026`, which is closer to the main site and easier
    for volunteers to maintain.
25. **Replace the jQuery UI 1.10.4 / jsTree "apple" browsing widget** on
    `packages/release/BiocViews.html` and delete `assets/style/tree-widget/!style.css` (silver/Georgia
    headings, `-moz-border-radius`, Verdana 9px, fixed `width: 780px`). This is the primary package
    discovery surface and is the oldest-looking thing a new user meets. A `<details>`-based tree plus
    the existing search covers it with no dependency.

### What not to do

Do not rebrand, do not change the typeface, do not adopt a CSS framework, and do not rewrite the
token file — those are the parts that are already right. The gap is enforcement and reach, not taste.

---

## Appendix — screenshots

All under `review/screenshots/`, captured with headless Chromium at `deviceScaleFactor: 1`.

| File | What it shows |
|---|---|
| `home-1440.png` | Homepage desktop, full page — black links, three card border styles, three gradient families, mixed iconography |
| `home-800.png` | **Tablet break** — `h2` clipped at the right edge, hamburger already active |
| `home-390.png` | Homepage mobile — reflows correctly |
| `home-1440-darkmode.png` | `prefers-color-scheme: dark` — identical to light |
| `home-1440-print.png` | Print emulation — design dropped (`media="screen"`) |
| `pkg-deseq2-1440.png` | Package page — 200-char line length, monochrome code block, single coloured link |
| `pkg-deseq2-390.png` | **Content clipping** — tables truncated mid-word, unreachable |
| `biocviews-1440.png` | Package index — jQuery UI / jsTree widget |
| `buildreport-1440.png` | Build report — 2003 stack, no site chrome, `#0000EE` links, peach background |
| `checkresults-1440.png`, `checkresults-390.png` | Build results index — no stylesheet, no viewport meta |
| `support-1440.png`, `support-390.png` | Support forum — Bootstrap 3, Helvetica 13px |
| `contrib-1440.png` | Contributions book — bookdown, no Bioc chrome, has a dark-mode toggle |
| `blog-1440.png` | Blog — Quarto, no logo |
| `conf-bioc2026-1440.png`, `conf-eurobioc2026-1440.png` | Conference sites — Bootstrap 3.3.7 vs Quarto |
| `about-1440.png`, `help-1440.png`, `install-1440.png`, `developers-1440.png`, `news-release-1440.png`, `vignette-1440.png` | Section pages and generated documentation |
