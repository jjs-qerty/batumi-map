/* Niniko's Map: walks, memories, pins and places around Batumi, saved on this device. */
(function () {
  'use strict';

  const BATUMI = [41.6430, 41.6360]; // Old Boulevard / Europe Square area, [lat, lng]
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'; // free, no key, light and calm
  const FALLBACK_STYLE = {
    version: 8,
    sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
    layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.55, 'raster-brightness-min': 0.08, 'raster-contrast': -0.08 } }],
  };
  const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/';
  const MIN_STEP_M = 5;              // ignore GPS jitter smaller than this
  const MAX_ACCURACY_M = 40;         // ignore fixes worse than this
  const AUTO_KEY = 'niniko.autoRecord';
  const AUTO_GAP_MS = 30 * 60000;    // a trail paused longer than this becomes its own walk
  const AUTO_MIN_M = 50;             // automatic trails shorter than this are dropped
  const REC_KEY = 'niniko.recording';
  const PHOTO_JOIN_M = 30;           // a photo within this distance of a memory joins that memory
  const PIN_COLORS = ['#e8456b', '#f2a516', '#2b8a3e', '#1c7ed6', '#7048e8', '#495057'];

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const ll = (p) => [p[1], p[0]]; // [lat, lng] -> [lng, lat]

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
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km'; }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function fmtMinutes(sec) { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
  function fmtDate(isoOrMs) {
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs + 'T12:00:00');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  function fmtClock(ms) {
    const d = new Date(ms), sameDay = d.toDateString() === new Date().toDateString();
    return fmtTime(ms) + (sameDay ? ' today' : ', ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' }));
  }
  const photosOf = (m) => (m.photos && m.photos.length ? m.photos : (m.photo ? [m.photo] : []));

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- storage (IndexedDB, falls back to memory) ----------
  const STORES = ['walks', 'memories', 'pins'];
  const store = (function () {
    let dbp = null;
    const mem = Object.fromEntries(STORES.map((n) => [n, new Map()]));
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve) => {
        try {
          const req = indexedDB.open('niniko-map', 2);
          req.onupgradeneeded = () => {
            const db = req.result;
            for (const n of STORES) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: 'id' });
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
        t.oncomplete = () => resolve(r && 'result' in r ? r.result : r);
        t.onerror = () => reject(t.error);
      }));
    }
    return {
      all(name) { return tx(name, 'readonly', (os) => os ? os.getAll() : Array.from(mem[name].values())); },
      put(name, obj) {
        const clean = { ...obj }; delete clean._marker;
        return tx(name, 'readwrite', (os) => { if (os) os.put(clean); else mem[name].set(clean.id, clean); return clean; });
      },
      del(name, id) { return tx(name, 'readwrite', (os) => { if (os) os.delete(id); else mem[name].delete(id); return id; }); },
    };
  })();

  const state = {
    walks: [], memories: [], pins: [],
    recording: null,  // { id, startedAt, points: [[lat,lng,t]] }
    recUnsub: null,
    wakeLock: null,
    mode: 'idle',     // idle | pickMemory | pickPin | drawWalk
    draw: null,       // { points: [] }
    threeD: false,
  };
  const walkColor = () => getComputedStyle(document.documentElement).getPropertyValue('--walk').trim() || '#e8456b';

  // ---------- map ----------
  const map = new maplibregl.Map({
    container: 'map', style: STYLE_URL, center: ll(BATUMI), zoom: 14, maxPitch: 70,
    attributionControl: { compact: true }, dragRotate: true, pitchWithRotate: true,
  });
  map.touchZoomRotate.enableRotation();

  // If the vector map can't load on this phone, fall back to plain OpenStreetMap tiles.
  let styleReady = false, usingFallback = false;
  function useFallback() {
    if (usingFallback) return;
    usingFallback = true; styleReady = false;
    map.setStyle(FALLBACK_STYLE);
  }
  map.on('error', () => { if (!styleReady) useFallback(); });
  setTimeout(() => { if (!styleReady) useFallback(); }, 12000);

  // Overlay data is kept here so it survives a style switch.
  const geo = {};
  const EMPTY = { type: 'FeatureCollection', features: [] };
  function setGeo(id, data) {
    geo[id] = data;
    const src = map.getSource(id);
    if (src) src.setData(data);
  }
  const line = (pts, props) => ({ type: 'Feature', properties: props || {}, geometry: { type: 'LineString', coordinates: pts.map(ll) } });
  const point = (p, props) => ({ type: 'Feature', properties: props || {}, geometry: { type: 'Point', coordinates: ll(p) } });
  const fc = (features) => ({ type: 'FeatureCollection', features });

  function addOverlays() {
    const wc = walkColor();
    for (const id of ['walks', 'rec', 'route', 'draw', 'dot']) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: geo[id] || EMPTY });
    const round = { 'line-cap': 'round', 'line-join': 'round' };
    const add = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
    add3dBuildings();
    add({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#ffffff', 'line-width': 10, 'line-opacity': 0.9 } });
    add({ id: 'route-line', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#2f7cf6', 'line-width': 6 } });
    add({ id: 'walks-line', type: 'line', source: 'walks', layout: round, paint: { 'line-color': wc, 'line-width': 5, 'line-opacity': 0.65 } });
    add({ id: 'walks-hit', type: 'line', source: 'walks', layout: round, paint: { 'line-color': '#000', 'line-width': 26, 'line-opacity': 0.01 } });
    add({ id: 'rec-line', type: 'line', source: 'rec', layout: round, paint: { 'line-color': wc, 'line-width': 5.5, 'line-opacity': 0.95 } });
    add({ id: 'rec-hit', type: 'line', source: 'rec', layout: round, paint: { 'line-color': '#000', 'line-width': 26, 'line-opacity': 0.01 } });
    add({ id: 'draw-line', type: 'line', source: 'draw', filter: ['==', '$type', 'LineString'], layout: round, paint: { 'line-color': wc, 'line-width': 4, 'line-dasharray': [0.5, 2] } });
    add({ id: 'draw-pts', type: 'circle', source: 'draw', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': wc, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    add({ id: 'dot', type: 'circle', source: 'dot', paint: { 'circle-radius': 7, 'circle-color': wc, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
  }

  // 3D buildings from the vector map's building layer.
  function add3dBuildings() {
    if (map.getLayer('buildings-3d')) return;
    const sources = map.getStyle().sources || {};
    const src = sources.openmaptiles ? 'openmaptiles' : Object.keys(sources).find((k) => sources[k].type === 'vector');
    if (!src) return;
    const firstSymbol = (map.getStyle().layers || []).find((l) => l.type === 'symbol');
    try {
      map.addLayer({
        id: 'buildings-3d', type: 'fill-extrusion', source: src, 'source-layer': 'building', minzoom: 13,
        layout: { visibility: state.threeD ? 'visible' : 'none' },
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#f1ede6', 60, '#e4ddd3'],
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
          'fill-extrusion-opacity': 0.85,
        },
      }, firstSymbol && firstSymbol.id);
    } catch (e) { /* this map has no buildings layer */ }
  }

  map.on('style.load', () => { styleReady = true; addOverlays(); });

  // ---------- popups and markers ----------
  let popup = null, popupClosing = null;
  function closePopup() { if (popup) { const p = popup; popup = null; p.remove(); } }
  function openPopup(lngLat, html, wire, o) {
    closePopup();
    const p = popup = new maplibregl.Popup({ maxWidth: '300px', offset: (o && o.offset) || 14, anchor: 'bottom', focusAfterOpen: false })
      .setLngLat(lngLat).setHTML(html).addTo(map);
    p.on('close', () => { if (popup === p) popup = null; setGeo('dot', EMPTY); if (popupClosing) { const c = popupClosing; popupClosing = null; c(); } });
    if (wire) wire(p.getElement());
    // Keep the whole popup clear of the title and chips at the top and the toolbar at the bottom.
    const fit = () => {
      if (popup !== p) return;
      const pt = map.project(lngLat), r = p.getElement().getBoundingClientRect();
      const W = map.getContainer().clientWidth, maxY = map.getContainer().clientHeight - 100, minTop = 160;
      let dx = 0, dy = 0;
      if (r.left < 8) dx = r.left - 8; else if (r.right > W - 8) dx = r.right - (W - 8);
      if (pt.y - r.height < minTop) dy = pt.y - r.height - minTop; else if (pt.y > maxY) dy = pt.y - maxY;
      if (dx || dy) map.panBy([dx, dy], { duration: 250 });
    };
    requestAnimationFrame(fit);
    setTimeout(fit, 400); // again once photos have their real height
    return p;
  }

  function marker(lat, lng, el, onTap, anchor) {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.mode !== 'idle') { handleMapTap({ lat, lng }); return; }
      onTap();
    });
    return new maplibregl.Marker({ element: el, anchor: anchor || 'bottom' }).setLngLat([lng, lat]).addTo(map);
  }

  // ---------- rendering ----------
  const walksLayerData = () => fc(state.walks.filter((w) => w.points.length > 1).map((w) => line(w.points, { id: w.id })));
  let memoryMarkers = [], pinMarkers = [];

  function renderStats() {
    const km = state.walks.reduce((s, w) => s + (w.distance || 0), 0);
    $('stats').innerHTML = `<span class="sw" style="background:${walkColor()}"></span><b>${fmtDist(km)}</b> walked · <b>${state.memories.length}</b> ${state.memories.length === 1 ? 'memory' : 'memories'}`;
  }

  function memoryEl(m) {
    const el = document.createElement('div'), ph = photosOf(m)[0];
    el.className = 'pin' + (ph ? ' has-photo' : '');
    if (ph) el.style.backgroundImage = `url('${ph}')`;
    el.title = m.title;
    el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.4-7 10-7 10z"/></svg>';
    return el;
  }
  function pinEl(p) {
    const el = document.createElement('div');
    el.className = 'upin'; el.style.setProperty('--c', p.color || PIN_COLORS[0]); el.title = p.name;
    el.innerHTML = '<svg viewBox="0 0 24 32" aria-hidden="true"><path d="M12 31s10-11.2 10-19A10 10 0 0 0 2 12c0 7.8 10 19 10 19z"/><circle cx="12" cy="12" r="4"/></svg>';
    return el;
  }

  function renderMemories() {
    memoryMarkers.forEach((mk) => mk.remove());
    memoryMarkers = state.memories.map((m) => (m._marker = marker(m.lat, m.lng, memoryEl(m), () => openMemoryPopup(m))));
  }
  function renderPins() {
    pinMarkers.forEach((mk) => mk.remove());
    pinMarkers = state.pins.map((p) => (p._marker = marker(p.lat, p.lng, pinEl(p), () => openPinPopup(p))));
  }
  function renderAll() { setGeo('walks', walksLayerData()); renderMemories(); renderPins(); renderStats(); }

  // The recorded point closest to where the trail was tapped.
  function nearestPoint(points, lngLat) {
    const tap = map.project(lngLat);
    let best = null, bestD = Infinity;
    for (const p of points) {
      const q = map.project(ll(p)), d = Math.hypot(q.x - tap.x, q.y - tap.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
  const markTrailPoint = (p) => setGeo('dot', fc([point(p)]));

  // ---------- walk popups ----------
  function openWalkPopup(w, lngLat) {
    const dur = w.endedAt && w.startedAt ? ` · ${fmtDur(w.endedAt - w.startedAt)}` : '';
    const near = nearestPoint(w.points, lngLat);
    const atPoint = near && near[2]
      ? `<div class="here-at">You were here at <b>${fmtClock(near[2])}</b></div>`
      : (w.drawn ? '<div class="when">Drawn by hand, so there are no times on this walk.</div>' : '');
    const span = !w.drawn && w.endedAt ? `${fmtTime(w.startedAt)}–${fmtTime(w.endedAt)}` : '';
    const html = `<div class="pop">${atPoint}<h3>${esc(w.name)}</h3>
      <div class="when">${fmtDate(w.startedAt)}${span ? ' · ' + span : ''}</div>
      <p>${fmtDist(w.distance)}${dur}</p>
      <div class="row"><button class="btn btn-sm" data-act="rename">Rename</button>
      <button class="btn btn-sm btn-danger" data-act="delete">Delete walk</button></div></div>`;
    openPopup(near ? ll(near) : lngLat, html, (el) => {
      el.querySelector('[data-act="rename"]').onclick = () => { closePopup(); openWalkForm(w); };
      armDelete(el.querySelector('[data-act="delete"]'), async () => {
        await store.del('walks', w.id);
        state.walks = state.walks.filter((x) => x.id !== w.id);
        closePopup(); renderAll(); toast('Walk deleted');
      });
    });
    if (near && near[2]) markTrailPoint(near);
  }

  function liveTrailPopup(lngLat) {
    const rec = state.recording; if (!rec) return;
    const near = nearestPoint(rec.points, lngLat); if (!near) return;
    openPopup(ll(near), `<div class="pop"><div class="here-at">You were here at <b>${fmtClock(near[2])}</b></div><div class="when">Current trail · ${fmtDist(pathLength(rec.points))} so far</div></div>`);
    markTrailPoint(near);
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
  function openMemoryPopup(m) {
    const photos = photosOf(m);
    const gallery = photos.length ? `<div class="gallery${photos.length > 1 ? ' multi' : ''}">${photos.map((src) => `<img src="${src}" alt="">`).join('')}</div>` : '';
    const html = `<div class="pop"><h3>${esc(m.title)}</h3>
      <div class="when">${m.date ? fmtDate(m.date) : ''}${photos.length > 1 ? ` · ${photos.length} photos` : ''}</div>
      ${gallery}${m.note ? `<p>${esc(m.note)}</p>` : ''}
      <div class="row"><button class="btn btn-sm" data-act="edit">Edit</button>
      <button class="btn btn-sm" data-act="go">Walk there</button>
      <button class="btn btn-sm btn-danger" data-act="delete">Delete</button></div></div>`;
    openPopup([m.lng, m.lat], html, (el) => {
      el.querySelector('[data-act="edit"]').onclick = () => { closePopup(); openMemoryForm(m); };
      el.querySelector('[data-act="go"]').onclick = () => navigateTo({ lat: m.lat, lng: m.lng, name: m.title });
      armDelete(el.querySelector('[data-act="delete"]'), async () => {
        await store.del('memories', m.id);
        state.memories = state.memories.filter((x) => x.id !== m.id);
        closePopup(); renderAll(); toast('Memory deleted');
      });
    }, { offset: 40 });
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('sheet').hidden) closeSheet(); else closePopup();
  });

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
    document.body.classList.toggle('picking', mode !== 'idle');
    if (mode === 'idle') hideHint();
  }

  // ---------- location ----------
  let meMarker = null;
  function showMe(lat, lng) {
    if (!meMarker) {
      const el = document.createElement('div'); el.className = 'me-dot';
      meMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
    } else meMarker.setLngLat([lng, lat]);
  }

  function geoError(err) {
    if (!window.isSecureContext) return 'Location needs the app to be opened over https://.';
    if (err && err.code === 1) return 'Location is blocked. Allow location for this app in your phone settings.';
    if (err && err.code === 3) return 'Still looking for GPS. Step outside or wait a moment.';
    return 'Could not get your location right now.';
  }

  // One shared GPS watch for recording, directions and the blue dot.
  const gps = (function () {
    const subs = new Set();
    let watchId = null, last = null;
    function start() {
      if (watchId != null || !('geolocation' in navigator)) return;
      watchId = navigator.geolocation.watchPosition((pos) => {
        last = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, t: pos.timestamp || Date.now() };
        showMe(last.lat, last.lng);
        subs.forEach((s) => s.fn(last));
      }, (err) => { subs.forEach((s) => s.onError && s.onError(err)); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    }
    return {
      subscribe(fn, onError) {
        const s = { fn, onError }; subs.add(s); start();
        if (last && Date.now() - last.t < 5000) fn(last);
        return () => { subs.delete(s); if (!subs.size && watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } };
      },
      get last() { return last; },
    };
  })();

  function currentFix() {
    if (gps.last && Date.now() - gps.last.t < 20000) return Promise.resolve(gps.last);
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) { reject(new Error('no geolocation')); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        const f = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
        showMe(f.lat, f.lng); resolve(f);
      }, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
    });
  }

  $('btnLocate').onclick = async () => {
    try {
      const f = await currentFix();
      map.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 15.5) });
    } catch (e) { toast(geoError(e), 4000); }
  };

  // ---------- 3D ----------
  function set3d(on) {
    state.threeD = on;
    $('btn3d').textContent = on ? '2D' : '3D';
    $('btn3d').setAttribute('aria-pressed', String(on));
    if (map.getLayer('buildings-3d')) map.setLayoutProperty('buildings-3d', 'visibility', on ? 'visible' : 'none');
    map.easeTo({ pitch: on ? 60 : 0, bearing: on ? -17 : 0, zoom: on ? Math.max(map.getZoom(), 15.5) : map.getZoom(), duration: 900 });
    if (on && usingFallback) toast('3D buildings need the main map, which could not load right now.');
  }
  $('btn3d').onclick = () => set3d(!state.threeD);

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
    $('recMeta').textContent = `${fmtDist(pathLength(state.recording.points))} · ${fmtDur(Date.now() - state.recording.startedAt)}`;
  }
  let recTick = null;

  function startRecording(resume, auto) {
    if (!('geolocation' in navigator)) { toast('This browser cannot read GPS.'); return; }
    if (!window.isSecureContext) { toast(geoError(), 4500); return; }
    state.recording = resume || { id: uid(), startedAt: Date.now(), points: [] };
    setGeo('rec', fc(state.recording.points.length > 1 ? [line(state.recording.points)] : []));
    document.body.classList.add('recording');
    $('btnRecLabel').textContent = 'Finish';
    $('recBanner').hidden = false; $('recText').textContent = 'Recording';
    updateRecBanner(); recTick = setInterval(updateRecBanner, 1000);
    requestWakeLock();
    let first = true;
    state.recUnsub = gps.subscribe((f) => {
      if (!state.recording) return;
      if (first) { first = false; if (!nav.active) map.easeTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 15.5) }); }
      if (f.acc > MAX_ACCURACY_M) { $('recText').textContent = 'Waiting for better GPS'; return; }
      $('recText').textContent = 'Recording';
      const pts = state.recording.points, p = [f.lat, f.lng, f.t];
      if (pts.length && haversine(pts[pts.length - 1], p) < Math.max(MIN_STEP_M, Math.min(f.acc, 25))) return;
      pts.push(p);
      if (pts.length > 1) setGeo('rec', fc([line(pts)]));
      saveRecDraft(); updateRecBanner();
    }, (err) => { $('recText').textContent = 'GPS paused'; if (err.code === 1) { toast(geoError(err), 4500); stopRecording(false); } });
    if (!resume && !auto) toast('Walk started. Keep the app open while you walk.', 3500);
  }

  // quiet: save without asking for a name (used for automatic trails).
  function stopRecording(save, quiet) {
    if (state.recUnsub) { state.recUnsub(); state.recUnsub = null; }
    clearInterval(recTick);
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
    document.body.classList.remove('recording');
    $('btnRecLabel').textContent = 'Start walk';
    $('recBanner').hidden = true;
    setGeo('rec', EMPTY);
    const rec = state.recording; state.recording = null;
    if (!save || !rec) { clearRecDraft(); return Promise.resolve(); }
    const dist = pathLength(rec.points);
    if (rec.points.length < 2 || (quiet && dist < AUTO_MIN_M)) {
      clearRecDraft(); if (!quiet) toast('Walk was too short to save.'); return Promise.resolve();
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
  function redrawDraw() {
    const pts = state.draw ? state.draw.points : [];
    setGeo('draw', fc([...(pts.length > 1 ? [line(pts)] : []), ...pts.map((p) => point(p))]));
  }
  function startDrawWalk() {
    closeSheet(); closePopup();
    setMode('drawWalk');
    state.draw = { points: [] };
    const refresh = () => {
      const d = state.draw;
      showHint(d.points.length < 2 ? 'Tap along the streets you walked' : `${fmtDist(pathLength(d.points))} so far`, [
        { label: 'Undo', onClick: () => { d.points.pop(); redrawDraw(); refresh(); } },
        { label: 'Cancel', onClick: cancelMode },
        { label: 'Save walk', primary: true, onClick: finishDrawWalk },
      ]);
    };
    state.draw.refresh = refresh;
    redrawDraw(); refresh();
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
    state.draw = null; redrawDraw();
    setMode('idle');
  }

  function handleMapTap(pos) {
    if (state.mode === 'drawWalk' && state.draw) { state.draw.points.push([pos.lat, pos.lng]); redrawDraw(); state.draw.refresh(); }
    else if (state.mode === 'pickMemory') { setMode('idle'); openMemoryForm(null, pos); }
    else if (state.mode === 'pickPin') { setMode('idle'); openPinForm(null, pos); }
  }

  let suppressClick = false;
  map.on('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    if (state.mode !== 'idle') { handleMapTap(e.lngLat); return; }
    const layers = ['rec-hit', 'walks-hit'].filter((id) => map.getLayer(id));
    const box = [[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]];
    const hits = layers.length ? map.queryRenderedFeatures(box, { layers }) : [];
    if (!hits.length) { closePopup(); return; }
    if (hits[0].layer.id === 'rec-hit') { liveTrailPopup(e.lngLat); return; }
    const w = state.walks.find((x) => x.id === hits[0].properties.id);
    if (w) openWalkPopup(w, e.lngLat);
  });

  // Long-press (or right-click) anywhere: pin, memory or directions for that spot.
  (function longPress() {
    let timer = null, start = null, lastFired = 0;
    const fire = (lngLat) => {
      if (Date.now() - lastFired < 900 || state.mode !== 'idle') return;
      lastFired = Date.now(); suppressClick = true; setTimeout(() => { suppressClick = false; }, 700);
      spotMenu({ lat: lngLat.lat, lng: lngLat.lng });
    };
    const c = map.getCanvasContainer();
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { clearTimeout(timer); return; }
      const t = e.touches[0]; start = [t.clientX, t.clientY];
      timer = setTimeout(() => {
        const r = map.getContainer().getBoundingClientRect();
        fire(map.unproject([start[0] - r.left, start[1] - r.top]));
      }, 600);
    }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (start && Math.hypot(t.clientX - start[0], t.clientY - start[1]) > 10) clearTimeout(timer);
    }, { passive: true });
    c.addEventListener('touchend', () => clearTimeout(timer));
    c.addEventListener('touchcancel', () => clearTimeout(timer));
    map.on('contextmenu', (e) => fire(e.lngLat));
  })();

  function spotMenu(pos) {
    closePopup();
    const node = h(`
      <p class="note">${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}</p>
      <button class="btn btn-primary btn-block" type="button" id="spotPin">Drop a pin here</button>
      <button class="btn btn-block" type="button" id="spotMemory">Add a memory here</button>
      <button class="btn btn-block" type="button" id="spotGo">Walk here</button>`);
    openSheet('This spot', node);
    $('spotPin').onclick = () => openPinForm(null, pos);
    $('spotMemory').onclick = () => openMemoryForm(null, pos);
    $('spotGo').onclick = () => { closeSheet(); navigateTo({ lat: pos.lat, lng: pos.lng, name: 'the dropped spot' }); };
  }

  // ---------- memories ----------
  function chooseSpot(title, onHere, pickMode) {
    if (state.mode !== 'idle') cancelMode();
    const node = h(`
      <p class="note">Where is it?</p>
      <button class="btn btn-primary btn-block" type="button" id="spotHere">Right here, where I am</button>
      <button class="btn btn-block" type="button" id="spotPick">Pick a spot on the map</button>
      <p class="note">Tip: press and hold anywhere on the map to drop a pin or memory there.</p>`);
    openSheet(title, node);
    $('spotHere').onclick = async () => {
      $('spotHere').textContent = 'Finding you…';
      try { const f = await currentFix(); onHere({ lat: f.lat, lng: f.lng }); }
      catch (e) { toast(geoError(e), 4000); $('spotHere').textContent = 'Right here, where I am'; }
    };
    $('spotPick').onclick = () => {
      closeSheet(); closePopup(); setMode(pickMode);
      showHint('Tap the place on the map', [{ label: 'Cancel', onClick: cancelMode }]);
    };
  }
  $('btnMemory').onclick = () => chooseSpot('New memory', (pos) => openMemoryForm(null, pos), 'pickMemory');

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

  async function saveMemory(m) {
    const clean = { ...m }; delete clean._marker; delete clean.photo;
    await store.put('memories', clean);
    state.memories = state.memories.filter((x) => x.id !== clean.id).concat(clean);
    renderAll();
    return state.memories.find((x) => x.id === clean.id);
  }

  function openMemoryForm(existing, pos, title) {
    const m = existing ? { ...existing, photos: photosOf(existing).slice() }
      : { id: uid(), lat: pos.lat, lng: pos.lng, title: title || '', note: '', date: todayISO(), photos: [], createdAt: Date.now() };
    const node = h(`
      <div class="field"><label for="memTitle">What happened here</label><input type="text" id="memTitle" maxlength="100" placeholder="First swim at the boulevard"></div>
      <div class="field"><label for="memDate">When</label><input type="date" id="memDate"></div>
      <div class="field"><label for="memNote">Story</label><textarea id="memNote" placeholder="Who you were with, what you remember"></textarea></div>
      <div class="field"><label for="memPhoto">Photos</label>
        <div class="photo-pick" id="memPhotos"></div>
        <input type="file" id="memPhoto" accept="image/*" multiple></div>
      <div class="where">${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</div>
      <div class="form-actions"><button class="btn" type="button" id="memCancel">Cancel</button>
      <button class="btn btn-primary" type="button" id="memSave">${existing ? 'Save changes' : 'Save memory'}</button></div>`);
    openSheet(existing ? 'Edit memory' : 'New memory', node);
    $('memTitle').value = m.title; $('memDate').value = m.date || ''; $('memNote').value = m.note || '';
    const showPhotos = () => {
      const box = $('memPhotos'); box.innerHTML = '';
      m.photos.forEach((src, i) => {
        const wrap = document.createElement('div'); wrap.className = 'thumb-wrap';
        wrap.innerHTML = `<img src="${src}" alt=""><button type="button" class="thumb-x" aria-label="Remove photo">×</button>`;
        wrap.querySelector('button').onclick = () => { m.photos.splice(i, 1); showPhotos(); };
        box.appendChild(wrap);
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
      const saved = await saveMemory(m);
      closeSheet(); toast(existing ? 'Memory updated' : 'Memory saved');
      map.easeTo({ center: [saved.lng, saved.lat] });
      setTimeout(() => openMemoryPopup(saved), 350);
    };
  }

  // ---------- photo button ----------
  $('btnPhoto').onclick = () => {
    if (state.mode !== 'idle') cancelMode();
    $('cameraInput').click();
  };
  $('cameraInput').onchange = async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    toast('Saving photo…', 6000);
    let photo, f;
    try { photo = await resizeImage(file); } catch (err) { toast(err.message); return; }
    try { f = await currentFix(); } catch (err) { toast('Photo kept, but I could not find where you are. ' + geoError(err), 5000); return pickSpotForPhoto(photo); }
    await attachPhoto(photo, { lat: f.lat, lng: f.lng });
  };

  // A photo joins the memory you're standing at, or starts a new one named after the nearest place.
  async function attachPhoto(photo, pos) {
    let best = null, bestD = Infinity;
    for (const m of state.memories) { const d = haversine([pos.lat, pos.lng], [m.lat, m.lng]); if (d < bestD) { bestD = d; best = m; } }
    let m;
    if (best && bestD <= PHOTO_JOIN_M) {
      m = { ...best, photos: photosOf(best).concat(photo) };
      m = await saveMemory(m);
      toast(`Photo added to “${m.title}”`);
    } else {
      const placeNear = places ? places.near(pos.lat, pos.lng, 40)[0] : null;
      m = await saveMemory({ id: uid(), lat: pos.lat, lng: pos.lng, title: placeNear ? placeNear.name : 'Photo at ' + fmtTime(Date.now()),
        note: '', date: todayISO(), photos: [photo], createdAt: Date.now() });
      toast('Photo saved as a new memory here');
    }
    map.easeTo({ center: [m.lng, m.lat], zoom: Math.max(map.getZoom(), 15.5) });
    setTimeout(() => openMemoryPopup(m), 400);
  }
  function pickSpotForPhoto(photo) {
    closeSheet(); setMode('pickPhoto');
    showHint('Tap where you took the photo', [{ label: 'Cancel', onClick: cancelMode }]);
    const once = (e) => { if (state.mode !== 'pickPhoto') return; map.off('click', once); setMode('idle'); attachPhoto(photo, e.lngLat); };
    map.on('click', once);
  }

  // ---------- pins ----------
  $('btnPin').onclick = () => chooseSpot('New pin', (pos) => openPinForm(null, pos), 'pickPin');

  function openPinForm(existing, pos) {
    const p = existing ? { ...existing } : { id: uid(), lat: pos.lat, lng: pos.lng, name: '', note: '', color: PIN_COLORS[0], createdAt: Date.now() };
    const node = h(`
      <div class="field"><label for="pinName">Name</label><input type="text" id="pinName" maxlength="80" placeholder="Best khachapuri"></div>
      <div class="field"><label>Colour</label><div class="swatches" id="pinColors" role="radiogroup">${PIN_COLORS.map((c) =>
        `<button type="button" class="swatch" role="radio" data-c="${c}" style="--c:${c}" aria-label="Colour ${c}" aria-checked="${c === p.color}"></button>`).join('')}</div></div>
      <div class="field"><label for="pinNote">Note</label><textarea id="pinNote" placeholder="Why you pinned it"></textarea></div>
      <div class="form-actions"><button class="btn" type="button" id="pinCancel">Cancel</button>
      <button class="btn btn-primary" type="button" id="pinSave">${existing ? 'Save changes' : 'Save pin'}</button></div>`);
    openSheet(existing ? 'Edit pin' : 'New pin', node);
    $('pinName').value = p.name; $('pinNote').value = p.note || '';
    $('pinColors').onclick = (e) => {
      const b = e.target.closest('.swatch'); if (!b) return;
      p.color = b.dataset.c;
      $('pinColors').querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    };
    $('pinCancel').onclick = closeSheet;
    $('pinSave').onclick = async () => {
      p.name = $('pinName').value.trim() || 'Pin';
      p.note = $('pinNote').value.trim();
      const clean = { ...p }; delete clean._marker;
      await store.put('pins', clean);
      state.pins = state.pins.filter((x) => x.id !== clean.id).concat(clean);
      closeSheet(); renderAll(); toast(existing ? 'Pin updated' : 'Pin dropped');
    };
  }

  function openPinPopup(p) {
    const html = `<div class="pop"><div class="cat" style="color:${p.color}">Pin</div><h3>${esc(p.name)}</h3>
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}
      <div class="row"><button class="btn btn-sm btn-primary" data-act="go">Walk there</button>
      <button class="btn btn-sm" data-act="edit">Edit</button>
      <button class="btn btn-sm btn-danger" data-act="delete">Delete</button></div></div>`;
    openPopup([p.lng, p.lat], html, (el) => {
      el.querySelector('[data-act="go"]').onclick = () => navigateTo({ lat: p.lat, lng: p.lng, name: p.name });
      el.querySelector('[data-act="edit"]').onclick = () => { closePopup(); openPinForm(p); };
      armDelete(el.querySelector('[data-act="delete"]'), async () => {
        await store.del('pins', p.id);
        state.pins = state.pins.filter((x) => x.id !== p.id);
        closePopup(); renderAll(); toast('Pin deleted');
      });
    }, { offset: 34 });
  }

  // ---------- walking directions inside the app ----------
  const nav = { active: null };

  const STEP_WORDS = { left: 'left', right: 'right', 'slight left': 'slightly left', 'slight right': 'slightly right', 'sharp left': 'sharp left', 'sharp right': 'sharp right', straight: 'straight', uturn: 'around' };
  function stepText(s) {
    const m = s.maneuver || {}, on = s.name ? ` onto ${s.name}` : '', dir = STEP_WORDS[m.modifier] || '';
    if (m.type === 'arrive') return 'Arrive at your destination';
    if (m.type === 'depart') return `Head off${s.name ? ' along ' + s.name : ''}`;
    if (m.type === 'roundabout' || m.type === 'rotary') return `Go around the roundabout${on}`;
    if (dir === 'straight') return `Keep straight${on}`;
    if (dir) return `Turn ${dir}${on}`;
    return `Continue${on}`;
  }

  async function fetchRoute(from, to) {
    const url = `${ROUTER}${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const data = await res.json();
      if (!res.ok || data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('no route');
      const r = data.routes[0];
      const coords = r.geometry.coordinates.map((c) => [c[1], c[0]]);
      const steps = [];
      for (const leg of r.legs || []) for (const s of leg.steps || []) {
        const loc = s.maneuver && s.maneuver.location;
        if (loc) steps.push({ at: [loc[1], loc[0]], text: stepText(s) });
      }
      return { coords, distance: r.distance, duration: r.duration, steps, exact: true };
    } catch (e) {
      // No route service: fall back to a straight line so you still get a direction and distance.
      const coords = [[from.lat, from.lng], [to.lat, to.lng]], d = haversine(coords[0], coords[1]);
      return { coords, distance: d, duration: d / 1.3, steps: [], exact: false };
    } finally { clearTimeout(timer); }
  }

  function nearestIndex(coords, p) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < coords.length; i++) { const d = haversine(coords[i], p); if (d < bestD) { bestD = d; best = i; } }
    return { i: best, d: bestD };
  }

  function navPanel(title, line1, line2) {
    $('navTitle').textContent = title; $('navMain').textContent = line1; $('navNext').textContent = line2 || '';
    $('navNext').hidden = !line2;
    $('navPanel').hidden = false;
    document.body.classList.add('navigating');
  }
  function googleLink(dest) { return `https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=${dest.lat},${dest.lng}`; }

  async function navigateTo(dest) {
    closePopup(); closeSheet(); if (state.mode !== 'idle') cancelMode();
    endNav(true);
    nav.active = { dest, route: null, lastReroute: 0, arrived: false };
    $('navGoogle').href = googleLink(dest);
    navPanel('Walking to ' + dest.name, 'Finding a walking route…');
    let from;
    try { from = await currentFix(); } catch (e) { toast(geoError(e), 4500); endNav(); return; }
    if (!nav.active || nav.active.dest !== dest) return;
    await planRoute(from, true);
    nav.active.unsub = gps.subscribe(onNavFix);
  }

  async function planRoute(from, fit) {
    const a = nav.active; if (!a) return;
    a.lastReroute = Date.now();
    const r = await fetchRoute(from, a.dest);
    if (nav.active !== a) return;
    a.route = r; a.speed = r.duration > 0 ? r.distance / r.duration : 1.3;
    a.stepIdx = r.steps.map((s) => nearestIndex(r.coords, s.at).i);
    setGeo('route', fc([line(r.coords)]));
    if (fit) {
      const b = new maplibregl.LngLatBounds(ll(r.coords[0]), ll(r.coords[0]));
      r.coords.forEach((c) => b.extend(ll(c)));
      map.fitBounds(b, { padding: { top: 180, bottom: 230, left: 50, right: 50 }, maxZoom: 16.5, duration: 800 });
    }
    updateNav(from);
  }

  function updateNav(f) {
    const a = nav.active; if (!a || !a.route) return;
    const r = a.route, here = [f.lat, f.lng];
    const toDest = haversine(here, [a.dest.lat, a.dest.lng]);
    if (toDest < 25) {
      if (!a.arrived) {
        a.arrived = true;
        const p = a.dest.placeId && places ? places.markVisited(a.dest.placeId) : null;
        toast(p ? `You arrived at ${a.dest.name}. Marked as visited.` : 'You have arrived.', 4000);
      }
      navPanel(a.dest.name, 'You have arrived', '');
      return;
    }
    const n = nearestIndex(r.coords, here);
    let remaining = n.d;
    for (let i = n.i; i < r.coords.length - 1; i++) remaining += haversine(r.coords[i], r.coords[i + 1]);
    const k = a.stepIdx.findIndex((idx) => idx > n.i);
    const next = k >= 0 ? `Next: ${r.steps[k].text}` : (r.exact ? '' : 'No street route available, so this is a straight line.');
    navPanel('Walking to ' + a.dest.name, `${fmtMinutes(remaining / a.speed)} · ${fmtDist(remaining)}`, next);
    // Wandered off the route: plan a new one (at most every 20 seconds).
    if (r.exact && n.d > 50 && Date.now() - a.lastReroute > 20000) planRoute(f, false);
  }
  function onNavFix(f) { updateNav(f); }

  function endNav(silent) {
    const a = nav.active; nav.active = null;
    if (a && a.unsub) a.unsub();
    setGeo('route', EMPTY);
    $('navPanel').hidden = true;
    document.body.classList.remove('navigating');
    if (a && !silent) toast('Directions ended');
  }
  $('navEnd').onclick = () => endNav();

  // ---------- "My map" sheet ----------
  let listTab = 'memories';
  function openList() {
    if (state.mode !== 'idle') cancelMode();
    const km = state.walks.reduce((s, w) => s + (w.distance || 0), 0);
    const visitedCount = places ? places.visitedList().length : 0;
    const node = h(`
      <div class="summary">
        <div><b>${fmtDist(km)}</b><span>walked</span></div>
        <div><b>${state.memories.length}</b><span>${state.memories.length === 1 ? 'memory' : 'memories'}</span></div>
        <div><b>${visitedCount}</b><span>places visited</span></div>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" type="button" data-tab="memories">Memories</button>
        <button role="tab" type="button" data-tab="walks">Walks</button>
        <button role="tab" type="button" data-tab="pins">Pins</button>
        <button role="tab" type="button" data-tab="visited">Visited</button>
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
    openSheet('My Batumi', node);
    const go = (lat, lng, then) => { closeSheet(); map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15.5) }); setTimeout(then, 800); };
    const EMPTY_TEXT = {
      memories: 'No memories yet. Tap Memory or Photo to save the first place that means something.',
      walks: 'No walks yet. Tap Start walk when you head out, or draw a past walk below.',
      pins: 'No pins yet. Tap Pin, or press and hold anywhere on the map.',
      visited: 'No places marked visited yet. Open a place and tap Mark visited, or walk there with directions.',
    };
    const fill = () => {
      node.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === listTab)));
      const ul = $('listItems'); ul.innerHTML = '';
      let items;
      if (listTab === 'memories') items = state.memories.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      else if (listTab === 'walks') items = state.walks.slice().sort((a, b) => b.startedAt - a.startedAt);
      else if (listTab === 'pins') items = state.pins.slice().sort((a, b) => b.createdAt - a.createdAt);
      else items = places ? places.visitedList() : [];
      if (!items.length) { ul.innerHTML = `<li class="empty" style="cursor:default">${EMPTY_TEXT[listTab]}</li>`; return; }
      for (const it of items) {
        const li = document.createElement('li');
        if (listTab === 'memories') {
          const ph = photosOf(it)[0];
          li.innerHTML = `${ph ? `<img class="thumb" src="${ph}" alt="">` : '<span class="thumb"><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.4-7 10-7 10z"/></svg></span>'}
            <div class="txt"><div class="t">${esc(it.title)}</div><div class="s">${it.date ? fmtDate(it.date) : ''}${photosOf(it).length > 1 ? ` · ${photosOf(it).length} photos` : ''}</div></div>`;
          li.onclick = () => go(it.lat, it.lng, () => openMemoryPopup(it));
        } else if (listTab === 'walks') {
          li.innerHTML = `<span class="walk-sw"></span><div class="txt"><div class="t">${esc(it.name)}</div>
            <div class="s">${fmtDate(it.startedAt)} · ${fmtDist(it.distance)}</div></div>`;
          li.onclick = () => {
            closeSheet();
            const b = new maplibregl.LngLatBounds(ll(it.points[0]), ll(it.points[0]));
            it.points.forEach((p) => b.extend(ll(p)));
            map.fitBounds(b, { padding: { top: 180, bottom: 120, left: 40, right: 40 }, maxZoom: 16 });
            const mid = it.points[Math.floor(it.points.length / 2)];
            setTimeout(() => openWalkPopup(it, ll(mid)), 900);
          };
        } else if (listTab === 'pins') {
          li.innerHTML = `<span class="pin-sw" style="--c:${it.color}"></span><div class="txt"><div class="t">${esc(it.name)}</div><div class="s">${esc(it.note || '')}</div></div>`;
          li.onclick = () => go(it.lat, it.lng, () => openPinPopup(it));
        } else {
          li.innerHTML = `<span class="pin-sw visited-sw"></span><div class="txt"><div class="t">${esc(it.p.name)}</div><div class="s">Visited ${fmtDate(it.at)}</div></div>`;
          li.onclick = () => go(it.p.lat, it.p.lng, () => places.open(it.p));
        }
        ul.appendChild(li);
      }
    };
    node.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { listTab = b.dataset.tab; fill(); }; });
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
    const pts = [];
    state.walks.forEach((w) => w.points.forEach((p) => pts.push(ll(p))));
    state.memories.forEach((m) => pts.push([m.lng, m.lat]));
    state.pins.forEach((p) => pts.push([p.lng, p.lat]));
    if (!pts.length) { map.flyTo({ center: ll(BATUMI), zoom: 14 }); return; }
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    pts.forEach((p) => b.extend(p));
    map.fitBounds(b, { padding: { top: 180, bottom: 120, left: 50, right: 50 }, maxZoom: 16 });
  }

  // ---------- backup ----------
  function exportBackup() {
    const strip = (o) => { const c = { ...o }; delete c._marker; return c; };
    const data = { app: 'niniko-map', version: 2, exportedAt: new Date().toISOString(),
      walks: state.walks.map(strip), memories: state.memories.map(strip), pins: state.pins.map(strip),
      visited: places ? places.exportVisited() : {} };
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
      for (const name of STORES) for (const x of data[name] || []) { await store.put(name, x); n++; }
      if (data.visited && places) places.importVisited(data.visited);
      await load(); closeSheet(); fitAll(); toast(`Restored ${n} items`);
    } catch (err) { toast('That file is not a backup from this app.'); }
  };

  // ---------- startup ----------
  async function load() {
    state.walks = (await store.all('walks')) || [];
    state.memories = (await store.all('memories')) || [];
    state.pins = (await store.all('pins')) || [];
    renderAll();
  }

  function offerResume() {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(REC_KEY) || 'null'); } catch (e) { draft = null; }
    if (!draft || !draft.points) return;
    const node = h(`
      <p class="note">You have a walk that was still recording (${fmtDist(pathLength(draft.points))}, started ${fmtTime(draft.startedAt)}).</p>
      <div class="form-actions"><button class="btn" type="button" id="resDiscard">Discard</button>
      <button class="btn" type="button" id="resSave">Save it</button>
      <button class="btn btn-primary" type="button" id="resGo">Keep recording</button></div>`);
    openSheet('Unfinished walk', node);
    $('resDiscard').onclick = () => { clearRecDraft(); closeSheet(); };
    $('resSave').onclick = () => { closeSheet(); state.recording = draft; stopRecording(true); };
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

  const places = NinikoPlaces.init(map, {
    marker, openPopup, closePopup, toast,
    onAddMemory: (pos, name) => openMemoryForm(null, pos, name),
    onDirections: (dest) => navigateTo(dest),
  });

  load().then(() => {
    if (state.walks.length || state.memories.length || state.pins.length) fitAll();
    if (window.isSecureContext && 'geolocation' in navigator) startTrail(); else offerResume();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
