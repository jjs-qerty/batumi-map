/* Niniko's Map: walks and memories around Batumi, saved on this device. */
(function () {
  'use strict';

  const BATUMI = [41.6430, 41.6360]; // Old Boulevard / Europe Square area
  const MIN_STEP_M = 5;              // ignore GPS jitter smaller than this
  const AUTO_KEY = 'niniko.autoRecord';
  const AUTO_GAP_MS = 30 * 60000;    // a trail paused longer than this becomes its own walk
  const AUTO_MIN_M = 50;             // automatic trails shorter than this are dropped
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
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km'; }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function fmtDate(isoOrMs) {
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs + 'T12:00:00');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  }
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
        t.oncomplete = () => resolve(r && 'result' in r ? r.result : r);
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
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(BATUMI, 15);
  // OpenStreetMap tiles (free, no key). app.css softens their colours, and darkens them in dark mode.
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'base-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
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
  };

  // ---------- rendering ----------
  function renderStats() {
    const km = state.walks.reduce((s, w) => s + (w.distance || 0), 0);
    $('stats').innerHTML = `<span class="sw" style="background:${walkColor()}"></span><b>${fmtDist(km)}</b> walked · <b>${state.memories.length}</b> ${state.memories.length === 1 ? 'memory' : 'memories'}`;
  }

  function renderWalks() {
    walksLayer.clearLayers();
    for (const w of state.walks) {
      const pts = w.points.map((p) => [p[0], p[1]]);
      L.polyline(pts, { ...walkStyle(), interactive: false }).addTo(walksLayer);
      trailHitLine(pts, (latlng) => openWalkPopup(w, latlng)).addTo(walksLayer);
    }
  }

  function memoryIcon(m) {
    const style = m.photo ? ` style="background-image:url('${m.photo}')"` : '';
    return L.divIcon({
      className: '',
      html: `<div class="pin${m.photo ? ' has-photo' : ''}"${style}><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.4-7 10-7 10z"/></svg></div>`,
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
      if (state.mode !== 'idle') handleMapTap(e.latlng); else onTap(e.latlng);
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
      ${m.photo ? `<img src="${m.photo}" alt="">` : ''}
      ${m.note ? `<p>${esc(m.note)}</p>` : ''}
      <div class="row"><button class="btn btn-sm" data-act="edit">Edit</button>
      <button class="btn btn-sm btn-danger" data-act="delete">Delete</button></div></div>`;
  }
  function wireMemoryPopup(popup, m) {
    const el = popup.getElement();
    el.querySelector('[data-act="edit"]').onclick = () => { map.closePopup(); openMemoryForm(m); };
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
    document.body.classList.toggle('picking', mode !== 'idle');
    if (mode === 'idle') hideHint();
  }

  // ---------- location ----------
  function showMe(lat, lng, acc) {
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
    $('recMeta').textContent = `${fmtDist(pathLength(pts))} · ${fmtDur(Date.now() - state.recording.startedAt)}`;
  }
  let recTick = null;

  function liveTrailPopup(latlng) {
    const rec = state.recording; if (!rec) return;
    const near = nearestPoint(rec.points, latlng); if (!near) return;
    L.popup({ maxWidth: 260 }).setLatLng([near[0], near[1]])
      .setContent(`<div class="pop"><div class="here-at">You were here at <b>${fmtClock(near[2])}</b></div><div class="when">Current trail · ${fmtDist(pathLength(rec.points))} so far</div></div>`)
      .openOn(map);
    markTrailPoint(near);
  }

  function startRecording(resume, auto) {
    if (!('geolocation' in navigator)) { toast('This browser cannot read GPS.'); return; }
    if (!window.isSecureContext) { toast(geoError(), 4500); return; }
    state.recording = resume || { id: uid(), startedAt: Date.now(), points: [] };
    const startPts = state.recording.points.map((p) => [p[0], p[1]]);
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
      const pts = state.recording.points, p = [lat, lng, pos.timestamp];
      if (pts.length && haversine(pts[pts.length - 1], p) < Math.max(MIN_STEP_M, Math.min(accuracy, 25))) return;
      pts.push(p); state.recLine.eachLayer((l) => l.addLatLng([lat, lng])); saveRecDraft(); updateRecBanner();
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
    if (state.draw) { map.removeLayer(state.draw.line); map.removeLayer(state.draw.vertices); state.draw = null; }
    setMode('idle');
  }

  function handleMapTap(latlng) {
    if (state.mode === 'drawWalk' && state.draw) { state.draw.points.push([latlng.lat, latlng.lng]); state.draw.redraw(); }
    else if (state.mode === 'pickMemory') { setMode('idle'); openMemoryForm(null, latlng); }
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
    const m = existing ? { ...existing } : { id: uid(), lat: latlng.lat, lng: latlng.lng, title: title || '', note: '', date: todayISO(), photo: null, createdAt: Date.now() };
    const node = h(`
      <div class="field"><label for="memTitle">What happened here</label><input type="text" id="memTitle" maxlength="100" placeholder="First swim at the boulevard"></div>
      <div class="field"><label for="memDate">When</label><input type="date" id="memDate"></div>
      <div class="field"><label for="memNote">Story</label><textarea id="memNote" placeholder="Who you were with, what you remember"></textarea></div>
      <div class="field"><label for="memPhoto">Photo</label>
        <div class="photo-pick"><img id="memPreview" alt="" hidden>
          <input type="file" id="memPhoto" accept="image/*">
          <button class="btn btn-sm" type="button" id="memPhotoRemove" hidden>Remove photo</button></div></div>
      <div class="where">${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</div>
      <div class="form-actions"><button class="btn" type="button" id="memCancel">Cancel</button>
      <button class="btn btn-primary" type="button" id="memSave">${existing ? 'Save changes' : 'Save memory'}</button></div>`);
    openSheet(existing ? 'Edit memory' : 'New memory', node);
    $('memTitle').value = m.title; $('memDate').value = m.date || ''; $('memNote').value = m.note || '';
    const showPhoto = () => { $('memPreview').hidden = !m.photo; $('memPhotoRemove').hidden = !m.photo; if (m.photo) $('memPreview').src = m.photo; };
    showPhoto();
    $('memPhoto').onchange = async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      try { m.photo = await resizeImage(f); showPhoto(); } catch (err) { toast(err.message); }
    };
    $('memPhotoRemove').onclick = () => { m.photo = null; $('memPhoto').value = ''; showPhoto(); };
    $('memCancel').onclick = closeSheet;
    $('memSave').onclick = async () => {
      m.title = $('memTitle').value.trim();
      if (!m.title) { $('memTitle').focus(); toast('Give the memory a short title.'); return; }
      m.date = $('memDate').value; m.note = $('memNote').value.trim();
      const clean = { ...m }; delete clean._marker;
      await store.put('memories', clean);
      state.memories = state.memories.filter((x) => x.id !== clean.id).concat(clean);
      closeSheet(); renderAll(); toast(existing ? 'Memory updated' : 'Memory saved');
      const mk = state.memories.find((x) => x.id === clean.id)._marker;
      map.panTo([clean.lat, clean.lng]); if (mk) mk.openPopup();
    };
  }

  // ---------- "My map" sheet ----------
  let listTab = 'memories';
  function openList() {
    if (state.mode !== 'idle') cancelMode();
    const km = state.walks.reduce((s, w) => s + (w.distance || 0), 0);
    const node = h(`
      <div class="summary">
        <div><b>${fmtDist(km)}</b><span>walked</span></div>
        <div><b>${state.walks.length}</b><span>${state.walks.length === 1 ? 'walk' : 'walks'}</span></div>
        <div><b>${state.memories.length}</b><span>${state.memories.length === 1 ? 'memory' : 'memories'}</span></div>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" type="button" id="tabMem" aria-selected="${listTab === 'memories'}">Memories</button>
        <button role="tab" type="button" id="tabWalk" aria-selected="${listTab === 'walks'}">Walks</button>
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
    const fill = () => {
      $('tabMem').setAttribute('aria-selected', listTab === 'memories'); $('tabWalk').setAttribute('aria-selected', listTab === 'walks');
      const ul = $('listItems'); ul.innerHTML = '';
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
          li.innerHTML = `${it.photo ? `<img class="thumb" src="${it.photo}" alt="">` : '<span class="thumb"><svg viewBox="0 0 24 24"><path d="M12 20s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.4-7 10-7 10z"/></svg></span>'}
            <div class="txt"><div class="t">${esc(it.title)}</div><div class="s">${it.date ? fmtDate(it.date) : ''}</div></div>`;
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
    };
    $('tabMem').onclick = () => { listTab = 'memories'; fill(); };
    $('tabWalk').onclick = () => { listTab = 'walks'; fill(); };
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
    state.walks.forEach((w) => w.points.forEach((p) => pts.push([p[0], p[1]])));
    state.memories.forEach((m) => pts.push([m.lat, m.lng]));
    if (pts.length) map.flyToBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 17 });
    else map.flyTo(BATUMI, 15);
  }

  // ---------- backup ----------
  function exportBackup() {
    const strip = (o) => { const c = { ...o }; delete c._marker; return c; };
    const data = { app: 'niniko-map', version: 1, exportedAt: new Date().toISOString(), walks: state.walks.map(strip), memories: state.memories.map(strip) };
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
      await load(); closeSheet(); fitAll(); toast(`Restored ${n} items`);
    } catch (err) { toast('That file is not a backup from this app.'); }
  };

  // ---------- startup ----------
  async function load() {
    state.walks = (await store.all('walks')) || [];
    state.memories = ((await store.all('memories')) || []).map((m) => (!m.photo && m.photos && m.photos.length ? { ...m, photo: m.photos[0] } : m));
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

  NinikoPlaces.init(map, { onAddMemory: (latlng, name) => openMemoryForm(null, latlng, name), toast });

  load().then(() => {
    if (state.walks.length || state.memories.length) fitAll();
    if (window.isSecureContext && 'geolocation' in navigator) startTrail(); else offerResume();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
