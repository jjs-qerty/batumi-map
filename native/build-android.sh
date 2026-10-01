#!/usr/bin/env bash
# Builds native/niniko-map.apk from the web app. Run from the repo root (CI does this).
set -euo pipefail
cd "$(dirname "$0")"

# 1. Web app -> www/
rm -rf www && mkdir -p www
cp -r ../index.html ../app.css ../app.js ../poi.js ../manifest.webmanifest ../icons ../vendor www/

# 2. Native project
npm install --no-audit --no-fund
[ -d android ] || npx cap add android
npx cap sync android

# 3. Permissions the web view needs for the camera button
MANIFEST=android/app/src/main/AndroidManifest.xml
grep -q 'android.permission.CAMERA' "$MANIFEST" || \
  sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.CAMERA" />#' "$MANIFEST"

# 4. App icon and notification text
RES=android/app/src/main/res
rm -rf "$RES"/mipmap-anydpi-v26
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  cp ../icons/icon-192.png "$RES/mipmap-$d/ic_launcher.png"
  cp ../icons/icon-192.png "$RES/mipmap-$d/ic_launcher_round.png"
done
cat > "$RES/values/niniko.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="capacitor_background_geolocation_notification_channel_name">Walk recording</string>
</resources>
XML

# 5. Sign with the app's own key so new versions install over old ones (and keep your data)
cat >> android/app/build.gradle <<'GRADLE'

android {
    signingConfigs {
        niniko {
            storeFile file("../../niniko.keystore")
            storePassword "niniko-map"
            keyAlias "niniko"
            keyPassword "niniko-map"
        }
    }
    buildTypes {
        debug { signingConfig signingConfigs.niniko }
    }
}
GRADLE

# 6. Build
(cd android && chmod +x gradlew && ./gradlew --no-daemon assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk niniko-map.apk
echo "Built $(pwd)/niniko-map.apk"
