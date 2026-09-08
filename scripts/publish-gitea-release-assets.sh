#!/usr/bin/env bash
set -euo pipefail

: "${GITEA_TOKEN:?GITEA_TOKEN is required}"
: "${GITEA_SERVER_URL:?GITEA_SERVER_URL is required}"
: "${GITEA_REPOSITORY:?GITEA_REPOSITORY is required}"
: "${GITEA_REF_NAME:?GITEA_REF_NAME is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

if [ "$#" -eq 0 ]; then
  echo 'No release assets supplied.' >&2
  exit 1
fi

api="${GITEA_SERVER_URL}/api/v1/repos/${GITEA_REPOSITORY}"
lookup_release() {
  response=$(curl --silent --show-error --write-out $'\n%{http_code}' \
    --header "Authorization: token ${GITEA_TOKEN}" \
    "${api}/releases/tags/${GITEA_REF_NAME}")
  status=${response##*$'\n'}
  release=${response%$'\n'*}
}

lookup_release
if [ "$status" = 404 ]; then
  payload=$(node -e 'console.log(JSON.stringify({tag_name: process.argv[1], name: `Weltbon ${process.argv[1]}`, target_commitish: process.argv[2], draft: true, prerelease: false}))' "$GITEA_REF_NAME" "$GITHUB_SHA")
  if ! release=$(curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: token ${GITEA_TOKEN}" \
    --header 'Content-Type: application/json' \
    --data "$payload" \
    "${api}/releases"); then
    # Another platform may have created the release between our lookup and POST.
    lookup_release
    if [ "$status" != 200 ]; then
      printf 'could not create or look up release %s (HTTP %s)\n' "$GITEA_REF_NAME" "$status" >&2
      exit 1
    fi
  fi
elif [ "$status" != 200 ]; then
  printf 'could not look up release %s (HTTP %s)\n' "$GITEA_REF_NAME" "$status" >&2
  exit 1
fi

release_id=$(node -p 'JSON.parse(process.argv[1]).id' "$release")
if [ "$(node -p 'JSON.parse(process.argv[1]).draft' "$release")" = false ]; then
  echo "Release ${GITEA_REF_NAME} is already public; refusing to mutate it." >&2
  exit 0
fi
for asset in "$@"; do
  test -f "$asset"
  asset_name=$(basename "$asset")
  attachments=$(curl --fail --silent --show-error \
    --header "Authorization: token ${GITEA_TOKEN}" \
    "${api}/releases/${release_id}/assets")
  old_asset=$(node -e 'const [assets, name] = process.argv.slice(1); const attachment = JSON.parse(assets).find(item => item.name === name); if (attachment) process.stdout.write(String(attachment.id));' "$attachments" "$asset_name")
  if [ -n "$old_asset" ]; then
    curl --fail --silent --show-error \
      --request DELETE \
      --header "Authorization: token ${GITEA_TOKEN}" \
      "${api}/releases/${release_id}/assets/${old_asset}"
  fi
  asset_name_uri=$(node -p 'encodeURIComponent(process.argv[1])' "$asset_name")
  curl --fail --silent --show-error \
    --request POST \
    --header "Authorization: token ${GITEA_TOKEN}" \
    --form "attachment=@${asset}" \
    "${api}/releases/${release_id}/assets?name=${asset_name_uri}"
done
attachments=$(curl --fail --silent --show-error \
  --header "Authorization: token ${GITEA_TOKEN}" \
  "${api}/releases/${release_id}/assets")
for asset in "$@"; do
  asset_name=$(basename "$asset")
  node -e 'const [assets, name] = process.argv.slice(1); if (!JSON.parse(assets).some(item => item.name === name && item.size > 0)) process.exit(1);' "$attachments" "$asset_name"
done
curl --fail --silent --show-error \
  --request PATCH \
  --header "Authorization: token ${GITEA_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{"draft":false}' \
  "${api}/releases/${release_id}"
