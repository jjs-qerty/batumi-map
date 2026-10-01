# Niniko's Map

A phone web app with a map of Batumi that remembers the streets you walked and the places where memories were made.

## What it does
- **Start walk / Finish walk** records your route with GPS and draws it in pink. Every walk stays on the map, so the streets you have walked fill in over time.
- **Memory** pins a place (where you are now, or any spot you tap) with a title, date, story and an optional photo.
- **My map** lists walks and memories, lets you draw a past walk by tapping along streets, and saves or restores a backup file.
- Everything is stored on the phone only. Use *Save a backup* now and then.

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

## Good to know
- Keep the app open on screen while recording. Phones pause GPS for web apps when the screen locks or you switch apps. The app asks the phone to keep the screen awake, and if it does get interrupted it offers to resume the walk next time you open it.
- Recording in the background with the screen off would need a native iPhone/Android app.

## Files
`index.html`, `app.css`, `app.js` (the app), `sw.js` (offline support and map tile caching), `manifest.webmanifest` and `icons/` (home-screen install), `vendor/` (Leaflet 1.9.4 map library). Map data © OpenStreetMap contributors.
