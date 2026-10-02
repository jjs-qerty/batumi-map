/* Niniko's Map: walks and memories around Batumi, saved on this device. */
(function () {
  'use strict';

  // Cities the map knows. center is [lat, lng]; box is [south, west, north, east].
  const CITIES = {
    batumi: { name: 'Batumi', local: 'ბათუმი', center: [41.6430, 41.6360], box: [41.565, 41.555, 41.700, 41.720] },
    tbilisi: { name: 'Tbilisi', local: 'თბილისი', center: [41.6925, 44.8030], box: [41.640, 44.700, 41.800, 44.920] },
  };
  const CITY_KEY = 'niniko.city';
  let city = (() => { try { return CITIES[localStorage.getItem(CITY_KEY)] ? localStorage.getItem(CITY_KEY) : 'batumi'; } catch (e) { return 'batumi'; } })();
  const inCity = (c, lat, lng) => { const b = CITIES[c].box; return lat >= b[0] && lat <= b[2] && lng >= b[1] && lng <= b[3]; };
  const MIN_STEP_M = 8;              // ignore GPS jitter smaller than this
  const MAX_SPEED_MS = 15;           // a jump faster than this (54 km/h) is a GPS glitch, unless it keeps happening
  const AUTO_KEY = 'niniko.autoRecord';
  const AUTO_GAP_MS = 30 * 60000;    // a trail paused longer than this becomes its own walk
  const MIN_WALK_M = 200;            // walks shorter than this aren't saved (they just clutter the list)
  const MIN_SPREAD_M = 60;           // nor walks that never got further than this from where they started
  const MAX_ACCURACY_M = 40;         // ignore fixes worse than this
  const REC_KEY = 'niniko.recording';

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

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
  const trailLength = (points) => pathLength(smoothTrail(points));
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km'; }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function fmtDate(isoOrMs) {
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs + 'T12:00:00');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  // Memories hold a list of photos; older ones saved a single "photo".
  const photosOf = (m) => (m.photos && m.photos.length ? m.photos : (m.photo ? [m.photo] : []));
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }

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
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
      return dbp;
    }
    function tx(name, mode, fn) {
      return open().then((db) => new Promise((resolve, reject) => {
        if (!db) { resolve(fn(null)); return; }
        const t = db.transaction(name, mode), os = t.objectStore(name);
        const r = fn(os);
        t.oncomplete = () => resolve(r && typeof r === 'object' && 'result' in r ? r.result : r); // delete returns a plain id string
        t.onerror = () => reject(t.error);
      }));
    }
    return {
      all(name) {
        return tx(name, 'readonly', (os) => os ? os.getAll() : Array.from(mem[name].values()));
      },
      put(name, obj) {
        return tx(name, 'readwrite', (os) => { if (os) os.put(obj); else mem[name].set(obj.id, obj); return obj; });
      },
      del(name, id) {
        return tx(name, 'readwrite', (os) => { if (os) os.delete(id); else mem[name].delete(id); return id; });
      },
    };
  })();

  // ---------- map ----------
  // Keep popups clear of the title, filter chips and bottom toolbar when they open.
  L.Popup.mergeOptions({ autoPanPaddingTopLeft: L.point(12, 170), autoPanPaddingBottomRight: L.point(12, 110) });
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(CITIES[city].center, 15);
  // Free map styles that need no key. "Bright" is the plain OpenStreetMap map in full colour.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const BASEMAPS = {
    bright: { name: 'Bright', note: 'Full-colour OpenStreetMap: green parks, blue sea, clear streets.',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, cls: 'tiles-bright', attribution: OSM_ATTR },
    colourful: { name: 'Colourful', note: 'OpenStreetMap France style: warmer colours and more shop and café icons.',
      url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 20, cls: 'tiles-bright',
      attribution: OSM_ATTR + ', tiles by <a href="https://www.openstreetmap.fr" target="_blank" rel="noopener">OSM France</a>' },
    soft: { name: 'Soft', note: 'The earlier calm look with faded colours.',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, cls: 'tiles-soft', attribution: OSM_ATTR },
  };
  const BASEMAP_KEY = 'niniko.basemap';
  let baseKey = 'bright', baseLayer = null;
  try { if (BASEMAPS[localStorage.getItem(BASEMAP_KEY)]) baseKey = localStorage.getItem(BASEMAP_KEY); } catch (e) { /* ignore */ }
  function setBasemap(key) {
    const b = BASEMAPS[key] || BASEMAPS.bright;
    if (baseLayer) map.removeLayer(baseLayer);
    baseKey = key;
    baseLayer = L.tileLayer(b.url, { maxZoom: b.maxZoom, subdomains: b.subdomains || 'abc', className: b.cls, attribution: b.attribution }).addTo(map);
    // If a style's tile server isn't answering, go back to the plain OpenStreetMap map by itself.
    if (key !== 'bright' && key !== 'soft') {
      let ok = 0, bad = 0;
      const layer = baseLayer;
      layer.on('tileload', () => { ok++; });
      layer.on('tileerror', () => {
        if (++bad >= 4 && ok === 0 && baseLayer === layer) { setBasemap('bright'); toast(`The ${b.name} map isn't loading right now, so I switched back to Bright.`, 4500); }
      });
    }
    try { localStorage.setItem(BASEMAP_KEY, baseKey); } catch (e) { /* ignore */ }
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

  // ---------- rendering ----------
  function renderStats() {
    let km = state.walks.reduce((s, w) => s + (w.distance || 0), 0);
    if (state.recording) km += trailLength(state.recording.points); // count the walk in progress too
    $('stats').innerHTML = `<span class="sw" style="background:${walkColor()}"></span><b>${fmtDist(km)}</b> walked · <b>${state.memories.length}</b> ${state.memories.length === 1 ? 'memory' : 'memories'}`;
  }

  function renderWalks() {
    walksLayer.clearLayers();
    for (const w of state.walks) {
      const pts = w.drawn ? w.points.map((p) => [p[0], p[1]]) : smoothTrail(w.points);
      w._line = L.polyline(pts, { ...walkStyle(), interactive: false }).addTo(walksLayer);
      trailHitLine(pts, (latlng) => openWalkPopup(w, latlng)).addTo(walksLayer);
    }
  }

  function memoryIcon(m) {
    const ph = photosOf(m)[0], style = ph ? ` style="background-image:url('${ph}')"` : '';
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

  function fmtClock(ms) {
    const d = new Date(ms), sameDay = d.toDateString() === new Date().toDateString();
    return fmtTime(ms) + (sameDay ? ' today' : ', ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' }));
  }

  // ---------- walk popups ----------
  function openWalkPopup(w, latlng) {
    const dur = w.endedAt && w.startedAt ? ` · ${fmtDur(w.endedAt - w.startedAt)}` : '';
    const near = nearestPoint(w.points, latlng);
    const atPoint = near && near[2]
      ? `<div class="here-at">You were here at <b>${fmtClock(near[2])}</b></div>`
      : (w.drawn ? '<div class="when">Drawn by hand, so there are no times on this walk.</div>' : '');
    const span = !w.drawn && w.endedAt ? `${fmtTime(w.startedAt)}–${fmtTime(w.endedAt)}` : '';
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
      if (other) { autoSwitched = true; setCity(other, false); toast(`You're in ${CITIES[other].name}, so the map switched there.`); }
    }
    if (!meMarker) {
      meMarker = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      meCircle = L.circle([lat, lng], { radius: acc || 0, color: '#2f7cf6', weight: 1, opacity: 0.4, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng([lat, lng]); meCircle.setLatLng([lat, lng]).setRadius(acc || 0);
    }
  }

  function geoError(err) {
    if (!window.isSecureContext) return 'Location needs the app to be opened over https://. See the hosting notes.';
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
      map.flyTo([latitude, longitude], Math.max(map.getZoom(), 16));
    } catch (e) { toast(geoError(e), 4000); }
  };

  // ---------- recording a walk ----------
  function saveRecDraft() {
    try { localStorage.setItem(REC_KEY, JSON.stringify({ id: state.recording.id, startedAt: state.recording.startedAt, points: state.recording.points })); } catch (e) { /* storage full or blocked */ }
  }
  function clearRecDraft() { try { localStorage.removeItem(REC_KEY); } catch (e) { /* ignore */ } }

  async function requestWakeLock() {
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
      .setContent(`<div class="pop"><div class="here-at">You were here at <b>${fmtClock(near[2])}</b></div><div class="when">Current trail · ${fmtDist(trailLength(rec.points))} so far</div></div>`)
      .openOn(map);
    markTrailPoint(near);
  }

  function startRecording(resume, auto) {
    if (!('geolocation' in navigator)) { toast('This browser cannot read GPS.'); return; }
    if (!window.isSecureContext) { toast(geoError(), 4500); return; }
    state.recording = resume || { id: uid(), startedAt: Date.now(), points: [] };
    const startPts = smoothTrail(state.recording.points);
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
      pts.push(p); const line = smoothTrail(pts); state.recLine.eachLayer((l) => l.setLatLngs(line)); saveRecDraft(); updateRecBanner();
    }, (err) => { $('recText').textContent = 'GPS paused'; if (err.code === 1) { toast(geoError(err), 4500); stopRecording(false); } },
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
      id: rec.id, name: 'Walk on ' + new Date(rec.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
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
    const w = { id: uid(), name: 'Walk on ' + new Date(now).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), startedAt: now, points: pts, distance: pathLength(pts), drawn: true };
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
    const m = existing ? { ...existing } : { id: uid(), lat: latlng.lat, lng: latlng.lng, title: title || '', note: '', date: todayISO(), createdAt: Date.now() };
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
  const dayKey = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const fmtDayLong = (key) => new Date(key + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtDayShort = (key) => new Date(key + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  function fmtSpan(ms) { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? `${h} h ${m % 60} min` : `${m} min`; }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Everything that happened on each day: walks, memories (by their date) and places marked visited.
  function journalDays() {
    const days = new Map();
    const day = (k) => { if (!days.has(k)) days.set(k, { key: k, walks: [], memories: [], visited: [], dist: 0, ms: 0, photos: 0 }); return days.get(k); };
    for (const w of state.walks) {
      const d = day(dayKey(w.startedAt)); d.walks.push(w); d.dist += w.distance || 0;
      if (!w.drawn && w.endedAt) d.ms += w.endedAt - w.startedAt;
    }
    for (const m of state.memories) { const d = day(m.date || dayKey(m.createdAt || Date.now())); d.memories.push(m); d.photos += photosOf(m).length; }
    for (const v of places.visitedList()) if (v.at) day(dayKey(v.at)).visited.push(v);
    return [...days.values()].sort((a, b) => b.key.localeCompare(a.key));
  }
  function daySummary(d) {
    return [d.dist ? fmtDist(d.dist) : '', d.ms > 60000 ? fmtSpan(d.ms) : '', d.photos ? plural(d.photos, 'photo', 'photos') : '',
      d.memories.length && !d.photos ? plural(d.memories.length, 'memory', 'memories') : '',
      d.visited.length ? plural(d.visited.length, 'place', 'places') : ''].filter(Boolean).join(' · ') || 'Nothing saved';
  }

  // Show one day on the map: its walks and memories stand out, everything else fades.
  function showDay(key) {
    closeSheet(); map.closePopup(); if (state.mode !== 'idle') cancelMode();
    const d = journalDays().find((x) => x.key === key); if (!d) return;
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
      const line = w.drawn ? w.points.map((p) => [p[0], p[1]]) : smoothTrail(w.points), cum = [0];
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
        const clock = !w.drawn && w.endedAt ? ' · ' + fmtTime(w.startedAt + (w.endedAt - w.startedAt) * (cur.upto / cur.sg.len)) : '';
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
  function openStats() {
    const days = journalDays();
    const total = state.walks.reduce((n, w) => n + (w.distance || 0), 0);
    const photos = state.memories.reduce((n, m) => n + photosOf(m).length, 0);
    const longest = state.walks.slice().sort((a, b) => (b.distance || 0) - (a.distance || 0))[0];
    const best = days.filter((d) => d.dist).sort((a, b) => b.dist - a.dist)[0];
    // Time of day, from the recorded points' times.
    const parts = [['Morning', 5, 12], ['Afternoon', 12, 17], ['Evening', 17, 22], ['Night', 22, 29]], byPart = [0, 0, 0, 0];
    for (const w of state.walks) {
      if (w.drawn) continue;
      for (let i = 1; i < w.points.length; i++) {
        const t = w.points[i][2]; if (!t) continue;
        let hr = new Date(t).getHours(); if (hr < 5) hr += 24;
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
        <li>Places visited: <b>${places.visitedList().length}</b></li>
        <li>Memories saved: <b>${state.memories.length}</b></li>
      </ul>`);
    openSheet('Trip stats', node);
    favouriteDistricts().then((rows) => {
      const box = $('statDistricts'); if (!box) return;
      if (!rows.length) { box.textContent = state.walks.length ? 'District names aren\'t available for where you walked yet.' : 'Go for a walk and your favourite districts show up here.'; return; }
      const sum = rows.reduce((n, r) => n + r.dist, 0);
      box.className = '';
      box.innerHTML = `<p class="fav">Your favourite: <b>${esc(rows[0].name)}</b>${rows[0].local && rows[0].local !== rows[0].name ? ` <span class="note">${esc(rows[0].local)}</span>` : ''}
        <span class="note">(${Math.round(rows[0].dist / sum * 100)}% of your walking)</span></p>` + bars(rows.slice(0, 5).map((r) => [r.name, r.dist]));
    }).catch(() => { const box = $('statDistricts'); if (box) box.textContent = 'Couldn\'t look up district names right now. Try again when you are online.'; });
  }
  // Each stretch of walking counts for the nearest named district or neighbourhood (within 3 km).
  async function favouriteDistricts() {
    const totals = new Map();
    const cities = Object.keys(CITIES).filter((c) => state.walks.some((w) => w.points.length && inCity(c, w.points[0][0], w.points[0][1])));
    for (const c of cities) {
      const list = await NinikoPlaces.districts(c);
      if (!list.length) continue;
      for (const w of state.walks) {
        if (!w.points.length || !inCity(c, w.points[0][0], w.points[0][1])) continue;
        const line = w.drawn ? w.points : smoothTrail(w.points);
        for (let i = 1; i < line.length; i++) {
          const mid = [(line[i - 1][0] + line[i][0]) / 2, (line[i - 1][1] + line[i][1]) / 2];
          let best = null, bestD = 3000;
          for (const dd of list) { const dist = haversine(mid, [dd.lat, dd.lng]); if (dist < bestD) { bestD = dist; best = dd; } }
          if (!best) continue;
          const k = best.name, row = totals.get(k) || { name: best.name, local: best.local, dist: 0 };
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
  const KA = 'ა a ბ b გ g დ d ე e ვ v ზ z თ t ი i კ k ლ l მ m ნ n ო o პ p ჟ zh რ r ს s ტ t უ u ფ p ქ k ღ gh ყ q შ sh ჩ ch ც ts ძ dz წ ts ჭ ch ხ kh ჯ j ჰ h'.split(' ');
  const KA_MAP = Object.fromEntries(KA.reduce((acc, x, i) => (i % 2 ? acc : acc.concat([[x, KA[i + 1]]])), []));
  const latinName = (s) => s.replace(/[\u10d0-\u10ff]/g, (c) => KA_MAP[c] || '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim();
  function saveBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = latinName(name) || 'photos';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  function downloadPhotos(memories, zipName) {
    const files = memories.flatMap(photoFiles);
    if (!files.length) { toast('No photos to download yet.'); return; }
    if (files.length === 1) saveBlob(new Blob([files[0].bytes], { type: 'image/jpeg' }), files[0].name);
    else saveBlob(makeZip(files), zipName);
    toast(files.length === 1 ? 'Photo downloaded' : `${files.length} photos downloaded as one .zip file`, 3000);
  }

  // ---------- "My map" sheet ----------
  let listTab = 'days';
  function openList() {
    if (state.mode !== 'idle') cancelMode();
    const km = state.walks.reduce((s, w) => s + (w.distance || 0), 0);
    const node = h(`
      <div class="summary">
        <div><b>${fmtDist(km)}</b><span>walked</span></div>
        <div><b>${state.walks.length}</b><span>${state.walks.length === 1 ? 'walk' : 'walks'}</span></div>
        <div><b>${state.memories.length}</b><span>${state.memories.length === 1 ? 'memory' : 'memories'}</span></div>
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
    openSheet('My map', node);
    const fill = () => {
      $('tabMem').setAttribute('aria-selected', listTab === 'memories'); $('tabWalk').setAttribute('aria-selected', listTab === 'walks');
      $('tabVisit').setAttribute('aria-selected', listTab === 'visited'); $('tabDays').setAttribute('aria-selected', listTab === 'days');
      const ul = $('listItems'); ul.innerHTML = '';
      if (listTab === 'days') {
        const days = journalDays();
        if (!days.length) { ul.innerHTML = '<li class="empty" style="cursor:default">Your trip diary fills in here, one line per day you walked or saved a memory.</li>'; return; }
        for (const d of days) {
          const li = document.createElement('li');
          const thumb = d.memories.map((m) => photosOf(m)[0]).find(Boolean);
          li.innerHTML = `${thumb ? `<img class="thumb" src="${thumb}" alt="">` : '<span class="walk-sw"></span>'}
            <div class="txt"><div class="t">${esc(fmtDayLong(d.key))}</div><div class="s">${esc(daySummary(d))}</div></div>`;
          li.onclick = () => showDay(d.key);
          ul.appendChild(li);
        }
        return;
      }
      if (listTab === 'visited') {
        const vis = places.visitedList();
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
        ? state.memories.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        : state.walks.slice().sort((a, b) => b.startedAt - a.startedAt);
      if (!items.length) {
        ul.innerHTML = `<li class="empty" style="cursor:default">${listTab === 'memories'
          ? 'No memories yet. Tap Memory to pin the first place that means something.'
          : 'No walks yet. Tap Start walk when you head out, or draw a past walk below.'}</li>`;
        return;
      }
      for (const it of items) {
        const li = document.createElement('li');
        if (listTab === 'memories') {
          li.innerHTML = `${photosOf(it)[0] ? `<img class="thumb" src="${photosOf(it)[0]}" alt="">` : '<span class="thumb"><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.4-7 10-7 10z"/></svg></span>'}
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
      const nPhotos = listTab === 'memories' ? state.memories.reduce((n, m) => n + photosOf(m).length, 0) : 0;
      if (nPhotos) {
        const li = document.createElement('li'); li.className = 'list-action';
        li.innerHTML = `<button class="btn btn-block" type="button">Download all ${nPhotos} ${nPhotos === 1 ? 'photo' : 'photos'}</button>`;
        li.querySelector('button').onclick = () => downloadPhotos(state.memories.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')), `Niniko's Map photos ${todayISO()}.zip`);
        ul.prepend(li);
      }
      // Offer to clear out tiny walks saved by older versions of the app.
      const tiny = listTab === 'walks' ? state.walks.filter((w) => !w.drawn && isTinyWalk(w.points, w.distance)) : [];
      if (tiny.length) {
        const li = document.createElement('li'); li.className = 'list-action';
        li.innerHTML = `<button class="btn btn-block" type="button">Remove ${tiny.length} short ${tiny.length === 1 ? 'walk' : 'walks'} (under ${MIN_WALK_M} m)</button>`;
        armDelete(li.querySelector('button'), async () => {
          for (const w of tiny) await store.del('walks', w.id);
          const ids = new Set(tiny.map((w) => w.id));
          state.walks = state.walks.filter((w) => !ids.has(w.id));
          renderAll(); fill(); toast(`Removed ${tiny.length} short ${tiny.length === 1 ? 'walk' : 'walks'}`);
        });
        ul.prepend(li);
      }
    };
    $('tabMem').onclick = () => { listTab = 'memories'; fill(); };
    $('tabWalk').onclick = () => { listTab = 'walks'; fill(); };
    $('tabDays').onclick = () => { listTab = 'days'; fill(); };
    $('openStats').onclick = openStats;
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
  $('btnList').onclick = openList;

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
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `batumi-map-backup-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup saved to your downloads');
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
    $('brandCity').textContent = CITIES[city].local;
    $('brand').setAttribute('aria-label', `${CITIES[city].name}. Change city`);
    $('map').setAttribute('aria-label', `Map of ${CITIES[city].name}`);
  }
  function setCity(c, fly) {
    if (!CITIES[c]) return;
    city = c;
    try { localStorage.setItem(CITY_KEY, c); } catch (e) { /* ignore */ }
    renderCity();
    places.setCity(c);
    if (fly) map.setView(CITIES[c].center, 15); // the cities are far apart, so jump instead of a long fly
  }
  $('brand').onclick = () => {
    if (state.mode !== 'idle') cancelMode();
    const node = h(`<div class="city-list">${Object.entries(CITIES).map(([k, c]) =>
      `<button type="button" class="city-btn${k === city ? ' on' : ''}" data-city="${k}"><b>${c.name}</b><span>${c.local}</span></button>`).join('')}</div>
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
    const m = { id: uid(), lat, lng, title: place ? place.name : 'Photo at ' + fmtTime(Date.now()), note: '', date: todayISO(), photos: [], createdAt: Date.now() };
    await addPhotosTo(m, photos, true);
  }

  async function addPhotosTo(m, photos, isNew) {
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

  load().then(() => {
    if (state.walks.length || state.memories.length) fitAll();
    if (window.isSecureContext && 'geolocation' in navigator) startTrail(); else offerResume();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
