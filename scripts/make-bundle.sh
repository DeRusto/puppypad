#!/bin/sh
# Packs what a server needs to run a release (no source: the code ships in the images):
#   scripts/make-bundle.sh v1.2.3 dist
# writes dist/puppypad-v1.2.3.tar.gz, dist/install.sh and dist/SHA256SUMS. The release workflow
# attaches all three to the GitHub release; scripts/install.sh downloads them.
set -eu
cd "$(dirname "$0")/.."
tag=$1 out=$2
echo "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+' || { echo "not a release tag: $tag"; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/scripts" "$out"
cp docker-compose.yml Caddyfile .env.example .env.caddy.example README.md LICENSE "$stage/"
cp scripts/backup.sh scripts/install.sh scripts/upgrade-watch.sh "$stage/scripts/"
echo "$tag" > "$stage/VERSION"
tar -czf "$out/puppypad-$tag.tar.gz" -C "$stage" --owner=0 --group=0 .
cp scripts/install.sh "$out/install.sh"
(cd "$out" && sha256sum "puppypad-$tag.tar.gz" install.sh > SHA256SUMS)
echo "wrote $out/puppypad-$tag.tar.gz"
