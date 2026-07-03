(() => {
  'use strict';

  const DB_NAME = 'watchtrail-db';
  const DB_VERSION = 1;
  const STORE = 'state';
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w185';

  const state = {
    items: [],
    episodes: {},
    importedAt: null,
    updatedAt: null,
    sourceFiles: [],
  };

  const $ = (id) => document.getElementById(id);
  const logBox = () => $('logBox');

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    console.log(line);
    if (logBox()) logBox().textContent = `${line}\n${logBox().textContent || ''}`.slice(0, 9000);
  }

  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  function download(name, mime, content) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveState() {
    state.updatedAt = new Date().toISOString();
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(JSON.parse(JSON.stringify(state)), 'state');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function loadState() {
    const db = await openDb();
    const saved = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get('state');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (saved && Array.isArray(saved.items)) {
      Object.assign(state, saved);
      state.episodes = state.episodes || {};
    }
  }

  async function wipeState() {
    if (!confirm('Svuotare tutti i dati locali di WatchTrail?')) return;
    state.items = []; state.episodes = {}; state.sourceFiles = []; state.importedAt = null;
    await saveState();
    renderAll();
    log('Archivio locale svuotato.');
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i], next = text[i + 1];
      if (ch === '"') {
        if (quote && next === '"') { field += '"'; i++; }
        else quote = !quote;
      } else if (ch === ',' && !quote) { row.push(field); field = ''; }
      else if ((ch === '\n' || ch === '\r') && !quote) {
        if (ch === '\r' && next === '\n') i++;
        row.push(field); field = '';
        if (row.some(v => String(v).trim() !== '')) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field); if (row.some(v => String(v).trim() !== '')) rows.push(row);
    if (!rows.length) return [];
    const headers = rows.shift().map(h => String(h || '').trim());
    return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  }

  function getField(obj, candidates) {
    if (!obj || typeof obj !== 'object') return '';
    const keys = Object.keys(obj);
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(obj, c)) return obj[c];
      const found = keys.find(k => norm(k) === norm(c));
      if (found) return obj[found];
    }
    return '';
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) { log('Nessun file selezionato.'); return; }
    log(`Import avviato: ${files.map(f => f.name).join(', ')}`);
    let imported = 0;
    for (const file of files) {
      try {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.zip')) {
          const entries = await unzipFile(file);
          for (const entry of entries) {
            await importNamedText(entry.name, entry.text);
            imported++;
          }
        } else {
          await importNamedText(file.name, await file.text());
          imported++;
        }
      } catch (err) {
        log(`ERRORE su ${file.name}: ${err && err.message ? err.message : err}`);
      }
    }
    dedupeAndSort();
    state.importedAt = new Date().toISOString();
    await saveState();
    renderAll();
    log(`Import completato. File/entry processati: ${imported}.`);
  }

  async function importNamedText(name, text) {
    const lower = name.toLowerCase();
    state.sourceFiles.push(name);
    if (lower.endsWith('.json')) {
      const data = JSON.parse(text);
      importJson(data, name);
    } else if (lower.endsWith('.csv')) {
      importCsv(parseCsv(text), name);
    } else if (lower.endsWith('.html')) {
      log(`HTML riepilogo rilevato (${name}), tenuto solo come riferimento.`);
    } else {
      log(`Formato ignorato: ${name}`);
    }
  }

  function importJson(data, name) {
    if (Array.isArray(data)) {
      const looksMovie = name.toLowerCase().includes('movie');
      data.forEach(x => looksMovie ? upsertMovie(fromMovieObj(x)) : upsertSeries(fromSeriesObj(x)));
      log(`${name}: importati array JSON (${data.length}).`);
      return;
    }
    const series = data.series || data.shows || data.tv_shows || data.tvShows || [];
    const movies = data.movies || data.films || [];
    if (Array.isArray(series)) series.forEach(x => upsertSeries(fromSeriesObj(x)));
    if (Array.isArray(movies)) movies.forEach(x => upsertMovie(fromMovieObj(x)));
    if (!series.length && !movies.length && (data.name || data.title)) {
      name.toLowerCase().includes('movie') ? upsertMovie(fromMovieObj(data)) : upsertSeries(fromSeriesObj(data));
    }
    log(`${name}: JSON letto. Serie ${series.length || 0}, film ${movies.length || 0}.`);
  }

  function fromSeriesObj(x) {
    const title = getField(x, ['name','title','series_name','show_name']) || 'Senza titolo';
    const item = {
      id: String(getField(x, ['id','uuid','tvtime_id','tvdb_id','thetvdb_id']) || uid('series')),
      kind: 'series',
      title,
      year: getField(x, ['year','start_year','first_air_year']) || yearFromDate(getField(x, ['first_air_date','aired_at','date'])),
      status: getField(x, ['status','state']) || 'unknown',
      favorite: Boolean(getField(x, ['favorite','is_favorite','favorited'])),
      poster: getField(x, ['poster','image','poster_path','cover']) || '',
      external: {
        tvtime: getField(x, ['tvtime_id','id']),
        tvdb: getField(x, ['tvdb_id','thetvdb_id']),
        imdb: getField(x, ['imdb_id']),
        tmdb: getField(x, ['tmdb_id'])
      }
    };
    const eps = extractEpisodes(x, item.id, title);
    if (eps.length) state.episodes[item.id] = mergeEpisodes(state.episodes[item.id] || [], eps);
    return item;
  }

  function extractEpisodes(x, seriesId, seriesTitle) {
    const flat = [];
    const direct = x.episodes || x.watched_episodes || [];
    if (Array.isArray(direct)) direct.forEach(ep => flat.push(normalizeEpisode(ep, seriesId, seriesTitle)));
    const seasons = x.seasons || [];
    if (Array.isArray(seasons)) {
      seasons.forEach(season => {
        const sn = Number(getField(season, ['number','season_number','season'])) || 0;
        const eps = season.episodes || [];
        if (Array.isArray(eps)) eps.forEach(ep => flat.push(normalizeEpisode({...ep, season_number: getField(ep,['season_number']) || sn}, seriesId, seriesTitle)));
      });
    }
    return flat.filter(Boolean);
  }

  function normalizeEpisode(ep, seriesId, seriesTitle) {
    const s = Number(getField(ep, ['season_number','season','seasonNumber'])) || 0;
    const e = Number(getField(ep, ['episode_number','number','episode','episodeNumber'])) || 0;
    if (!s && !e && !getField(ep, ['title','name'])) return null;
    return {
      id: String(getField(ep, ['id','uuid']) || `${seriesId}_s${s}_e${e}`),
      seriesId,
      seriesTitle,
      season: s,
      number: e,
      title: getField(ep, ['name','title']) || `Episodio ${e}`,
      watched: Boolean(getField(ep, ['watched','is_watched','seen','viewed']) || getField(ep, ['watched_at','seen_at','viewed_at'])),
      watchedAt: getField(ep, ['watched_at','seen_at','viewed_at','date']) || '',
      rewatch: Number(getField(ep, ['rewatch_count','rewatches','rewatch'])) || 0,
      airdate: getField(ep, ['airdate','air_date','aired_at']) || ''
    };
  }

  function fromMovieObj(x) {
    const title = getField(x, ['title','name','movie_title']) || 'Senza titolo';
    return {
      id: String(getField(x, ['id','uuid','imdb_id','tmdb_id','tvtime_id']) || uid('movie')),
      kind: 'movie',
      title,
      year: getField(x, ['year','release_year']) || yearFromDate(getField(x, ['release_date','watched_at','date'])),
      status: getField(x, ['status']) || (getField(x, ['watched','watched_at','seen_at']) ? 'watched' : 'planned'),
      favorite: Boolean(getField(x, ['favorite','is_favorite','favorited'])),
      watched: Boolean(getField(x, ['watched','is_watched','seen']) || getField(x, ['watched_at','seen_at'])),
      watchedAt: getField(x, ['watched_at','seen_at','viewed_at','date']) || '',
      rewatch: Number(getField(x, ['rewatch_count','rewatches','rewatch'])) || 0,
      poster: getField(x, ['poster','image','poster_path','cover']) || '',
      external: {
        imdb: getField(x, ['imdb_id']), tmdb: getField(x, ['tmdb_id']), tvtime: getField(x, ['tvtime_id','id'])
      }
    };
  }

  function importCsv(rows, name) {
    const lower = name.toLowerCase();
    if (lower.includes('episode')) {
      const bySeries = new Map();
      rows.forEach(r => {
        const title = getField(r, ['Series','Series Name','Show','show_name','series_name','Title']);
        const idBase = String(getField(r, ['TVDB ID','tvdb_id','series_id']) || norm(title) || uid('series'));
        const sid = `series_${idBase}`;
        if (!state.items.some(i => i.id === sid)) upsertSeries({ id: sid, kind:'series', title: title || 'Senza titolo', year:'', status:'unknown', external:{tvdb:idBase} });
        if (!bySeries.has(sid)) bySeries.set(sid, []);
        bySeries.get(sid).push({
          id: `${sid}_s${Number(getField(r, ['Season','season'])) || 0}_e${Number(getField(r, ['Episode','Episode Number','episode'])) || 0}`,
          seriesId: sid,
          seriesTitle: title,
          season: Number(getField(r, ['Season','season'])) || 0,
          number: Number(getField(r, ['Episode','Episode Number','episode'])) || 0,
          title: getField(r, ['Episode Title','Name','episode_title','Title']) || '',
          watched: truthy(getField(r, ['Watched','Seen','watched'])) || Boolean(getField(r, ['Watched At','watched_at','Date'])),
          watchedAt: getField(r, ['Watched At','watched_at','Date']) || '',
          rewatch: Number(getField(r, ['Rewatch','Rewatch Count','rewatch'])) || 0,
          airdate: getField(r, ['Airdate','airdate']) || ''
        });
      });
      bySeries.forEach((eps, sid) => state.episodes[sid] = mergeEpisodes(state.episodes[sid] || [], eps));
      log(`${name}: episodi CSV ${rows.length}.`);
    } else if (lower.includes('movie')) {
      rows.forEach(r => upsertMovie({
        id: String(getField(r, ['IMDb ID','imdb_id','TMDB ID','id']) || uid('movie')),
        kind:'movie',
        title: getField(r, ['Title','Movie','Name']) || 'Senza titolo',
        year: getField(r, ['Year','Release Year']) || yearFromDate(getField(r, ['Release Date','Date'])),
        status: truthy(getField(r, ['Watched','Seen'])) || getField(r, ['Watched At','Date']) ? 'watched' : 'planned',
        watched: truthy(getField(r, ['Watched','Seen'])) || Boolean(getField(r, ['Watched At','Date'])),
        watchedAt: getField(r, ['Watched At','Date']) || '',
        rewatch: Number(getField(r, ['Rewatch','Rewatch Count'])) || 0,
        favorite: truthy(getField(r, ['Favorite'])),
        external: { imdb: getField(r, ['IMDb ID','imdb_id']), tmdb: getField(r, ['TMDB ID','tmdb_id']) }
      }));
      log(`${name}: film CSV ${rows.length}.`);
    } else {
      rows.forEach(r => upsertSeries({
        id: String(getField(r, ['TVDB ID','tvdb_id','id']) || uid('series')),
        kind:'series', title: getField(r, ['Title','Name','Series']) || 'Senza titolo',
        year: getField(r, ['Year']) || '', status: getField(r, ['Status']) || 'unknown', external: { tvdb: getField(r, ['TVDB ID','tvdb_id']) }
      }));
      log(`${name}: serie CSV ${rows.length}.`);
    }
  }

  function truthy(v) { return ['1','true','yes','si','sì','watched','seen'].includes(norm(v)); }
  function yearFromDate(v) { const m = String(v || '').match(/(19|20)\d{2}/); return m ? m[0] : ''; }

  function upsertSeries(item) { upsertItem(item); }
  function upsertMovie(item) { upsertItem(item); }

  function upsertItem(item) {
    if (!item || !item.title) return;
    item.search = norm(`${item.title} ${item.year || ''}`);
    const key = item.external?.imdb || item.external?.tmdb || item.external?.tvdb || item.id;
    const existing = state.items.findIndex(i => i.kind === item.kind && ((key && JSON.stringify(i.external || {}).includes(String(key))) || norm(i.title) === norm(item.title)));
    if (existing >= 0) state.items[existing] = { ...state.items[existing], ...item, external: { ...(state.items[existing].external || {}), ...(item.external || {}) } };
    else state.items.push(item);
  }

  function mergeEpisodes(oldEps, newEps) {
    const map = new Map();
    [...oldEps, ...newEps].forEach(ep => {
      const k = `${ep.season}-${ep.number}-${norm(ep.title)}`;
      map.set(k, { ...(map.get(k) || {}), ...ep, watched: Boolean((map.get(k) || {}).watched || ep.watched) });
    });
    return Array.from(map.values()).sort((a,b) => (a.season-b.season) || (a.number-b.number));
  }

  function dedupeAndSort() {
    const map = new Map();
    state.items.forEach(item => {
      const key = `${item.kind}_${item.external?.imdb || item.external?.tmdb || item.external?.tvdb || norm(item.title)}`;
      map.set(key, { ...(map.get(key) || {}), ...item });
    });
    state.items = Array.from(map.values()).sort((a,b) => a.title.localeCompare(b.title));
  }

  async function unzipFile(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const entries = parseZipEntries(bytes);
    const out = [];
    for (const e of entries) {
      if (!/\.(json|csv|html)$/i.test(e.name)) continue;
      let data = bytes.slice(e.offset, e.offset + e.compressedSize);
      if (e.method === 0) {
        // stored
      } else if (e.method === 8 && 'DecompressionStream' in window) {
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([data]).stream().pipeThrough(ds);
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error(`ZIP compresso non supportato dal browser per ${e.name}. Estrai lo ZIP e importa JSON/CSV.`);
      }
      out.push({ name: e.name, text: new TextDecoder('utf-8').decode(data) });
    }
    if (!out.length) throw new Error('Nessun JSON/CSV/HTML trovato nello ZIP.');
    return out;
  }

  function parseZipEntries(bytes) {
    const entries = [];
    let p = 0;
    const u16 = o => bytes[o] | (bytes[o+1] << 8);
    const u32 = o => (bytes[o] | (bytes[o+1] << 8) | (bytes[o+2] << 16) | (bytes[o+3] << 24)) >>> 0;
    while (p < bytes.length - 30) {
      if (u32(p) !== 0x04034b50) { p++; continue; }
      const method = u16(p + 8);
      const compressedSize = u32(p + 18);
      const nameLen = u16(p + 26);
      const extraLen = u16(p + 28);
      const name = new TextDecoder().decode(bytes.slice(p + 30, p + 30 + nameLen));
      const offset = p + 30 + nameLen + extraLen;
      if (!name.endsWith('/')) entries.push({ name, method, compressedSize, offset });
      p = offset + compressedSize;
    }
    return entries;
  }

  function renderAll() {
    renderStats(); renderContinue(); renderLibrary();
  }

  function renderStats() {
    const series = state.items.filter(i => i.kind === 'series');
    const movies = state.items.filter(i => i.kind === 'movie');
    const eps = Object.values(state.episodes).flat();
    $('statSeries').textContent = series.length.toLocaleString('it-IT');
    $('statEpisodes').textContent = eps.filter(e => e.watched).length.toLocaleString('it-IT');
    $('statMovies').textContent = movies.length.toLocaleString('it-IT');
    $('statProgress').textContent = series.filter(s => nextEpisode(s.id)).length.toLocaleString('it-IT');
  }

  function posterHtml(item) {
    const src = item.poster && String(item.poster).startsWith('/') ? TMDB_IMG + item.poster : item.poster;
    return `<div class="poster">${src ? `<img src="${escapeHtml(src)}" alt="">` : escapeHtml((item.title || '?').slice(0,1).toUpperCase())}</div>`;
  }

  function itemHtml(item, mode = 'library') {
    const eps = state.episodes[item.id] || [];
    const seen = item.kind === 'movie' ? (item.watched ? 1 : 0) : eps.filter(e => e.watched).length;
    const total = item.kind === 'movie' ? 1 : eps.length;
    const next = item.kind === 'series' ? nextEpisode(item.id) : null;
    return `<article class="item" data-id="${escapeHtml(item.id)}">
      ${posterHtml(item)}
      <div>
        <h3>${escapeHtml(item.title)}</h3>
        <div class="meta">
          <span class="pill">${item.kind === 'movie' ? 'Film' : 'Serie/anime'}</span>
          ${item.year ? `<span class="pill">${escapeHtml(item.year)}</span>` : ''}
          <span class="pill">${seen}/${total || '?'}</span>
          ${item.favorite ? `<span class="pill">★ preferito</span>` : ''}
        </div>
      </div>
      <button class="secondary nextBtn" data-action="${item.kind === 'movie' ? 'toggleMovie' : 'open'}" data-id="${escapeHtml(item.id)}">${item.kind === 'movie' ? (item.watched ? 'Visto' : 'Segna visto') : (next ? `S${next.season}E${next.number}` : 'Apri')}</button>
    </article>`;
  }

  function renderContinue() {
    const list = $('continueList');
    const items = state.items.filter(i => i.kind === 'series' && nextEpisode(i.id)).slice(0, 30);
    list.innerHTML = items.length ? items.map(i => itemHtml(i, 'continue')).join('') : `<div class="empty">Importa TV Time o aggiungi una serie per vedere i prossimi episodi.</div>`;
  }

  function renderLibrary() {
    const q = norm($('librarySearch')?.value || '');
    const type = $('typeFilter')?.value || 'all';
    let items = state.items;
    if (type !== 'all') items = items.filter(i => i.kind === type);
    if (q) items = items.filter(i => (i.search || norm(i.title)).includes(q));
    items = items.slice(0, 120);
    $('libraryList').innerHTML = items.length ? items.map(i => itemHtml(i)).join('') : `<div class="empty">Nessun risultato.</div>`;
  }

  function nextEpisode(seriesId) {
    return (state.episodes[seriesId] || []).find(e => !e.watched) || null;
  }

  function openDetail(id) {
    const item = state.items.find(i => i.id === id);
    if (!item) return;
    const content = $('detailContent');
    if (item.kind === 'movie') {
      content.innerHTML = `<h2>${escapeHtml(item.title)}</h2><p class="muted">${escapeHtml(item.year || '')}</p><button class="primary" data-action="toggleMovie" data-id="${escapeHtml(item.id)}">${item.watched ? 'Segna non visto' : 'Segna visto'}</button>`;
    } else {
      const eps = state.episodes[item.id] || [];
      const grouped = new Map(); eps.forEach(e => { if (!grouped.has(e.season)) grouped.set(e.season, []); grouped.get(e.season).push(e); });
      content.innerHTML = `<h2>${escapeHtml(item.title)}</h2><p class="muted">${eps.filter(e=>e.watched).length}/${eps.length} episodi visti</p>` +
        Array.from(grouped.entries()).map(([s, arr]) => `<div class="season"><h3>Stagione ${s}</h3>${arr.map(e => `<label class="episode"><input type="checkbox" data-action="toggleEpisode" data-series="${escapeHtml(item.id)}" data-episode="${escapeHtml(e.id)}" ${e.watched ? 'checked' : ''}><span>S${e.season}E${e.number} · ${escapeHtml(e.title || '')}</span><span class="meta">${escapeHtml(e.watchedAt || '')}</span></label>`).join('')}</div>`).join('') || `<div class="empty">Nessun episodio importato. Puoi comunque tenerla in libreria.</div>`;
    }
    $('detailSheet').classList.remove('hidden');
  }

  async function toggleMovie(id) {
    const item = state.items.find(i => i.id === id); if (!item) return;
    item.watched = !item.watched; item.status = item.watched ? 'watched' : 'planned'; item.watchedAt = item.watched ? new Date().toISOString().slice(0,10) : '';
    await saveState(); renderAll(); openDetail(id);
  }

  async function toggleEpisode(seriesId, episodeId, checked) {
    const ep = (state.episodes[seriesId] || []).find(e => e.id === episodeId); if (!ep) return;
    ep.watched = Boolean(checked); ep.watchedAt = checked ? (ep.watchedAt || new Date().toISOString().slice(0,10)) : '';
    await saveState(); renderAll();
  }

  async function onlineSearch() {
    const q = $('onlineQuery').value.trim(); const type = $('onlineType').value;
    const box = $('onlineResults');
    if (!q) { box.innerHTML = `<div class="empty">Scrivi un titolo.</div>`; return; }
    box.innerHTML = `<div class="empty">Ricerca in corso…</div>`;
    try {
      let results = [];
      if (type === 'series') results = await searchTvmaze(q);
      else if (type === 'anime') results = await searchJikan(q);
      else results = await searchTmdbMovie(q);
      box.innerHTML = results.length ? results.map(r => resultHtml(r)).join('') : `<div class="empty">Nessun risultato. Usa inserimento manuale.</div>`;
    } catch (err) {
      box.innerHTML = `<div class="empty">Ricerca non riuscita: ${escapeHtml(err.message || err)}</div>`;
    }
  }

  async function searchTvmaze(q) {
    const data = await fetchJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`);
    return data.slice(0,10).map(x => ({ source:'tvmaze', kind:'series', id:x.show.id, title:x.show.name, year:yearFromDate(x.show.premiered), poster:x.show.image?.medium || '', meta:x.show.type || 'Serie' }));
  }

  async function searchJikan(q) {
    const data = await fetchJson(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=10`);
    return (data.data || []).map(x => ({ source:'jikan', kind:'series', id:x.mal_id, title:x.title, year:x.year || yearFromDate(x.aired?.from), poster:x.images?.jpg?.image_url || '', meta:`Anime · ${x.episodes || '?'} ep` }));
  }

  async function searchTmdbMovie(q) {
    const key = $('tmdbKey').value.trim() || localStorage.getItem('watchtrail_tmdb_key') || '';
    if (!key) throw new Error('Per i film serve una TMDB API key, oppure aggiungi manualmente.');
    localStorage.setItem('watchtrail_tmdb_key', key);
    const data = await fetchJson(`https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(key)}&language=it-IT&query=${encodeURIComponent(q)}`);
    return (data.results || []).slice(0,10).map(x => ({ source:'tmdb', kind:'movie', id:x.id, title:x.title, year:yearFromDate(x.release_date), poster:x.poster_path ? TMDB_IMG + x.poster_path : '', meta:'Film' }));
  }

  async function fetchJson(url) {
    const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json();
  }

  function resultHtml(r) {
    return `<article class="item"><div class="poster">${r.poster ? `<img src="${escapeHtml(r.poster)}" alt="">` : escapeHtml(r.title.slice(0,1))}</div><div><h3>${escapeHtml(r.title)}</h3><div class="meta"><span class="pill">${escapeHtml(r.meta)}</span>${r.year ? `<span class="pill">${escapeHtml(r.year)}</span>` : ''}</div></div><button class="primary" data-action="addOnline" data-payload="${escapeHtml(JSON.stringify(r))}">Aggiungi</button></article>`;
  }

  async function addOnline(payload) {
    const r = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (r.kind === 'movie') upsertMovie({ id:`tmdb_${r.id}`, kind:'movie', title:r.title, year:r.year, poster:r.poster, status:'planned', watched:false, external:{tmdb:r.id} });
    else {
      const id = `${r.source}_${r.id}`;
      upsertSeries({ id, kind:'series', title:r.title, year:r.year, poster:r.poster, status:'planned', external:{[r.source]:r.id} });
      if (r.source === 'tvmaze') {
        try {
          const eps = await fetchJson(`https://api.tvmaze.com/shows/${r.id}/episodes`);
          state.episodes[id] = mergeEpisodes(state.episodes[id] || [], eps.map(e => ({ id:`${id}_${e.id}`, seriesId:id, seriesTitle:r.title, season:e.season, number:e.number, title:e.name, watched:false, watchedAt:'', airdate:e.airdate || '' })));
        } catch (err) { log(`Episodi TVmaze non caricati: ${err.message || err}`); }
      } else if (r.source === 'jikan') {
        const count = Number((r.meta || '').match(/(\d+) ep/)?.[1]) || 0;
        if (count) state.episodes[id] = Array.from({length: count}, (_, i) => ({ id:`${id}_s1_e${i+1}`, seriesId:id, seriesTitle:r.title, season:1, number:i+1, title:`Episodio ${i+1}`, watched:false, watchedAt:'', airdate:'' }));
      }
    }
    dedupeAndSort(); await saveState(); renderAll(); log(`Aggiunto: ${r.title}`);
  }

  async function addManual() {
    const title = $('manualTitle').value.trim(); if (!title) return;
    const kind = $('manualKind').value; const year = $('manualYear').value.trim();
    kind === 'movie' ? upsertMovie({id:uid('movie'), kind:'movie', title, year, status:'planned', watched:false}) : upsertSeries({id:uid('series'), kind:'series', title, year, status:'planned'});
    $('manualTitle').value = ''; $('manualYear').value = '';
    dedupeAndSort(); await saveState(); renderAll(); log(`Inserito manualmente: ${title}`);
  }

  function exportJson() {
    download(`watchtrail-backup-${new Date().toISOString().slice(0,10)}.json`, 'application/json', JSON.stringify(state, null, 2));
  }

  function exportMovieCsv() {
    const rows = [['Title','Year','WatchedDate','Rewatch','Favorite','IMDb','TMDB']];
    state.items.filter(i => i.kind === 'movie').forEach(m => rows.push([m.title, m.year || '', m.watchedAt || '', m.rewatch || 0, m.favorite ? 'Yes' : '', m.external?.imdb || '', m.external?.tmdb || '']));
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
    download(`watchtrail-movies-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv', csv);
  }

  function wireEvents() {
    $('fileInput').addEventListener('change', e => importFiles(e.target.files));
    $('exportBtn').addEventListener('click', exportJson);
    $('exportJsonBtn').addEventListener('click', exportJson);
    $('exportCsvBtn').addEventListener('click', exportMovieCsv);
    $('wipeBtn').addEventListener('click', wipeState);
    $('librarySearch').addEventListener('input', renderLibrary);
    $('typeFilter').addEventListener('change', renderLibrary);
    $('onlineSearchBtn').addEventListener('click', onlineSearch);
    $('manualAddBtn').addEventListener('click', addManual);
    $('refreshContinue').addEventListener('click', renderContinue);
    $('closeSheet').addEventListener('click', () => $('detailSheet').classList.add('hidden'));
    document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    document.body.addEventListener('click', async e => {
      const btn = e.target.closest('[data-action]'); if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'open') openDetail(btn.dataset.id || btn.closest('.item')?.dataset.id);
      if (action === 'toggleMovie') await toggleMovie(btn.dataset.id);
      if (action === 'addOnline') await addOnline(btn.dataset.payload);
    });
    document.body.addEventListener('change', async e => {
      const el = e.target.closest('[data-action="toggleEpisode"]');
      if (el) await toggleEpisode(el.dataset.series, el.dataset.episode, el.checked);
    });
    document.body.addEventListener('click', e => {
      const item = e.target.closest('.item[data-id]');
      if (item && !e.target.closest('button')) openDetail(item.dataset.id);
    });
  }

  function switchView(view) {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $(`${view}View`).classList.add('active');
    if (view === 'library') renderLibrary();
  }

  function setupInstall() {
    let deferred;
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('installBtn').classList.remove('hidden'); });
    $('installBtn').addEventListener('click', async () => { if (deferred) { deferred.prompt(); deferred = null; $('installBtn').classList.add('hidden'); } });
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  async function init() {
    try {
      wireEvents(); setupInstall();
      const key = localStorage.getItem('watchtrail_tmdb_key'); if (key) $('tmdbKey').value = key;
      await loadState(); renderAll(); log('WatchTrail avviato.');
    } catch (err) {
      document.body.insertAdjacentHTML('afterbegin', `<div style="padding:16px;background:#ff5573;color:white">Errore avvio: ${escapeHtml(err.message || err)}</div>`);
      console.error(err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
