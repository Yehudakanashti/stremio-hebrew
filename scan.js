// Scans popular + recent movies/series and records which ones have Hebrew subtitles (Ktuvit / Wizdom).
// Writes data/cache.json (full state) and docs/ (static site: index.json, summary.json, catalog files).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CACHE_FILE = path.join(ROOT, 'data', 'cache.json');
const DOCS = path.join(ROOT, 'docs');

const CINEMETA = 'https://v3-cinemeta.strem.io';
const HEB_SOURCES = {
  ktuvit: 'https://4b139a4b7f94-ktuvit-stremio.baby-beamup.club',
  wizdom: 'https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club',
  // Stremio's own OpenSubtitles addon (installed on the owner's TV): the official Hebrew subtitles of Amazon/Netflix
  // releases are ripped there (Last Meal 2026 had them only there). Counted only for titles whose Israeli streaming
  // offer lists Hebrew subtitles (JustWatch), so machine translations uploaded there do not mark a title as Hebrew.
  opensubtitles: 'https://opensubtitles-v3.strem.io',
};
const TMDB_HE = 'https://tmdb.elfhosted.com/%7B%22language%22%3A%22he-IL%22%7D';
const KTUVIT_BROWSE = 'https://www.ktuvit.me/BrowseFilms.aspx?ResultsPerPage=100&Page=';
const JUSTWATCH = 'https://apis.justwatch.com/graphql';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130';
const TYPES = ['movie', 'series'];
const TOP_PAGES = 60;      // Cinemeta's whole Popular catalog (~3,000 titles), not just its first 1,200
const RATING_PAGES = 60;   // Cinemeta's Featured catalog
const YEAR_PAGES = 20;
const KTUVIT_PAGES = 40;   // the 4,000 films whose subtitles were added or updated last on ktuvit.me (its addon is dead, this list is the only Ktuvit signal)
const GENRE_PAGES = 20;    // Cinemeta's per-genre Popular lists (Discover > genre), 1,000 titles per genre; they run ~12,000 deep
const TMDB_PAGES = 25;     // the TMDB addon's Popular / Trending / Latest rows (what his Stremio home shows in Hebrew), 500 titles each
const CINEMETA_GENRES = {
  movie: ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'],
  series: ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western', 'Reality-TV', 'Talk-Show', 'Game-Show'],
};
const TMDB_CATALOGS = ['tmdb.top', 'tmdb.trending', 'tmdb.latest'];
const JW_PAGES = 22;       // every title of the last two years on Israeli streaming services (~2,200 films, ~930 series)
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 70) * 60e3;  // the Actions job is killed at 90 min
const CONCURRENCY = 6;
const RECHECK_HAS_MS = 7 * 24 * 3600e3;
const RECHECK_RECENT_MS = 3 * 3600e3;
const RECHECK_OLD_MS = 12 * 3600e3;
const MAX_CHECKS = Number(process.env.MAX_CHECKS || 20000);  // ~7 checks/s with the dead Ktuvit addon skipped; the time budget is the real limit
const PAGE = 100;
const STATIC_PAGES = 5;

const log = m => console.log(`${new Date().toISOString()} ${m}`);

// Push notifications for cinema releases that just got Hebrew subtitles.
const THEATRICAL_WINDOW_DAYS = 150;
const SITE_URL = 'https://yehudakanashti.github.io/stremio-hebrew/';

function isTheatricalRecent(e) {
  if (e.type !== 'movie' || !e.released) return false;
  const days = (Date.now() - Date.parse(e.released)) / 864e5;
  return days >= 0 && days <= THEATRICAL_WINDOW_DAYS;
}

async function notify(items) {
  if (!items.length) return;
  const lines = items.map(m => `• ${m.name} (${m.year || ''})${m.imdbRating ? ` · IMDb ${m.imdbRating}` : ''}`);
  const title = items.length === 1 ? 'סרט קולנוע קיבל כתוביות בעברית' : `${items.length} סרטי קולנוע קיבלו כתוביות בעברית`;
  const message = lines.join('\n') + '\n\nזמין עכשיו ב-Stremio בשורה "סרטים חדשים עם עברית".';
  const topic = process.env.NTFY_TOPIC;
  if (topic) {
    try {
      const r = await fetch('https://ntfy.sh/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, title, message, click: SITE_URL, tags: ['clapper'], priority: 4 }),
      });
      log(`ntfy: ${r.status}`);
    } catch (e) { log('ntfy failed ' + e.message); }
  }
  const tg = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tg && chat) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: `${title}\n${message}` }),
      });
      log(`telegram: ${r.status}`);
    } catch (e) { log('telegram failed ' + e.message); }
  }
  if (!topic && !(tg && chat)) log('notify: no channel configured, skipped');
}

function loadCache() {
  try { const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); return { items: d.items || {}, lastScanEnd: d.lastScanEnd || null, kmap: d.kmap || {} }; }
  catch { return { items: {}, lastScanEnd: null, kmap: {} }; }
}

async function getJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function getText(url, timeoutMs = 30000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

async function pool(items, n, fn) {
  const q = items.slice();
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); }));
}

const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const norm = s => String(s || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^0-9a-z\u05d0-\u05ea]+/g, ' ').trim();
const sameName = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && x.replace(/ /g, '') === y.replace(/ /g, ''); };
const yearOf = m => Number((String((m && (m.year || m.releaseInfo || m.released)) || '').match(/(19|20)\d\d/) || [0])[0]);

// ktuvit.me lists its films newest-first, 100 per page, with Hebrew + English names, year, file count and an IMDb id.
// The id is cut to 7 digits there (tt50016818 is shown as tt5001681), so it is verified, or found again by name + year.
function parseKtuvit(html) {
  const films = [];
  for (const chunk of html.split('MovieInfo.aspx?ID=').slice(1)) {
    const h = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(chunk);
    const y = /\u05e9\u05e0\u05ea \u05d9\u05e6\u05d9\u05d0\u05d4: (\d{4})/.exec(chunk);
    const tt = /data-title="(tt\d+)"/.exec(chunk);
    const files = /\u05e7\u05d1\u05e6\u05d9\u05dd: (\d+)/.exec(chunk);
    if (!h || !tt) continue;
    const title = decode(h[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(title);
    films.push({ tt7: tt[1], he: m ? m[1].trim() : title, names: m ? m[2].split('/').map(x => x.trim()).filter(Boolean) : [],
      year: y ? Number(y[1]) : 0, files: files ? Number(files[1]) : 1 });
  }
  return films;
}

async function resolveKtuvit(f, kmap) {
  const key = `${f.tt7}|${f.year}|${f.names[0] || f.he}`;
  const prev = kmap[key];
  if (prev && (prev.id || Date.now() - prev.at < 7 * 864e5)) return prev.id;
  const fits = m => !!m && /^tt\d+$/.test(m.id || '') && (!f.year || !yearOf(m) || Math.abs(yearOf(m) - f.year) <= 1)
    && [...f.names, f.he].flatMap(n => [n, n.replace(/\s+(19|20)\d\d$/, '')]).some(n => sameName(n, m.name));  // "Moana 2026"
  let id = null;
  try { const d = await getJson(`${CINEMETA}/meta/movie/${f.tt7}.json`); if (fits(d && d.meta)) id = f.tt7; } catch { /* unknown id */ }
  for (const n of f.names) {
    if (id) break;
    try { const hit = ((await getJson(`${CINEMETA}/catalog/movie/top/search=${encodeURIComponent(n)}.json`)).metas || []).find(fits); if (hit) id = hit.id; }
    catch { /* search down */ }
  }
  for (const n of f.names) {  // TMDB knows films Cinemeta's search does not; its answers carry imdb_id and Hebrew names
    if (id) break;
    try {
      const hit = ((await getJson(`${TMDB_HE}/catalog/movie/tmdb.search/search=${encodeURIComponent(n)}.json`)).metas || [])
        .map(m => ({ ...m, id: m.imdb_id || m.id })).find(fits);
      if (hit) id = hit.id;
    } catch { /* search down */ }
  }
  kmap[key] = { id, at: Date.now() };
  return id;
}

// JustWatch: the titles of the last two years on Netflix / Prime Video (its code is prv, not amp) / Disney+ / Apple TV+ / iTunes in Israel,
// with the subtitle languages each service offers (an 'he' there = an official Hebrew translation exists)
const JW_QUERY = 'query ($country: Country!, $filter: TitleFilter, $first: Int!, $language: Language!, $offset: Int) { popularTitles(country: $country, filter: $filter, first: $first, sortBy: POPULAR, sortRandomSeed: 0, offset: $offset) { pageInfo { hasNextPage } edges { node { content(country: $country, language: $language) { title originalReleaseYear externalIds { imdbId } } offers(country: $country, platform: WEB) { subtitleLanguages package { technicalName } } } } } }';
async function justwatch(type) {
  const y = new Date().getFullYear();
  const out = new Map();
  for (let offset = 0; offset < JW_PAGES * 100; offset += 100) {
    const body = { query: JW_QUERY, variables: { country: 'IL', language: 'he', first: 100, offset, filter: {
      objectTypes: [type === 'movie' ? 'MOVIE' : 'SHOW'], packages: ['nfx', 'prv', 'dnp', 'atp', 'itu'], releaseYear: { min: y - 1, max: y } } } };
    const r = await fetch(JUSTWATCH, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const pt = ((await r.json()).data || {}).popularTitles;
    if (!pt) throw new Error('no data');
    for (const e of pt.edges) {
      const n = e.node, c = n.content || {}, id = c.externalIds && c.externalIds.imdbId;
      if (!id || !/^tt\d+$/.test(id)) continue;
      const he = (n.offers || []).some(o => (o.subtitleLanguages || []).includes('he'));
      out.set(id, { id, jwHe: he || !!(out.get(id) || {}).jwHe });
    }
    if (!pt.pageInfo.hasNextPage) break;
  }
  return [...out.values()];
}

// catalog meta for a title Cinemeta's lists did not give us; Cinemeta lacks the dates of new releases (Last Meal 2026
// had no year at all), TMDB he-IL has them
async function fetchMeta(type, id) {
  let c = {};
  try { c = (await getJson(`${CINEMETA}/meta/${type}/${id}.json`)).meta || {}; } catch { /* unknown to Cinemeta */ }
  if (!c.name || !c.released || !c.year) {
    try {
      const t = (await getJson(`${TMDB_HE}/meta/${type}/${id}.json`)).meta || {};
      c = { name: c.name || t.name, poster: c.poster || t.poster, description: c.description || t.description,
        year: c.year || t.year || t.releaseInfo, released: c.released || t.released, imdbRating: c.imdbRating || t.imdbRating,
        genres: (c.genres && c.genres.length ? c.genres : null) || c.genre || t.genres || t.genre };
    } catch { /* nothing more to ask */ }
  }
  if (!c.name) return null;
  return { id, name: c.name, poster: c.poster, description: c.description, year: String(c.year || '').slice(0, 4),
    released: c.released, imdbRating: c.imdbRating, genres: c.genres || c.genre || [] };
}

// titles beyond Cinemeta's lists: Map id -> { tags, ktuvitFiles, jwHe }
async function extraWanted(type, cache) {
  const wanted = new Map();
  const want = id => { if (!wanted.has(id)) wanted.set(id, { tags: new Set(), ktuvitFiles: 0, jwHe: false }); return wanted.get(id); };
  if (type === 'movie') {
    const films = [];
    for (let p = 1; p <= KTUVIT_PAGES; p++) {
      try { films.push(...parseKtuvit(await getText(KTUVIT_BROWSE + p, 40000))); }
      catch (e) { log(`ktuvit browse page ${p}: ${e.message}`); break; }
    }
    let mapped = 0;
    await pool(films, 6, async f => {
      const id = await resolveKtuvit(f, cache.kmap);
      if (!id) return;
      mapped++;
      const w = want(id); w.tags.add('ktuvit'); w.ktuvitFiles = Math.max(w.ktuvitFiles, f.files);
    });
    log(`ktuvit browse: ${films.length} films listed, ${mapped} mapped to IMDb`);
  }
  try {
    const jw = await justwatch(type);
    for (const t of jw) { const w = want(t.id); w.tags.add('jw'); w.jwHe = w.jwHe || t.jwHe; }
    log(`justwatch ${type}: ${jw.length} titles, ${jw.filter(t => t.jwHe).length} with Hebrew subtitles on the service`);
  } catch (e) { log(`justwatch ${type}: ${e.message}`); }
  // the TMDB addon's rows (ids are tmdb:NNN; its meta carries the IMDb id, remembered in cache.tmap)
  cache.tmap = cache.tmap || {};
  const tmdbIds = new Set();
  for (const cat of TMDB_CATALOGS) {
    for (let p = 0; p < TMDB_PAGES; p++) {
      try {
        const d = await getJson(`${TMDB_HE}/catalog/${type}/${cat}/skip=${p * 20}.json`);
        if (!d.metas || !d.metas.length) break;
        for (const m of d.metas) if (m.id) tmdbIds.add(m.id);
      } catch (e) { log(`tmdb ${type} ${cat} ${p}: ${e.message}`); break; }
    }
  }
  // 2 at a time with a pause: 6 parallel lookups made the addon refuse most of them (a refusal is not cached, a real answer is)
  let tmdbMapped = 0, tmdbFetched = 0, tmdbErrors = 0, firstErr = '';
  await pool([...tmdbIds], 2, async id => {
    let tt = /^tt\d+$/.test(id) ? id : null;
    if (!tt) {
      const known = cache.tmap[id];
      if (known && (known.id || Date.now() - known.at < 30 * 86400e3)) tt = known.id;
      else {
        tmdbFetched++;
        let meta = null;
        for (let a = 0; a < 2 && !meta; a++) {
          try { meta = (await getJson(`${TMDB_HE}/meta/${type}/${id}.json`)).meta || {}; }
          catch (e) { if (!firstErr) firstErr = e.message; await new Promise(r => setTimeout(r, 1500)); }
        }
        if (!meta) { tmdbErrors++; return; }
        tt = /^tt\d+$/.test(meta.imdb_id || '') ? meta.imdb_id : null;
        cache.tmap[id] = { id: tt, at: Date.now() };
        await new Promise(r => setTimeout(r, 150));
      }
    }
    if (!tt) return;
    tmdbMapped++;
    want(tt).tags.add('tmdb');
  });
  log(`tmdb rows ${type}: ${tmdbIds.size} titles, ${tmdbMapped} with an IMDb id (${tmdbFetched} looked up now, ${tmdbErrors} refused${firstErr ? ': ' + firstErr : ''})`);
  return wanted;
}

async function fetchCandidates(type, cache) {
  const out = new Map();
  const add = (metas, tag) => {
    for (const m of metas) {
      const id = m.imdb_id || m.id;
      if (!id || !/^tt\d+$/.test(id)) continue;
      if (!out.has(id)) out.set(id, { ...m, id, _popRank: out.size, _tags: new Set() });
      out.get(id)._tags.add(tag);
    }
  };
  for (let p = 0; p < TOP_PAGES; p++) {
    try {
      const d = await getJson(`${CINEMETA}/catalog/${type}/top/skip=${p * 50}.json`);
      if (!d.metas || !d.metas.length) break;
      add(d.metas, 'top');
    } catch (e) { log(`cinemeta ${type} top ${p}: ${e.message}`); }
  }
  const y = new Date().getFullYear();
  for (const year of [y, y - 1]) {
    for (let p = 0; p < YEAR_PAGES; p++) {
      try {
        const d = await getJson(`${CINEMETA}/catalog/${type}/year/genre=${year}&skip=${p * 50}.json`);
        if (!d.metas || !d.metas.length) break;
        add(d.metas, 'year');
      } catch (e) { log(`cinemeta ${type} year ${year} ${p}: ${e.message}`); }
    }
  }
  for (let p = 0; p < RATING_PAGES; p++) {
    try {
      const d = await getJson(`${CINEMETA}/catalog/${type}/imdbRating/skip=${p * 50}.json`);
      if (!d.metas || !d.metas.length) break;
      add(d.metas, 'featured');
    } catch (e) { log(`cinemeta ${type} featured ${p}: ${e.message}`); }
  }
  // Discover > genre: each genre's own Popular list runs far deeper than the global one
  const beforeGenres = out.size;
  await pool(CINEMETA_GENRES[type] || [], 4, async genre => {
    for (let p = 0; p < GENRE_PAGES; p++) {
      try {
        const d = await getJson(`${CINEMETA}/catalog/${type}/top/genre=${encodeURIComponent(genre)}&skip=${p * 50}.json`);
        if (!d.metas || !d.metas.length) break;
        add(d.metas, 'genre');
      } catch (e) { log(`cinemeta ${type} ${genre} ${p}: ${e.message}`); break; }
    }
  });
  log(`${type}: genre lists added ${out.size - beforeGenres} titles beyond Popular/Featured/New`);
  // beyond Cinemeta's lists: ktuvit.me's newest subtitles, the Israeli streaming catalogs and the TMDB addon's rows
  const extra = await extraWanted(type, cache);
  const flags = w => ({ ktuvitFiles: w.ktuvitFiles, jwHe: w.jwHe });
  const fresh = [];
  for (const [id, w] of extra) {
    if (out.has(id)) { for (const t of w.tags) out.get(id)._tags.add(t); Object.assign(out.get(id), flags(w)); } else fresh.push(id);
  }
  let fetched = 0, unknown = 0;
  await pool(fresh, 6, async id => {
    const c = cache.items[`${type}:${id}`];
    let m = c && c.name ? { id, name: c.name, poster: c.poster, description: c.description, year: c.year, released: c.released, imdbRating: c.imdbRating, genres: c.genres } : null;
    if (!m) { m = await fetchMeta(type, id); fetched++; }
    if (!m) { unknown++; return; }
    out.set(id, { ...m, ...flags(extra.get(id)), _popRank: 99999, _tags: extra.get(id).tags });
  });
  log(`${type}: ${extra.size} titles from ktuvit/justwatch/tmdb, ${fresh.length} beyond Cinemeta's lists, metas fetched ${fetched}, unknown ${unknown}`);
  return [...out.values()];
}

const hasHebSubs = d => (Array.isArray(d && d.subtitles) ? d.subtitles : []).some(s => /^(heb|he|hebrew)$/i.test(String(s.lang || '')));

async function checkSource(base, type, id) {
  try {
    if (type === 'movie') return hasHebSubs(await getJson(`${base}/subtitles/movie/${id}.json`, 15000));
    for (const ep of ['1:1', '1:2']) if (hasHebSubs(await getJson(`${base}/subtitles/series/${id}:${ep}.json`, 15000))) return true;
    return false;
  } catch { return null; }
}

const SRC_STATS = {};
// a source that fails 20 titles in a row is skipped for the rest of the run: the dead Ktuvit addon (504 since 1.11.26)
// held every check for its 15 s timeout, so a 70-minute run checked only ~2,000 titles
const SRC_DOWN = {}, SRC_FAILS = {};
async function checkHebrew(e) {
  // OpenSubtitles is asked only when an Israeli streaming service offers Hebrew subtitles for the title (see HEB_SOURCES)
  const names = Object.keys(HEB_SOURCES).filter(n => !SRC_DOWN[n] && (n !== 'opensubtitles' || e.jwHe));
  const results = await Promise.all(names.map(n => checkSource(HEB_SOURCES[n], e.type, e.id)));
  names.forEach((n, i) => {
    const s = SRC_STATS[n] = SRC_STATS[n] || { ok: 0, fail: 0, hebrew: 0 };
    if (results[i] !== null) { s.ok++; SRC_FAILS[n] = 0; if (results[i]) s.hebrew++; return; }
    s.fail++;
    SRC_FAILS[n] = (SRC_FAILS[n] || 0) + 1;  // (++ on an unset key gives NaN and never trips)
    if (SRC_FAILS[n] >= 20 && !SRC_DOWN[n]) { SRC_DOWN[n] = true; log(`${n} failed 20 titles in a row, skipped for the rest of this run`); }
  });
  const sources = names.filter((n, i) => results[i] === true);
  // a film on ktuvit.me's own list has subtitles there even while the Ktuvit addon is down (it answered 504 from 1.11.26)
  if (e.ktuvitFiles > 0 && !sources.includes('ktuvit')) sources.push('ktuvit');
  return { hasHebrew: sources.length > 0, sources, allFailed: results.every(r => r === null) };
}

const isRecent = e => Number(e.year) >= new Date().getFullYear() - 1;

function needsCheck(e, now) {
  if (!e.checkedAt) return true;
  const age = now - e.checkedAt;
  if (e.allFailed) return age > 3600e3;
  if (e.hasHebrew) return age > RECHECK_HAS_MS;
  return age > (isRecent(e) ? RECHECK_RECENT_MS : RECHECK_OLD_MS);
}

function toMeta(m) {
  return {
    id: m.id, type: m.type, name: m.name, poster: m.poster, posterShape: 'poster',
    description: m.description ? String(m.description).slice(0, 400) : m.description,  // index.json is parsed by the Worker whole; keep it lean
    releaseInfo: m.year ? String(m.year) : undefined,
    imdbRating: m.imdbRating, genres: m.genres,
  };
}

const GENRES = require('./genres.js');

function sortCatalog(list, catId) {
  const byPop = (a, b) => (a.popRank ?? 99999) - (b.popRank ?? 99999);
  const byReleased = (a, b) => String(b.released || '').localeCompare(String(a.released || ''));
  if (catId === 'heb-cinema-new') {
    const cutoff = Date.now() - 180 * 864e5;
    return list.filter(m => m.type === 'movie' && m.released && Date.parse(m.released) >= cutoff)
      .sort((a, b) => ((b.hebrewSince || 0) - (a.hebrewSince || 0)) || byReleased(a, b));
  }
  if (catId === 'heb-new') return list.filter(isRecent).sort(byReleased);
  if (catId === 'heb-popular') return list.slice().sort(byPop);
  const g = GENRES.find(x => `heb-genre-${x.key}` === catId);
  const tags = new Set((g ? g.tags : []).map(t => t.toLowerCase()));
  return list.filter(m => (m.genres || []).some(x => tags.has(String(x).toLowerCase()))).sort(byPop);
}

const CATALOG_IDS = ['heb-cinema-new', 'heb-new', 'heb-popular', ...GENRES.map(g => `heb-genre-${g.key}`)];

function writeDocs(cache) {
  // titles that already had Hebrew before tracking started: order them by release date
  for (const m of Object.values(cache.items)) if (m.hasHebrew && !m.hebrewSince) m.hebrewSince = Date.parse(m.released || '') || 0;
  const items = Object.values(cache.items).filter(m => m.hasHebrew && m.name);
  const compact = items.map(m => ({
    id: m.id, type: m.type, name: m.name, poster: m.poster, description: m.description, year: m.year,
    released: m.released, imdbRating: m.imdbRating, genres: m.genres, popRank: m.popRank, sources: m.sources,
    hebrewSince: m.hebrewSince,
  }));
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), items: compact }));
  const counts = {};
  for (const type of TYPES) {
    const dir = path.join(DOCS, 'catalog', type);
    fs.mkdirSync(dir, { recursive: true });
    for (const catId of CATALOG_IDS) {
      if (catId === 'heb-cinema-new' && type !== 'movie') continue;
      const sorted = sortCatalog(items.filter(m => m.type === type), catId);
      counts[`${type}/${catId}`] = sorted.length;
      const pages = catId.startsWith('heb-genre-') ? 1 : STATIC_PAGES;
      for (let p = 0; p < pages; p++) {
        const metas = sorted.slice(p * PAGE, (p + 1) * PAGE).map(toMeta);
        const file = p === 0 ? `${catId}.json` : `${catId}/skip=${p * PAGE}.json`;
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), JSON.stringify({ metas }));
      }
    }
  }
  fs.writeFileSync(path.join(DOCS, 'summary.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), counts,
    totals: { movie: items.filter(m => m.type === 'movie').length, series: items.filter(m => m.type === 'series').length },
    checked: Object.keys(cache.items).length,
  }));
  fs.writeFileSync(path.join(DOCS, 'manifest.json'), JSON.stringify(require('./manifest.js')({ dynamic: false })));
  log(`docs written: movie ${counts['movie/heb-popular']}, series ${counts['series/heb-popular']}`);
}

async function main() {
  const cache = loadCache();
  log(`cache: ${Object.keys(cache.items).length} items`);
  if (process.argv.includes('--docs-only')) { writeDocs(cache); return; }
  if (process.argv.includes('--notify-test')) {
    await notify([{ name: 'בדיקה: Mutiny', year: '2026', imdbRating: '5.8' }]);
    return;
  }
  const now = Date.now();
  const queue = [];
  let listed = 0;
  for (const type of TYPES) {
    const candidates = await fetchCandidates(type, cache);
    log(`${type} candidates: ${candidates.length}`);
    for (const c of candidates) {
      const key = `${type}:${c.id}`;
      const prev = cache.items[key] || {};
      cache.items[key] = {
        ...prev, type, id: c.id, name: c.name, poster: c.poster, description: c.description,
        year: c.year || prev.year, released: c.released || prev.released, imdbRating: c.imdbRating || prev.imdbRating,
        genres: (c.genre || c.genres || []).length ? (c.genre || c.genres) : (prev.genres || []),
        popRank: c._tags.has('top') ? c._popRank : (prev.popRank ?? 99999), seenAt: now,
        ktuvitFiles: Math.max(c.ktuvitFiles || 0, prev.ktuvitFiles || 0), jwHe: !!(c.jwHe || prev.jwHe),
      };
      const it = cache.items[key];
      if (it.ktuvitFiles > 0 && !it.hasHebrew) {  // listed on ktuvit.me = subtitles exist; no need to wait for its turn in the queue
        it.hasHebrew = true; it.sources = ['ktuvit']; it.hebrewSince = now; listed++;
        log(`NEW: ${type} ${it.name} (${it.id}) via ktuvit's list`);
      }
      if (needsCheck(it, now)) queue.push(key);
    }
  }
  queue.sort((a, b) => (isRecent(cache.items[b]) ? 1 : 0) - (isRecent(cache.items[a]) ? 1 : 0));
  if (queue.length > MAX_CHECKS) queue.length = MAX_CHECKS;
  log(`to check: ${queue.length}, new from ktuvit's list: ${listed}`);
  let done = 0, found = 0;
  const toNotify = [];
  const started = Date.now();
  const save = () => { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); };
  const worker = async () => {
    while (queue.length) {
      if (Date.now() - started > TIME_BUDGET_MS) { log(`time budget reached, ${queue.length} left for the next run`); queue.length = 0; break; }
      const key = queue.shift();
      const e = cache.items[key];
      const r = await checkHebrew(e);
      if (r.allFailed) {
        e.allFailed = true;  // no source answered: what we knew about the title stays (an outage must not empty the rows)
      } else {
        if (r.hasHebrew && !e.hasHebrew) {
          found++;
          e.hebrewSince = Date.now();
          log(`NEW: ${e.type} ${e.name} (${e.id}) via ${r.sources.join(',')}`);
          if (isTheatricalRecent(e) && !e.notifiedAt) { e.notifiedAt = Date.now(); toNotify.push(e); }
        }
        e.hasHebrew = r.hasHebrew; e.sources = r.sources; e.allFailed = false;
      }
      e.checkedAt = Date.now();
      done++;
      if (done % 100 === 0) { log(`checked ${done}`); save(); }
      await new Promise(res => setTimeout(res, 400));  // 6 workers, ~6-8 requests/s to the subtitle addons, not more
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  cache.lastScanEnd = Date.now();
  save();
  writeDocs(cache);
  await notify(toNotify);
  log('sources: ' + Object.entries(SRC_STATS).map(([n, s]) => `${n} answered ${s.ok} failed ${s.fail} hebrew ${s.hebrew}`).join(' | '));
  log(`done: checked ${done}, newly found ${found}, notified ${toNotify.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
