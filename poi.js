/* Places layer: points of interest from OpenStreetMap, open/closed status, ticket notes. */
(function () {
  'use strict';

  // Area searched for places in each city (south, west, north, east).
  const BBOX = {
    batumi: '41.565,41.555,41.700,41.720',  // Gonio to the Botanical Garden
    tbilisi: '41.640,44.700,41.800,44.920', // Old Tbilisi, Vake, Saburtalo, Didube, Isani
    ayianapa: '34.955,33.920,35.035,34.095', // Ayia Napa, Cape Greco, Protaras
  };
  // Opening hours are read in each city's local time.
  const TZ = { batumi: 'Asia/Tbilisi', tbilisi: 'Asia/Tbilisi', ayianapa: 'Asia/Nicosia' };
  let tz = TZ.batumi;
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  const CACHE_KEY = 'niniko.places.v2'; // + '.' + city for cities other than Batumi; v2 keeps the wikidata/brand tags
  const CACHE_DAYS = 7;
  const FILTER_KEY = 'niniko.placeFilters.v1';
  const POPULAR_KEY = 'niniko.popularOnly';
  const MAX_MARKERS = 120;
  const VISITED_KEY = 'niniko.visited.v1';
  const TICKET_SITES = '<a href="https://tkt.ge" target="_blank" rel="noopener">tkt.ge</a> or <a href="https://biletebi.ge" target="_blank" rel="noopener">biletebi.ge</a>';

  const I = {
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>',
    museum: '<path d="M3 9l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
    gallery: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 16l5-5 4 4 3-3 4 4"/><circle cx="15.5" cy="9" r="1.3"/>',
    cafe: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5M11 3.5v2.5"/>',
    restaurant: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 21V3c-2 1-3 4-3 7h3"/>',
    bar: '<path d="M5 4h14l-7 8zM12 12v7M8 20h8"/>',
    park: '<path d="M12 3l5 7h-3l4 5H6l4-5H7zM12 15v6"/>',
    pharmacy: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
    hospital: '<path d="M7 4v16M17 4v16M7 12h10"/>',
    events: '<path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM10 7v10"/>',
  };

  // Order here is the order of the filter chips.
  const CATS = [
    { key: 'sights', one: 'Sight', label: 'Sights', icon: I.star, color: '#d9480f', on: true },
    { key: 'museums', one: 'Museum', label: 'Museums', icon: I.museum, color: '#7048e8', on: true },
    { key: 'galleries', one: 'Gallery', label: 'Galleries', icon: I.gallery, color: '#ae3ec9', on: true },
    { key: 'events', one: 'Event venue', label: 'Events', icon: I.events, color: '#c2255c', on: true },
    { key: 'parks', one: 'Park', label: 'Parks', icon: I.park, color: '#2b8a3e', on: true },
    { key: 'cafes', one: 'Café', label: 'Cafés', icon: I.cafe, color: '#a0522d', on: false },
    { key: 'restaurants', one: 'Restaurant', label: 'Restaurants', icon: I.restaurant, color: '#e8590c', on: false },
    { key: 'bars', one: 'Bar', label: 'Bars', icon: I.bar, color: '#5f3dc4', on: false },
    { key: 'pharmacies', one: 'Pharmacy', label: 'Pharmacies', icon: I.pharmacy, color: '#0c8599', on: false },
    { key: 'hospitals', one: 'Hospital or clinic', label: 'Hospitals', icon: I.hospital, color: '#e03131', on: false },
  ];
  const CAT = Object.fromEntries(CATS.map((c) => [c.key, c]));
  // Busy categories only show when zoomed in, so the map stays calm.
  const MIN_ZOOM = { cafes: 15, restaurants: 15, bars: 15, pharmacies: 14, hospitals: 13 };

  function categorize(t) {
    const a = t.amenity, tr = t.tourism, l = t.leisure;
    if (tr === 'museum') return 'museums';
    if (tr === 'gallery' || a === 'arts_centre' && /galler/i.test(t.name || '')) return 'galleries';
    if (a === 'theatre' || a === 'cinema' || a === 'arts_centre' || a === 'nightclub' || a === 'events_venue' || a === 'concert_hall' || l === 'stadium') return 'events';
    if (tr === 'attraction' || tr === 'zoo' || tr === 'aquarium' || tr === 'theme_park' || tr === 'viewpoint' || l === 'water_park' || t.historic === 'castle' || t.historic === 'fort' || t.historic === 'monument') return 'sights';
    if (l === 'park' || l === 'garden' && t.garden_type === 'botanical') return 'parks';
    if (a === 'cafe' || a === 'ice_cream') return 'cafes';
    if (a === 'restaurant' || a === 'fast_food') return 'restaurants';
    if (a === 'bar' || a === 'pub' || a === 'biergarten') return 'bars';
    if (a === 'pharmacy' || t.healthcare === 'pharmacy') return 'pharmacies';
    if (a === 'hospital' || a === 'clinic') return 'hospitals';
    return null;
  }

  // ---------- ticket notes for each city's main paid places ----------
  // Prices are the last known adult prices and change often, so the popup always says to check.
  const TICKETS_BY_CITY = {};
  TICKETS_BY_CITY.batumi = [
    { match: /alphabet/i, name: 'Alphabetic Tower', lat: 41.6563, lng: 41.6393, cat: 'sights', fee: true,
      price: 'about 10–15 GEL for the lift to the top', how: 'Buy at the ticket window at the foot of the tower. Cash and card are usually accepted.' },
    { match: /ali (and|&|და) nino|ალი და ნინო/i, name: 'Ali and Nino statue', lat: 41.6559, lng: 41.6398, cat: 'sights', fee: false,
      how: 'Free, open all the time. The figures move best to watch after dark (around 19:00 onward).' },
    { match: /\bargo\b|არგო/i, name: 'Argo Cable Car', lat: 41.6486, lng: 41.6474, cat: 'sights', fee: true,
      price: 'about 30 GEL return for adults, less for children', how: 'Buy at the lower station on Gogebashvili Street, by the port. Card and cash.' },
    { match: /ferris|ბორბალ|eshmakis borbali|ეშმაკის/i, name: 'Batumi Ferris Wheel', lat: 41.6555, lng: 41.6407, cat: 'sights', fee: true,
      price: 'about 10 GEL per ride', how: 'Pay at the booth by the wheel in Miracle Park.' },
    { match: /dolphin|დელფინ/i, name: 'Batumi Dolphinarium', lat: 41.6427, lng: 41.6246, cat: 'sights', fee: true,
      price: 'about 30–50 GEL depending on the seat', how: 'Shows run at set times, so check the schedule first. Buy at the box office by 6 May Park or online on ' + TICKET_SITES + '.' },
    { match: /aquarium|აკვარიუმ/i, name: 'Batumi Aquarium', lat: 41.6431, lng: 41.6251, cat: 'sights', fee: true,
      price: 'about 10 GEL', how: 'Buy at the entrance in 6 May Park, next to the Dolphinarium.' },
    { match: /botanical|ბოტანიკ/i, name: 'Batumi Botanical Garden', lat: 41.6937, lng: 41.7094, cat: 'parks', fee: true,
      price: 'about 25 GEL for visitors, less for Georgian citizens; the electric car inside is extra', how: 'Buy at the main gate (Mtsvane Kontskhi, about 9 km north of the centre). Card and cash.' },
    { match: /gonio|გონიო/i, name: 'Gonio Fortress', lat: 41.5728, lng: 41.5735, cat: 'sights', fee: true,
      price: 'about 15 GEL', how: 'Buy at the gate. Minibus 16 from the centre goes there.' },
    { match: /art museum|ხელოვნების მუზეუმ|adjara.*museum|აჭარის.*მუზეუმ/i, name: 'Adjara Art Museum', lat: 41.6474, lng: 41.6395, cat: 'museums', fee: true,
      price: 'about 5–10 GEL', how: 'Buy at the museum desk. Usually closed on Mondays.' },
    { match: /archaeolog|არქეოლოგ/i, name: 'Batumi Archaeological Museum', lat: 41.6466, lng: 41.6449, cat: 'museums', fee: true,
      price: 'about 5 GEL', how: 'Buy at the museum desk. Usually closed on Mondays.' },
    { match: /drama|ილია ჭავჭავაძის|chavchavadze.*theat/i, name: 'Batumi Drama Theatre', lat: 41.6491, lng: 41.6364, cat: 'events', fee: true,
      price: 'depends on the show, often 10–40 GEL', how: 'Buy at the theatre box office on Theatre Square or online on ' + TICKET_SITES + '.' },
  ];

  TICKETS_BY_CITY.tbilisi = [
    { match: /narikala|ნარიყალა/i, name: 'Narikala Fortress', lat: 41.6878, lng: 44.8085, cat: 'sights', fee: false,
      how: 'Free to walk around, open all the time. Walk up from Old Tbilisi or take the cable car from Rike Park.' },
    { match: /cable car|aerial tramway|საბაგირო/i, name: 'Rike Park – Narikala Cable Car', lat: 41.6921, lng: 44.8113, cat: 'sights', fee: true,
      price: 'about 2.5 GEL per ride', how: 'Tap a bank card or a Metromoney transport card at the gate in Rike Park. No ticket to buy in advance.' },
    { match: /funicular|ფუნიკულიორ/i, name: 'Mtatsminda Funicular', lat: 41.6950, lng: 44.7880, cat: 'sights', fee: true,
      price: 'about 3 GEL one way', how: 'Buy a rechargeable park card at the lower station on Chonkadze Street. The same card pays for the rides in Mtatsminda Park.' },
    { match: /mtatsminda.*park|მთაწმინდის პარკ/i, name: 'Mtatsminda Park', lat: 41.6943, lng: 44.7863, cat: 'parks', fee: false,
      how: 'Free to enter. Rides are paid with the park card sold at the funicular and park ticket desks.' },
    { match: /national museum|ეროვნული მუზეუმ|janashia|ჯანაშია/i, name: 'Georgian National Museum', lat: 41.6955, lng: 44.8007, cat: 'museums', fee: true,
      price: 'about 15–20 GEL for visitors, extra for the Treasury', how: 'Buy at the desk on Rustaveli Avenue 3. Usually closed on Mondays.' },
    { match: /sulfur|sulphur|abano|აბანო|chreli|ჭრელი/i, name: 'Sulphur Baths (Abanotubani)', lat: 41.6879, lng: 44.8104, cat: 'sights', fee: true,
      price: 'public baths from about 10–30 GEL; private rooms roughly 50–200 GEL per hour', how: 'Private rooms are booked by the hour at each bathhouse (for example Chreli Abano). Call or book ahead for evenings and weekends.' },
    { match: /bridge of peace|მშვიდობის ხიდ/i, name: 'Bridge of Peace', lat: 41.6930, lng: 44.8085, cat: 'sights', fee: false,
      how: 'Free, open all the time. It lights up after dark.' },
    { match: /sameba|holy trinity|სამება/i, name: 'Holy Trinity Cathedral (Sameba)', lat: 41.6975, lng: 44.8168, cat: 'sights', fee: false,
      how: 'Free. Cover shoulders and knees; women usually cover their hair.' },
    { match: /chronicles of georgia|საქართველოს მატიანე/i, name: 'Chronicles of Georgia', lat: 41.7746, lng: 44.8290, cat: 'sights', fee: false,
      how: 'Free, open all the time. Best at sunset; it is on a hill by the Tbilisi Sea, so go by taxi.' },
    { match: /botanical|ბოტანიკ/i, name: 'National Botanical Garden', lat: 41.6872, lng: 44.8050, cat: 'parks', fee: true,
      price: 'about 6 GEL', how: 'Buy at the gate below Narikala. Card and cash.' },
    { match: /opera|ოპერ/i, name: 'Tbilisi Opera and Ballet Theatre', lat: 41.6996, lng: 44.7962, cat: 'events', fee: true,
      price: 'depends on the show, often 20–150 GEL', how: 'Buy at the box office on Rustaveli Avenue or online on ' + TICKET_SITES + '.' },
    { match: /rustaveli.*theat|რუსთაველის.*თეატრ/i, name: 'Rustaveli Theatre', lat: 41.6988, lng: 44.7979, cat: 'events', fee: true,
      price: 'depends on the show, often 10–60 GEL', how: 'Buy at the box office or online on ' + TICKET_SITES + '.' },
    { match: /gabriadze|გაბრიაძ/i, name: 'Gabriadze Puppet Theatre', lat: 41.6963, lng: 44.8063, cat: 'events', fee: true,
      price: 'about 30–50 GEL', how: 'Small hall that sells out, so book several days ahead at the box office in Old Tbilisi or online on ' + TICKET_SITES + '. The clock tower show outside is free.' },
  ];
  // No ticket notes for Ayia Napa yet: we only list prices we have checked.
  TICKETS_BY_CITY.ayianapa = [];
  let TICKETS = TICKETS_BY_CITY.batumi;
  let currency = 'GEL';

    const CURATED_CATS = new Set(['sights', 'museums', 'galleries', 'events', 'parks']);
  function findCurated(p) {
    if (!CURATED_CATS.has(p.cat)) return null;
    const t = p.tags;
    return TICKETS.find((x) => x.match.test(p.name) || x.match.test(t.name || '') || x.match.test(t['name:ka'] || '')) || null;
  }

  function ticketInfo(p) {
    const t = p.tags, curated = findCurated(p);
    if (curated) {
      if (!curated.fee) return { needs: false, text: curated.how };
      return { needs: true, price: curated.price, how: curated.how, unverified: true };
    }
    if (t.fee === 'no') return { needs: false, text: 'Free entry.' };
    if (t.fee === 'yes' || t.charge) {
      return { needs: true, price: t.charge ? t.charge.replace(/;/g, ', ') : null,
        how: p.cat === 'events' ? 'Buy at the box office or online on ' + TICKET_SITES + '.' : 'Buy at the entrance.' };
    }
    if (p.cat === 'museums' || p.cat === 'galleries') return { maybe: true, text: currency ? `Most museums here charge a small entry fee (often 3–10 ${currency}), paid at the desk.` : 'Many museums charge a small entry fee, paid at the desk.' };
    if (p.cat === 'events') return { maybe: true, text: currency ? 'Tickets for shows and concerts are sold at the box office and online on ' + TICKET_SITES + '.' : 'Tickets for shows and concerts are usually sold at the venue.' };
    return null;
  }

  // ---------- opening hours ----------
  // Handles the common OSM forms ("Mo-Fr 09:00-18:00; Sa 10:00-14:00", "24/7", "Mo off", ranges past midnight).
  // Anything fancier returns null and the raw text is shown without an open/closed badge.
  const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const D = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)';
  const RULE = new RegExp('^\\s*(?:(' + D + '(?:\\s*-\\s*' + D + ')?(?:\\s*,\\s*' + D + '(?:\\s*-\\s*' + D + ')?)*)\\s*:?\\s*)?' +
    '(off|closed|24/7|\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}\\+?(?:\\s*,\\s*\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}\\+?)*)\\s*([;,]|\\|\\||$)', 'i');
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

  function parseHours(raw) {
    if (!raw) return null;
    let rest = raw.trim();
    if (/^24\/7$/.test(rest)) return Array.from({ length: 7 }, () => [[0, 1440]]);
    const week = Array.from({ length: 7 }, () => []);
    let additive = false;
    while (rest.length) {
      const m = rest.match(RULE);
      if (!m || !m[0].length) return null;
      rest = rest.slice(m[0].length);
      let days = [0, 1, 2, 3, 4, 5, 6];
      if (m[1]) {
        days = [];
        for (const part of m[1].split(/\s*,\s*/)) {
          if (/^PH$/i.test(part)) continue;
          const [a, b] = part.split(/\s*-\s*/).map((x) => DAYS.indexOf(x.slice(0, 1).toUpperCase() + x.slice(1).toLowerCase()));
          if (a < 0) continue;
          for (let i = a; ; i = (i + 1) % 7) { days.push(i); if (b == null || b < 0 || i === b) break; }
        }
        if (!days.length) { additive = m[3] === ','; continue; } // holiday-only rule
      }
      const val = m[2].toLowerCase();
      let ranges = [];
      if (val === '24/7') ranges = [[0, 1440]];
      else if (val !== 'off' && val !== 'closed') {
        ranges = val.split(/\s*,\s*/).map((r) => {
          const plus = r.endsWith('+'); const [s, e] = r.replace('+', '').split(/\s*-\s*/).map(toMin);
          let end = plus ? Math.max(e, 1440) : e; if (end <= s) end += 1440;
          return [s, end];
        });
      }
      for (const d of days) week[d] = additive ? week[d].concat(ranges) : ranges.slice();
      additive = m[3] === ',';
    }
    return week;
  }

  // Day of the week (0 = Monday) and minute of the day in the current city's time.
  const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  function cityNow() {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).map((x) => [x.type, x.value]));
      return { day: WD[parts.weekday], min: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
    } catch (e) {
      const t = new Date(Date.now() + (tz === 'Asia/Nicosia' ? 2 : 4) * 3600e3); // phones without time zone data
      return { day: (t.getUTCDay() + 6) % 7, min: t.getUTCHours() * 60 + t.getUTCMinutes() };
    }
  }
  function isOpenAt(week, day, min) {
    if (week[day].some(([s, e]) => min >= s && min < e)) return true;
    const prev = (day + 6) % 7;
    return week[prev].some(([s, e]) => e > 1440 && min + 1440 >= s && min + 1440 < e);
  }
  const hhmm = (m) => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

  function openStatus(raw) {
    const week = parseHours(raw);
    if (!week) return null;
    if (week.every((r) => r.length === 1 && r[0][0] === 0 && r[0][1] >= 1440)) return { open: true, text: 'Open 24 hours' };
    const now = cityNow(), open = isOpenAt(week, now.day, now.min);
    // Walk forward minute by minute (max a week) to find the next change.
    for (let i = 1; i <= 7 * 1440; i++) {
      const t = now.min + i, day = (now.day + Math.floor(t / 1440)) % 7, min = t % 1440;
      if (isOpenAt(week, day, min) !== open) {
        const when = i < 1440 - now.min ? hhmm(min) : (i < 2 * 1440 - now.min ? 'tomorrow ' + hhmm(min) : DAY_NAMES[day] + ' ' + hhmm(min));
        return { open, text: open ? 'Open now · closes ' + when : 'Closed now · opens ' + when };
      }
    }
    return open ? { open: true, text: 'Open now' } : { open: false, text: 'Closed' };
  }
  function isOpenNow(raw) { const w = parseHours(raw); if (!w) return null; const n = cityNow(); return isOpenAt(w, n.day, n.min); }

  // ---------- data ----------
  function overpassQuery(city) {
    const b = '(' + BBOX[city] + ')';
    return '[out:json][timeout:60];(' +
      `nwr[tourism~"^(museum|gallery|attraction|zoo|aquarium|theme_park)$"]${b};` +
      `nwr[amenity~"^(hospital|clinic|pharmacy|cafe|ice_cream|bar|pub|biergarten|restaurant|theatre|cinema|arts_centre|nightclub|events_venue|concert_hall)$"]${b};` +
      `nwr[leisure~"^(park|water_park|stadium)$"]${b};nwr[historic~"^(castle|fort)$"]${b};` +
      ');out center tags;';
  }
  const KEEP = ['name', 'name:en', 'name:ka', 'name:ru', 'opening_hours', 'fee', 'charge', 'website', 'contact:website', 'phone', 'contact:phone',
    'addr:street', 'addr:housenumber', 'cuisine', 'wikidata', 'wikipedia', 'brand', 'stars', 'tourism', 'amenity', 'leisure', 'historic', 'garden_type', 'healthcare', 'emergency', 'description'];

  function slim(json) {
    const out = [];
    for (const e of json.elements || []) {
      const t = e.tags || {}; if (!t.name && !t['name:en']) continue;
      const lat = e.lat ?? (e.center && e.center.lat), lng = e.lon ?? (e.center && e.center.lon);
      if (lat == null) continue;
      const tags = {}; for (const k of KEEP) if (t[k]) tags[k] = t[k];
      out.push({ id: e.type[0] + e.id, lat, lng, tags });
    }
    return out;
  }

  // Ask OpenStreetMap (Overpass), trying the next server if one is down.
  async function overpass(query) {
    let lastErr;
    for (const url of OVERPASS) {
      try {
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000);
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  async function fetchPlaces(city) { return slim(await overpass(overpassQuery(city))); }

  // Named districts and neighbourhoods of a city, for "favourite district" in trip stats.
  const DISTRICT_DAYS = 30;
  async function districts(city) {
    const key = 'niniko.districts.' + city;
    try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c && Date.now() - c.at < DISTRICT_DAYS * 864e5) return c.items; } catch (e) { /* ignore */ }
    const b = '(' + BBOX[city] + ')';
    const json = await overpass(`[out:json][timeout:40];nwr[place~"^(suburb|neighbourhood|quarter)$"][name]${b};out center tags;`);
    const items = (json.elements || []).map((e) => ({
      name: (e.tags && (e.tags['name:en'] || e.tags.name)) || '', local: (e.tags && e.tags.name) || '',
      lat: e.lat ?? (e.center && e.center.lat), lng: e.lon ?? (e.center && e.center.lon),
    })).filter((d) => d.name && d.lat != null);
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), items })); } catch (e) { /* full */ }
    return items;
  }

  const cacheKey = (city) => (city === 'batumi' ? CACHE_KEY : CACHE_KEY + '.' + city);
  function readCache(city) { try { return JSON.parse(localStorage.getItem(cacheKey(city)) || 'null'); } catch (e) { return null; } }
  function writeCache(city, items) { try { localStorage.setItem(cacheKey(city), JSON.stringify({ at: Date.now(), items })); } catch (e) { /* full */ } }

  // ---------- presentation ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

  function decorate(raw) {
    const t = raw.tags, cat = categorize(t);
    if (!cat) return null;
    const name = t['name:en'] || t.name;
    const alt = t.name && t.name !== name ? t.name : (t['name:ka'] && t['name:ka'] !== name ? t['name:ka'] : '');
    const p = { ...raw, cat, name, alt };
    p.popular = isPopular(p);
    return p;
  }

  // "Popular" keeps places that are well known (they have a Wikipedia/Wikidata entry or are on our ticket list)
  // or that look like real, well-kept businesses in OpenStreetMap. Everything else only shows with "All places".
  function isPopular(p) {
    const t = p.tags;
    if (t.wikidata || t.wikipedia || findCurated(p)) return true;
    const site = !!(t.website || t['contact:website']), hours = !!t.opening_hours, phone = !!(t.phone || t['contact:phone']);
    switch (p.cat) {
      case 'museums': return true;
      case 'events': return t.amenity === 'theatre' || t.amenity === 'concert_hall' || t.amenity === 'cinema' || site;
      case 'sights': return t.tourism !== 'attraction' || site;
      case 'galleries': return site;
      case 'parks': return false;
      case 'cafes': case 'restaurants': case 'bars': return (site ? 1 : 0) + (hours ? 1 : 0) + (phone ? 1 : 0) + (t.cuisine ? 1 : 0) >= 3;
      case 'pharmacies': return !!t.brand || site;
      case 'hospitals': return t.amenity === 'hospital';
      default: return false;
    }
  }

  // ---------- visited ----------
  // id -> { at, name, lat, lng, cat }, so visited places can be listed from any city. Older entries are just a time.
  let visited = {};
  try { visited = JSON.parse(localStorage.getItem(VISITED_KEY) || '{}') || {}; } catch (e) { visited = {}; }
  const visitedAt = (v) => (typeof v === 'number' ? v : v && v.at);
  const saveVisited = () => { try { localStorage.setItem(VISITED_KEY, JSON.stringify(visited)); } catch (e) { /* full */ } };
  const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

  function placeIcon(p) {
    const c = CAT[p.cat], v = !!visited[p.id];
    return L.divIcon({ className: '', html: `<div class="poi${v ? ' is-visited' : ''}" style="--c:${c.color}">${svg(c.icon)}<span class="poi-check"></span></div>`,
      iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
  }

  function popupHtml(p) {
    const t = p.tags, c = CAT[p.cat];
    const st = openStatus(t.opening_hours);
    const tk = ticketInfo(p);
    const site = t.website || t['contact:website'];
    const phone = t.phone || t['contact:phone'];
    const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    const v = visited[p.id];
    const visitTag = v ? `<span class="pill pill-visited">Visited · ${esc(fmtDay(visitedAt(v)))}</span>` : '<span class="pill pill-new">Not visited yet</span>';
    let status = '';
    if (st) status = `<span class="pill ${st.open ? 'pill-open' : 'pill-closed'}">${esc(st.text)}</span>`;
    else if (t.opening_hours) status = '<span class="pill">Check hours below</span>';
    else if (p.cat !== 'parks' && !findCurated(p)) status = '<span class="pill">Hours not listed</span>';
    let ticket = '';
    if (tk) {
      if (tk.needs) {
        ticket = `<div class="ticket"><b>Ticket needed</b>${tk.price ? `<div>Price: ${esc(tk.price)}</div>` : ''}<div>${tk.how}</div>` +
          (tk.unverified ? '<div class="fine">Prices change often. This is the last known price, so check at the desk.</div>' : '') + '</div>';
      } else if (tk.maybe) ticket = `<div class="ticket"><b>Tickets</b><div>${tk.text}</div></div>`;
      else ticket = `<div class="ticket ticket-free"><b>No ticket needed</b><div>${esc(tk.text)}</div></div>`;
    }
    const hours = t.opening_hours ? `<div class="hours">${esc(t.opening_hours).replace(/;\s*/g, '<br>')}</div>` : '';
    const links = [
      `<a href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">Directions</a>`,
      site ? `<a href="${esc(/^https?:/.test(site) ? site : 'https://' + site)}" target="_blank" rel="noopener">Website</a>` : '',
      phone ? `<a href="tel:${esc(phone.split(/[;,]/)[0].replace(/\s/g, ''))}">${esc(phone.split(/[;,]/)[0])}</a>` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="pop"><div class="cat" style="color:${c.color}">${c.one}</div>
      <h3>${esc(p.name)}</h3>${p.alt ? `<div class="when">${esc(p.alt)}</div>` : ''}
      <div class="pills">${visitTag}${status}</div>${hours}${ticket}
      ${addr ? `<div class="when">${esc(addr)}</div>` : ''}
      <div class="links">${links}</div>
      <div class="row"><button class="btn btn-sm${v ? '' : ' btn-primary'}" data-act="visit">${v ? 'Mark not visited' : 'Mark visited'}</button>
      <button class="btn btn-sm" data-act="memory">Add a memory</button></div></div>`;
  }

  // ---------- layer ----------
  function init(map, opts) {
    const layer = L.layerGroup().addTo(map);
    const shown = new Map(); // place id -> marker
    let places = [];
    let filters;
    try { filters = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); } catch (e) { filters = null; }
    if (!filters) filters = Object.fromEntries(CATS.map((c) => [c.key, c.on]));
    let openOnly = false;
    let visitMode = 'all'; // all | todo | done
    const VISIT_LABEL = { all: 'Visited or not', todo: 'Not visited', done: 'Visited' };
    let popularOnly = true;
    try { popularOnly = localStorage.getItem(POPULAR_KEY) !== 'all'; } catch (e) { /* ignore */ }

    const bar = document.getElementById('chips');
    function renderChips() {
      bar.innerHTML = `<button type="button" class="chip chip-open${popularOnly ? ' on' : ''}" data-k="__popular" aria-pressed="${popularOnly}">${popularOnly ? 'Popular only' : 'All places'}</button>` +
        `<button type="button" class="chip chip-open${openOnly ? ' on' : ''}" data-k="__open" aria-pressed="${openOnly}">Open now</button>` +
        `<button type="button" class="chip chip-visit${visitMode !== 'all' ? ' on' : ''}" data-k="__visit">${VISIT_LABEL[visitMode]}</button>` +
        CATS.map((c) => `<button type="button" class="chip${filters[c.key] ? ' on' : ''}" data-k="${c.key}" style="--c:${c.color}" aria-pressed="${!!filters[c.key]}">${svg(c.icon)}${c.label}</button>`).join('');
    }
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      const k = b.dataset.k;
      if (k === '__open') openOnly = !openOnly;
      else if (k === '__visit') visitMode = visitMode === 'all' ? 'todo' : visitMode === 'todo' ? 'done' : 'all';
      else if (k === '__popular') {
        popularOnly = !popularOnly;
        try { localStorage.setItem(POPULAR_KEY, popularOnly ? 'popular' : 'all'); } catch (err) { /* ignore */ }
        opts.toast && opts.toast(popularOnly ? 'Showing only popular places' : 'Showing all places');
      } else filters[k] = !filters[k];
      try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch (err) { /* ignore */ }
      renderChips(); render();
    });

    function render() {
      const z = map.getZoom(), view = map.getBounds().pad(0.3), c = map.getCenter();
      const list = places.filter((p) => filters[p.cat] && (!popularOnly || p.popular) && z >= (MIN_ZOOM[p.cat] || 0) && view.contains([p.lat, p.lng])
        && (!openOnly || isOpenNow(p.tags.opening_hours) === true)
        && (visitMode === 'all' || (visitMode === 'done') === !!visited[p.id]));
      // Too many markers make the map messy and slow on a phone, so keep the ones nearest the middle of the screen.
      const cos = Math.cos(c.lat * Math.PI / 180), d2 = (p) => ((p.lng - c.lng) * cos) ** 2 + (p.lat - c.lat) ** 2;
      list.sort((a, b) => d2(a) - d2(b));
      // Only add and remove what changed, so an open popup isn't closed when the map pans to show it.
      const keep = new Set();
      for (const p of list.slice(0, MAX_MARKERS)) {
        keep.add(p.id);
        if (shown.has(p.id)) continue;
        const mk = L.marker([p.lat, p.lng], { icon: placeIcon(p), title: p.name, keyboard: true });
        mk.bindPopup(() => popupHtml(p), { maxWidth: 280 });
        mk.on('popupopen', (e) => wirePopup(e.popup, p, mk));
        mk.addTo(layer); shown.set(p.id, mk);
      }
      for (const [id, mk] of shown) if (!keep.has(id) && !mk.isPopupOpen()) { layer.removeLayer(mk); shown.delete(id); }
    }
    let t; map.on('moveend zoomend', () => { clearTimeout(t); t = setTimeout(render, 120); });

    function wirePopup(popup, p, mk) {
      const el = popup.getElement();
      el.querySelector('[data-act="memory"]').onclick = () => { map.closePopup(); opts.onAddMemory(L.latLng(p.lat, p.lng), p.name); };
      el.querySelector('[data-act="visit"]').onclick = () => {
        setVisited(p, !visited[p.id]);
        opts.toast && opts.toast(visited[p.id] ? `Marked ${p.name} as visited` : `Marked ${p.name} as not visited`);
        // Redraw after this tap has finished, or the map treats it as a tap outside the popup and closes it.
        setTimeout(() => { popup.setContent(popupHtml(p)); wirePopup(popup, p, mk); }, 0);
      };
    }
    function setVisited(p, on) {
      if (on) visited[p.id] = { at: Date.now(), name: p.name, lat: p.lat, lng: p.lng, cat: p.cat }; else delete visited[p.id];
      saveVisited();
      const mk = shown.get(p.id); if (mk) mk.setIcon(placeIcon(p));
    }

    function setPlaces(raw) {
      const seen = new Set();
      layer.clearLayers(); shown.clear();
      places = raw.map(decorate).filter(Boolean);
      places.forEach((p) => { const k = findCurated(p); if (k) seen.add(k.name); });
      // Make sure the main paid sights are on the map even if OSM names them differently.
      for (const k of TICKETS) if (!seen.has(k.name)) places.push({ id: 'k-' + k.name, lat: k.lat, lng: k.lng, cat: k.cat, name: k.name, alt: '', popular: true, tags: { name: k.name } });
      render();
    }

    // Load a city's places: from the phone's copy if it is recent, otherwise from OpenStreetMap.
    let city = null;
    function setCity(c) {
      if (!BBOX[c] || c === city) return;
      city = c; TICKETS = TICKETS_BY_CITY[c] || []; tz = TZ[c] || tz; currency = c === 'ayianapa' ? '' : 'GEL';
      const cached = readCache(c);
      setPlaces(cached && cached.items ? cached.items : []);
      if (!cached || Date.now() - cached.at > CACHE_DAYS * 864e5) {
        fetchPlaces(c).then((items) => { writeCache(c, items); if (city === c) setPlaces(items); })
          .catch(() => { if (!cached && city === c) opts.toast && opts.toast('Could not load places right now. They will appear when you are online.'); });
      }
    }

    renderChips();
    setCity(opts.city || 'batumi');
    // Refresh open/closed filtering every few minutes.
    setInterval(() => { if (openOnly) render(); }, 5 * 60000);
    // Popular places within r metres of a spot, nearest first (used to name a photo memory).
    function near(lat, lng, r) {
      const R = 6371000, rad = Math.PI / 180;
      const dist = (p) => { const x = (p.lng - lng) * rad * Math.cos(lat * rad), y = (p.lat - lat) * rad; return Math.sqrt(x * x + y * y) * R; };
      return places.filter((p) => p.popular).map((p) => [dist(p), p]).filter(([d]) => d <= r).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
    }
    return {
      render, near, setCity,
      // Mark a place visited (used when you take a photo there). Returns the place if it changed.
      markVisited(p) { if (!p || visited[p.id]) return null; setVisited(p, true); return p; },
      unmarkVisited(id) { const p = places.find((x) => x.id === id) || { id }; delete visited[id]; saveVisited(); const mk = shown.get(id); if (mk && p.cat) mk.setIcon(placeIcon(p)); },
      visitedList: () => Object.entries(visited).map(([id, v]) => {
        const p = places.find((x) => x.id === id);
        return { id, at: visitedAt(v), name: (v && v.name) || (p && p.name), lat: (v && v.lat) || (p && p.lat), lng: (v && v.lng) || (p && p.lng), cat: (v && v.cat) || (p && p.cat) };
      }).filter((x) => x.name && x.lat != null).sort((a, b) => b.at - a.at),
      catLabel: (cat) => (CAT[cat] ? CAT[cat].one : 'Place'),
      exportVisited: () => ({ ...visited }),
      importVisited(v) { Object.assign(visited, v || {}); saveVisited(); layer.clearLayers(); shown.clear(); render(); },
    };
  }

  window.NinikoPlaces = { init, districts, _test: { parseHours, openStatus, isOpenAt } };
})();
