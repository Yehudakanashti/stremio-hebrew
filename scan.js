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
};
const TYPES = ['movie', 'series'];
const TOP_PAGES = 24;
const YEAR_PAGES = 6;
const CONCURRENCY = 6;
const RECHECK_HAS_MS = 7 * 24 * 3600e3;
const RECHECK_RECENT_MS = 3 * 3600e3;
const RECHECK_OLD_MS = 12 * 3600e3;
const MAX_CHECKS = Number(process.env.MAX_CHECKS || 4000);
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
  try { const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); return { items: d.items || {}, lastScanEnd: d.lastScanEnd || null }; }
  catch { return { items: {}, lastScanEnd: null }; }
}

async function getJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchCandidates(type) {
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

async function checkHebrew(type, id) {
  const names = Object.keys(HEB_SOURCES);
  const results = await Promise.all(names.map(n => checkSource(HEB_SOURCES[n], type, id)));
  const sources = names.filter((n, i) => results[i] === true);
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
    description: m.description, releaseInfo: m.year ? String(m.year) : undefined,
    imdbRating: m.imdbRating, genres: m.genres,
  };
}

const GENRES = require('./genres.js');

function sortCatalog(list, catId) {
  const byPop = (a, b) => (a.popRank ?? 99999) - (b.popRank ?? 99999);
  if (catId === 'heb-new') return list.filter(isRecent).sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')));
  if (catId === 'heb-popular') return list.slice().sort(byPop);
  const g = GENRES.find(x => `heb-genre-${x.key}` === catId);
  const tags = new Set((g ? g.tags : []).map(t => t.toLowerCase()));
  return list.filter(m => (m.genres || []).some(x => tags.has(String(x).toLowerCase()))).sort(byPop);
}

const CATALOG_IDS = ['heb-new', 'heb-popular', ...GENRES.map(g => `heb-genre-${g.key}`)];

function writeDocs(cache) {
  const items = Object.values(cache.items).filter(m => m.hasHebrew && m.name);
  const compact = items.map(m => ({
    id: m.id, type: m.type, name: m.name, poster: m.poster, description: m.description, year: m.year,
    released: m.released, imdbRating: m.imdbRating, genres: m.genres, popRank: m.popRank, sources: m.sources,
  }));
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), items: compact }));
  const counts = {};
  for (const type of TYPES) {
    const dir = path.join(DOCS, 'catalog', type);
    fs.mkdirSync(dir, { recursive: true });
    for (const catId of CATALOG_IDS) {
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
  for (const type of TYPES) {
    const candidates = await fetchCandidates(type);
    log(`${type} candidates: ${candidates.length}`);
    for (const c of candidates) {
      const key = `${type}:${c.id}`;
      const prev = cache.items[key] || {};
      cache.items[key] = {
        ...prev, type, id: c.id, name: c.name, poster: c.poster, description: c.description,
        year: c.year, released: c.released, imdbRating: c.imdbRating, genres: c.genre || c.genres || [],
        popRank: c._tags.has('top') ? c._popRank : (prev.popRank ?? 99999), seenAt: now,
      };
      if (needsCheck(cache.items[key], now)) queue.push(key);
    }
  }
  queue.sort((a, b) => (isRecent(cache.items[b]) ? 1 : 0) - (isRecent(cache.items[a]) ? 1 : 0));
  if (queue.length > MAX_CHECKS) queue.length = MAX_CHECKS;
  log(`to check: ${queue.length}`);
  let done = 0, found = 0;
  const toNotify = [];
  const worker = async () => {
    while (queue.length) {
      const key = queue.shift();
      const e = cache.items[key];
      const r = await checkHebrew(e.type, e.id);
      if (r.hasHebrew && !e.hasHebrew) {
        found++;
        log(`NEW: ${e.type} ${e.name} (${e.id}) via ${r.sources.join(',')}`);
        if (isTheatricalRecent(e) && !e.notifiedAt) { e.notifiedAt = Date.now(); toNotify.push(e); }
      }
      e.hasHebrew = r.hasHebrew; e.sources = r.sources; e.allFailed = r.allFailed; e.checkedAt = Date.now();
      done++;
      if (done % 100 === 0) log(`checked ${done}`);
      await new Promise(res => setTimeout(res, 100));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  cache.lastScanEnd = Date.now();
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  writeDocs(cache);
  await notify(toNotify);
  log(`done: checked ${done}, newly found ${found}, notified ${toNotify.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
