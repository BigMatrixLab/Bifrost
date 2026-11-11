// Cloudflare Pages Function: serves the installers from the R2 bucket bound as
// DOWNLOADS (see wrangler.toml), so the website's download buttons work for
// everyone while the source repository stays private.
//
//   /download/windows | macos | android   the latest installer, as an attachment
//   /download/<platform>.sha256           its checksum file
//   /download/latest.json                 version, date, sizes and checksums
//
// CI uploads each release under releases/<tag>/ and then rewrites latest.json
// (.github/scripts/publish-downloads.sh), so a half-finished upload is never
// served. Range requests are supported, so browsers and download managers can
// resume large files such as the APK.

const PLATFORMS = ["windows", "macos", "android"];

const TYPES = {
  windows: "application/vnd.microsoft.portable-executable",
  macos: "application/x-apple-diskimage",
  android: "application/vnd.android.package-archive",
};

function text(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

// A browser following a download button for a build that isn't in the bucket
// goes back to the page, which greys that button out, instead of saving this
// error message as a file.
function notPublished(request, platform) {
  return Response.redirect(new URL(`/?unavailable=${platform}#download`, request.url).toString(), 302);
}

async function manifest(env) {
  const obj = await env.DOWNLOADS.get("latest.json");
  if (!obj) return null;
  return obj.json();
}

export async function onRequest({ request, env, params }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(405, "Method not allowed\n", { allow: "GET, HEAD" });
  }
  const path = [].concat(params.path || []).join("/");
  const m = /^(windows|macos|android)(\.sha256)?$/.exec(path);

  if (!env.DOWNLOADS) {
    if (m && !m[2]) return notPublished(request, m[1]);
    return text(503, "Downloads are not set up yet: the DOWNLOADS R2 binding is missing.\n");
  }

  if (path === "latest.json") {
    const obj = await env.DOWNLOADS.get("latest.json");
    if (!obj) return text(404, "No release has been published yet.\n");
    return new Response(request.method === "HEAD" ? null : obj.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
        etag: obj.httpEtag,
      },
    });
  }

  if (!m) {
    return text(404, `Unknown download. Try one of: ${PLATFORMS.map((p) => `/download/${p}`).join(", ")}\n`);
  }
  const [, platform, checksum] = m;

  const latest = await manifest(env);
  const file = latest?.files?.[platform];
  if (!file) {
    if (!checksum) return notPublished(request, platform);
    return text(404, `No ${platform} build has been published yet.\n`);
  }

  const key = checksum ? `${file.key}.sha256` : file.key;
  const name = checksum ? `${file.name}.sha256` : file.name;

  const obj = await env.DOWNLOADS.get(key, { range: request.headers, onlyIf: request.headers });
  if (obj === null) return checksum ? text(404, "File not found.\n") : notPublished(request, platform);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("content-type", checksum ? "text/plain; charset=utf-8" : TYPES[platform]);
  headers.set("content-disposition", `attachment; filename="${name}"`);
  // The URL always means "the latest build", so caches must check back.
  headers.set("cache-control", "no-cache");
  headers.set("x-content-type-options", "nosniff");

  // A conditional request (If-None-Match etc.) that matched: no body.
  if (!("body" in obj)) {
    return new Response(null, { status: request.headers.has("if-none-match") ? 304 : 412, headers });
  }

  let status = 200;
  let length = obj.size;
  if (obj.range && request.headers.has("range")) {
    const r = obj.range;
    let start;
    let end;
    // R2 reports either { suffix } or { offset, length }; unused keys may be
    // present but undefined.
    if (typeof r.suffix === "number") {
      start = Math.max(0, obj.size - r.suffix);
      end = obj.size - 1;
    } else {
      start = typeof r.offset === "number" ? r.offset : 0;
      end = typeof r.length === "number" ? start + r.length - 1 : obj.size - 1;
    }
    status = 206;
    length = end - start + 1;
    headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
  }
  headers.set("content-length", String(length));

  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
}
