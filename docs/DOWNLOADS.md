# How downloads are hosted

The source repository is private, so files attached to its GitHub Releases can't be downloaded by anyone outside it. Every release is therefore also copied to a **Cloudflare R2** bucket. The website serves the installers from there through a small **Pages Function**. Each download button links straight to a file, so the download starts on click.

| URL on the website | What it returns |
|---|---|
| `/download/windows` | the latest `Bifrost-Setup-<version>-x64.exe` |
| `/download/macos` | the latest `Bifrost-<version>-aarch64.dmg` |
| `/download/android` | the latest `Bifrost-<version>-build<n>-android.apk` |
| `/download/<platform>.sha256` | that file's SHA-256 checksum |
| `/download/latest.json` | version, date, file names, sizes and checksums (the page shows these) |

Downloads support HTTP range requests, so a browser or download manager can resume an interrupted APK download.

## The pieces

- **`.github/scripts/publish-downloads.sh`** runs as the last job of the Build workflow (`downloads`), after the Windows, macOS and Android jobs have published the GitHub Release.
  - It uploads each installer and its checksum to `releases/<tag>/` in the bucket.
  - Then it rewrites `latest.json`. Until that last step, the website keeps serving the previous build, so a half-finished upload is never served.
  - It creates the bucket on first use.
- **`functions/download/[[path]].js`** is the Pages Function. It reads `latest.json` from the bucket (bound as `DOWNLOADS`) and streams the file as an attachment.
- **`wrangler.toml`** sets the Pages project name (`bifrost-app`), the site folder (`website/`) and the R2 binding (`bifrost-downloads`).
- **`.github/workflows/website.yml`** deploys the site and the function with `wrangler pages deploy`. It creates the Pages project on first use. It also keeps publishing the `gh-pages` branch as before.

Both workflows skip the Cloudflare steps, with a warning, until the secrets below exist, so nothing fails in the meantime.

## One-time setup

1. **Create an API token** in the Cloudflare dashboard (My Profile → API Tokens → Create Token → Custom token) with these permissions:
   - Account · **Cloudflare Pages** · Edit
   - Account · **Workers R2 Storage** · Edit

   Limit it to your account under Account Resources.
2. **Find your account ID**. It's on the right of the dashboard's Workers & Pages overview, or in the URL after `dash.cloudflare.com/`.
3. **Add two repository secrets** on GitHub (Settings → Secrets and variables → Actions → New repository secret):
   - `CLOUDFLARE_API_TOKEN`: the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 2
4. **Run both workflows once**: Actions → *Website* → Run workflow, then Actions → *Build* → Run workflow.
   - The Website run creates the `bifrost-app` Pages project and prints its address.
   - The Build run fills the bucket. After it, the download buttons work.

To use different names, set the repository **variables** `CF_PAGES_PROJECT` and `R2_BUCKET` (Settings → Secrets and variables → Actions → Variables). The bucket stays private; files are only reachable through the website.

## Moving from the old Cloudflare project

Cloudflare can't rename a Pages project, so the site moves to the new `bifrost-app` project, which CI deploys directly. Once it works, delete the old Git-connected project (Workers & Pages → the old project → Settings → Delete project). If you had a custom domain on the old project, add it to the new one under Custom domains.

## Without Cloudflare

The `gh-pages` branch is still published, but the download buttons only work on the Cloudflare site. GitHub Pages can't run the download function. If the repository is made public later, the GitHub Release links work for everyone too.
