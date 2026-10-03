# Niniko's Map

A phone web app with a map of Batumi, Tbilisi and Ayia Napa that remembers the streets you walked and the places where memories were made.

## What it does
- **Start walk / Finish walk** records your route with GPS and draws it in pink. Every walk stays on the map, so the streets you have walked fill in over time.
- **Memory** pins a place (where you are now, or any spot you tap) with a title, date, story and photos.
- **Photo button** (camera, right side): take a photo and it is saved to the memory where you are standing, or starts a new memory there named after the nearest popular place. *+ Photo* on a memory adds more.
- **My map** lists walks and memories, lets you draw a past walk by tapping along streets, and saves or restores a backup file.
- **Trail times**: tap any point of a recorded walk to see when you were there.
- **Smooth trails**: GPS wobble and glitches are smoothed out, so a straight walk draws as a clean line. Walks under 200 m aren't saved, and *My map → Walks* offers to remove old tiny ones.
- **Trip diary** (*My map → Days*): one line per day with distance, time and photos. Tap a day to see just that day, then **Replay the day** to watch the walk draw itself with the time ticking and memories popping up.
- **Trip stats**: total distance, favourite districts (from OpenStreetMap neighbourhood names), what time of day you walk, and your biggest day.
- **Visited**: mark places visited in their popup (taking a photo at a place does it too). A chip filters visited / not visited, and *My map → Visited* lists them.
- **Download photos**: *Download* on a memory, or *Download all photos* in *My map → Memories* (several photos come as one .zip).
- **Automatic trail**: while the app is open it records where you go (turn this off in *My map*). A break of more than 30 minutes starts a new walk.
- **Places**: chips at the top show sights, museums, galleries, event venues, parks, cafés, restaurants, bars, pharmacies and hospitals from OpenStreetMap. Each place shows whether it is open now (in the city's local time, from its listed opening hours) and whether you need a ticket. The main paid sights have notes on price and where to buy; prices are the last known ones and should be checked. *Open now* hides closed places. *Popular only* (on by default) hides lesser-known places; tap it to see *All places*.
- **Map style** (layers button): Bright (full-colour OpenStreetMap, default), Colourful (OSM France) or Soft. If a style's server is down the app goes back to Bright.
- **Events**: there is no free live feed of Batumi events, so the map shows event venues (theatres, cinemas, arts centres, clubs, stadiums) with links to tkt.ge and biletebi.ge for what's on.
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
`index.html`, `app.css`, `app.js` (the app), `poi.js` (places, opening hours, ticket notes), `sw.js` (offline support and map tile caching), `manifest.webmanifest` and `icons/` (home-screen install), `vendor/` (Leaflet 1.9.4 map library). Map data © OpenStreetMap contributors, places via the Overpass API.
