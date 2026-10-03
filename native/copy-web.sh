#!/usr/bin/env bash
# Copies the web app into native/www (the files bundled inside the phone app).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf www && mkdir -p www
cp -r ../index.html ../app.css ../app.js ../poi.js ../manifest.webmanifest ../icons ../vendor www/
