(() => {
  'use strict';

  const DB_NAME = 'watchtrail-db';
  const DB_VERSION = 2;
  const STORE = 'state';
  const TMDB_IMG = 'https://image.tmdb.org/t/p/w185';

  const state = {
    items: [],
    episodes: {},
    importedAt: null,
    updatedAt: null,
    sourceFiles: [],
    importReports: []
  };

  const $ = id => document.getElementById(id);
  const norm = value => String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  const compact = value => norm(value).replace(/[^a-z0-9]+/g, '');
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

  function log(message, level = 'info') {
    const line = `[${new Date().toLocaleTimeString('it-IT')}] ${message}`;
    console[level === 'error' ? 'error' : 'log'](line);
    const box = $('logBox');
    if (box) box.textContent = `${line}\n${box.textContent || ''}`.slice(0, 20000);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
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
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
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
      state.sourceFiles = state.sourceFiles || [];
      state.importReports = state.importReports || [];
    }
  }

  async function wipeState() {
    if (!confirm('Svuotare tutti i dati locali di WatchTrail?')) return;
    state.items = [];
    state.episodes = {};
    state.sourceFiles = [];
    state.importReports = [];
    state.importedAt = null;
    await saveState();
    renderAll();
    log('Archivio locale svuotato.');
  }

  function download(name, mime, content) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function parseCsv(text) {
    const clean = stripBom(String(text || ''));
    const delimiter = detectDelimiter(clean);
    const rows = [];
    let row = [];
    let field = '';
    let quote = false;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      const next = clean[i + 1];
      if (ch === '"') {
        if (quote && next === '"') {
          field += '"';
          i++;
        } else {
          quote = !quote;
        }
      } else if (ch === delimiter && !quote) {
        row.push(field);
        field = '';
      } else if ((ch === '\n' || ch === '\r') && !quote) {
        if (ch === '\r' && next === '\n') i++;
        row.push(field);
        if (row.some(v => String(v).trim() !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }

    row.push(field);
    if (row.some(v => String(v).trim() !== '')) rows.push(row);
    if (!rows.length) return [];

    const headers = rows.shift().map((h, i) => String(h || `col_${i}`).trim());
    return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  }

  function detectDelimiter(text) {
    const first = text.split(/\r?\n/).find(Boolean) || '';
    const candidates = [',', ';', '\t', '|'];
    return candidates.map(d => [d, (first.match(new RegExp(`\\${d}`, 'g')) || []).length])
      .sort((a, b) => b[1] - a[1])[0][0] || ',';
  }

  function stripBom(text) {
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  }

  function getField(obj, candidates) {
    if (!obj || typeof obj !== 'object') return '';
    const keys = Object.keys(obj);
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(obj, c)) return obj[c];
      const found = keys.find(k => norm(k) === norm(c) || compact(k) === compact(c));
      if (found) return obj[found];
    }
    return '';
  }

  function getAny(obj, groups) {
    for (const group of groups) {
      const value = getField(obj, group);
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return '';
  }

  function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v > 0;
    return ['1', 'true', 'yes', 'y', 'si', 'sì', 'visto', 'vista', 'watched', 'seen', 'completed', 'done'].includes(norm(v));
  }

  function yearFromDate(v) {
    const m = String(v || '').match(/(19|20)\d{2}/);
    return m ? m[0] : '';
  }

  function numberFrom(v) {
    const n = Number(String(v ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0] || 0);
    return Number.isFinite(n) ? n : 0;
  }

  function titleFromRow(row, fileKind) {
    const seriesTitle = getAny(row, [
      ['series_title', 'series name', 'series', 'show name', 'show', 'tv show', 'tv_show_name', 'program name', 'nome serie', 'serie']
    ]);
    const movieTitle = getAny(row, [
      ['movie_title', 'movie', 'film', 'film title', 'titolo film']
    ]);
    const generic = getAny(row, [
      ['title', 'name', 'original title', 'original_name', 'titolo', 'nome']
    ]);
    if (fileKind === 'movie') return movieTitle || generic || seriesTitle;
    if (fileKind === 'episode') return seriesTitle || getAny(row, [['show title', 'parent title']]) || generic;
    return seriesTitle || movieTitle || generic;
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) {
      log('Nessun file selezionato.');
      return;
    }

    log(`Import avviato: ${files.map(f => f.name).join(', ')}`);
    const before = snapshotCounts();
    let processed = 0;

    for (const file of files) {
      try {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.zip')) {
          const entries = await unzipFile(file);
          log(`${file.name}: ZIP aperto, ${entries.length} file utili trovati.`);
          for (const entry of entries) {
            await importNamedText(entry.name, entry.text);
            processed++;
          }
        } else {
          await importNamedText(file.name, await file.text());
          processed++;
        }
      } catch (err) {
        log(`ERRORE su ${file.name}: ${err?.message || err}`, 'error');
      }
    }

    dedupeAndSort();
    state.importedAt = new Date().toISOString();
    const after = snapshotCounts();
    const report = diffCounts(before, after);
    state.importReports.unshift({ at: state.importedAt, processed, report });
    state.importReports = state.importReports.slice(0, 20);
    await saveState();
    renderAll();
    log(`Import completato. File/entry processati: ${processed}. Nuovi totali: ${report}.`);
  }

  async function unzipFile(file) {
    if (!window.JSZip) {
      throw new Error('JSZip non caricato. Ricarica la pagina o controlla la connessione al CDN.');
    }
    const zip = await JSZip.loadAsync(file);
    const allowed = /\.(json|csv|txt)$/i;
    const entries = Object.values(zip.files)
      .filter(entry => !entry.dir && allowed.test(entry.name) && !entry.name.includes('__MACOSX'));

    if (!entries.length) {
      throw new Error('Nessun file JSON/CSV/TXT trovato nello ZIP.');
    }

    const out = [];
    for (const entry of entries) {
      try {
        const text = await entry.async('string');
        out.push({ name: entry.name, text });
      } catch (err) {
        log(`ERRORE estrazione ${entry.name}: ${err?.message || err}`, 'error');
      }
    }
    return out;
  }

  async function importNamedText(name, text) {
    const lower = name.toLowerCase();
    const safeText = stripBom(text);
    state.sourceFiles.push(name);

    if (lower.endsWith('.json')) {
      const data = JSON.parse(safeText);
      importJson(data, name);
    } else if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
      const rows = parseCsv(safeText);
      importCsv(rows, name);
    } else {
      log(`${name}: formato ignorato.`);
    }
  }

  function inferFileKind(name, rows = []) {
    const lower = norm(name);
    const headers = rows[0] ? Object.keys(rows[0]).map(compact).join(' ') : '';
    if (/episode|episod|puntat|watched[-_ ]?episodes|seen[-_ ]?episodes/.test(lower) || /season|episodenumber|episodetitle|seasonnumber/.test(headers)) return 'episode';
    if (/movie|movies|film/.test(lower) || /imdb|tmdb|movietitle|release/.test(headers)) return 'movie';
    if (/show|shows|series|serie|anime|watchlist|follow/.test(lower)) return 'series';
    return 'mixed';
  }

  function importCsv(rows, name) {
    if (!rows.length) {
      log(`${name}: CSV vuoto o non leggibile.`);
      return;
    }

    const kind = inferFileKind(name, rows);
    let seriesCount = 0;
    let episodeCount = 0;
    let movieCount = 0;

    if (kind === 'episode') {
      const grouped = new Map();
      for (const row of rows) {
        const seriesTitle = titleFromRow(row, 'episode') || 'Senza titolo';
        const sid = seriesIdFromRow(row, seriesTitle);
        const seriesItem = seriesFromRow(row, sid, seriesTitle);
        upsertSeries(seriesItem);
        seriesCount++;
        const ep = episodeFromRow(row, sid, seriesTitle);
        if (ep) {
          if (!grouped.has(sid)) grouped.set(sid, []);
          grouped.get(sid).push(ep);
          episodeCount++;
        }
      }
      grouped.forEach((eps, sid) => state.episodes[sid] = mergeEpisodes(state.episodes[sid] || [], eps));
    } else if (kind === 'movie') {
      for (const row of rows) {
        const item = movieFromRow(row);
        if (item.title && norm(item.title) !== 'senza titolo') {
          upsertMovie(item);
          movieCount++;
        }
      }
    } else {
      for (const row of rows) {
        const maybeSeason = getAny(row, [['season', 'season number', 'season_number', 'stagione']]);
        const maybeEpisode = getAny(row, [['episode', 'episode number', 'episode_number', 'episodio']]);
        const hasEpisodeSignals = maybeSeason !== '' || maybeEpisode !== '';
        const hasMovieSignals = getAny(row, [['imdb id', 'imdb_id', 'tmdb id', 'tmdb_id', 'release date', 'release_date']]) !== '' || /movie|film/.test(norm(getAny(row, [['type', 'kind', 'media type']])));

        if (hasEpisodeSignals) {
          const seriesTitle = titleFromRow(row, 'episode') || 'Senza titolo';
          const sid = seriesIdFromRow(row, seriesTitle);
          upsertSeries(seriesFromRow(row, sid, seriesTitle));
          const ep = episodeFromRow(row, sid, seriesTitle);
          if (ep) {
            state.episodes[sid] = mergeEpisodes(state.episodes[sid] || [], [ep]);
            episodeCount++;
          }
          seriesCount++;
        } else if (hasMovieSignals) {
          upsertMovie(movieFromRow(row));
          movieCount++;
        } else {
          const title = titleFromRow(row, 'series') || 'Senza titolo';
          upsertSeries(seriesFromRow(row, seriesIdFromRow(row, title), title));
          seriesCount++;
        }
      }
    }

    log(`${name}: CSV letto. Righe ${rows.length}; serie ${seriesCount}; episodi ${episodeCount}; film ${movieCount}.`);
  }

  function seriesIdFromRow(row, title) {
    const tvdb = getAny(row, [['tvdb id', 'tvdb_id', 'thetvdb_id', 'series tvdb id']]);
    const tvtime = getAny(row, [['tv time id', 'tvtime_id', 'tvshow id', 'show id', 'series id', 'id']]);
    const imdb = getAny(row, [['imdb id', 'imdb_id']]);
    const stable = tvdb || tvtime || imdb || compact(title);
    return `series_${stable || uid('series')}`;
  }

  function seriesFromRow(row, id, knownTitle = '') {
    const title = knownTitle || titleFromRow(row, 'series') || 'Senza titolo';
    const date = getAny(row, [['first air date', 'first_air_date', 'start date', 'release date', 'date', 'air date']]);
    return {
      id,
      kind: 'series',
      title,
      year: getAny(row, [['year', 'start year', 'first air year']]) || yearFromDate(date),
      status: getAny(row, [['status', 'state', 'watch status']]) || 'unknown',
      favorite: truthy(getAny(row, [['favorite', 'favourite', 'is favorite', 'favorited']])),
      poster: getAny(row, [['poster', 'image', 'poster path', 'cover', 'cover url']]),
      external: {
        tvtime: getAny(row, [['tv time id', 'tvtime_id', 'tvshow id', 'show id']]),
        tvdb: getAny(row, [['tvdb id', 'tvdb_id', 'thetvdb_id']]),
        imdb: getAny(row, [['imdb id', 'imdb_id']]),
        tmdb: getAny(row, [['tmdb id', 'tmdb_id']])
      }
    };
  }

  function episodeFromRow(row, seriesId, seriesTitle) {
    const season = numberFrom(getAny(row, [['season', 'season number', 'season_number', 'stagione']]));
    const number = numberFrom(getAny(row, [['episode', 'episode number', 'episode_number', 'number', 'episodio']]));
    const title = getAny(row, [['episode title', 'episode_title', 'episode name', 'episode_name', 'name', 'title', 'titolo episodio']]);
    if (!season && !number && !title) return null;
    const watchedAt = getAny(row, [['watched at', 'watched_at', 'seen at', 'seen_at', 'viewed at', 'viewed_at', 'date watched', 'watch date', 'date', 'data']]);
    return {
      id: String(getAny(row, [['episode id', 'episode_id', 'id']]) || `${seriesId}_s${season}_e${number}_${compact(title).slice(0, 24)}`),
      seriesId,
      seriesTitle,
      season,
      number,
      title: title || `Episodio ${number || '?'}`,
      watched: truthy(getAny(row, [['watched', 'seen', 'viewed', 'visto']])) || Boolean(watchedAt),
      watchedAt,
      rewatch: numberFrom(getAny(row, [['rewatch', 'rewatches', 'rewatch count', 'rewatch_count']])),
      airdate: getAny(row, [['airdate', 'air date', 'air_date', 'aired at', 'aired_at']])
    };
  }

  function movieFromRow(row) {
    const title = titleFromRow(row, 'movie') || 'Senza titolo';
    const watchedAt = getAny(row, [['watched at', 'watched_at', 'seen at', 'seen_at', 'viewed at', 'date watched', 'watch date', 'date', 'data']]);
    const releaseDate = getAny(row, [['release date', 'release_date', 'released', 'date']]);
    return {
      id: String(getAny(row, [['imdb id', 'imdb_id', 'tmdb id', 'tmdb_id', 'tv time id', 'tvtime_id', 'id']]) || `movie_${compact(title)}_${yearFromDate(releaseDate)}` || uid('movie')),
      kind: 'movie',
      title,
      year: getAny(row, [['year', 'release year', 'release_year']]) || yearFromDate(releaseDate || watchedAt),
      status: truthy(getAny(row, [['watched', 'seen', 'viewed', 'visto']])) || Boolean(watchedAt) ? 'watched' : (getAny(row, [['status', 'state']]) || 'planned'),
      watched: truthy(getAny(row, [['watched', 'seen', 'viewed', 'visto']])) || Boolean(watchedAt),
      watchedAt,
      rewatch: numberFrom(getAny(row, [['rewatch', 'rewatches', 'rewatch count', 'rewatch_count']])),
      favorite: truthy(getAny(row, [['favorite', 'favourite', 'is favorite', 'favorited']])),
      poster: getAny(row, [['poster', 'image', 'poster path', 'cover', 'cover url']]),
      external: {
        imdb: getAny(row, [['imdb id', 'imdb_id']]),
        tmdb: getAny(row, [['tmdb id', 'tmdb_id']]),
        tvtime: getAny(row, [['tv time id', 'tvtime_id']])
      }
    };
  }

  function importJson(data, name) {
    const before = snapshotCounts();
    consumeJson(data, name, []);
    const after = snapshotCounts();
    log(`${name}: JSON letto. ${diffCounts(before, after)}.`);
  }

  function consumeJson(node, name, path) {
    if (!node) return;
    if (Array.isArray(node)) {
      const kind = inferJsonArrayKind(node, name, path);
      for (const item of node) consumeJsonRecord(item, kind, name);
      return;
    }
    if (typeof node !== 'object') return;

    const seriesArrays = ['series', 'shows', 'tv_shows', 'tvShows', 'watchlist', 'watched_shows', 'followed_shows'];
    const movieArrays = ['movies', 'films', 'watched_movies'];
    const episodeArrays = ['episodes', 'watched_episodes', 'watchedEpisodes'];
    let used = false;

    for (const key of seriesArrays) {
      if (Array.isArray(node[key])) {
        node[key].forEach(x => consumeJsonRecord(x, 'series', name));
        used = true;
      }
    }
    for (const key of movieArrays) {
      if (Array.isArray(node[key])) {
        node[key].forEach(x => consumeJsonRecord(x, 'movie', name));
        used = true;
      }
    }
    for (const key of episodeArrays) {
      if (Array.isArray(node[key])) {
        node[key].forEach(x => consumeJsonRecord(x, 'episode', name));
        used = true;
      }
    }

    if (!used && looksLikeMediaRecord(node)) {
      consumeJsonRecord(node, inferJsonRecordKind(node, name), name);
      return;
    }

    if (!used) {
      for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value) || (value && typeof value === 'object')) consumeJson(value, name, path.concat(key));
      }
    }
  }

  function inferJsonArrayKind(arr, name, path) {
    const joined = norm(`${name} ${path.join(' ')}`);
    if (/episode|episod|puntat/.test(joined)) return 'episode';
    if (/movie|film/.test(joined)) return 'movie';
    if (/show|series|serie|anime|watchlist/.test(joined)) return 'series';
    const sample = arr.find(x => x && typeof x === 'object') || {};
    return inferJsonRecordKind(sample, name);
  }

  function inferJsonRecordKind(obj, name) {
    const joinedKeys = Object.keys(obj || {}).map(compact).join(' ');
    const joinedName = norm(name);
    if (/season|episodenumber|episodetitle|episode/.test(joinedKeys) || /episode|episod/.test(joinedName)) return 'episode';
    if (/movie|film|imdb|tmdb|releasedate/.test(joinedKeys) || /movie|film/.test(joinedName)) return 'movie';
    return 'series';
  }

  function looksLikeMediaRecord(obj) {
    return Boolean(getAny(obj, [['title', 'name', 'show name', 'series name', 'movie title']])) ||
      Boolean(getAny(obj, [['season', 'episode', 'season_number', 'episode_number']])) ||
      Array.isArray(obj.episodes) || Array.isArray(obj.seasons);
  }

  function consumeJsonRecord(obj, kind, name) {
    if (!obj || typeof obj !== 'object') return;
    if (kind === 'movie') {
      upsertMovie(movieFromObj(obj));
    } else if (kind === 'episode') {
      const seriesObj = obj.series || obj.show || obj.tv_show || obj.tvShow || {};
      const seriesTitle = getAny(obj, [['series_title', 'series name', 'show name', 'show', 'series']]) || getAny(seriesObj, [['title', 'name']]) || titleFromRow(obj, 'episode') || 'Senza titolo';
      const sid = `series_${getAny(seriesObj, [['tvdb_id', 'id', 'tvtime_id']]) || getAny(obj, [['series_id', 'show_id', 'tvdb_id']]) || compact(seriesTitle)}`;
      upsertSeries(seriesFromObj(seriesObj.title || seriesObj.name ? seriesObj : { ...obj, title: seriesTitle, name: seriesTitle }, sid));
      const ep = episodeFromObj(obj, sid, seriesTitle);
      if (ep) state.episodes[sid] = mergeEpisodes(state.episodes[sid] || [], [ep]);
    } else {
      const series = seriesFromObj(obj);
      upsertSeries(series);
      const eps = extractEpisodesFromObj(obj, series.id, series.title);
      if (eps.length) state.episodes[series.id] = mergeEpisodes(state.episodes[series.id] || [], eps);
    }
  }

  function seriesFromObj(obj, forcedId = '') {
    const title = getAny(obj, [['name', 'title', 'series_name', 'show_name', 'original_name', 'original title']]) || 'Senza titolo';
    const date = getAny(obj, [['first_air_date', 'first air date', 'aired_at', 'date', 'release_date']]);
    const id = forcedId || String(getAny(obj, [['id', 'uuid', 'tvtime_id', 'tvdb_id', 'thetvdb_id', 'tmdb_id']]) || `series_${compact(title)}` || uid('series'));
    return {
      id: id.startsWith('series_') ? id : `series_${id}`,
      kind: 'series',
      title,
      year: getAny(obj, [['year', 'start_year', 'first_air_year']]) || yearFromDate(date),
      status: getAny(obj, [['status', 'state', 'watch_status']]) || 'unknown',
      favorite: truthy(getAny(obj, [['favorite', 'is_favorite', 'favorited']])),
      poster: getAny(obj, [['poster', 'image', 'poster_path', 'cover', 'cover_url']]),
      external: {
        tvtime: getAny(obj, [['tvtime_id', 'tv time id', 'id']]),
        tvdb: getAny(obj, [['tvdb_id', 'thetvdb_id']]),
        imdb: getAny(obj, [['imdb_id']]),
        tmdb: getAny(obj, [['tmdb_id']])
      }
    };
  }

  function movieFromObj(obj) {
    const title = getAny(obj, [['title', 'name', 'movie_title', 'original_title']]) || 'Senza titolo';
    const watchedAt = getAny(obj, [['watched_at', 'seen_at', 'viewed_at', 'date']]);
    const releaseDate = getAny(obj, [['release_date', 'released', 'date']]);
    return {
      id: String(getAny(obj, [['id', 'uuid', 'imdb_id', 'tmdb_id', 'tvtime_id']]) || `movie_${compact(title)}_${yearFromDate(releaseDate)}` || uid('movie')),
      kind: 'movie',
      title,
      year: getAny(obj, [['year', 'release_year']]) || yearFromDate(releaseDate || watchedAt),
      status: getAny(obj, [['status']]) || (truthy(getAny(obj, [['watched', 'is_watched', 'seen', 'viewed']])) || Boolean(watchedAt) ? 'watched' : 'planned'),
      favorite: truthy(getAny(obj, [['favorite', 'is_favorite', 'favorited']])),
      watched: truthy(getAny(obj, [['watched', 'is_watched', 'seen', 'viewed']])) || Boolean(watchedAt),
      watchedAt,
      rewatch: numberFrom(getAny(obj, [['rewatch_count', 'rewatches', 'rewatch']])),
      poster: getAny(obj, [['poster', 'image', 'poster_path', 'cover', 'cover_url']]),
      external: {
        imdb: getAny(obj, [['imdb_id']]),
        tmdb: getAny(obj, [['tmdb_id']]),
        tvtime: getAny(obj, [['tvtime_id', 'id']])
      }
    };
  }

  function episodeFromObj(obj, seriesId, seriesTitle) {
    const season = numberFrom(getAny(obj, [['season_number', 'seasonNumber', 'season', 'stagione']]));
    const number = numberFrom(getAny(obj, [['episode_number', 'episodeNumber', 'number', 'episode', 'episodio']]));
    const title = getAny(obj, [['name', 'title', 'episode_title', 'episode name']]);
    if (!season && !number && !title) return null;
    const watchedAt = getAny(obj, [['watched_at', 'seen_at', 'viewed_at', 'date']]);
    return {
      id: String(getAny(obj, [['id', 'uuid', 'episode_id']]) || `${seriesId}_s${season}_e${number}_${compact(title).slice(0, 24)}`),
      seriesId,
      seriesTitle,
      season,
      number,
      title: title || `Episodio ${number || '?'}`,
      watched: truthy(getAny(obj, [['watched', 'is_watched', 'seen', 'viewed']])) || Boolean(watchedAt),
      watchedAt,
      rewatch: numberFrom(getAny(obj, [['rewatch_count', 'rewatches', 'rewatch']])),
      airdate: getAny(obj, [['airdate', 'air_date', 'aired_at']])
    };
  }

  function extractEpisodesFromObj(obj, seriesId, seriesTitle) {
    const flat = [];
    const direct = obj.episodes || obj.watched_episodes || obj.watchedEpisodes || [];
    if (Array.isArray(direct)) direct.forEach(ep => {
      const normalized = episodeFromObj(ep, seriesId, seriesTitle);
      if (normalized) flat.push(normalized);
    });

    const seasons = obj.seasons || [];
    if (Array.isArray(seasons)) {
      seasons.forEach(season => {
        const sn = numberFrom(getAny(season, [['number', 'season_number', 'season']]));
        const eps = season.episodes || [];
        if (Array.isArray(eps)) eps.forEach(ep => {
          const normalized = episodeFromObj({ ...ep, season_number: getAny(ep, [['season_number']]) || sn }, seriesId, seriesTitle);
          if (normalized) flat.push(normalized);
        });
      });
    }
    return flat;
  }

  function upsertSeries(item) { upsertItem(item); }
  function upsertMovie(item) { upsertItem(item); }

  function upsertItem(item) {
    if (!item || !item.title || norm(item.title) === 'senza titolo') return;
    item.id = String(item.id || uid(item.kind));
    item.search = norm(`${item.title} ${item.year || ''}`);
    item.external = item.external || {};

    const existing = state.items.findIndex(i => {
      if (i.kind !== item.kind) return false;
      const extA = Object.values(i.external || {}).filter(Boolean).map(String);
      const extB = Object.values(item.external || {}).filter(Boolean).map(String);
      if (extA.length && extB.some(v => extA.includes(v))) return true;
      return norm(i.title) === norm(item.title) && (!item.year || !i.year || String(i.year) === String(item.year));
    });

    if (existing >= 0) {
      const old = state.items[existing];
      state.items[existing] = {
        ...old,
        ...item,
        title: old.title || item.title,
        year: old.year || item.year,
        poster: item.poster || old.poster,
        external: { ...(old.external || {}), ...(item.external || {}) }
      };
      if (old.id !== item.id && state.episodes[item.id] && !state.episodes[old.id]) {
        state.episodes[old.id] = state.episodes[item.id].map(ep => ({ ...ep, seriesId: old.id }));
        delete state.episodes[item.id];
      }
    } else {
      state.items.push(item);
    }
  }

  function episodeKey(ep) {
    return `${numberFrom(ep.season)}-${numberFrom(ep.number)}`;
  }

  function makeEpisode(series, season, number, options = {}) {
    return {
      id: `${series.id}_s${numberFrom(season)}_e${numberFrom(number)}`,
      seriesId: series.id,
      seriesTitle: series.title,
      season: numberFrom(season),
      number: numberFrom(number),
      title: options.title || `Episodio ${numberFrom(number)}`,
      watched: Boolean(options.watched),
      watchedAt: options.watchedAt || (options.watched ? new Date().toISOString().slice(0, 10) : ''),
      rewatch: options.rewatch || 0,
      airdate: options.airdate || ''
    };
  }

  function mergeEpisodes(oldEps, newEps) {
    const map = new Map();
    [...oldEps, ...newEps].filter(Boolean).forEach(ep => {
      const normalized = {
        ...ep,
        season: numberFrom(ep.season),
        number: numberFrom(ep.number)
      };
      const key = episodeKey(normalized);
      const previous = map.get(key) || {};
      map.set(key, {
        ...previous,
        ...normalized,
        id: previous.id || normalized.id,
        title: previous.title || normalized.title || `Episodio ${numberFrom(normalized.number)}`,
        watched: Boolean(previous.watched || normalized.watched),
        watchedAt: previous.watchedAt || normalized.watchedAt || ''
      });
    });
    return Array.from(map.values()).sort((a, b) => (numberFrom(a.season) - numberFrom(b.season)) || (numberFrom(a.number) - numberFrom(b.number)) || String(a.title).localeCompare(String(b.title)));
  }

  function addEpisodeRangeToSeries(seriesId, season, from, to, watched = false) {
    const series = state.items.find(i => i.id === seriesId && i.kind === 'series');
    if (!series) return { added: 0, skipped: 0, total: 0 };

    season = numberFrom(season);
    from = numberFrom(from);
    to = numberFrom(to);

    if ((!season && season !== 0) || !from || !to || to < from) {
      throw new Error('Intervallo episodi non valido. Controlla stagione, episodio iniziale e finale.');
    }

    const existing = new Set((state.episodes[series.id] || []).map(episodeKey));
    const created = [];
    let skipped = 0;

    for (let n = from; n <= to; n++) {
      const candidate = makeEpisode(series, season, n, { watched });
      if (existing.has(episodeKey(candidate))) {
        skipped++;
        continue;
      }
      created.push(candidate);
    }

    state.episodes[series.id] = mergeEpisodes(state.episodes[series.id] || [], created);
    return { added: created.length, skipped, total: to - from + 1 };
  }

  function markEpisodeRange(seriesId, season, from, to, watched = true) {
    const eps = state.episodes[seriesId] || [];
    season = numberFrom(season);
    from = numberFrom(from);
    to = numberFrom(to);
    let changed = 0;
    eps.forEach(ep => {
      const epSeason = numberFrom(ep.season);
      const epNumber = numberFrom(ep.number);
      if (epSeason === season && epNumber >= from && epNumber <= to) {
        if (ep.watched !== watched) changed++;
        ep.watched = watched;
        ep.watchedAt = watched ? (ep.watchedAt || new Date().toISOString().slice(0, 10)) : '';
      }
    });
    return changed;
  }

  function dedupeAndSort() {
    const oldItems = [...state.items];
    state.items = [];
    oldItems.forEach(upsertItem);
    state.items.sort((a, b) => String(a.title).localeCompare(String(b.title), 'it'));
  }

  function snapshotCounts() {
    return {
      series: state.items.filter(i => i.kind === 'series').length,
      movies: state.items.filter(i => i.kind === 'movie').length,
      episodes: Object.values(state.episodes).flat().length,
      watchedEpisodes: Object.values(state.episodes).flat().filter(e => e.watched).length
    };
  }

  function diffCounts(before, after) {
    return `serie ${after.series} (${signed(after.series - before.series)}), film ${after.movies} (${signed(after.movies - before.movies)}), episodi ${after.episodes} (${signed(after.episodes - before.episodes)}), episodi visti ${after.watchedEpisodes} (${signed(after.watchedEpisodes - before.watchedEpisodes)})`;
  }

  function signed(n) { return n >= 0 ? `+${n}` : String(n); }

  function renderAll() {
    renderStats();
    renderContinue();
    renderLibrary();
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
    const raw = item.poster || '';
    const src = raw && String(raw).startsWith('/') ? TMDB_IMG + raw : raw;
    if (src) return `<div class="poster"><img src="${esc(src)}" alt=""></div>`;
    return `<div class="poster">${esc((item.title || '?').slice(0, 1).toUpperCase())}</div>`;
  }

  function itemHtml(item) {
    const eps = state.episodes[item.id] || [];
    const seen = item.kind === 'movie' ? (item.watched ? 1 : 0) : eps.filter(e => e.watched).length;
    const total = item.kind === 'movie' ? 1 : eps.length;
    const next = item.kind === 'series' ? nextEpisode(item.id) : null;
    const nextLabel = item.kind === 'series' && next ? `Prossimo S${next.season}E${next.number}` : '';

    return `<article class="card open-detail-card" data-id="${esc(item.id)}" tabindex="0" role="button" aria-label="Apri e modifica ${esc(item.title)}">
      ${posterHtml(item)}
      <div class="card-body">
        <h3 class="card-title">${esc(item.title)}</h3>
        <div class="meta">
          <span class="pill">${item.kind === 'movie' ? 'Film' : 'Serie/anime'}</span>
          ${item.year ? `<span class="pill">${esc(item.year)}</span>` : ''}
          <span class="pill">${seen}/${total || '?'}</span>
          ${item.favorite ? '<span class="pill">★ preferito</span>' : ''}
          ${nextLabel ? `<span class="pill">${esc(nextLabel)}</span>` : ''}
        </div>
        <div class="card-actions">
          <button class="primary small open-detail" data-id="${esc(item.id)}">Apri / modifica</button>
        </div>
      </div>
    </article>`;
  }

  function renderContinue() {
    const items = state.items
      .filter(i => i.kind === 'series' && nextEpisode(i.id))
      .sort((a, b) => String(a.title).localeCompare(String(b.title), 'it'))
      .slice(0, 40);
    $('continueList').innerHTML = items.length
      ? items.map(itemHtml).join('')
      : '<div class="empty">Importa TV Time o aggiungi una serie per vedere i prossimi episodi.</div>';
  }

  function renderLibrary() {
    const q = norm($('librarySearch')?.value || '');
    const type = $('typeFilter')?.value || 'all';
    let items = [...state.items];
    if (type !== 'all') items = items.filter(i => i.kind === type);
    if (q) items = items.filter(i => (i.search || norm(i.title)).includes(q));
    $('libraryList').innerHTML = items.length
      ? items.map(itemHtml).join('')
      : '<div class="empty">Nessun risultato.</div>';
  }

  function nextEpisode(seriesId) {
    return (state.episodes[seriesId] || []).find(e => !e.watched) || null;
  }


  function episodeButtonHtml(ep) {
    const label = `S${numberFrom(ep.season)}E${numberFrom(ep.number)}`;
    const title = ep.title && !/^Episodio\s+\d+$/i.test(ep.title) ? ep.title : '';
    const date = ep.watchedAt ? `Visto: ${ep.watchedAt}` : 'Non visto';
    return `<div class="episode-card ${ep.watched ? 'is-watched' : ''}">
      <button class="episode-tile ${ep.watched ? 'is-watched' : ''}" data-ep="${esc(ep.id)}" title="${esc(label + (title ? ' · ' + title : ''))}">
        <span class="ep-code">${esc(label)}</span>
        ${title ? `<span class="ep-title">${esc(title)}</span>` : ''}
        <span class="ep-state">${ep.watched ? '✓ Visto' : date}</span>
      </button>
      <div class="ep-tools">
        <button class="ghost tiny edit-ep" data-ep="${esc(ep.id)}" title="Modifica episodio">✎</button>
        <button class="danger tiny delete-ep" data-ep="${esc(ep.id)}" title="Elimina episodio">×</button>
      </div>
    </div>`;
  }

  function seasonsForSeries(seriesId) {
    const eps = state.episodes[seriesId] || [];
    const grouped = new Map();
    eps.forEach(e => {
      const season = numberFrom(e.season);
      if (!grouped.has(season)) grouped.set(season, []);
      grouped.get(season).push(e);
    });
    return Array.from(grouped.entries())
      .sort((a, b) => numberFrom(a[0]) - numberFrom(b[0]))
      .map(([season, arr]) => [season, arr.sort((a, b) => numberFrom(a.number) - numberFrom(b.number))]);
  }

  function selectedSeasonFromDialog(fallback = 1) {
    return numberFrom($('seasonPicker')?.value || fallback || 1);
  }

  async function saveItemEdits(item) {
    const oldTitle = item.title;
    const newTitle = $('editItemTitle')?.value.trim() || item.title;
    const newYear = $('editItemYear')?.value.trim() || '';
    item.title = newTitle;
    item.year = newYear;
    item.favorite = Boolean($('editItemFavorite')?.checked);
    item.search = norm(`${item.title} ${item.year || ''}`);
    if (item.kind === 'series') {
      (state.episodes[item.id] || []).forEach(ep => {
        ep.seriesTitle = item.title;
      });
    }
    await saveState();
    renderAll();
    openDetail(item.id, selectedSeasonFromDialog(1));
    log(`Scheda aggiornata: ${oldTitle} → ${item.title}.`);
  }

  async function deleteItem(item) {
    const label = item.kind === 'movie' ? 'film' : 'serie';
    if (!confirm(`Eliminare definitivamente ${label} "${item.title}" dal database locale?`)) return;
    state.items = state.items.filter(i => i.id !== item.id);
    if (item.kind === 'series') delete state.episodes[item.id];
    await saveState();
    renderAll();
    $('detailDialog')?.close();
    log(`Eliminato: ${item.title}.`);
  }

  async function editEpisode(seriesId, episodeId) {
    const eps = state.episodes[seriesId] || [];
    const ep = eps.find(e => e.id === episodeId);
    if (!ep) return;

    const season = prompt('Stagione', String(numberFrom(ep.season)));
    if (season === null) return;
    const number = prompt('Episodio', String(numberFrom(ep.number)));
    if (number === null) return;
    const title = prompt('Titolo episodio', ep.title || '');
    if (title === null) return;
    const watchedAt = prompt('Data visto, opzionale YYYY-MM-DD', ep.watchedAt || '');
    if (watchedAt === null) return;

    const newSeason = numberFrom(season);
    const newNumber = numberFrom(number);
    if ((!newSeason && newSeason !== 0) || !newNumber) {
      log('Stagione o episodio non validi.', 'error');
      return;
    }

    const duplicate = eps.find(e => e.id !== ep.id && numberFrom(e.season) === newSeason && numberFrom(e.number) === newNumber);
    if (duplicate && !confirm(`Esiste già S${newSeason}E${newNumber}. Vuoi comunque sovrascrivere questo episodio?`)) return;

    ep.season = newSeason;
    ep.number = newNumber;
    ep.title = title.trim() || `Episodio ${newNumber}`;
    ep.watchedAt = watchedAt.trim();
    ep.watched = Boolean(ep.watchedAt) || ep.watched;
    ep.id = `${seriesId}_s${newSeason}_e${newNumber}`;

    state.episodes[seriesId] = mergeEpisodes(eps, []);
    await saveState();
    renderAll();
    openDetail(seriesId, newSeason);
    log(`Episodio modificato: S${newSeason}E${newNumber}.`);
  }

  async function deleteEpisode(seriesId, episodeId) {
    const eps = state.episodes[seriesId] || [];
    const ep = eps.find(e => e.id === episodeId);
    if (!ep) return;
    if (!confirm(`Eliminare S${ep.season}E${ep.number} dal database locale?`)) return;
    state.episodes[seriesId] = eps.filter(e => e.id !== episodeId);
    await saveState();
    renderAll();
    openDetail(seriesId, numberFrom(ep.season));
    log(`Episodio eliminato: S${ep.season}E${ep.number}.`);
  }

  function openDetail(id, preferredSeason = null) {
    const item = state.items.find(i => i.id === id);
    if (!item) return;
    const content = $('detailContent');

    if (item.kind === 'movie') {
      content.innerHTML = `
        <div class="detail-head">
          <div>
            <h2>${esc(item.title)}</h2>
            <p>${esc(item.year || '')} ${item.watched ? '· visto' : '· non visto'}</p>
          </div>
          <button class="danger" id="deleteItemBtn">Elimina</button>
        </div>

        <section class="edit-box">
          <h3>Modifica scheda</h3>
          <div class="edit-grid">
            <label>Titolo
              <input id="editItemTitle" value="${esc(item.title)}">
            </label>
            <label>Anno
              <input id="editItemYear" value="${esc(item.year || '')}" inputmode="numeric">
            </label>
            <label class="checkline">
              <input id="editItemFavorite" type="checkbox" ${item.favorite ? 'checked' : ''}> preferito
            </label>
            <button class="primary" id="saveItemBtn">Salva modifiche</button>
          </div>
        </section>

        <section class="edit-box">
          <h3>Stato film</h3>
          <div class="edit-grid compact-edit-grid">
            <label>Data visto
              <input id="movieWatchedAt" type="date" value="${esc((item.watchedAt || '').slice(0, 10))}">
            </label>
            <button class="primary" id="toggleMovieSeen">${item.watched ? 'Segna non visto' : 'Segna visto'}</button>
            <button class="ghost" id="saveMovieDateBtn">Salva data</button>
          </div>
        </section>
      `;

      $('saveItemBtn').onclick = () => saveItemEdits(item);
      $('deleteItemBtn').onclick = () => deleteItem(item);
      $('toggleMovieSeen').onclick = async () => {
        item.watched = !item.watched;
        item.status = item.watched ? 'watched' : 'planned';
        item.watchedAt = item.watched ? (item.watchedAt || new Date().toISOString().slice(0, 10)) : '';
        await saveState();
        renderAll();
        openDetail(id);
      };
      $('saveMovieDateBtn').onclick = async () => {
        item.watchedAt = $('movieWatchedAt').value || '';
        item.watched = Boolean(item.watchedAt);
        item.status = item.watched ? 'watched' : 'planned';
        await saveState();
        renderAll();
        openDetail(id);
        log(`${item.title}: data visione aggiornata.`);
      };
    } else {
      const eps = state.episodes[item.id] || [];
      const seenCount = eps.filter(e => e.watched).length;
      const next = nextEpisode(item.id);
      const last = eps.length ? eps[eps.length - 1] : null;
      const suggestedSeason = preferredSeason || next?.season || last?.season || 1;
      const suggestedFrom = next?.number || (last ? numberFrom(last.number) + 1 : 1);
      const suggestedTo = suggestedFrom;
      const seasons = seasonsForSeries(item.id);
      const activeSeason = numberFrom(preferredSeason || suggestedSeason || seasons[0]?.[0] || 1);
      const activeSeasonEpisodes = (state.episodes[item.id] || [])
        .filter(e => numberFrom(e.season) === activeSeason)
        .sort((a, b) => numberFrom(a.number) - numberFrom(b.number));
      const seasonOptions = seasons.length
        ? seasons.map(([season]) => `<option value="${esc(season)}" ${numberFrom(season) === activeSeason ? 'selected' : ''}>Stagione ${esc(season)}</option>`).join('')
        : `<option value="${esc(activeSeason)}">Stagione ${esc(activeSeason)}</option>`;

      content.innerHTML = `
        <div class="detail-head">
          <div>
            <h2>${esc(item.title)}</h2>
            <p>${seenCount}/${eps.length} episodi visti${next ? ` · prossimo: S${esc(next.season)}E${esc(next.number)}` : ''}</p>
          </div>
          <div class="detail-actions">
            ${next ? `<button class="primary" id="markNextBtn">Segna prossimo visto</button>` : ''}
            <button class="danger" id="deleteItemBtn">Elimina serie</button>
          </div>
        </div>

        <section class="edit-box">
          <h3>Correggi scheda serie</h3>
          <div class="edit-grid">
            <label>Titolo
              <input id="editItemTitle" value="${esc(item.title)}">
            </label>
            <label>Anno
              <input id="editItemYear" value="${esc(item.year || '')}" inputmode="numeric">
            </label>
            <label class="checkline">
              <input id="editItemFavorite" type="checkbox" ${item.favorite ? 'checked' : ''}> preferita
            </label>
            <button class="primary" id="saveItemBtn">Salva modifiche</button>
          </div>
        </section>

        <section class="episode-board-box">
          <div class="episode-board-head">
            <div>
              <h3>Episodi</h3>
              <p class="hint">Clicca l'episodio per visto/non visto. Usa ✎ per correggere stagione, numero o titolo. Usa × per rimuovere un episodio importato male.</p>
            </div>
            <select id="seasonPicker" aria-label="Scegli stagione">${seasonOptions}</select>
          </div>
          ${activeSeasonEpisodes.length
            ? `<div class="episode-grid">${activeSeasonEpisodes.map(episodeButtonHtml).join('')}</div>`
            : '<div class="empty">Nessun episodio salvato per questa stagione. Aggiungili dal box sotto.</div>'}
        </section>

        <section class="continue-series-box">
          <h3>Aggiungi episodi mancanti</h3>
          <p class="hint">Crea nuovi episodi nel database locale della serie. Quelli già presenti non vengono duplicati e quelli già visti restano visti.</p>
          <div class="episode-range-grid">
            <label>Stagione
              <input id="rangeSeason" type="number" min="0" value="${esc(activeSeason || suggestedSeason)}">
            </label>
            <label>Da episodio
              <input id="rangeFrom" type="number" min="1" value="${esc(suggestedFrom)}">
            </label>
            <label>A episodio
              <input id="rangeTo" type="number" min="1" value="${esc(suggestedTo)}">
            </label>
            <label class="checkline">
              <input id="rangeWatched" type="checkbox"> già visti
            </label>
            <button class="primary" id="addRangeBtn">+ Aggiungi</button>
            <button class="ghost" id="markRangeBtn">Segna intervallo visto</button>
          </div>
        </section>

        ${seasons.length ? `<section class="season-summary"><h3>Tutte le stagioni</h3>${seasons.map(([season, arr]) => {
          const watched = arr.filter(e => e.watched).length;
          return `<button class="season-chip ${numberFrom(season) === activeSeason ? 'active' : ''}" data-season="${esc(season)}">S${esc(season)} · ${watched}/${arr.length}</button>`;
        }).join('')}</section>` : ''}
      `;

      $('saveItemBtn').onclick = () => saveItemEdits(item);
      $('deleteItemBtn').onclick = () => deleteItem(item);

      const seasonPicker = $('seasonPicker');
      if (seasonPicker) seasonPicker.onchange = () => openDetail(id, numberFrom(seasonPicker.value));

      content.querySelectorAll('.season-chip').forEach(btn => btn.addEventListener('click', () => {
        openDetail(id, numberFrom(btn.dataset.season));
      }));

      const markNextBtn = $('markNextBtn');
      if (markNextBtn) markNextBtn.onclick = async () => {
        const ep = nextEpisode(item.id);
        if (!ep) return;
        ep.watched = true;
        ep.watchedAt = ep.watchedAt || new Date().toISOString().slice(0, 10);
        await saveState();
        renderAll();
        openDetail(id, numberFrom(ep.season));
        log(`${item.title}: segnato visto S${ep.season}E${ep.number}.`);
      };

      content.querySelectorAll('.episode-tile').forEach(btn => btn.addEventListener('click', async () => {
        const ep = (state.episodes[item.id] || []).find(x => x.id === btn.dataset.ep);
        if (!ep) return;
        ep.watched = !ep.watched;
        ep.watchedAt = ep.watched ? (ep.watchedAt || new Date().toISOString().slice(0, 10)) : '';
        await saveState();
        renderAll();
        openDetail(id, numberFrom(ep.season));
        log(`${item.title}: S${ep.season}E${ep.number} ${ep.watched ? 'visto' : 'non visto'}.`);
      }));

      content.querySelectorAll('.edit-ep').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        editEpisode(item.id, btn.dataset.ep);
      }));

      content.querySelectorAll('.delete-ep').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        deleteEpisode(item.id, btn.dataset.ep);
      }));

      const readRange = () => ({
        season: numberFrom($('rangeSeason').value),
        from: numberFrom($('rangeFrom').value),
        to: numberFrom($('rangeTo').value),
        watched: $('rangeWatched').checked
      });

      $('addRangeBtn').onclick = async () => {
        try {
          const r = readRange();
          const result = addEpisodeRangeToSeries(item.id, r.season, r.from, r.to, r.watched);
          await saveState();
          renderAll();
          openDetail(id, r.season);
          log(`${item.title}: aggiunti ${result.added}/${result.total} episodi S${r.season}E${r.from}-E${r.to}. Duplicati ignorati: ${result.skipped}.`);
        } catch (err) {
          log(err.message || String(err), 'error');
        }
      };

      $('markRangeBtn').onclick = async () => {
        try {
          const r = readRange();
          if (!r.from || !r.to || r.to < r.from) throw new Error('Intervallo episodi non valido.');
          const result = addEpisodeRangeToSeries(item.id, r.season, r.from, r.to, false);
          const changed = markEpisodeRange(item.id, r.season, r.from, r.to, true);
          await saveState();
          renderAll();
          openDetail(id, r.season);
          log(`${item.title}: intervallo S${r.season}E${r.from}-E${r.to} segnato visto. Creati mancanti: ${result.added}, aggiornati: ${changed}.`);
        } catch (err) {
          log(err.message || String(err), 'error');
        }
      };
    }
    if (!$('detailDialog').open) $('detailDialog').showModal();
  }

  function exportJson() {
    const payload = {
      app: 'WatchTrail',
      exportedAt: new Date().toISOString(),
      items: state.items,
      episodes: state.episodes,
      sourceFiles: state.sourceFiles,
      importReports: state.importReports
    };
    download(`watchtrail-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json', JSON.stringify(payload, null, 2));
  }

  function exportMoviesCsv() {
    const movies = state.items.filter(i => i.kind === 'movie');
    const header = ['Title', 'Year', 'Watched', 'Watched At', 'IMDb ID', 'TMDB ID'];
    const rows = movies.map(m => [m.title, m.year || '', m.watched ? 'yes' : 'no', m.watchedAt || '', m.external?.imdb || '', m.external?.tmdb || '']);
    const csv = [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
    download(`watchtrail-film-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8', csv);
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function addManual() {
    const title = $('manualTitle').value.trim();
    if (!title) return;
    const kind = $('manualKind').value;
    const year = $('manualYear').value.trim();
    const item = { id: `${kind}_${compact(title)}_${year || ''}` || uid(kind), kind, title, year, status: kind === 'movie' ? 'planned' : 'unknown', external: {} };
    kind === 'movie' ? upsertMovie(item) : upsertSeries(item);
    saveState().then(() => {
      $('manualTitle').value = '';
      $('manualYear').value = '';
      renderAll();
      log(`Aggiunto manualmente: ${title}`);
    });
  }

  function wireEvents() {
    $('fileInput').addEventListener('change', e => importFiles(e.target.files));
    $('exportJsonBtn').addEventListener('click', exportJson);
    $('downloadJsonBtn').addEventListener('click', exportJson);
    $('downloadMoviesCsvBtn').addEventListener('click', exportMoviesCsv);
    $('wipeBtn').addEventListener('click', wipeState);
    $('clearLogBtn').addEventListener('click', () => $('logBox').textContent = 'Log pulito.');
    $('refreshBtn').addEventListener('click', renderAll);
    $('manualAddBtn').addEventListener('click', addManual);
    $('librarySearch').addEventListener('input', renderLibrary);
    $('typeFilter').addEventListener('change', renderLibrary);
    $('closeDetail').addEventListener('click', () => $('detailDialog').close());

    document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-page').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    }));

    document.body.addEventListener('click', e => {
      const target = e.target.closest('.open-detail, .open-detail-card');
      if (!target) return;
      const id = target.dataset.id || target.closest('[data-id]')?.dataset.id;
      if (id) openDetail(id);
    });

    document.body.addEventListener('keydown', e => {
      const card = e.target.closest?.('.open-detail-card');
      if (!card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDetail(card.dataset.id);
      }
    });

    const dropZone = $('dropZone');
    ['dragenter', 'dragover'].forEach(eventName => {
      document.addEventListener(eventName, e => {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.add('dragging-file');
        dropZone.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(eventName => {
      document.addEventListener(eventName, e => {
        e.preventDefault();
        e.stopPropagation();
        document.body.classList.remove('dragging-file');
        dropZone.classList.remove('dragging');
      });
    });
    document.addEventListener('drop', e => {
      const files = e.dataTransfer?.files;
      if (!files || !files.length) {
        log('Drop rilevato, ma nessun file trovato.');
        return;
      }
      log(`File trascinati: ${Array.from(files).map(f => f.name).join(', ')}`);
      importFiles(files);
    });
  }

  function registerPwa() {
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredPrompt = e;
      $('installBtn').hidden = false;
    });
    $('installBtn').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      $('installBtn').hidden = true;
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(err => log(`Service worker non registrato: ${err.message || err}`));
    }
  }

  async function init() {
    wireEvents();
    registerPwa();
    await loadState();
    renderAll();
    log('WatchTrail pronto. Import supportato: ZIP, CSV, JSON.');
  }

  init().catch(err => log(`Errore avvio: ${err?.message || err}`, 'error'));
})();
