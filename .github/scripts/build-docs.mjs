// Builds the website's document pages (changelog/, security/, relay/, and the
// legal pages privacy/, terms/, refund/, delivery/, contact/) from the
// repository's own Markdown, so the public site never links into the private
// repository. Run by the Website workflow before deploying, or locally with
// `npm run build:docs`. The output folders are generated, not committed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "https://github.com/BigMatrixLab/Bifrost";

const PAGES = [
  {
    src: "CHANGELOG.md",
    out: "changelog",
    title: "Changelog",
    nav: "Changelog",
    description: "Every Bifrost release and what changed in it.",
  },
  {
    src: "SECURITY.md",
    out: "security",
    title: "Security policy",
    nav: "Security",
    // The footer also links to the home page's Security section.
    footer: "Security policy",
    description: "How Bifrost protects your files, and how to report a security problem.",
    // The repository's reporting form is private; the site can't send people there.
    replace: [
      [
        /Report privately through GitHub:\s*\*\*\[Report a vulnerability\]\([^)]*\)\*\*/,
        "A private address for security reports will be listed here soon. Until then, please keep the details to yourself rather than posting them anywhere public.",
      ],
    ],
  },
  {
    src: "docs/RELAY.md",
    out: "relay",
    title: "Relay guide",
    nav: "Relay guide",
    description: "Get full speed when a direct connection is blocked: router settings, or your own relay server.",
  },
  // Legal and business pages: listed in the footer only, not the top bar.
  {
    src: "docs/legal/PRIVACY.md",
    out: "privacy",
    title: "Privacy policy",
    nav: "Privacy",
    footer: "Privacy policy",
    legal: true,
    description: "What the Bifrost app and website send, to whom and why, and what never leaves your device.",
  },
  {
    src: "docs/legal/TERMS.md",
    out: "terms",
    title: "Terms and conditions",
    nav: "Terms",
    legal: true,
    description: "The terms for using Bifrost, its website and the Pro subscription.",
  },
  {
    src: "docs/legal/REFUND.md",
    out: "refund",
    title: "Refund and cancellation policy",
    nav: "Refunds",
    legal: true,
    description: "How to cancel Bifrost Pro and when you can get your money back.",
  },
  {
    src: "docs/legal/DELIVERY.md",
    out: "delivery",
    title: "Delivery policy",
    nav: "Delivery",
    legal: true,
    description: "How the Bifrost app and the Pro subscription are delivered.",
  },
  {
    src: "docs/legal/CONTACT.md",
    out: "contact",
    title: "Contact",
    nav: "Contact",
    footer: "Contact details",
    legal: true,
    // Not in the top bar's menu; the footer lists it with the legal pages.
    navHidden: true,
    description: "How to reach the people behind Bifrost for support, billing, privacy and security.",
  },
];

// Business details used by the legal pages ({{key}} in their Markdown).
// Until a value is filled in, the page shows the bracketed placeholder and
// the build prints a warning.
const BUSINESS = {
  company: "Big-Matrix Solutions",
  address: "[Registered address]",
  email: "[support email address]",
  processor: "[payment provider]",
  jurisdiction: "[country or state]",
  refund_days: "[number of]",
};

// Repository files with a page on the site. A link to any other file in the
// private repository keeps its text and loses the link.
const HOSTED = Object.fromEntries(PAGES.map((p) => [p.src, `../${p.out}/`]));

function target(href, from) {
  if (href.startsWith("#") || href.startsWith("mailto:")) return href;
  // "site:#pricing" points into the home page.
  if (href.startsWith("site:")) return `../${href.slice(5)}`;
  let path = null;
  if (href.startsWith(`${REPO}/blob/main/`)) path = href.slice(`${REPO}/blob/main/`.length);
  else if (href === REPO || href.startsWith(`${REPO}/`) || href.startsWith(`${REPO}#`)) return null;
  else if (/^[a-z]+:/i.test(href)) return href;
  else path = posix.normalize(posix.join(posix.dirname(from), href));
  const [file, hash] = path.split("#");
  return HOSTED[file] ? HOSTED[file] + (hash ? `#${hash}` : "") : null;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function page({ title, description, out }, body) {
  return `<!doctype html>
<html lang="en" class="doc-root" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(title)} · Bifrost</title>
    <meta name="description" content="${esc(description)}" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#050506" />
    <link rel="icon" type="image/png" sizes="32x32" href="../assets/favicon-32.png" />
    <link rel="icon" type="image/svg+xml" href="../assets/bifrost-mark.svg" />
    <link rel="apple-touch-icon" href="../assets/icon-256.png" />
    <link rel="canonical" href="https://getbifrost.pages.dev/${out}/" />
    <link rel="preload" href="../assets/fonts/space-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="preload" href="../assets/fonts/rajdhani-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="../style.css" />
    <script src="../glide.js" defer></script>
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    <header class="doc-top">
      <div class="wrap doc-top-inner">
        <a class="brand" href="../" aria-label="Bifrost home"><img class="brand-mark" src="../assets/bifrost-mark.svg" width="24" height="24" alt="" /><span>Bifrost</span></a>
        <!-- PCs: the pages sit in the bar. Phones: the menu button opens them
             as a list under the bar, like the home page's menu. -->
        <nav class="doc-nav" id="doc-menu" aria-label="Pages" data-glide=":scope > a, :scope > .doc-more > summary">
${navLinks(out, "          ")}
          <details class="doc-more"${PAGES.some((q) => q.legal && q.out === out && !q.navHidden) ? " data-current" : ""}>
            <summary>Legal</summary>
            <div class="doc-more-menu panel">
              <header class="gw-head" aria-hidden="true"><span class="gw-plate"><b class="gw-code">LG01</b><span class="gw-title">Legal</span></span><span class="gw-hatch"></span></header>
              <div class="hud-menu" data-glide="a">
${navLinks(out, "                ", true)}
              </div>
            </div>
          </details>
          <div class="doc-legal" data-glide="a">
            <p class="lab">Legal</p>
${navLinks(out, "            ", true, false)}
          </div>
        </nav>
        <a class="btn btn-primary btn-sm" href="../#download">Download</a>
        <button class="doc-burger" type="button" data-doc-toggle aria-expanded="false" aria-controls="doc-menu" aria-label="Open menu">
          <svg class="i-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          <svg class="i-close" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
    </header>
    <main class="wrap doc" id="main">
${body}
    </main>
${footer(out)}
    <script>
      // Legal menu: closes on Escape or a click outside it.
      (function () {
        var m = document.querySelector(".doc-more");
        if (!m) return;
        document.addEventListener("click", function (e) { if (m.open && !m.contains(e.target)) m.open = false; });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape" && m.open) { m.open = false; m.querySelector("summary").focus(); } });
      })();
      // Phones: the menu button opens the page list under the bar. Choosing a
      // page, Escape, a tap outside or leaving the phone layout closes it.
      (function () {
        var top = document.querySelector(".doc-top");
        var btn = document.querySelector("[data-doc-toggle]");
        if (!top || !btn) return;
        var set = function (open) {
          top.classList.toggle("open", open);
          btn.setAttribute("aria-expanded", String(open));
          btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        };
        btn.addEventListener("click", function () { set(!top.classList.contains("open")); });
        top.querySelectorAll(".doc-nav a").forEach(function (a) { a.addEventListener("click", function () { set(false); }); });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape" && top.classList.contains("open")) { set(false); btn.focus(); } });
        document.addEventListener("pointerdown", function (e) { if (top.classList.contains("open") && !top.contains(e.target)) set(false); });
        var mq = matchMedia("(max-width: 760px)");
        if (mq.addEventListener) mq.addEventListener("change", function () { set(false); });
      })();
      // Contents: mark the section being read.
      (function () {
        var links = document.querySelectorAll(".doc-toc a");
        if (!links.length || !("IntersectionObserver" in window)) return;
        var io = new IntersectionObserver(function (es) {
          es.forEach(function (e) {
            if (!e.isIntersecting) return;
            links.forEach(function (a) {
              if (a.getAttribute("href") === "#" + e.target.id) a.setAttribute("aria-current", "location");
              else a.removeAttribute("aria-current");
            });
          });
        }, { rootMargin: "-30% 0px -60% 0px" });
        document.querySelectorAll(".doc-sec[id]").forEach(function (s) { io.observe(s); });
      })();
    </script>
  </body>
</html>
`;
}

/**
 * The site footer, the same on the home page (website/index.html, kept in
 * step by hand) and every doc page: brand and maker, then every home page
 * section (Product, Get Bifrost) and every page (Guides, Legal), then the
 * copyright line.
 */
// The home page's sections, in the rail's order and with the rail's names,
// split over the footer's first two columns.
const SECTIONS = [
  [
    ["top", "Overview"],
    ["privacy", "Privacy"],
    ["words", "Safety words"],
    ["how", "How it works"],
    ["features", "Features"],
    ["security", "Security"],
  ],
  [
    ["compare", "Compare"],
    ["pricing", "Pricing"],
    ["download", "Download"],
    ["engine", "Under the hood"],
    ["faq", "FAQ"],
    ["contact", "Contact"],
  ],
];

function footer(current) {
  const link = (href, text, out) => `<a href="${href}"${out === current ? ' aria-current="page"' : ""}>${text}</a>`;
  // Every page, under the name it has in the footer (`footer`, else `nav`).
  const pages = (legal) =>
    PAGES.filter((q) => !!q.legal === legal)
      .map((q) => `          ${link(`../${q.out}/`, esc(q.footer || q.nav), q.out)}`)
      .join("\n");
  const sections = (list) => list.map(([id, name]) => `          <a href="../#${id}">${esc(name)}</a>`).join("\n");
  return `    <footer class="footer">
      <div class="wrap footer-grid">
        <div class="footer-brand">
          <span class="brand small"><img class="brand-mark" src="../assets/bifrost-mark.svg" width="20" height="20" alt="" /><span>Bifrost</span></span>
          <p>Your files, your devices, nobody in between.</p>
        </div>
        <nav class="footer-col" aria-label="Product">
          <p class="lab">Product</p>
${sections(SECTIONS[0])}
        </nav>
        <nav class="footer-col" aria-label="Get Bifrost">
          <p class="lab">Get Bifrost</p>
${sections(SECTIONS[1])}
        </nav>
        <nav class="footer-col" aria-label="Guides">
          <p class="lab">Guides</p>
${pages(false)}
        </nav>
        <nav class="footer-col" aria-label="Legal">
          <p class="lab">Legal</p>
${pages(true)}
        </nav>
      </div>
      <div class="wrap footer-base">
        <a class="footer-maker" href="https://big-matrix.com/" target="_blank" rel="noopener"><span>Developed and powered by</span><img src="../assets/big-matrix-logo.png" width="480" height="126" alt="Big-Matrix Solutions" /></a>
        <span>© ${new Date().getFullYear()} Big-Matrix Solutions. All rights reserved.</span>
      </div>
    </footer>`;
}

/** The doc pages (or, with `legal`, the legal pages), the current one marked. */
function navLinks(current, pad, legal = false, numbered = legal) {
  // The dropdown's entries are numbered like the app's lists.
  const num = (n) => (numbered ? `<span class="opt-n">${String(n + 1).padStart(2, "0")}</span>` : "");
  // Pages marked navHidden (Contact) are in the footer only.
  return PAGES.filter((q) => !!q.legal === legal && !q.navHidden)
    .map((q, n) => `${pad}<a href="../${q.out}/"${q.out === current ? ' aria-current="page"' : ""}>${num(n)}${esc(q.nav)}</a>`)
    .join("\n");
}

/** GitHub-style heading anchor, so links to #sections keep working. */
function slugger() {
  const seen = new Map();
  return (html) => {
    const base =
      html
        .replace(/<[^>]+>/g, "")
        .replace(/&[a-z#0-9]+;/gi, "")
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s/g, "-") || "section";
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * The page body: the title and intro, then a contents window and one HUD
 * window per "##" section (code plate S01…, the heading as its title).
 */
function layout(p, h1, html) {
  const parts = html.split(/\u0000SEC(.*?)\u0000/);
  const intro = parts[0].trim();
  const secs = [];
  for (let i = 1; i < parts.length; i += 2) secs.push({ ...JSON.parse(parts[i]), body: parts[i + 1].trim() });
  const toc = secs.length
    ? `      <nav class="doc-toc panel" aria-label="On this page">
        <div class="gw-head" aria-hidden="true"><span class="gw-plate"><b class="gw-code">IX</b><span class="gw-title">Contents</span></span><span class="gw-hatch"></span><span class="gw-meta">${pad2(secs.length)}</span></div>
        <ol data-glide="a">
${secs.map((s, k) => `          <li><a href="#${s.id}"><b class="num" aria-hidden="true">S${pad2(k + 1)}</b><span>${s.text}</span></a></li>`).join("\n")}
        </ol>
      </nav>`
    : "";
  const windows = secs
    .map(
      (s, k) => `        <section class="doc-sec panel" id="${s.id}" aria-labelledby="${s.id}-h">
          <header class="gw-head"><div class="gw-plate"><b class="gw-code" aria-hidden="true">S${pad2(k + 1)}</b><h2 class="gw-title" id="${s.id}-h">${s.html}</h2></div><span class="gw-hatch" aria-hidden="true"></span><span class="gw-x deco" aria-hidden="true"></span></header>
          <div class="doc-sec-body">
${s.body}
          </div>
        </section>`,
    )
    .join("\n");
  return `    <div class="doc-head">
      <p class="lab"><span class="idx">DOC</span>${esc(p.nav)}</p>
      <h1>${h1}</h1>
${intro ? `      <div class="doc-intro">\n${intro}\n      </div>` : ""}
    </div>
    <div class="doc-grid${toc ? "" : " no-toc"}">
${toc}
      <div class="doc-body">
${windows}
      </div>
    </div>`;
}

for (const p of PAGES) {
  let md = readFileSync(join(root, p.src), "utf8");
  md = md.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in BUSINESS)) throw new Error(`${p.src}: unknown placeholder ${m}; add it to BUSINESS in build-docs.mjs`);
    return BUSINESS[key];
  });
  for (const [find, repl] of p.replace || []) {
    if (!find.test(md)) throw new Error(`${p.src}: expected text not found for ${find}; update build-docs.mjs`);
    md = md.replace(find, repl);
  }
  const slug = slugger();
  let h1 = esc(p.title);
  const renderer = {
    // "#" is the page title, "##" opens a section window (split in layout()),
    // deeper headings get anchors.
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      if (depth === 1) {
        h1 = html;
        return "";
      }
      const id = slug(html);
      if (depth === 2) return `\u0000SEC${JSON.stringify({ id, html, text: html.replace(/<[^>]+>/g, "") })}\u0000`;
      return `<h${depth} id="${id}">${html}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const to = target(href, p.src);
      if (to === null) return text;
      return `<a href="${esc(to)}"${title ? ` title="${esc(title)}"` : ""}>${text}</a>`;
    },
    // Code blocks are HUD windows like the rest of the site: a header plate
    // with the kind of block, then the lines, with "#" comment lines dimmed.
    code({ text, lang }) {
      const kind = (lang || "").toLowerCase();
      const [tag, name] =
        kind === "sh" || kind === "bash" || kind === "shell" ? ["SH", "Shell"] : kind === "toml" || kind === "ini" || kind === "yaml" ? ["CF", "Config"] : ["TX", "Text"];
      const lines = text
        .replace(/\n$/, "")
        .split("\n")
        .map((l) => `<span class="ln${/^\s*#/.test(l) ? " c" : ""}">${esc(l).replace(/>/g, "&gt;")}</span>`)
        .join("\n");
      return (
        `<div class="term panel">` +
        `<div class="gw-head" aria-hidden="true"><span class="gw-plate"><b class="gw-code">${tag}</b><span class="gw-title">${name}</span></span><span class="gw-hatch"></span><span class="gw-x deco"></span></div>` +
        `<pre><code${kind ? ` class="language-${esc(kind)}"` : ""}>${lines}</code></pre>` +
        `</div>\n`
      );
    },
  };
  const html = new Marked({ gfm: true, renderer }).parse(md); // sets h1
  const body = layout(p, h1, html);
  mkdirSync(join(root, "website", p.out), { recursive: true });
  writeFileSync(join(root, "website", p.out, "index.html"), page(p, body));
  console.log(`website/${p.out}/index.html  <-  ${p.src}`);
}

const unfilled = Object.entries(BUSINESS).filter(([, v]) => /^\[.*\]$/.test(v));
if (unfilled.length) {
  const msg = `Legal pages still show placeholders for: ${unfilled.map(([k]) => k).join(", ")} (BUSINESS in .github/scripts/build-docs.mjs).`;
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=Legal placeholders::${msg}` : `warning: ${msg}`);
}
