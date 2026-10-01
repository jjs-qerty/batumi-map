# Niniko's Map

A phone web app with a map of Batumi and Tbilisi that remembers the streets you walked and the places where memories were made.

## What it does
- **Batumi and Tbilisi**: tap the title to switch city. Each city has its own places and ticket notes; the map also switches by itself when your location is in the other city. Your walks, memories and pins show in both.
- **Calm map with 3D**: a light OpenFreeMap vector map (Positron style). The **3D** button tilts the map and raises the buildings. If that map can't load, the app falls back to plain OpenStreetMap tiles.
- **Start walk / Finish** records your route with GPS. With *Record my trail whenever the app is open* (in **My map**) it starts by itself. Tap any point of a trail to see when you were there.
- **Photo** opens the camera. The photo is saved to the memory you're standing at (within 30 m), or starts a new memory there, named after the nearest place.
- **Memory** saves a place with a title, date, story and photos.
- **Pin** drops your own pin with a name, colour and note. Press and hold anywhere on the map for a quick pin, memory or directions to that spot.
- **Places**: chips at the top show sights, museums, galleries, event venues, parks, cafés, restaurants, bars, pharmacies and hospitals from OpenStreetMap, with open/closed status (Batumi time), ticket notes and a visited tag. *All places / Not visited / Visited* filters by the tag.
- **Walk there** draws a walking route inside the app (OSRM foot routing from routing.openstreetmap.de), shows minutes, distance and the next turn, re-plans if you wander off, and marks the place visited when you arrive. *Google Maps* is there as a backup.
- **Events**: there is no free live feed of Batumi events, so the map shows event venues with links to tkt.ge and biletebi.ge.
- Everything is stored on the phone only. Use *Save a backup* in **My map** now and then.

## Putting it on your phone
The app is hosted at **https://jjs-qerty.github.io/batumi-map/** (GitHub Pages from the `main` branch). Open that link on your phone and add it to your home screen:
- iPhone (Safari): Share button, then **Add to Home Screen**.
- Android (Chrome): menu, then **Install app** / **Add to Home screen**.

### Hosting it somewhere else
GPS only works when the app is opened from an `https://` address, so the folder needs to be hosted. The easiest free way:

1. Download and unzip `niniko-map.zip` on a computer.
2. Open https://app.netlify.com/drop and drag the unzipped `batumi-map` folder onto the page.
3. You get a link like `https://something.netlify.app`. Sign up (free) when it asks, so the link stays online.
4. Open that link on your phone.
   - iPhone (Safari): Share button, then **Add to Home Screen**.
   - Android (Chrome): menu, then **Install app** / **Add to Home screen**.
5. Open it from the home screen icon and allow location when asked.

GitHub Pages works too and is free; it needs a GitHub repository.

## Android app (records with the screen off)
Download **https://github.com/jjs-qerty/batumi-map/releases/download/android/niniko-map.apk** on the phone and open it. Android asks once to allow installing apps from your browser. The app records your trail through a background service, so it keeps going when the screen is locked; a notification shows while it records.

The Android app is paused for now. Running the *Android app* workflow by hand rebuilds the APK (`.github/workflows/android.yml`, `native/build-android.sh`) and replaces it in the `android` release. Installing a newer APK over the old one keeps your data, because every build is signed with the same key (`native/niniko.keystore`).

The web app and the Android app keep separate data. To move walks and memories across, use *Save a backup* in one and *Restore a backup* in the other.

## Good to know
- In the web version, keep the app open on screen while recording. Phones pause GPS for web apps when the screen locks or you switch apps. The app asks the phone to keep the screen awake, and if it does get interrupted it offers to resume the walk next time you open it.

## Files
`index.html`, `app.css`, `app.js` (the app), `poi.js` (places, opening hours, ticket notes, visited tags), `sw.js` (offline support and map tile caching), `manifest.webmanifest` and `icons/` (home-screen install), `vendor/` (MapLibre GL JS 5.24.0). Map data © OpenStreetMap contributors, map style and tiles by OpenFreeMap, places via the Overpass API, walking routes via routing.openstreetmap.de.
