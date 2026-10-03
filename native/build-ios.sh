#!/usr/bin/env bash
# Builds native/niniko-map.ipa, unsigned. Run on macOS from the repo root (CI does this).
# Sideloadly or AltStore signs it with your own Apple ID when you install it.
set -euo pipefail
cd "$(dirname "$0")"
./copy-web.sh
npm install --no-audit --no-fund
[ -d ios ] || npx cap add ios
npx cap sync ios

# What iOS shows when the app asks for GPS, the camera and Photos.
PLIST=ios/App/App/Info.plist
pb() { /usr/libexec/PlistBuddy -c "Delete :$1" "$PLIST" 2>/dev/null || true; /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"; }
pb NSLocationWhenInUseUsageDescription "Niniko's Map uses your location to draw the streets you walk and to place your memories."
pb NSCameraUsageDescription "Niniko's Map uses the camera for photos of your memories."
pb NSPhotoLibraryUsageDescription "Niniko's Map lets you add photos from your library to a memory."
pb NSPhotoLibraryAddUsageDescription "Niniko's Map saves your memory photos to Photos when you ask."
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Niniko's Map" "$PLIST" 2>/dev/null || true

# App icon (one 1024 px image)
ICONS=ios/App/App/Assets.xcassets/AppIcon.appiconset
for f in "$ICONS"/*.png; do sips -s format png -z 1024 1024 ../icons/icon-512.png --out "$f" >/dev/null; done

cd ios/App
if [ -d App.xcworkspace ]; then SRC=(-workspace App.xcworkspace); else SRC=(-project App.xcodeproj); fi
xcodebuild "${SRC[@]}" -scheme App -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
rm -rf Payload && mkdir Payload
cp -R build/Build/Products/Release-iphoneos/App.app Payload/
zip -qry ../../niniko-map.ipa Payload
echo "Built $(cd ../.. && pwd)/niniko-map.ipa"
