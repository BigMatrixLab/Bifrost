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
    description: "Every Bifrost release and what changed in it.",
  },
  {
    src: "SECURITY.md",
    out: "security",
    title: "Security policy",
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
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" content="#050506" />
    <script>
      (function () {
        var t;
        try { t = localStorage.getItem("bifrost-site-theme"); } catch (e) {}
        if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
        document.documentElement.dataset.theme = t;
        var m = document.querySelector('meta[name="theme-color"]');
        if (m) m.content = t === "light" ? "#f6f6f4" : "#050506";
      })();
    </script>
    <link rel="icon" type="image/png" sizes="32x32" href="../assets/favicon-32.png" />
    <link rel="icon" type="image/svg+xml" href="../assets/bifrost-mark.svg" />
    <link rel="apple-touch-icon" href="../assets/icon-256.png" />
    <link rel="canonical" href="https://getbifrost.pages.dev/${out}/" />
    <link rel="preload" href="../assets/fonts/space-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
    <link rel="stylesheet" href="../style.css" />
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    <header class="doc-top">
      <div class="wrap doc-top-inner">
        <a class="brand" href="../" aria-label="Bifrost home"><img class="brand-mark" src="../assets/bifrost-mark.svg" width="24" height="24" alt="" /><span>Bifrost</span></a>
        <a class="btn btn-primary btn-md" href="../#download">Download</a>
      </div>
    </header>
    <main class="wrap doc" id="main">
${body}
    </main>
    <footer class="footer">
      <div class="wrap footer-inner">
        <span>Your files, your devices, nobody in between.</span>
        <nav aria-label="Footer">
          <a href="../#download">Download</a>
          <a href="../changelog/">Changelog</a>
          <a href="../security/">Security</a>
          <a href="../relay/">Relay guide</a>
        </nav>
      </div>
    </footer>
  </body>
</html>
`;
}

for (const p of PAGES) {
  let md = readFileSync(join(root, p.src), "utf8");
  for (const [find, repl] of p.replace || []) {
    if (!find.test(md)) throw new Error(`${p.src}: expected text not found for ${find}; update build-docs.mjs`);
    md = md.replace(find, repl);
  }
  const renderer = {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const to = target(href, p.src);
      if (to === null) return text;
      return `<a href="${esc(to)}"${title ? ` title="${esc(title)}"` : ""}>${text}</a>`;
    },
  };
  const body = new Marked({ gfm: true, renderer }).parse(md);
  mkdirSync(join(root, "website", p.out), { recursive: true });
  writeFileSync(join(root, "website", p.out, "index.html"), page(p, body));
  console.log(`website/${p.out}/index.html  <-  ${p.src}`);
}
