#!/usr/bin/env bash
# Attach build outputs to a Forgejo release and publish it.
#
#   scripts/forgejo-release.sh upload FILE...   add or replace assets on the draft
#   scripts/forgejo-release.sh publish N        require N non-empty assets, then publish
#
# Each platform job uploads its own files, so no job has to download another
# job's artifacts (Forgejo has no artifact-download API for Actions tokens).
# `upload` also stores each file in the generic package weltbon-desktop/<version>
# owned by the repository owner: Forgejo serves release attachments of a private
# repository only to a browser session, while the package registry accepts a
# token, which is how GitHub's release workflow fetches the files. The Actions
# token cannot write packages (HTTP 401), so this needs PACKAGE_TOKEN: a
# personal access token of the repository owner with the write:package scope.
# The release stays a draft until `publish` has checked that every platform
# delivered, so a half-built release is never visible. A tag containing `-`
# (v1.2.3-rc.1) is published as a prerelease.
set -euo pipefail

: "${FORGEJO_TOKEN:?FORGEJO_TOKEN is required}"
: "${FORGEJO_SERVER_URL:?FORGEJO_SERVER_URL is required}"
: "${FORGEJO_REPOSITORY:?FORGEJO_REPOSITORY is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_SHA:?RELEASE_SHA is required}"

api="${FORGEJO_SERVER_URL}/api/v1/repos/${FORGEJO_REPOSITORY}"
package="${FORGEJO_SERVER_URL}/api/packages/${FORGEJO_REPOSITORY%%/*}/generic/weltbon-desktop/${RELEASE_TAG#v}"
auth=(--header "Authorization: token ${FORGEJO_TOKEN}")

lookup_release() {
  response=$(curl --silent --show-error --write-out $'\n%{http_code}' "${auth[@]}" \
    "${api}/releases/tags/${RELEASE_TAG}")
  status=${response##*$'\n'}
  release=${response%$'\n'*}
}

# Drafts are not returned by the tag lookup on every Forgejo version, so fall
# back to scanning the release list for a draft with this tag.
find_draft() {
  curl --fail --silent --show-error "${auth[@]}" "${api}/releases?draft=true&limit=50" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(x=>x.tag_name===process.argv[1]);if(r)process.stdout.write(JSON.stringify(r))})' "$RELEASE_TAG"
}

ensure_release() {
  lookup_release
  if [ "$status" = 200 ]; then return; fi
  if [ "$status" != 404 ]; then
    printf 'could not look up release %s (HTTP %s)\n' "$RELEASE_TAG" "$status" >&2
    exit 1
  fi
  release=$(find_draft)
  if [ -n "$release" ]; then return; fi
  payload=$(node -e 'console.log(JSON.stringify({tag_name: process.argv[1], name: `Weltbon ${process.argv[1]}`, target_commitish: process.argv[2], draft: true, prerelease: process.argv[1].includes("-")}))' "$RELEASE_TAG" "$RELEASE_SHA")
  if ! release=$(curl --fail --silent --show-error --request POST "${auth[@]}" \
    --header 'Content-Type: application/json' --data "$payload" "${api}/releases"); then
    # Another platform job may have created it between the lookup and the POST.
    release=$(find_draft)
    if [ -z "$release" ]; then
      printf 'could not create or find release %s\n' "$RELEASE_TAG" >&2
      exit 1
    fi
  fi
}

field() { node -p "JSON.parse(process.argv[1]).$1" "$release"; }

list_assets() {
  curl --fail --silent --show-error "${auth[@]}" "${api}/releases/$(field id)/assets"
}

cmd=${1:-}
shift || true
case "$cmd" in
  upload)
    [ "$#" -gt 0 ] || { echo 'No release assets supplied.' >&2; exit 1; }
    : "${PACKAGE_TOKEN:?PACKAGE_TOKEN is required to upload to the package registry}"
    package_auth=(--header "Authorization: token ${PACKAGE_TOKEN}")
    ensure_release
    if [ "$(field draft)" = false ]; then
      echo "Release ${RELEASE_TAG} is already published; refusing to change it." >&2
      exit 1
    fi
    for asset in "$@"; do
      test -f "$asset"
      name=$(basename "$asset")
      old=$(list_assets | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).find(x=>x.name===process.argv[1]);if(a)process.stdout.write(String(a.id))})' "$name")
      if [ -n "$old" ]; then
        curl --fail --silent --show-error --request DELETE "${auth[@]}" \
          "${api}/releases/$(field id)/assets/${old}"
      fi
      echo "uploading ${name}"
      curl --fail --silent --show-error --output /dev/null --request POST "${auth[@]}" \
        --form "attachment=@${asset}" \
        "${api}/releases/$(field id)/assets?name=$(node -p 'encodeURIComponent(process.argv[1])' "$name")"
      encoded=$(node -p 'encodeURIComponent(process.argv[1])' "$name")
      # A rerun replaces the file; a 404 here just means it was not there yet.
      curl --silent --output /dev/null --request DELETE "${package_auth[@]}" "${package}/${encoded}" || true
      curl --fail --silent --show-error --output /dev/null "${package_auth[@]}" \
        --upload-file "$asset" "${package}/${encoded}"
    done
    ;;
  publish)
    expected=${1:?publish needs the expected asset count}
    ensure_release
    count=$(list_assets | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).filter(a=>a.size>0).length')
    if [ "$count" != "$expected" ]; then
      echo "Release ${RELEASE_TAG} has ${count} non-empty assets, expected ${expected}; leaving it as a draft." >&2
      exit 1
    fi
    if [ "$(field draft)" = true ]; then
      curl --fail --silent --show-error --output /dev/null --request PATCH "${auth[@]}" \
        --header 'Content-Type: application/json' --data '{"draft":false}' \
        "${api}/releases/$(field id)"
    fi
    echo "Release ${RELEASE_TAG} published with ${count} assets."
    ;;
  *)
    echo "usage: $0 upload FILE... | publish COUNT" >&2
    exit 2
    ;;
esac
