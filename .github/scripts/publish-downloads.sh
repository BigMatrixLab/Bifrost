#!/usr/bin/env bash
# Uploads a release's installers to the Cloudflare R2 bucket that the website's
# download function reads (functions/download/[[path]].js).
#
#   publish-downloads.sh <dir with the release files> <tag>
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; R2_BUCKET picks the
# bucket (default bifrost-downloads), which is created on first use. Files go
# to releases/<tag>/ first; latest.json is written last, so the website only
# switches to the new build once every file is in place.
set -euo pipefail

dir=${1:?release files directory}
tag=${2:?release tag}
bucket=${R2_BUCKET:-bifrost-downloads}
wrangler() { npx --yes wrangler@4.153.0 "$@"; }

shopt -s nullglob
declare -A pattern=([windows]='*-x64.exe' [macos]='*.dmg' [android]='*-android.apk')
declare -A ctype=(
  [windows]=application/vnd.microsoft.portable-executable
  [macos]=application/x-apple-diskimage
  [android]=application/vnd.android.package-archive
)

if ! wrangler r2 bucket info "$bucket" >/dev/null 2>&1; then
  echo "Creating R2 bucket $bucket"
  wrangler r2 bucket create "$bucket"
fi

put() { # <key> <file> <content type> <download name>
  wrangler r2 object put "$bucket/$1" --remote --file "$2" --ct "$3" \
    --cd "attachment; filename=\"$4\"" --cc "public, max-age=31536000, immutable"
}

entries=()
for platform in windows macos android; do
  files=("$dir"/${pattern[$platform]})
  if [ ${#files[@]} -eq 0 ]; then
    echo "::warning title=Downloads::No $platform installer in this release; the site keeps serving the previous one"
    continue
  fi
  f=${files[0]}
  name=$(basename "$f")
  key="releases/$tag/$name"
  [ -f "$f.sha256" ] || (cd "$(dirname "$f")" && sha256sum "$name" > "$name.sha256")
  sha=$(awk '{print $1}' "$f.sha256")
  size=$(stat -c %s "$f")
  echo "Uploading $name ($size bytes) to $bucket/$key"
  put "$key" "$f" "${ctype[$platform]}" "$name"
  put "$key.sha256" "$f.sha256" "text/plain; charset=utf-8" "$name.sha256"
  entries+=("$platform" "$key" "$name" "$size" "$sha")
done

if [ ${#entries[@]} -eq 0 ]; then
  echo "::error title=Downloads::No installers found in $dir"
  exit 1
fi

# Start from the current latest.json so a platform missing from this run
# keeps its previous build.
old=$(mktemp)
wrangler r2 object get "$bucket/latest.json" --remote --file "$old" >/dev/null 2>&1 || echo '{}' > "$old"

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
node - "$old" "$tag" "$version" "${entries[@]}" > latest.json <<'EOF'
const fs = require("fs");
const [oldPath, tag, version, ...rest] = process.argv.slice(2);
let prev = {};
try { prev = JSON.parse(fs.readFileSync(oldPath, "utf8")); } catch {}
const files = { ...(prev.files || {}) };
for (let i = 0; i < rest.length; i += 5) {
  const [platform, key, name, size, sha256] = rest.slice(i, i + 5);
  files[platform] = { key, name, size: Number(size), sha256, tag };
}
const build = (tag.match(/build(\d+)/) || [])[1] || null;
process.stdout.write(JSON.stringify({
  name: `Bifrost ${version}${build ? ` (build ${build})` : ""}`,
  version, build, tag,
  published: new Date().toISOString(),
  files,
}, null, 2) + "\n");
EOF
cat latest.json
wrangler r2 object put "$bucket/latest.json" --remote --file latest.json \
  --ct "application/json; charset=utf-8" --cc "no-cache"
echo "::notice title=Downloads published::$tag is now the latest download (bucket $bucket)"
