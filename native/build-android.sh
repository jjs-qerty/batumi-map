#!/usr/bin/env bash
# Builds native/niniko-map.apk. Run from the repo root (CI does this).
set -euo pipefail
cd "$(dirname "$0")"
./copy-web.sh
npm install --no-audit --no-fund
[ -d android ] || npx cap add android
npx cap sync android

# Permissions the web view needs: GPS for walks, camera for the photo button.
MANIFEST=android/app/src/main/AndroidManifest.xml
for perm in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION CAMERA; do
  grep -q "android.permission.$perm\"" "$MANIFEST" || \
    sed -i "s#<uses-permission android:name=\"android.permission.INTERNET\" />#<uses-permission android:name=\"android.permission.INTERNET\" />\n    <uses-permission android:name=\"android.permission.$perm\" />#" "$MANIFEST"
done
grep -q 'android.hardware.location.gps' "$MANIFEST" || \
  sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#<uses-permission android:name="android.permission.INTERNET" />\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />#' "$MANIFEST"

# App icon
RES=android/app/src/main/res
rm -rf "$RES"/mipmap-anydpi-v26
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  cp ../icons/icon-192.png "$RES/mipmap-$d/ic_launcher.png"
  cp ../icons/icon-192.png "$RES/mipmap-$d/ic_launcher_round.png"
done

# Sign with the app's own key, so it installs over the earlier test app and keeps its data.
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

(cd android && chmod +x gradlew && ./gradlew --no-daemon assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk niniko-map.apk
echo "Built $(pwd)/niniko-map.apk"
