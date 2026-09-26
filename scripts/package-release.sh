#!/usr/bin/env bash
# Builds the release archives for LOCAL POS.
#
# The point of a script rather than a hand-typed zip command is that the result
# is reproducible and auditable: same commit in, same file list out. It also
# makes the important guarantee checkable — a release archive must never contain
# data/ (the WhatsApp login session, customer phone numbers, order history) or
# node_modules/, and this script fails loudly if one ever slips in.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "Packaging $NAME $VERSION from $(git rev-parse --short HEAD 2>/dev/null || echo 'no git')"

# The file list mirrors package.json "files", so the npm tarball and the release
# archive agree about what the software is.
mapfile -t FILES < <(node -e "
  const p = require('./package.json');
  for (const f of p.files) console.log(f.replace(/\/\$/, ''));
" | while read -r f; do
  # expand a trailing slash into the files underneath it
  if [ -d "$f" ]; then find "$f" -type f | sort; else echo "$f"; fi
done)

DIR="$STAGE/$NAME-$VERSION"
mkdir -p "$DIR"
for f in "${FILES[@]}"; do
  mkdir -p "$DIR/$(dirname "$f")"
  cp "$f" "$DIR/$f"
done
# package.json and the lock file are what make the archive installable and pin the exact dependency
# versions, and neither is listed in "files" (npm adds them itself when packing; this script has to).
# The README, changelog and license ride along for the same reason.
for extra in package.json package-lock.json README.md CHANGELOG.md LICENSE; do
  [ -f "$extra" ] && cp "$extra" "$DIR/"
done

# A release must never carry live shop data or installed packages.
if [ -d "$DIR/data" ] || [ -d "$DIR/node_modules" ]; then
  echo "FAIL: the archive contains data/ or node_modules/ — refusing to build" >&2
  exit 1
fi
# Without these the archive extracts to something that cannot be installed or started.
for must in package.json server.js; do
  if [ ! -f "$DIR/$must" ]; then
    echo "FAIL: $must is missing from the archive — it would not run" >&2
    exit 1
  fi
done

OUT="$ROOT/dist"
mkdir -p "$OUT"
rm -f "$OUT/$NAME-$VERSION.tar.gz" "$OUT/$NAME-$VERSION.zip"

tar -czf "$OUT/$NAME-$VERSION.tar.gz" -C "$STAGE" "$NAME-$VERSION"
(cd "$STAGE" && zip -qr "$OUT/$NAME-$VERSION.zip" "$NAME-$VERSION")

# A copy-pasteable install line, so installing is not a guessing game.
{
  echo "Install LOCAL POS $VERSION"
  echo
  echo "  tar -xzf $NAME-$VERSION.tar.gz && cd $NAME-$VERSION && npm install && npm start"
  echo
  echo "Then open http://localhost:3000 and let the setup wizard ask for your store name."
  echo "Your data is created in ./data on first run and stays on this machine."
} > "$OUT/$NAME-$VERSION.INSTALL.txt"

(cd "$OUT" && sha256sum "$NAME-$VERSION.tar.gz" "$NAME-$VERSION.zip" > "$NAME-$VERSION.sha256")

echo
echo "Built in dist/:"
(cd "$OUT" && for f in "$NAME-$VERSION.tar.gz" "$NAME-$VERSION.zip" "$NAME-$VERSION.INSTALL.txt" "$NAME-$VERSION.sha256"; do
  printf '  %-34s %8s\n' "$f" "$(du -h "$f" | cut -f1)"
done)
echo
echo "Contents (top level):"
tar -tzf "$OUT/$NAME-$VERSION.tar.gz" | sed "s|^$NAME-$VERSION/||" | grep -v '/' | sort | sed 's/^/  /'
echo
echo "Verify with:  cd dist && sha256sum -c $NAME-$VERSION.sha256"
