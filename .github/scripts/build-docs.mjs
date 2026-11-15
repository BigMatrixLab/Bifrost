// Builds the website's document pages (changelog/, security/, relay/) from the
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
];

// Repository files with a page on the site. A link to any other file in the
// private repository keeps its text and loses the link.
const HOSTED = Object.fromEntries(PAGES.map((p) => [p.src, `../${p.out}/`]));

function target(href, from) {
  if (href.startsWith("#") || href.startsWith("mailto:")) return href;
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
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    <header class="doc-top">
      <div class="wrap doc-top-inner">
        <a class="brand" href="../" aria-label="Bifrost home"><img class="brand-mark" src="../assets/bifrost-mark.svg" width="24" height="24" alt="" /><span>Bifrost</span></a>
        <nav class="doc-nav" aria-label="Pages">
${navLinks(out, "          ")}
        </nav>
        <a class="btn btn-primary btn-sm" href="../#download">Download</a>
      </div>
    </header>
    <main class="wrap doc" id="main">
${body}
    </main>
    <footer class="footer">
      <div class="wrap footer-inner">
        <span class="brand small"><img class="brand-mark" src="../assets/bifrost-mark.svg" width="20" height="20" alt="" /><span>Bifrost</span></span>
        <span>Your files, your devices, nobody in between.</span>
        <nav aria-label="Footer">
          <a href="../#download">Download</a>
${navLinks(out, "          ")}
        </nav>
      </div>
    </footer>
    <script>
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

/** The three doc pages, the current one marked. */
function navLinks(current, pad) {
  return PAGES.map((q) => `${pad}<a href="../${q.out}/"${q.out === current ? ' aria-current="page"' : ""}>${esc(q.nav)}</a>`).join("\n");
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
        <ol>
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
