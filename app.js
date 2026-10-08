/* Niniko's Map: walks and memories around Batumi, saved on this device. */
(function () {
  'use strict';

  // Cities the map knows. center is [lat, lng]; box is [south, west, north, east].
  const CITIES = {
    batumi: { name: 'Batumi', country: 'Georgia', center: [41.6430, 41.6360], box: [41.565, 41.555, 41.700, 41.720], tz: 'Asia/Tbilisi' },
    tbilisi: { name: 'Tbilisi', country: 'Georgia', center: [41.6925, 44.8030], box: [41.640, 44.700, 41.800, 44.920], tz: 'Asia/Tbilisi' },
    // Ayia Napa town with Cape Greco and Protaras. Cyprus time (UTC+2, +3 in summer).
    ayianapa: { name: 'Ayia Napa', country: 'Cyprus', center: [34.9886, 33.9997], box: [34.955, 33.920, 35.035, 34.095], tz: 'Asia/Nicosia' },
    // Larnaca town and seafront, the Salt Lake, the airport, Mackenzie beach, Oroklini and Aradippou.
    larnaca: { name: 'Larnaca', country: 'Cyprus', center: [34.9150, 33.6350], box: [34.855, 33.560, 34.985, 33.720], tz: 'Asia/Nicosia' },
  };
  const CITY_KEY = 'niniko.city';
  let city = (() => { try { return CITIES[localStorage.getItem(CITY_KEY)] ? localStorage.getItem(CITY_KEY) : 'batumi'; } catch (e) { return 'batumi'; } })();
  const inCity = (c, lat, lng) => { const b = CITIES[c].box; return lat >= b[0] && lat <= b[2] && lng >= b[1] && lng <= b[3]; };
  // Times on the map are shown in the local time of the city where they happened, whatever the phone is set to.
  const tzAt = (lat, lng) => { const c = Object.keys(CITIES).find((k) => inCity(k, lat, lng)); return c ? CITIES[c].tz : undefined; };
  // Dates and times are always written in English, whatever language the phone uses.
  const LOCALE = 'en-GB';
  // Date formatters are slow to create, so each one is made once and reused.
  const fmtCache = new Map();
  function formatter(locale, opts, tz) {
    const key = locale + JSON.stringify(opts) + (tz || '');
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(locale, tz ? { ...opts, timeZone: tz } : opts));
    return fmtCache.get(key);
  }
  function inTz(opts, tz) { try { return formatter(LOCALE, opts, tz); } catch (e) { return formatter(LOCALE, opts); } }
  function dayKey(ms, tz) {
    try { return formatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }, tz).format(ms); }
    catch (e) { return new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  }
  function hourIn(ms, tz) {
    try { return Number(formatter('en-GB', { hour: '2-digit', hourCycle: 'h23' }, tz).format(ms)) % 24; }
    catch (e) { return new Date(ms).getHours(); }
  }
  const MIN_STEP_M = 8;              // ignore GPS jitter smaller than this
  const MAX_SPEED_MS = 15;           // a jump faster than this (54 km/h) is a GPS glitch, unless it keeps happening
  const AUTO_KEY = 'niniko.autoRecord';
  const AUTO_GAP_MS = 30 * 60000;    // a trail paused longer than this becomes its own walk
  const MIN_WALK_M = 200;            // walks shorter than this aren't saved (they just clutter the list)
  const MIN_SPREAD_M = 60;           // nor walks that never got further than this from where they started
  const MAX_ACCURACY_M = 40;         // ignore fixes worse than this
  const REC_KEY = 'niniko.recording';

  // Running inside the phone app (Capacitor) rather than a browser. The app's own pages count as secure.
  const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const plugin = (name) => (NATIVE && window.Capacitor.Plugins ? window.Capacitor.Plugins[name] : null);
  const secure = () => window.isSecureContext || NATIVE;

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const todayISO = (tz) => dayKey(Date.now(), tz);

  function haversine(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function pathLength(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
    return d;
  }

  // GPS wobbles a few metres either side of where you really walked, which draws as zigzags.
  // For drawing and distance: drop out-and-back spikes, average each point with its neighbours,
  // then remove points that sit on a straight line. The recorded points (with times) stay untouched.
  function smoothTrail(points) {
    let pts = points.map((p) => [p[0], p[1]]);
    if (pts.length < 3) return pts;
    const kept = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = kept[kept.length - 1], b = pts[i], c = pts[i + 1];
      const ab = haversine(a, b), bc = haversine(b, c);
      if (ab > 12 && bc > 12 && haversine(a, c) < 0.35 * Math.min(ab, bc)) continue; // went out and straight back
      kept.push(b);
    }
    kept.push(pts[pts.length - 1]); pts = kept;
    const W = [1, 2, 3, 2, 1];
    for (let pass = 0; pass < 2; pass++) {
      pts = pts.map((p, i) => {
        if (i === 0 || i === pts.length - 1) return p;
        let la = 0, ln = 0, ws = 0;
        for (let k = -2; k <= 2; k++) { const q = pts[i + k]; if (!q) continue; la += q[0] * W[k + 2]; ln += q[1] * W[k + 2]; ws += W[k + 2]; }
        return [la / ws, ln / ws];
      });
    }
    return simplifyPath(pts, 2.5);
  }
  // Douglas–Peucker simplification with the tolerance in metres.
  function simplifyPath(pts, tol) {
    if (pts.length < 3) return pts;
    const lat0 = pts[0][0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const xy = pts.map((p) => [(p[1] - pts[0][1]) * kx, (p[0] - lat0) * ky]);
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
      let far = -1, farD = tol;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / len;
        if (d > farD) { farD = d; far = i; }
      }
      if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
    }
    return pts.filter((p, i) => keep[i]);
  }
  // Smoothing a long walk takes a moment, so the result is kept until the walk gets new points.
  const smoothCache = new WeakMap();
  function smoothed(points) {
    const c = smoothCache.get(points);
    if (c && c.n === points.length) return c.line;
    const line = smoothTrail(points);
    smoothCache.set(points, { n: points.length, line, len: pathLength(line) });
    return line;
  }
  const trailLength = (points) => { smoothed(points); return smoothCache.get(points).len; };
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km'; }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function fmtDate(isoOrMs) {
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs + 'T12:00:00');
    return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  // Memories hold a list of photos; older ones saved a single "photo".
  const photosOf = (m) => (m.photos && m.photos.length ? m.photos : (m.photo ? [m.photo] : []));
  function fmtTime(ms, tz) { return inTz({ hour: '2-digit', minute: '2-digit' }, tz).format(ms); }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- storage (IndexedDB, falls back to memory) ----------
  const store = (function () {
    let dbp = null;
    const mem = { walks: new Map(), memories: new Map() };
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve) => {
        try {
          // Version 2 matches the newer app, so pins and photos it saved stay on the phone untouched.
          const req = indexedDB.open('niniko-map', 2);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('walks')) db.createObjectStore('walks', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('memories')) db.createObjectStore('memories', { keyPath: 'id' });
          };
          req.onsuccess = () => {
            const db = req.result;
            db.onclose = () => { dbp = null; }; // the browser dropped the connection; open it again next time
            db.onversionchange = () => { db.close(); dbp = null; };
            resolve(db);
          };
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
      return dbp;
    }
    function tx(name, mode, fn, retry = true) {
      return open().then((db) => new Promise((resolve, reject) => {
        if (!db) { resolve(fn(null)); return; }
        const t = db.transaction(name, mode), os = t.objectStore(name);
        const r = fn(os);
        t.oncomplete = () => resolve(r && typeof r === 'object' && 'result' in r ? r.result : r); // delete returns a plain id string
        t.onerror = t.onabort = () => reject(t.error || new Error('Storage error'));
      })).catch((e) => {
        // iPhones sometimes lose the database connection while the app sits in the background: reconnect once and try again.
        if (retry) { dbp = null; return tx(name, mode, fn, false); }
        throw e;
      });
    }
    const saveFailed = (e) => { toast('Could not save on this phone. Its storage may be full.', 5000); throw e; };
    return {
      all(name) {
        return tx(name, 'readonly', (os) => os ? os.getAll() : Array.from(mem[name].values()));
      },
      put(name, obj) {
        return tx(name, 'readwrite', (os) => { if (os) os.put(obj); else mem[name].set(obj.id, obj); return obj; }).catch(saveFailed);
      },
      del(name, id) {
        return tx(name, 'readwrite', (os) => { if (os) os.delete(id); else mem[name].delete(id); return id; }).catch(saveFailed);
      },
    };
  })();

  // ---------- map ----------
  // Keep popups clear of the title, filter chips and bottom toolbar when they open.
  L.Popup.mergeOptions({ autoPanPaddingTopLeft: L.point(12, 170), autoPanPaddingBottomRight: L.point(12, 110) });
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(CITIES[city].center, 15);
  // ---------- map styles ----------
  // Jarji's five picks from the map catalogue (maps.html). All free and need no key.
  // The first four are vector maps drawn by MapLibre underneath Leaflet, with names switched to English.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const OFM_ATTR = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' + OSM_ATTR;
  const VT_ATTR = '<a href="https://versatiles.org" target="_blank" rel="noopener">VersaTiles</a> ' + OSM_ATTR;
  const esriTiles = (path) => 'https://server.arcgisonline.com/ArcGIS/rest/services/' + path + '/MapServer/tile/{z}/{y}/{x}';
  const BASEMAPS = {
    liberty: { name: 'Liberty', note: 'Bright and colourful, with green parks and blue sea.', style: 'https://tiles.openfreemap.org/styles/liberty', attribution: OFM_ATTR },
    bright: { name: 'Bright', note: 'Classic, cheerful street map with lots of colour.', style: 'https://tiles.openfreemap.org/styles/bright', attribution: OFM_ATTR },
    colorful: { name: 'Colorful', note: 'Soft pastel colours with a modern look.', style: 'https://tiles.versatiles.org/assets/styles/colorful/style.json', attribution: VT_ATTR },
    neutrino: { name: 'Neutrino', note: 'Minimal and gentle, in warm grey tones.', style: 'https://tiles.versatiles.org/assets/styles/neutrino/style.json', attribution: VT_ATTR },
    lightgray: { name: 'Light grey', note: 'Plain light grey with English names.', tiles: esriTiles('Canvas/World_Light_Gray_Base'),
      labels: esriTiles('Canvas/World_Light_Gray_Reference'), maxNative: 16, attribution: 'Tiles &copy; Esri, sources: Esri, HERE, Garmin, ' + OSM_ATTR },
  };
  const BASEMAP_ORDER = Object.keys(BASEMAPS);

  // A MapLibre map living inside Leaflet's tile pane, kept in step with Leaflet's view.
  // (MapLibre zoom is one less than Leaflet's at the same scale, because its tiles are 512 px.)
  const EN_NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name_int'], ['get', 'name']];
  const GLLayer = L.Layer.extend({
    initialize(opts) { this.opts = opts; },
    getAttribution() { return this.opts.attribution; },
    onAdd(m) {
      const el = this._el = L.DomUtil.create('div', 'gl-layer leaflet-zoom-animated');
      m.getPanes().tilePane.appendChild(el);
      this._resize();
      const c = m.getCenter();
      try {
        this.gl = new maplibregl.Map({ container: el, style: this.opts.style, interactive: false, attributionControl: false,
          center: [c.lng, c.lat], zoom: m.getZoom() - 1, fadeDuration: 0 });
      } catch (e) { // older phones without WebGL 2 can't draw these maps
        this.gl = null; setTimeout(() => this.opts.onError && this.opts.onError({ error: e, fatal: true })); return;
      }
      this.gl.on('style.load', () => {
        // Show English names (or the Latin spelling), never Georgian or Greek script.
        for (const layer of this.gl.getStyle().layers || []) {
          if (layer.type !== 'symbol') continue;
          const tf = this.gl.getLayoutProperty(layer.id, 'text-field');
          if (tf && /name/.test(JSON.stringify(tf))) this.gl.setLayoutProperty(layer.id, 'text-field', EN_NAME);
        }
        if (this.opts.onLoad) this.opts.onLoad();
      });
      this.gl.on('error', (e) => { if (this.opts.onError) this.opts.onError(e); });
      m.on('move zoom viewreset', this._sync, this);
      m.on('resize', this._resize, this);
      m.on('zoomanim', this._zoomAnim, this);
      this._sync();
    },
    onRemove(m) {
      m.off('move zoom viewreset', this._sync, this); m.off('resize', this._resize, this); m.off('zoomanim', this._zoomAnim, this);
      if (this.gl) { this.gl.remove(); this.gl = null; }
      L.DomUtil.remove(this._el);
    },
    _resize() {
      const size = this._map.getSize();
      this._el.style.width = size.x + 'px'; this._el.style.height = size.y + 'px';
      if (this.gl) { this.gl.resize(); this._sync(); }
    },
    _sync() {
      const m = this._map; if (!m || !this.gl) return;
      L.DomUtil.setPosition(this._el, m.containerPointToLayerPoint([0, 0]));
      const c = m.getCenter();
      this.gl.jumpTo({ center: [c.lng, c.lat], zoom: m.getZoom() - 1 });
    },
    // Follow Leaflet's zoom animation by scaling the canvas, then redraw sharp when it ends.
    _zoomAnim(e) {
      const m = this._map, scale = m.getZoomScale(e.zoom);
      const offset = m._latLngBoundsToNewLayerBounds(m.getBounds(), e.zoom, e.center).min;
      L.DomUtil.setTransform(this._el, offset, scale);
    },
  });

  const BASEMAP_KEY = 'niniko.basemap.v3'; // v3: Jarji's five catalogue picks, Liberty first
  let baseKey = 'liberty', baseLayer = null, baseTimer = null;
  try { if (BASEMAPS[localStorage.getItem(BASEMAP_KEY)]) baseKey = localStorage.getItem(BASEMAP_KEY); } catch (e) { /* ignore */ }
  // If a map doesn't load, try the next of the five for this visit (without changing the saved choice).
  function failBasemap(key, tried) {
    if (baseKey !== key) return;
    const next = BASEMAP_ORDER.find((k) => !tried.includes(k));
    if (!next) return;
    toast(`The ${BASEMAPS[key].name} map isn't loading right now, so this is ${BASEMAPS[next].name} for now.`, 4500);
    setBasemap(next, false, tried);
  }
  function setBasemap(key, save = true, tried = []) {
    const b = BASEMAPS[key] || BASEMAPS.liberty;
    key = BASEMAPS[key] ? key : 'liberty';
    clearTimeout(baseTimer);
    if (baseLayer) map.removeLayer(baseLayer);
    baseKey = key; tried = tried.concat(key);
    let loaded = false;
    if (b.style && window.maplibregl && maplibregl.supported !== false) {
      baseLayer = new GLLayer({ style: b.style, attribution: b.attribution,
        onLoad: () => { loaded = true; },
        onError: (e) => { if (e.fatal) failBasemap(key, tried); else if (!loaded && /style|fetch|Failed|404|50\d/i.test(String((e && e.error && (e.error.message || e.error.status)) || ''))) failBasemap(key, tried); } });
      baseLayer.addTo(map);
      baseTimer = setTimeout(() => { if (!loaded) failBasemap(key, tried); }, 15000);
    } else if (b.style) {
      failBasemap(key, tried); return; // this phone can't draw vector maps
    } else {
      const base = L.tileLayer(b.tiles, { maxZoom: 19, maxNativeZoom: b.maxNative || 19, attribution: b.attribution });
      if (!map.getPane('baseLabels')) map.createPane('baseLabels').style.zIndex = 250; // above the map, below trails
      const labels = b.labels ? L.tileLayer(b.labels, { maxZoom: 19, maxNativeZoom: b.maxNative || 19, pane: 'baseLabels' }) : null;
      baseLayer = L.layerGroup([base].concat(labels || [])).addTo(map);
      let ok = 0, bad = 0;
      base.on('tileload', () => { ok++; });
      base.on('tileerror', () => { if (++bad >= 4 && ok === 0) failBasemap(key, tried); });
    }
    if (save) try { localStorage.setItem(BASEMAP_KEY, baseKey); } catch (e) { /* ignore */ }
  }
  setBasemap(baseKey);
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => renderAll());

  const walkColor = () => getComputedStyle(document.documentElement).getPropertyValue('--walk').trim() || '#e8456b';
  const walkStyle = () => ({ color: walkColor(), weight: 6, opacity: 0.6, lineCap: 'round', lineJoin: 'round' });

  const walksLayer = L.layerGroup().addTo(map);
  const memoriesLayer = L.layerGroup().addTo(map);
  let meMarker = null, meCircle = null;

  const state = {
    walks: [],
    memories: [],
    recording: null,  // { id, startedAt, points: [[lat,lng,t]] }
    recLine: null,
    watchId: null,
    wakeLock: null,
    mode: 'idle',     // idle | pickMemory | drawWalk
    draw: null,       // { points: [], line, vertices }
    pendingMemory: null,
    jumps: 0,            // GPS jumps skipped in a row
  };

  // ---------- one city at a time ----------
  // Walks, memories and visited places belong to the city they are in (a walk goes by where it started).
  // Worked out from the location, so everything saved before this still sorts itself into the right city.
  const cityOf = (lat, lng) => Object.keys(CITIES).find((k) => inCity(k, lat, lng)) || null;
  const walkCity = (w) => (w.points.length ? cityOf(w.points[0][0], w.points[0][1]) : null);
  // key is a city key or 'all'.
  function scope(key) {
    const inIt = (c) => key === 'all' || c === key;
    return {
      key, name: key === 'all' ? 'All cities' : CITIES[key].name,
      walks: state.walks.filter((w) => inIt(walkCity(w))),
      memories: state.memories.filter((m) => inIt(cityOf(m.lat, m.lng))),
      visited: places.visitedList().filter((v) => inIt(cityOf(v.lat, v.lng))),
    };
  }

  // ---------- rendering ----------
  // The title bar shows the totals for the city you're looking at.
  function renderStats() {
    const walks = state.walks.filter((w) => walkCity(w) === city), mems = state.memories.filter((m) => cityOf(m.lat, m.lng) === city);
    let km = walks.reduce((s, w) => s + (w.distance || 0), 0);
    const rp = state.recording && state.recording.points;
    if (rp && (!rp.length || cityOf(rp[0][0], rp[0][1]) === city)) km += trailLength(rp); // count the walk in progress too
    $('stats').innerHTML = `<span class="sw" style="background:${walkColor()}"></span><b>${fmtDist(km)}</b> walked · <b>${mems.length}</b> ${mems.length === 1 ? 'memory' : 'memories'}`;
  }

  function renderWalks() {
    walksLayer.clearLayers();
    for (const w of state.walks) {
      const pts = w.drawn ? w.points.map((p) => [p[0], p[1]]) : smoothed(w.points);
      w._line = L.polyline(pts, { ...walkStyle(), interactive: false }).addTo(walksLayer);
      trailHitLine(pts, (latlng) => openWalkPopup(w, latlng)).addTo(walksLayer);
    }
  }

  // Small copies of photos for map pins and lists. Dozens of full-size photos as pins use a lot of a phone's memory.
  const thumbs = new Map(), waiting = new Map(); // full photo -> small copy; full photo -> who to tell when it's made
  let thumbQueue = Promise.resolve();
  function thumbOf(src, onReady) {
    if (!src) return null;
    if (thumbs.has(src)) return thumbs.get(src);
    if (waiting.has(src)) { if (onReady) waiting.get(src).push(onReady); return null; }
    waiting.set(src, onReady ? [onReady] : []);
    const ready = (small) => { thumbs.set(src, small); const cbs = waiting.get(src); waiting.delete(src); cbs.forEach((cb) => cb()); };
    thumbQueue = thumbQueue.then(() => new Promise((done) => { // one at a time, so they don't all load at once
      const img = new Image();
      img.onload = () => {
        const S = 96, c = document.createElement('canvas'); c.width = c.height = S;
        const k = S / Math.min(img.width, img.height), w = img.width * k, hh = img.height * k;
        c.getContext('2d').drawImage(img, (S - w) / 2, (S - hh) / 2, w, hh);
        ready(c.toDataURL('image/jpeg', 0.8)); done();
      };
      img.onerror = () => { ready(src); done(); };
      img.src = src;
    }));
    return null;
  }
  function memoryIcon(m) {
    const ph = thumbOf(photosOf(m)[0], () => m._marker && m._marker.setIcon(memoryIcon(m))), style = ph ? ` style="background-image:url('${ph}')"` : '';
    return L.divIcon({
      className: '',
      html: `<div class="pin${ph ? ' has-photo' : ''}"${style}><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.4-7 10-7 10z"/></svg></div>`,
      iconSize: [34, 34], iconAnchor: [17, 40], popupAnchor: [0, -38],
    });
  }

  function renderMemories() {
    memoriesLayer.clearLayers();
    for (const m of state.memories) {
      const mk = L.marker([m.lat, m.lng], { icon: memoryIcon(m), title: m.title, keyboard: true });
      mk.bindPopup(() => memoryPopupHtml(m), { maxWidth: 270 });
      mk.on('popupopen', (e) => wireMemoryPopup(e.popup, m));
      mk.addTo(memoriesLayer);
      m._marker = mk;
    }
  }

  function renderAll() { renderWalks(); renderMemories(); renderStats(); }

  // A wide invisible line on top of each trail so it is easy to tap with a finger.
  function trailHitLine(pts, onTap) {
    const hit = L.polyline(pts, { color: '#000', opacity: 0, weight: 26, lineCap: 'round', lineJoin: 'round' });
    hit.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (state.mode !== 'idle' && state.mode !== 'day') handleMapTap(e.latlng); else onTap(e.latlng);
    });
    return hit;
  }

  // The recorded point closest to where the trail was tapped.
  function nearestPoint(points, latlng) {
    const tap = map.latLngToLayerPoint(latlng);
    let best = null, bestD = Infinity;
    for (const p of points) {
      const d = map.latLngToLayerPoint([p[0], p[1]]).distanceTo(tap);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  let trailDot = null;
  function markTrailPoint(p) {
    if (trailDot) map.removeLayer(trailDot);
    trailDot = L.circleMarker([p[0], p[1]], { radius: 7, color: '#fff', weight: 3, fillColor: walkColor(), fillOpacity: 1, interactive: false }).addTo(map);
  }
  map.on('popupclose', () => { if (trailDot) { map.removeLayer(trailDot); trailDot = null; } });

  function fmtClock(ms, tz) {
    const sameDay = dayKey(ms, tz) === dayKey(Date.now(), tz);
    return fmtTime(ms, tz) + (sameDay ? ' today' : ', ' + inTz({ day: 'numeric', month: 'long' }, tz).format(ms));
  }

  // ---------- walk popups ----------
  function openWalkPopup(w, latlng) {
    const dur = w.endedAt && w.startedAt ? ` · ${fmtDur(w.endedAt - w.startedAt)}` : '';
    const near = nearestPoint(w.points, latlng), tz = w.points.length ? tzAt(w.points[0][0], w.points[0][1]) : undefined;
    const atPoint = near && near[2]
      ? `<div class="here-at">You were here at <b>${fmtClock(near[2], tz)}</b></div>`
      : (w.drawn ? '<div class="when">Drawn by hand, so there are no times on this walk.</div>' : '');
    const span = !w.drawn && w.endedAt ? `${fmtTime(w.startedAt, tz)}–${fmtTime(w.endedAt, tz)}` : '';
    const html = `<div class="pop">${atPoint}<h3>${esc(w.name)}</h3>
      <div class="when">${fmtDate(w.startedAt)}${span ? ' · ' + span : ''}</div>
      <p>${fmtDist(w.distance)}${dur}</p>
      <div class="row"><button class="btn btn-sm" data-act="rename">Rename</button>
      <button class="btn btn-sm btn-danger" data-act="delete">Delete walk</button></div></div>`;
    const pop = L.popup({ maxWidth: 270 }).setLatLng(near ? [near[0], near[1]] : latlng).setContent(html).openOn(map);
    if (near && near[2]) markTrailPoint(near);
    const el = pop.getElement();
    el.querySelector('[data-act="rename"]').onclick = () => { map.closePopup(); openWalkForm(w); };
    armDelete(el.querySelector('[data-act="delete"]'), async () => {
      await store.del('walks', w.id);
      state.walks = state.walks.filter((x) => x.id !== w.id);
      map.closePopup(); renderAll(); toast('Walk deleted');
    });
  }

  // Two-tap delete: first tap arms the button, second tap deletes.
  function armDelete(btn, onConfirm) {
    let armed = false, t;
    btn.addEventListener('click', () => {
      if (armed) { clearTimeout(t); onConfirm(); return; }
      armed = true; btn.classList.add('armed'); const old = btn.textContent; btn.textContent = 'Tap again to delete';
      t = setTimeout(() => { armed = false; btn.classList.remove('armed'); btn.textContent = old; }, 3000);
    });
  }

  // ---------- memory popups ----------
  function memoryPopupHtml(m) {
    return `<div class="pop"><h3>${esc(m.title)}</h3>
      <div class="when">${m.date ? fmtDate(m.date) : ''}</div>
      ${galleryHtml(photosOf(m))}
      ${m.note ? `<p>${esc(m.note)}</p>` : ''}
      <div class="row"><button class="btn btn-sm" data-act="edit">Edit</button>
      <button class="btn btn-sm" data-act="photo">+ Photo</button>
      ${photosOf(m).length ? '<button class="btn btn-sm" data-act="download">Download</button>' : ''}
      <button class="btn btn-sm btn-danger" data-act="delete">Delete</button></div></div>`;
  }
  function galleryHtml(list) {
    if (!list.length) return '';
    if (list.length === 1) return `<img src="${list[0]}" alt="">`;
    return `<div class="gallery">${list.map((src) => `<img src="${src}" alt="">`).join('')}</div><div class="when">${list.length} photos · swipe to see them all</div>`;
  }
  function wireMemoryPopup(popup, m) {
    const el = popup.getElement();
    el.querySelector('[data-act="edit"]').onclick = () => { map.closePopup(); openMemoryForm(m); };
    el.querySelector('[data-act="photo"]').onclick = () => { map.closePopup(); takePhotoFor(m); };
    const dl = el.querySelector('[data-act="download"]');
    if (dl) dl.onclick = () => downloadPhotos([m], `${m.date || todayISO()} ${safeName(m.title)}.zip`);
    armDelete(el.querySelector('[data-act="delete"]'), async () => {
      await store.del('memories', m.id);
      state.memories = state.memories.filter((x) => x.id !== m.id);
      map.closePopup(); renderAll(); toast('Memory deleted');
    });
  }

  // ---------- sheet ----------
  let sheetOnClose = null;
  function openSheet(title, bodyNode, onClose) {
    $('sheetTitle').textContent = title;
    const body = $('sheetBody'); body.innerHTML = ''; body.appendChild(bodyNode);
    $('sheet').hidden = false; $('scrim').hidden = false;
    sheetOnClose = onClose || null;
  }
  function closeSheet() {
    $('sheet').hidden = true; $('scrim').hidden = true;
    const cb = sheetOnClose; sheetOnClose = null; if (cb) cb();
  }
  $('sheetClose').onclick = closeSheet;
  $('scrim').onclick = closeSheet;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

  function h(html) { const d = document.createElement('div'); d.style.display = 'contents'; d.innerHTML = html; return d; }

  // ---------- hint bar (picking / drawing) ----------
  function showHint(text, actions) {
    $('hintText').textContent = text;
    const box = $('hintActions'); box.innerHTML = '';
    for (const a of actions || []) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-sm' + (a.primary ? ' btn-primary' : ''); b.textContent = a.label; b.onclick = a.onClick;
      box.appendChild(b);
    }
    $('hint').hidden = false;
  }
  function hideHint() { $('hint').hidden = true; }

  function setMode(mode) {
    state.mode = mode;
    document.body.classList.toggle('picking', mode !== 'idle' && mode !== 'day');
    if (mode === 'idle') hideHint();
  }

  // ---------- location ----------
  let lastFix = null; // newest GPS position seen, so the photo button doesn't have to wait for a new one
  let autoSwitched = false;
  function showMe(lat, lng, acc) {
    lastFix = { lat, lng, acc, at: Date.now() };
    // First fix of the session in the other city: switch the map there.
    if (!autoSwitched && !inCity(city, lat, lng)) {
      const other = Object.keys(CITIES).find((c) => inCity(c, lat, lng));
      if (other) { autoSwitched = true; setCity(other, true); toast(`You're in ${CITIES[other].name}, so the map switched there.`); }
    }
    if (!meMarker) {
      meMarker = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      meCircle = L.circle([lat, lng], { radius: acc || 0, color: '#2f7cf6', weight: 1, opacity: 0.4, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng([lat, lng]); meCircle.setLatLng([lat, lng]).setRadius(acc || 0);
    }
  }

  function geoError(err) {
    if (!secure()) return 'Location needs the app to be opened over https://. See the hosting notes.';
    if (err && err.code === 1) return 'Location is blocked. Allow location for this app in your phone settings.';
    if (err && err.code === 3) return 'Still looking for GPS. Step outside or wait a moment.';
    return 'Could not get your location right now.';
  }

  function locateOnce() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) { reject(new Error('no geolocation')); return; }
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
    });
  }

  $('btnLocate').onclick = async () => {
    try {
      const pos = await locateOnce();
      const { latitude, longitude, accuracy } = pos.coords;
      showMe(latitude, longitude, accuracy);
      // Jump when it's far (another city), glide when it's close.
      if (map.distance(map.getCenter(), [latitude, longitude]) > 50000) map.setView([latitude, longitude], 16);
      else map.flyTo([latitude, longitude], Math.max(map.getZoom(), 16));
    } catch (e) { toast(geoError(e), 4000); }
  };

  // ---------- recording a walk ----------
  function saveRecDraft() {
    try { localStorage.setItem(REC_KEY, JSON.stringify({ id: state.recording.id, startedAt: state.recording.startedAt, points: state.recording.points })); } catch (e) { /* storage full or blocked */ }
  }
  function clearRecDraft() { try { localStorage.removeItem(REC_KEY); } catch (e) { /* ignore */ } }

  async function requestWakeLock() {
    const keep = plugin('KeepAwake');
    if (keep) { try { await keep.keepAwake(); state.wakeLock = { release: () => keep.allowSleep() }; } catch (e) { state.wakeLock = null; } return; }
    try { if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { state.wakeLock = null; }
  }
  const autoOn = () => { try { return localStorage.getItem(AUTO_KEY) !== 'off'; } catch (e) { return true; } };
  const lastPointTime = (rec) => (rec.points.length ? rec.points[rec.points.length - 1][2] : rec.startedAt);

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !state.recording) return;
    // Back after a long break: close the old trail and start a fresh one.
    if (autoOn() && Date.now() - lastPointTime(state.recording) > AUTO_GAP_MS) {
      await stopRecording(true, true); startRecording(null, true); return;
    }
    if (!state.wakeLock) requestWakeLock();
  });

  function updateRecBanner() {
    if (!state.recording) return;
    const pts = state.recording.points;
    $('recMeta').textContent = `${fmtDist(trailLength(pts))} · ${fmtDur(Date.now() - state.recording.startedAt)}`;
    renderStats();
  }
  let recTick = null;

  function liveTrailPopup(latlng) {
    const rec = state.recording; if (!rec) return;
    const near = nearestPoint(rec.points, latlng); if (!near) return;
    L.popup({ maxWidth: 260 }).setLatLng([near[0], near[1]])
      .setContent(`<div class="pop"><div class="here-at">You were here at <b>${fmtClock(near[2], tzAt(near[0], near[1]))}</b></div><div class="when">Current trail · ${fmtDist(trailLength(rec.points))} so far</div></div>`)
      .openOn(map);
    markTrailPoint(near);
  }

  function startRecording(resume, auto) {
    if (!('geolocation' in navigator)) { toast('This browser cannot read GPS.'); return; }
    if (!secure()) { toast(geoError(), 4500); return; }
    state.recording = resume || { id: uid(), startedAt: Date.now(), points: [] };
    const startPts = smoothed(state.recording.points);
    state.recLine = L.layerGroup([
      L.polyline(startPts, { ...walkStyle(), opacity: 0.95, interactive: false }),
      trailHitLine(startPts, liveTrailPopup),
    ]).addTo(map);
    document.body.classList.add('recording');
    $('btnRecLabel').textContent = 'Finish walk';
    $('recBanner').hidden = false; $('recText').textContent = 'Recording';
    updateRecBanner(); recTick = setInterval(updateRecBanner, 1000);
    requestWakeLock();
    let first = true;
    state.watchId = navigator.geolocation.watchPosition((pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      showMe(lat, lng, accuracy);
      if (first) { first = false; map.setView([lat, lng], Math.max(map.getZoom(), 17)); }
      if (accuracy > MAX_ACCURACY_M) { $('recText').textContent = 'Waiting for better GPS'; return; }
      $('recText').textContent = 'Recording';
      const pts = state.recording.points, p = [lat, lng, pos.timestamp], last = pts[pts.length - 1];
      if (last) {
        const d = haversine(last, p);
        if (d < Math.max(MIN_STEP_M, Math.min(accuracy, 25))) return;
        // A sudden jump far faster than walking is usually a GPS glitch. If the jumps keep coming, you really moved (bus, taxi).
        if (last[2] && d / Math.max(1, (p[2] - last[2]) / 1000) > MAX_SPEED_MS && ++state.jumps < 3) return;
      }
      state.jumps = 0;
      pts.push(p); const line = smoothed(pts); state.recLine.eachLayer((l) => l.setLatLngs(line)); saveRecDraft(); updateRecBanner();
    }, (err) => { $('recText').textContent = 'GPS paused'; if (err.code === 1) { toast(geoError(err), 4500); stopRecording(true, true); } }, // keep what was already recorded
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    if (!resume && !auto) toast('Walk started. Keep the app open while you walk.', 3500);
  }

  // quiet: save without asking for a name (used for automatic trails).
  function stopRecording(save, quiet) {
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    clearInterval(recTick);
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
    document.body.classList.remove('recording');
    $('btnRecLabel').textContent = 'Start walk';
    $('recBanner').hidden = true;
    if (state.recLine) { map.removeLayer(state.recLine); state.recLine = null; }
    const rec = state.recording; state.recording = null;
    if (!save || !rec) { clearRecDraft(); return; }
    const dist = trailLength(rec.points);
    if (isTinyWalk(rec.points, dist)) {
      clearRecDraft(); if (!quiet) toast(`Walks under ${MIN_WALK_M} m aren't saved, so this one was left out.`, 3500); return Promise.resolve();
    }
    const last = rec.points[rec.points.length - 1][2];
    const w = {
      id: rec.id, name: 'Walk on ' + new Date(rec.startedAt).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }),
      startedAt: rec.startedAt, endedAt: quiet && last ? last : Date.now(), points: rec.points, distance: dist,
    };
    return store.put('walks', w).then(() => {
      clearRecDraft(); state.walks.push(w); renderAll(); if (!quiet) openWalkForm(w, true);
    });
  }

  // Too short, or just GPS drifting while you sat in one place.
  function isTinyWalk(points, dist) {
    if (points.length < 2 || dist < MIN_WALK_M) return true;
    return !points.some((p) => haversine(points[0], p) > MIN_SPREAD_M);
  }

  $('btnRec').onclick = () => {
    if (state.mode !== 'idle') cancelMode();
    if (state.recording) stopRecording(true); else startRecording();
  };

  function openWalkForm(w, justSaved) {
    const node = h(`
      ${justSaved ? `<p class="note">Saved ${fmtDist(w.distance)} in ${fmtDur(w.endedAt - w.startedAt)}. Give it a name if you like.</p>` : ''}
      <div class="field"><label for="walkName">Name</label><input type="text" id="walkName" maxlength="80"></div>
      <div class="form-actions"><button class="btn" type="button" id="walkCancel">${justSaved ? 'Keep this name' : 'Cancel'}</button>
      <button class="btn btn-primary" type="button" id="walkSave">Save</button></div>`);
    openSheet(justSaved ? 'Walk saved' : 'Rename walk', node);
    const input = $('walkName'); input.value = w.name;
    $('walkCancel').onclick = closeSheet;
    $('walkSave').onclick = async () => {
      w.name = input.value.trim() || w.name; await store.put('walks', w); closeSheet(); renderAll(); toast('Walk saved');
    };
  }

  // ---------- drawing a walk by hand ----------
  function startDrawWalk() {
    closeSheet(); map.closePopup();
    setMode('drawWalk');
    const d = state.draw = { points: [], line: L.polyline([], { ...walkStyle(), opacity: 0.95, dashArray: '2 10' }).addTo(map), vertices: L.layerGroup().addTo(map) };
    const refresh = () => {
      showHint(d.points.length < 2 ? 'Tap along the streets you walked' : `${fmtDist(pathLength(d.points))} so far`, [
        { label: 'Undo', onClick: () => { d.points.pop(); redraw(); } },
        { label: 'Cancel', onClick: cancelMode },
        { label: 'Save walk', primary: true, onClick: finishDrawWalk },
      ]);
    };
    const redraw = () => {
      d.line.setLatLngs(d.points); d.vertices.clearLayers();
      d.points.forEach((p) => L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="draw-vertex"></div>', iconSize: [12, 12] }), interactive: false }).addTo(d.vertices));
      refresh();
    };
    d.redraw = redraw;
    refresh();
  }
  async function finishDrawWalk() {
    const d = state.draw;
    if (!d || d.points.length < 2) { toast('Tap at least two points first.'); return; }
    const pts = d.points.map((p) => [p[0], p[1]]);
    const now = Date.now();
    const w = { id: uid(), name: 'Walk on ' + new Date(now).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }), startedAt: now, points: pts, distance: pathLength(pts), drawn: true };
    cancelMode();
    await store.put('walks', w); state.walks.push(w); renderAll();
    openWalkForm(w, false); $('sheetTitle').textContent = 'Name this walk';
  }

  function cancelMode() {
    state.pendingPhotos = null;
    if (state.mode === 'day') { stopReplay(); renderAll(); }
    if (state.draw) { map.removeLayer(state.draw.line); map.removeLayer(state.draw.vertices); state.draw = null; }
    setMode('idle');
  }

  function handleMapTap(latlng) {
    if (state.mode === 'drawWalk' && state.draw) { state.draw.points.push([latlng.lat, latlng.lng]); state.draw.redraw(); }
    else if (state.mode === 'pickMemory') { setMode('idle'); openMemoryForm(null, latlng); }
    else if (state.mode === 'pickPhoto' && state.pendingPhotos) { const ph = state.pendingPhotos; state.pendingPhotos = null; setMode('idle'); attachPhotos(ph, latlng.lat, latlng.lng); }
  }
  map.on('click', (e) => handleMapTap(e.latlng));

  // ---------- memories ----------
  function startAddMemory() {
    if (state.mode !== 'idle') cancelMode();
    const node = h(`
      <p class="note">Where did it happen?</p>
      <button class="btn btn-primary btn-block" type="button" id="memHere">Right here, where I am</button>
      <button class="btn btn-block" type="button" id="memPick">Pick a spot on the map</button>`);
    openSheet('New memory', node);
    $('memHere').onclick = async () => {
      $('memHere').textContent = 'Finding you…';
      try {
        const pos = await locateOnce();
        const { latitude, longitude, accuracy } = pos.coords; showMe(latitude, longitude, accuracy);
        openMemoryForm(null, L.latLng(latitude, longitude));
      } catch (e) { toast(geoError(e), 4000); $('memHere').textContent = 'Right here, where I am'; }
    };
    $('memPick').onclick = () => {
      closeSheet(); map.closePopup(); setMode('pickMemory');
      showHint('Tap the place on the map', [{ label: 'Cancel', onClick: cancelMode }]);
    };
  }
  $('btnMemory').onclick = startAddMemory;

  function resizeImage(file, max = 1280, quality = 0.8) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo this browser can read.')); };
      img.src = url;
    });
  }

  function openMemoryForm(existing, latlng, title) {
    const m = existing ? { ...existing } : { id: uid(), lat: latlng.lat, lng: latlng.lng, title: title || '', note: '', date: todayISO(tzAt(latlng.lat, latlng.lng)), createdAt: Date.now() };
    m.photos = photosOf(m).slice();
    const node = h(`
      <div class="field"><label for="memTitle">What happened here</label><input type="text" id="memTitle" maxlength="100" placeholder="First swim at the boulevard"></div>
      <div class="field"><label for="memDate">When</label><input type="date" id="memDate"></div>
      <div class="field"><label for="memNote">Story</label><textarea id="memNote" placeholder="Who you were with, what you remember"></textarea></div>
      <div class="field"><label for="memPhoto">Photos</label>
        <div class="thumbs" id="memThumbs"></div>
        <input type="file" id="memPhoto" accept="image/*" multiple></div>
      <div class="where">${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</div>
      <div class="form-actions"><button class="btn" type="button" id="memCancel">Cancel</button>
      <button class="btn btn-primary" type="button" id="memSave">${existing ? 'Save changes' : 'Save memory'}</button></div>`);
    openSheet(existing ? 'Edit memory' : 'New memory', node);
    $('memTitle').value = m.title; $('memDate').value = m.date || ''; $('memNote').value = m.note || '';
    const showPhotos = () => {
      const box = $('memThumbs'); box.innerHTML = '';
      m.photos.forEach((src, i) => {
        const d = document.createElement('div'); d.className = 'thumb-wrap';
        d.innerHTML = `<img src="${src}" alt=""><button type="button" aria-label="Remove this photo">×</button>`;
        d.querySelector('button').onclick = () => { m.photos.splice(i, 1); showPhotos(); };
        box.appendChild(d);
      });
    };
    showPhotos();
    $('memPhoto').onchange = async (e) => {
      for (const f of Array.from(e.target.files || [])) {
        try { m.photos.push(await resizeImage(f)); } catch (err) { toast(err.message); }
      }
      e.target.value = ''; showPhotos();
    };
    $('memCancel').onclick = closeSheet;
    $('memSave').onclick = async () => {
      m.title = $('memTitle').value.trim();
      if (!m.title) { $('memTitle').focus(); toast('Give the memory a short title.'); return; }
      m.date = $('memDate').value; m.note = $('memNote').value.trim();
      const clean = { ...m }; delete clean._marker;
      clean.photo = clean.photos[0] || null; // older versions of the app read this one
      await store.put('memories', clean);
      state.memories = state.memories.filter((x) => x.id !== clean.id).concat(clean);
      closeSheet(); renderAll(); toast(existing ? 'Memory updated' : 'Memory saved');
      const mk = state.memories.find((x) => x.id === clean.id)._marker;
      map.panTo([clean.lat, clean.lng]); if (mk) mk.openPopup();
    };
  }

  // ---------- trip journal: days, replay, stats ----------
  const fmtDayLong = (key) => new Date(key + 'T12:00:00').toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtDayShort = (key) => new Date(key + 'T12:00:00').toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  function fmtSpan(ms) { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? `${h} h ${m % 60} min` : `${m} min`; }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Everything that happened on each day: walks, memories (by their date) and places marked visited.
  function journalDays(sc) {
    const days = new Map();
    const day = (k) => { if (!days.has(k)) days.set(k, { key: k, walks: [], memories: [], visited: [], dist: 0, ms: 0, photos: 0 }); return days.get(k); };
    for (const w of sc.walks) {
      const d = day(dayKey(w.startedAt, w.points.length ? tzAt(w.points[0][0], w.points[0][1]) : undefined)); d.walks.push(w); d.dist += w.distance || 0;
      if (!w.drawn && w.endedAt) d.ms += w.endedAt - w.startedAt;
    }
    for (const m of sc.memories) { const d = day(m.date || dayKey(m.createdAt || Date.now(), tzAt(m.lat, m.lng))); d.memories.push(m); d.photos += photosOf(m).length; }
    for (const v of sc.visited) if (v.at) day(dayKey(v.at, tzAt(v.lat, v.lng))).visited.push(v);
    return [...days.values()].sort((a, b) => b.key.localeCompare(a.key));
  }
  function daySummary(d) {
    return [d.dist ? fmtDist(d.dist) : '', d.ms > 60000 ? fmtSpan(d.ms) : '', d.photos ? plural(d.photos, 'photo', 'photos') : '',
      d.memories.length && !d.photos ? plural(d.memories.length, 'memory', 'memories') : '',
      d.visited.length ? plural(d.visited.length, 'place', 'places') : ''].filter(Boolean).join(' · ') || 'Nothing saved';
  }

  // Show one day on the map: its walks and memories stand out, everything else fades.
  function showDay(key, sc) {
    closeSheet(); map.closePopup(); if (state.mode !== 'idle') cancelMode();
    const d = journalDays(sc).find((x) => x.key === key); if (!d) return;
    setMode('day');
    const pts = [];
    d.walks.forEach((w) => w.points.forEach((p) => pts.push([p[0], p[1]])));
    d.memories.forEach((m) => pts.push([m.lat, m.lng])); d.visited.forEach((v) => pts.push([v.lat, v.lng]));
    const c = pts.length && Object.keys(CITIES).find((k) => inCity(k, pts[0][0], pts[0][1]));
    if (c && c !== city) setCity(c, false);
    dimForDay(d, 0.95);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: 17 });
    showHint(`${fmtDayShort(key)} · ${daySummary(d)}`, [
      ...(d.walks.some((w) => w.points.length > 1) ? [{ label: 'Replay the day', primary: true, onClick: () => replayDay(d) }] : []),
      { label: 'Done', onClick: cancelMode },
    ]);
  }
  function dimForDay(d, dayOpacity) {
    const ids = new Set(d.walks.map((w) => w.id)), mids = new Set(d.memories.map((m) => m.id));
    state.walks.forEach((w) => w._line && w._line.setStyle({ opacity: ids.has(w.id) ? dayOpacity : 0.12 }));
    state.memories.forEach((m) => m._marker && m._marker.setOpacity(mids.has(m.id) ? 1 : 0.3));
  }

  // Replay: the day's walks draw themselves in order, with the time ticking and memories popping up as you reach them.
  let replay = null;
  function stopReplay() { if (!replay) return; cancelAnimationFrame(replay.raf); map.removeLayer(replay.layer); replay = null; }
  function replayDay(d) {
    stopReplay();
    const segs = d.walks.filter((w) => w.points.length > 1).sort((a, b) => a.startedAt - b.startedAt).map((w) => {
      const line = w.drawn ? w.points.map((p) => [p[0], p[1]]) : smoothed(w.points), cum = [0];
      for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1], line[i]));
      return { w, line, cum, len: cum[cum.length - 1] };
    }).filter((sg) => sg.len > 0);
    const total = segs.reduce((n, sg) => n + sg.len, 0); if (!total) return;
    dimForDay(d, 0.12);
    d.memories.forEach((m) => m._marker && m._marker.setOpacity(0.3));
    const layer = L.layerGroup().addTo(map);
    const traces = segs.map(() => L.polyline([], { ...walkStyle(), opacity: 1, weight: 7, interactive: false }).addTo(layer));
    const dot = L.marker(segs[0].line[0], { icon: L.divIcon({ className: '', html: '<div class="replay-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 900 }).addTo(layer);
    const dur = Math.min(25000, Math.max(8000, total * 5)); // about 5 seconds per km
    const popped = new Set(), t0 = performance.now();
    replay = { layer, raf: 0 };
    showHint(fmtDayShort(d.key), [{ label: 'Stop', onClick: () => finish() }]);
    const finish = () => {
      if (!replay) return;
      cancelAnimationFrame(replay.raf);
      segs.forEach((sg, i) => traces[i].setLatLngs(sg.line));
      d.memories.forEach((m) => m._marker && m._marker.setOpacity(1));
      showHint(`${fmtDayShort(d.key)} · ${daySummary(d)}`, [
        { label: 'Replay again', primary: true, onClick: () => replayDay(d) }, { label: 'Done', onClick: cancelMode }]);
    };
    const frame = (now) => {
      if (!replay) return;
      const f = Math.min(1, (now - t0) / dur);
      let left = f * total, cur = null;
      segs.forEach((sg, i) => {
        if (left <= 0) { traces[i].setLatLngs([]); return; }
        const upto = Math.min(left, sg.len); left -= sg.len;
        let j = 1; while (j < sg.cum.length - 1 && sg.cum[j] < upto) j++;
        const a = sg.line[j - 1], b = sg.line[j], k = Math.min(1, (upto - sg.cum[j - 1]) / ((sg.cum[j] - sg.cum[j - 1]) || 1));
        const here = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
        traces[i].setLatLngs(sg.line.slice(0, j).concat([here]));
        cur = { here, sg, upto };
      });
      if (cur) {
        dot.setLatLng(cur.here);
        const w = cur.sg.w;
        const clock = !w.drawn && w.endedAt ? ' · ' + fmtTime(w.startedAt + (w.endedAt - w.startedAt) * (cur.upto / cur.sg.len), tzAt(w.points[0][0], w.points[0][1])) : '';
        $('hintText').textContent = fmtDayShort(d.key) + clock;
        for (const m of d.memories) if (!popped.has(m.id) && haversine(cur.here, [m.lat, m.lng]) < 40) { popped.add(m.id); popMemory(m); }
      }
      if (f < 1) replay.raf = requestAnimationFrame(frame); else finish();
    };
    replay.raf = requestAnimationFrame(frame);
  }
  function popMemory(m) {
    const mk = m._marker; if (!mk) return;
    mk.setOpacity(1);
    const el = mk.getElement(); if (el) { el.classList.add('pop-in'); setTimeout(() => el.classList.remove('pop-in'), 700); }
    mk.bindTooltip(esc(m.title), { direction: 'top', offset: [0, -38] }).openTooltip();
    setTimeout(() => mk.unbindTooltip(), 2600);
  }

  // Trip stats: totals, favourite districts, when you like to walk, best days.
  function openStats(sc) {
    const days = journalDays(sc);
    const total = sc.walks.reduce((n, w) => n + (w.distance || 0), 0);
    const photos = sc.memories.reduce((n, m) => n + photosOf(m).length, 0);
    const longest = sc.walks.slice().sort((a, b) => (b.distance || 0) - (a.distance || 0))[0];
    const best = days.filter((d) => d.dist).sort((a, b) => b.dist - a.dist)[0];
    // Time of day, from the recorded points' times.
    const parts = [['Morning', 5, 12], ['Afternoon', 12, 17], ['Evening', 17, 22], ['Night', 22, 29]], byPart = [0, 0, 0, 0];
    for (const w of sc.walks) {
      if (w.drawn) continue;
      for (let i = 1; i < w.points.length; i++) {
        const t = w.points[i][2]; if (!t) continue;
        let hr = hourIn(t, tzAt(w.points[i][0], w.points[i][1])); if (hr < 5) hr += 24;
        const k = parts.findIndex(([, a, b]) => hr >= a && hr < b);
        if (k >= 0) byPart[k] += haversine(w.points[i - 1], w.points[i]);
      }
    }
    const bars = (rows) => {
      const max = Math.max(...rows.map((r) => r[1]), 1);
      return rows.map(([label, v, note]) => `<div class="bar-row"><span>${esc(label)}</span><b>${esc(note || fmtDist(v))}</b>
        <div class="bar"><i style="width:${Math.max(3, Math.round(v / max * 100))}%"></i></div></div>`).join('');
    };
    const partSum = byPart.reduce((a, b) => a + b, 0);
    const node = h(`
      <div class="summary">
        <div><b>${fmtDist(total)}</b><span>walked</span></div>
        <div><b>${days.length}</b><span>${days.length === 1 ? 'day' : 'days'}</span></div>
        <div><b>${photos}</b><span>${photos === 1 ? 'photo' : 'photos'}</span></div>
      </div>
      <div class="section-title">Favourite districts</div>
      <div id="statDistricts" class="note">Looking up the districts you walked through…</div>
      ${partSum ? `<div class="section-title">When you walk</div>${bars(parts.map(([n], i) => [n, byPart[i]]).filter((r) => r[1] > 0))}` : ''}
      <div class="section-title">Highlights</div>
      <ul class="facts">
        ${best ? `<li>Biggest day: <b>${esc(fmtDayLong(best.key))}</b>, ${fmtDist(best.dist)}</li>` : ''}
        ${longest && longest.distance ? `<li>Longest walk: <b>${esc(longest.name)}</b>, ${fmtDist(longest.distance)}</li>` : ''}
        <li>Places visited: <b>${sc.visited.length}</b></li>
        <li>Memories saved: <b>${sc.memories.length}</b></li>
      </ul>`);
    openSheet(sc.key === 'all' ? 'Trip stats' : `Trip stats · ${sc.name}`, node);
    favouriteDistricts(sc.walks).then((rows) => {
      const box = $('statDistricts'); if (!box) return;
      if (!rows.length) { box.textContent = sc.walks.length ? 'District names aren\'t available for where you walked yet.' : 'Go for a walk and your favourite districts show up here.'; return; }
      const sum = rows.reduce((n, r) => n + r.dist, 0);
      box.className = '';
      box.innerHTML = `<p class="fav">Your favourite: <b>${esc(rows[0].name)}</b>
        <span class="note">(${Math.round(rows[0].dist / sum * 100)}% of your walking)</span></p>` + bars(rows.slice(0, 5).map((r) => [r.name, r.dist]));
    }).catch(() => { const box = $('statDistricts'); if (box) box.textContent = 'Couldn\'t look up district names right now. Try again when you are online.'; });
  }
  // Each stretch of walking counts for the nearest named district or neighbourhood (within 3 km).
  async function favouriteDistricts(walks) {
    const totals = new Map();
    const cities = Object.keys(CITIES).filter((c) => walks.some((w) => walkCity(w) === c));
    for (const c of cities) {
      const list = await NinikoPlaces.districts(c);
      if (!list.length) continue;
      for (const w of walks) {
        if (walkCity(w) !== c) continue;
        const line = w.drawn ? w.points : smoothed(w.points);
        for (let i = 1; i < line.length; i++) {
          const mid = [(line[i - 1][0] + line[i][0]) / 2, (line[i - 1][1] + line[i][1]) / 2];
          let best = null, bestD = 3000;
          for (const dd of list) { const dist = haversine(mid, [dd.lat, dd.lng]); if (dist < bestD) { bestD = dist; best = dd; } }
          if (!best) continue;
          const k = best.name, row = totals.get(k) || { name: best.name, dist: 0 };
          row.dist += haversine(line[i - 1], line[i]); totals.set(k, row);
        }
      }
    }
    return [...totals.values()].sort((a, b) => b.dist - a.dist);
  }

  // ---------- downloading photos ----------
  function dataUrlToBytes(url) {
    const bin = atob(url.slice(url.indexOf(',') + 1)), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const safeName = (s) => String(s || 'memory').replace(/[\\/:*?"<>|\n\r]+/g, '-').trim().slice(0, 60) || 'memory';
  // File names like "2026-10-02 Coffeesta 2.jpg", so photos sort by day in the gallery or Downloads.
  function photoFiles(m) {
    const list = photosOf(m), base = `${m.date || todayISO()} ${safeName(m.title)}`;
    return list.map((src, i) => ({ name: list.length > 1 ? `${base} ${i + 1}.jpg` : `${base}.jpg`, bytes: dataUrlToBytes(src) }));
  }
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  // A plain .zip (photos are already compressed, so files are stored as they are).
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
    const seen = new Map();
    for (const f of files) {
      let name = f.name; const n = seen.get(name) || 0; seen.set(name, n + 1);
      if (n) name = name.replace(/\.jpg$/, ` (${n + 1}).jpg`);
      const nm = enc.encode(name), crc = crc32(f.bytes), size = f.bytes.length;
      const head = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, size, 4], [22, size, 4], [26, nm.length, 2], [28, 0, 2]]
        .forEach(([o, v, l]) => (l === 4 ? head.setUint32(o, v, true) : head.setUint16(o, v, true)));
      const cen = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, size, 4], [24, size, 4], [28, nm.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
        .forEach(([o, v, l]) => (l === 4 ? cen.setUint32(o, v, true) : cen.setUint16(o, v, true)));
      parts.push(head, nm, f.bytes); central.push(cen, nm);
      offset += 30 + nm.length + size;
    }
    const cenSize = central.reduce((s, x) => s + x.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, cenSize, 4], [16, offset, 4], [20, 0, 2]]
      .forEach(([o, v, l]) => (l === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }
  // Some phones refuse download names that aren't plain Latin, so Georgian is spelled out in Latin letters.
  const latinName = (s) => NinikoPlaces.toLatin(s).replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  // On iPhones a download from an app on the home screen often goes nowhere, so the share sheet is used instead
  // (Save Image puts photos straight into Photos, Save to Files keeps a backup).
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // In the phone app: save the files to the app's cache, then open the phone's share sheet with them.
  function nativeShare(files) {
    const fs = plugin('Filesystem'), share = plugin('Share');
    const base64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.slice(r.result.indexOf(',') + 1)); r.onerror = rej; r.readAsDataURL(f); });
    const seen = new Set(), unique = (n) => { let k = n, i = 1; while (seen.has(k)) k = n.replace(/(\.\w+)?$/, ` (${++i})$1`); seen.add(k); return k; };
    Promise.all(files.map((f) => base64(f).then((data) => fs.writeFile({ path: unique(f.name), data, directory: 'CACHE' }))))
      .then((out) => share.share({ files: out.map((o) => o.uri) }))
      .catch((e) => { if (!/cancel/i.test(String(e && (e.message || e)))) toast('Could not open the share menu.', 3500); });
  }
  function shareFiles(files) {
    if (plugin('Share') && plugin('Filesystem')) { nativeShare(files); return true; }
    if (!IS_IOS || !navigator.share || !navigator.canShare) return false;
    try { if (!navigator.canShare({ files })) return false; } catch (e) { return false; }
    navigator.share({ files }).catch(() => { /* closed the share sheet */ });
    return true;
  }
  function saveBlob(blob, name) {
    if (shareFiles([new File([blob], latinName(name) || 'file', { type: blob.type })])) return true;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = latinName(name) || 'photos';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return false;
  }
  function downloadPhotos(memories, zipName) {
    const files = memories.flatMap(photoFiles);
    if (!files.length) { toast('No photos to download yet.'); return; }
    if (shareFiles(files.map((f) => new File([f.bytes], latinName(f.name) || 'photo.jpg', { type: 'image/jpeg' })))) {
      if (NATIVE && !IS_IOS) toast('Choose where to save the photos', 3000);
      else toast(files.length === 1 ? 'Tap Save Image to keep it in Photos' : `Tap Save ${files.length} Images to keep them in Photos`, 4000);
      return;
    }
    if (files.length === 1) saveBlob(new Blob([files[0].bytes], { type: 'image/jpeg' }), files[0].name);
    else saveBlob(makeZip(files), zipName);
    toast(files.length === 1 ? 'Photo downloaded' : `${files.length} photos downloaded as one .zip file`, 3000);
  }

  // ---------- "My map" sheet ----------
  let listTab = 'days';
  // cityKey: which city's diary to show (a city key or 'all'); it opens on the city you're looking at.
  function openList(cityKey) {
    if (state.mode !== 'idle') cancelMode();
    const sc = scope(cityKey || city);
    const km = sc.walks.reduce((s, w) => s + (w.distance || 0), 0);
    const node = h(`
      <div class="tabs city-tabs" role="tablist" aria-label="City">
        ${Object.keys(CITIES).concat('all').map((k) => `<button role="tab" type="button" data-city="${k}" aria-selected="${k === sc.key}">${k === 'all' ? 'All' : esc(CITIES[k].name)}</button>`).join('')}
      </div>
      <div class="summary">
        <div><b>${fmtDist(km)}</b><span>walked</span></div>
        <div><b>${sc.walks.length}</b><span>${sc.walks.length === 1 ? 'walk' : 'walks'}</span></div>
        <div><b>${sc.memories.length}</b><span>${sc.memories.length === 1 ? 'memory' : 'memories'}</span></div>
      </div>
      <button class="btn btn-block" type="button" id="openStats">Trip stats: favourite district, best days</button>
      <div class="tabs" role="tablist">
        <button role="tab" type="button" id="tabDays" aria-selected="${listTab === 'days'}">Days</button>
        <button role="tab" type="button" id="tabMem" aria-selected="${listTab === 'memories'}">Memories</button>
        <button role="tab" type="button" id="tabWalk" aria-selected="${listTab === 'walks'}">Walks</button>
        <button role="tab" type="button" id="tabVisit" aria-selected="${listTab === 'visited'}">Visited</button>
      </div>
      <ul class="list" id="listItems"></ul>
      <label class="switch-row" for="autoRec"><span><b>Record my trail whenever the app is open</b>
        <span class="note">Starts by itself when you open the app. A break of more than 30 minutes starts a new walk.</span></span>
        <input type="checkbox" id="autoRec" role="switch"></label>
      <div class="section-title">More</div>
      <div class="more">
        <button class="btn" type="button" id="moreDraw">Draw a past walk</button>
        <button class="btn" type="button" id="moreFit">Show everything</button>
        <button class="btn" type="button" id="moreExport">Save a backup</button>
        <button class="btn" type="button" id="moreImport">Restore a backup</button>
      </div>
      <p class="note">Everything is kept on this phone only. Save a backup now and then so nothing is lost if the phone or browser is reset.</p>`);
    openSheet(sc.key === 'all' ? 'My map' : `My map · ${sc.name}`, node);
    node.querySelectorAll('.city-tabs [data-city]').forEach((b) => { b.onclick = () => openList(b.dataset.city); });
    const fill = () => {
      $('tabMem').setAttribute('aria-selected', listTab === 'memories'); $('tabWalk').setAttribute('aria-selected', listTab === 'walks');
      $('tabVisit').setAttribute('aria-selected', listTab === 'visited'); $('tabDays').setAttribute('aria-selected', listTab === 'days');
      const ul = $('listItems'); ul.innerHTML = '';
      if (listTab === 'days') {
        const days = journalDays(sc);
        if (!days.length) { ul.innerHTML = `<li class="empty" style="cursor:default">${sc.key === 'all' ? 'Your trip diary fills in here, one line per day you walked or saved a memory.' : `Nothing saved in ${esc(sc.name)} yet. Your days here show up as you walk and save memories.`}</li>`; return; }
        for (const d of days) {
          const li = document.createElement('li');
          const full = d.memories.map((m) => photosOf(m)[0]).find(Boolean), thumb = full && (thumbOf(full) || full);
          li.innerHTML = `${thumb ? `<img class="thumb" src="${thumb}" alt="">` : '<span class="walk-sw"></span>'}
            <div class="txt"><div class="t">${esc(fmtDayLong(d.key))}</div><div class="s">${esc(daySummary(d))}</div></div>`;
          li.onclick = () => showDay(d.key, sc);
          ul.appendChild(li);
        }
        return;
      }
      if (listTab === 'visited') {
        const vis = sc.visited;
        if (!vis.length) { ul.innerHTML = '<li class="empty" style="cursor:default">No visited places yet. Tap a place on the map and choose Mark visited. Taking a photo at a place marks it too.</li>'; return; }
        for (const v of vis) {
          const li = document.createElement('li');
          li.innerHTML = `<span class="visited-sw">✓</span><div class="txt"><div class="t">${esc(v.name)}</div><div class="s">${esc(places.catLabel(v.cat))} · ${fmtDate(v.at)}</div></div>`;
          li.onclick = () => {
            closeSheet();
            const c = Object.keys(CITIES).find((k) => inCity(k, v.lat, v.lng)); if (c && c !== city) setCity(c, false);
            map.flyTo([v.lat, v.lng], 17);
          };
          ul.appendChild(li);
        }
        return;
      }
      const items = listTab === 'memories'
        ? sc.memories.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        : sc.walks.slice().sort((a, b) => b.startedAt - a.startedAt);
      if (!items.length) {
        ul.innerHTML = `<li class="empty" style="cursor:default">${listTab === 'memories'
          ? 'No memories yet. Tap Memory to pin the first place that means something.'
          : 'No walks yet. Tap Start walk when you head out, or draw a past walk below.'}</li>`;
        return;
      }
      for (const it of items) {
        const li = document.createElement('li');
        if (listTab === 'memories') {
          li.innerHTML = `${photosOf(it)[0] ? `<img class="thumb" src="${thumbOf(photosOf(it)[0]) || photosOf(it)[0]}" alt="">` : '<span class="thumb"><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.4-7 10-7 10z"/></svg></span>'}
            <div class="txt"><div class="t">${esc(it.title)}</div><div class="s">${it.date ? fmtDate(it.date) : ''}${photosOf(it).length > 1 ? ` · ${photosOf(it).length} photos` : ''}</div></div>
            ${photosOf(it).length ? '<button class="icon-btn row-dl" type="button" aria-label="Download photos"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>' : ''}`;
          const dlb = li.querySelector('.row-dl');
          if (dlb) dlb.onclick = (e) => { e.stopPropagation(); downloadPhotos([it], `${it.date || todayISO()} ${safeName(it.title)}.zip`); };
          li.onclick = () => { closeSheet(); map.flyTo([it.lat, it.lng], 17); setTimeout(() => it._marker && it._marker.openPopup(), 700); };
        } else {
          li.innerHTML = `<span class="walk-sw"></span><div class="txt"><div class="t">${esc(it.name)}</div>
            <div class="s">${fmtDate(it.startedAt)} · ${fmtDist(it.distance)}</div></div>`;
          li.onclick = () => {
            closeSheet(); const b = L.latLngBounds(it.points.map((p) => [p[0], p[1]]));
            map.flyToBounds(b, { padding: [40, 40], maxZoom: 17 });
            setTimeout(() => openWalkPopup(it, b.getCenter()), 800);
          };
        }
        ul.appendChild(li);
      }
      const nPhotos = listTab === 'memories' ? sc.memories.reduce((n, m) => n + photosOf(m).length, 0) : 0;
      if (nPhotos) {
        const li = document.createElement('li'); li.className = 'list-action';
        li.innerHTML = `<button class="btn btn-block" type="button">Download all ${nPhotos} ${nPhotos === 1 ? 'photo' : 'photos'}</button>`;
        li.querySelector('button').onclick = () => downloadPhotos(sc.memories.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')), `Niniko's Map ${sc.key === 'all' ? '' : sc.name + ' '}photos ${todayISO()}.zip`);
        ul.prepend(li);
      }
      // Offer to clear out tiny walks saved by older versions of the app.
      const tiny = listTab === 'walks' ? sc.walks.filter((w) => !w.drawn && isTinyWalk(w.points, w.distance)) : [];
      if (tiny.length) {
        const li = document.createElement('li'); li.className = 'list-action';
        li.innerHTML = `<button class="btn btn-block" type="button">Remove ${tiny.length} short ${tiny.length === 1 ? 'walk' : 'walks'} (under ${MIN_WALK_M} m)</button>`;
        armDelete(li.querySelector('button'), async () => {
          for (const w of tiny) await store.del('walks', w.id);
          const ids = new Set(tiny.map((w) => w.id));
          state.walks = state.walks.filter((w) => !ids.has(w.id));
          renderAll(); openList(sc.key); toast(`Removed ${tiny.length} short ${tiny.length === 1 ? 'walk' : 'walks'}`);
        });
        ul.prepend(li);
      }
    };
    $('tabMem').onclick = () => { listTab = 'memories'; fill(); };
    $('tabWalk').onclick = () => { listTab = 'walks'; fill(); };
    $('tabDays').onclick = () => { listTab = 'days'; fill(); };
    $('openStats').onclick = () => openStats(sc);
    $('tabVisit').onclick = () => { listTab = 'visited'; fill(); };
    $('autoRec').checked = autoOn();
    $('autoRec').onchange = (e) => {
      try { localStorage.setItem(AUTO_KEY, e.target.checked ? 'on' : 'off'); } catch (err) { /* ignore */ }
      if (e.target.checked && !state.recording) { closeSheet(); startRecording(null, true); }
    };
    $('moreDraw').onclick = startDrawWalk;
    $('moreFit').onclick = () => { closeSheet(); fitAll(); };
    $('moreExport').onclick = exportBackup;
    $('moreImport').onclick = () => $('importFile').click();
    fill();
  }
  $('btnList').onclick = () => openList();

  function fitAll() {
    // Only what you saved in the current city, so the map doesn't zoom out across Georgia.
    const pts = [], add = (lat, lng) => { if (inCity(city, lat, lng)) pts.push([lat, lng]); };
    state.walks.forEach((w) => w.points.forEach((p) => add(p[0], p[1])));
    state.memories.forEach((m) => add(m.lat, m.lng));
    if (pts.length) map.flyToBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
    else map.flyTo(CITIES[city].center, 15);
  }

  // ---------- backup ----------
  function exportBackup() {
    const strip = (o) => { const c = { ...o }; delete c._marker; return c; };
    const data = { app: 'niniko-map', version: 1, exportedAt: new Date().toISOString(), walks: state.walks.map(strip), memories: state.memories.map(strip), visited: places.exportVisited() };
    if (!saveBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `batumi-map-backup-${todayISO()}.json`)) toast('Backup saved to your downloads');
  }
  $('importFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'niniko-map') throw new Error('bad file');
      let n = 0;
      for (const w of data.walks || []) { await store.put('walks', w); n++; }
      for (const m of data.memories || []) { await store.put('memories', m); n++; }
      if (data.visited) places.importVisited(data.visited);
      await load(); closeSheet(); fitAll(); toast(`Restored ${n} items`);
    } catch (err) { toast('That file is not a backup from this app.'); }
  };

  // ---------- startup ----------
  async function load() {
    state.walks = (await store.all('walks')) || [];
    // Distances are measured on the smoothed line, so GPS wobble doesn't add metres you never walked.
    state.walks.forEach((w) => { if (!w.drawn && w.points.length > 2) w.distance = trailLength(w.points); });
    state.memories = (await store.all('memories')) || [];
    renderAll();
  }

  function offerResume() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(REC_KEY) || 'null'); } catch (e) { draft = null; }
    if (!draft || !draft.points) return;
    // An old leftover that's too short to keep isn't worth asking about.
    const tiny = isTinyWalk(draft.points, trailLength(draft.points));
    if (tiny && Date.now() - lastPointTime(draft) > AUTO_GAP_MS) { clearRecDraft(); return; }
    const node = h(`
      <p class="note">You have a walk that was still recording (${fmtDist(trailLength(draft.points))}, started ${fmtTime(draft.startedAt)}).</p>
      <div class="form-actions"><button class="btn" type="button" id="resDiscard">Discard</button>
      ${tiny ? '' : '<button class="btn" type="button" id="resSave">Save it</button>'}
      <button class="btn btn-primary" type="button" id="resGo">Keep recording</button></div>`);
    openSheet('Unfinished walk', node);
    $('resDiscard').onclick = () => { clearRecDraft(); closeSheet(); };
    if (!tiny) $('resSave').onclick = () => { closeSheet(); state.recording = draft; stopRecording(true); };
    $('resGo').onclick = () => { closeSheet(); startRecording(draft); };
  }

  async function startTrail() {
    if (!autoOn()) { offerResume(); return; }
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(REC_KEY) || 'null'); } catch (e) { draft = null; }
    if (draft && draft.points) {
      if (Date.now() - lastPointTime(draft) < AUTO_GAP_MS) { startRecording(draft, true); return; }
      state.recording = draft; await stopRecording(true, true);
    }
    startRecording(null, true);
  }

  const places = NinikoPlaces.init(map, { city, onAddMemory: (latlng, name) => openMemoryForm(null, latlng, name), toast });

  // ---------- cities ----------
  function renderCity() {
    $('brandCity').textContent = CITIES[city].name;
    $('brand').setAttribute('aria-label', `${CITIES[city].name}. Change city`);
    $('map').setAttribute('aria-label', `Map of ${CITIES[city].name}`);
  }
  function setCity(c, fly) {
    if (!CITIES[c]) return;
    city = c;
    try { localStorage.setItem(CITY_KEY, c); } catch (e) { /* ignore */ }
    renderCity(); renderStats();
    places.setCity(c);
    if (fly) map.setView(CITIES[c].center, 15); // the cities are far apart, so jump instead of a long fly
  }
  $('brand').onclick = () => {
    if (state.mode !== 'idle') cancelMode();
    const node = h(`<div class="city-list">${Object.entries(CITIES).map(([k, c]) =>
      `<button type="button" class="city-btn${k === city ? ' on' : ''}" data-city="${k}"><b>${c.name}</b><span>${c.country}</span></button>`).join('')}</div>
      <p class="note">Your walks and memories stay on the map in every city.</p>`);
    openSheet('Choose a city', node);
    node.querySelectorAll('[data-city]').forEach((b) => { b.onclick = () => { closeSheet(); setCity(b.dataset.city, true); }; });
  };
  renderCity();

  // ---------- map style ----------
  $('btnStyle').onclick = () => {
    if (state.mode !== 'idle') cancelMode();
    const node = h(`<ul class="list">${Object.entries(BASEMAPS).map(([k, b]) => `<li data-k="${k}" aria-selected="${k === baseKey}">
      <span class="thumb style-sw style-${k}"></span><div class="txt"><div class="t">${b.name}${k === baseKey ? ' ✓' : ''}</div><div class="s">${b.note}</div></div></li>`).join('')}</ul>`);
    openSheet('Map style', node);
    node.querySelectorAll('li').forEach((li) => { li.onclick = () => { setBasemap(li.dataset.k); closeSheet(); }; });
  };

  // ---------- photo button ----------
  // Take a photo and it joins the memory you're standing at (within PHOTO_JOIN_M),
  // or starts a new memory there named after the nearest popular place.
  const PHOTO_JOIN_M = 40;
  let photoTarget = null, photoFix = null;
  function takePhotoFor(m) {
    if (state.mode !== 'idle') cancelMode();
    photoTarget = m || null;
    // Start finding GPS while the camera is open, so the spot is ready when the photo is.
    photoFix = m ? null : locateOnce().then((p) => p, (e) => ({ error: e }));
    $('cameraInput').click();
  }
  $('btnPhoto').onclick = () => takePhotoFor(null);
  $('cameraInput').onchange = async (e) => {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (!files.length) return;
    toast('Saving photo…', 6000);
    const photos = [];
    for (const f of files) { try { photos.push(await resizeImage(f)); } catch (err) { toast(err.message); } }
    if (!photos.length) return;
    if (photoTarget) { const m = photoTarget; photoTarget = null; await addPhotosTo(m, photos); return; }
    const recent = lastFix && Date.now() - lastFix.at < 20000 && lastFix.acc <= 50 ? lastFix : null;
    const fix = recent ? { coords: { latitude: recent.lat, longitude: recent.lng, accuracy: recent.acc } }
      : await (photoFix || locateOnce().then((p) => p, (err) => ({ error: err })));
    if (fix.error) {
      toast('Photo kept. I could not find where you are, so tap the spot on the map.', 5000);
      setMode('pickPhoto');
      showHint('Tap where you took the photo', [{ label: 'Cancel', onClick: cancelMode }]);
      state.pendingPhotos = photos;
      return;
    }
    const { latitude, longitude, accuracy } = fix.coords; showMe(latitude, longitude, accuracy);
    await attachPhotos(photos, latitude, longitude);
  };

  async function attachPhotos(photos, lat, lng) {
    let best = null, bestD = Infinity;
    for (const m of state.memories) { const d = haversine([lat, lng], [m.lat, m.lng]); if (d < bestD) { bestD = d; best = m; } }
    if (best && bestD <= PHOTO_JOIN_M) return addPhotosTo(best, photos);
    const place = places && places.near ? places.near(lat, lng, 60)[0] : null;
    if (place && places.markVisited(place)) setTimeout(() => toast(`Marked ${place.name} as visited`, 2500), 3600);
    const m = { id: uid(), lat, lng, title: place ? place.name : 'Photo at ' + fmtTime(Date.now(), tzAt(lat, lng)), note: '', date: todayISO(tzAt(lat, lng)), photos: [], createdAt: Date.now() };
    await addPhotosTo(m, photos, true);
  }

  async function addPhotosTo(m, photos, isNew) {
    if (!isNew) m = state.memories.find((x) => x.id === m.id) || m; // the newest copy, in case it was edited meanwhile
    const clean = { ...m, photos: photosOf(m).concat(photos) }; delete clean._marker;
    clean.photo = clean.photos[0];
    await store.put('memories', clean);
    state.memories = state.memories.filter((x) => x.id !== clean.id).concat(clean);
    renderAll();
    toast(isNew ? `Photo saved as a new memory: “${clean.title}”` : `Photo added to “${clean.title}”`, 3500);
    const mk = state.memories.find((x) => x.id === clean.id)._marker;
    map.setView([clean.lat, clean.lng], Math.max(map.getZoom(), 17));
    setTimeout(() => mk && mk.openPopup(), 300);
  }

  // Ask the browser to keep this app's data when the phone runs low on space or the app isn't opened for a while.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {}); } catch (e) { /* ignore */ }

  load().then(() => {
    if (state.walks.length || state.memories.length) fitAll();
    if (secure() && 'geolocation' in navigator) startTrail(); else offerResume();
  });

  if ('serviceWorker' in navigator && window.isSecureContext && !NATIVE) { // the phone app already has its files
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
