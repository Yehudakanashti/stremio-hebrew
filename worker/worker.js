// Cloudflare Worker: serves the Stremio addon "עם עברית" (manifest + themed catalogs, search, paging)
// from the index published by GitHub Pages. Free tier, always on.
const INDEX_URL = 'https://yehudakanashti.github.io/stremio-hebrew/index.json';
const SITE_URL = 'https://yehudakanashti.github.io/stremio-hebrew/';
const HE_URL = 'https://yehudakanashti.github.io/stremio-hebrew/he.json';
const SUBS_URL = 'https://yehudakanashti.github.io/stremio-hebrew/subs/index.json';
const YT_URL = 'https://yehudakanashti.github.io/stremio-hebrew/yt.json';
const DUB_URL = 'https://yehudakanashti.github.io/stremio-hebrew/dub.json';
const CINEMETA = 'https://v3-cinemeta.strem.io';
// Public TMDB addon with the Hebrew (he-IL) config: TMDB's own Hebrew text, no key needed.
const TMDB_HE = 'https://tmdb.elfhosted.com/%7B%22language%22%3A%22he-IL%22%7D';
const HEBREW = /[֐-׿]/;
const PAGE = 100;
const INDEX_TTL_MS = 5 * 60 * 1000;
const EXTRA = [{ name: 'search' }, { name: 'skip' }];

const rate = m => parseFloat(m.imdbRating) || 0;
const pop = m => m.popRank ?? 99999;
const year = m => Number(m.year) || 0;
const NOW_YEAR = () => new Date().getFullYear();
const byPop = (a, b) => pop(a) - pop(b);
const byRating = (a, b) => rate(b) - rate(a) || pop(a) - pop(b);
const byReleased = (a, b) => String(b.released || '').localeCompare(String(a.released || ''));
const tags = (...t) => m => (m.genres || []).some(g => t.includes(String(g).toLowerCase()));
const isRecent = m => year(m) >= NOW_YEAR() - 1;

// Netflix-style rows. `shape: 'landscape'` uses wide background art, `numbered` adds a rank to the title.
const SERIES = [
  { id: 'heb-s-new', name: '🔥 סדרות חדשות בעברית', shape: 'landscape', pick: l => l.filter(isRecent).sort(byReleased) },
  { id: 'heb-s-top10', name: '🔟 טופ 10 סדרות בעברית', numbered: true, pick: l => l.slice().sort(byPop).slice(0, 10) },
  { id: 'heb-s-best', name: '🏆 הסדרות המדורגות ביותר', pick: l => l.filter(m => rate(m) >= 8.3).sort(byRating) },
  { id: 'heb-s-thriller', name: '🧠 מתח שלא נותן לנשום', pick: l => l.filter(tags('thriller', 'mystery')).filter(m => rate(m) >= 7).sort(byPop) },
  { id: 'heb-s-crime', name: '🔪 פשע ובלשים', pick: l => l.filter(tags('crime')).sort(byPop) },
  { id: 'heb-s-drama', name: '🎭 דרמה שנכנסת ללב', pick: l => l.filter(tags('drama')).filter(m => rate(m) >= 7.5).sort(byPop) },
  { id: 'heb-s-comedy', name: '😂 קומדיה לפרק אחד נוסף', pick: l => l.filter(tags('comedy')).sort(byPop) },
  { id: 'heb-s-scifi', name: '🚀 מדע בדיוני ופנטזיה', pick: l => l.filter(tags('sci-fi', 'science fiction', 'fantasy')).sort(byPop) },
  { id: 'heb-s-action', name: '💥 אקשן והרפתקאות', pick: l => l.filter(tags('action', 'adventure')).sort(byPop) },
  { id: 'heb-s-family', name: '👨‍👩‍👧 אנימציה ומשפחה', pick: l => l.filter(tags('animation', 'family')).sort(byPop) },
  { id: 'heb-s-gems', name: '💎 פנינים נסתרות', pick: l => l.filter(m => rate(m) >= 7.8 && pop(m) > 150).sort(byRating) },
  { id: 'heb-s-horror', name: '👻 אימה', pick: l => l.filter(tags('horror')).sort(byPop) },
];

const MOVIES = [
  // Hebrew-DUBBED films (audio proven by dubscan.js, not subtitles). Items come from docs/dub.json, not the subs index.
  { id: 'heb-m-dubbed', name: '🗣️ דיבוב עברית מלא', dub: true, pick: (l, ctx) => Object.values((ctx && ctx.dub) || {}).sort((a, b) => byReleased(a, b) || byPop(a, b)) },
  { id: 'heb-cinema-new', name: '🎞️ קולנוע: חדש בעברית', shape: 'landscape', pick: l => { const cut = Date.now() - 180 * 864e5; return l.filter(m => m.released && Date.parse(m.released) >= cut).sort((a, b) => ((b.hebrewSince || 0) - (a.hebrewSince || 0)) || byReleased(a, b)); } },
  { id: 'heb-m-new', name: '🔥 סרטים חדשים בעברית', pick: l => l.filter(isRecent).sort(byReleased) },
  { id: 'heb-m-top10', name: '🔟 טופ 10 סרטים בעברית', numbered: true, pick: l => l.slice().sort(byPop).slice(0, 10) },
  { id: 'heb-m-best', name: '🏆 הסרטים המדורגים ביותר', pick: l => l.filter(m => rate(m) >= 8).sort(byRating) },
  { id: 'heb-m-action', name: '💥 אקשן שמרים דופק', pick: l => l.filter(tags('action', 'adventure')).sort(byPop) },
  { id: 'heb-m-comedy', name: '😂 קומדיות להעלות חיוך', pick: l => l.filter(tags('comedy')).sort(byPop) },
  { id: 'heb-m-thriller', name: '🧠 מתח ומסתורין', pick: l => l.filter(tags('thriller', 'mystery')).sort(byPop) },
  { id: 'heb-m-crime', name: '🔪 פשע', pick: l => l.filter(tags('crime')).sort(byPop) },
  { id: 'heb-m-scifi', name: '🚀 מדע בדיוני ופנטזיה', pick: l => l.filter(tags('sci-fi', 'science fiction', 'fantasy')).sort(byPop) },
  { id: 'heb-m-family', name: '👨‍👩‍👧 לכל המשפחה', pick: l => l.filter(tags('animation', 'family')).sort(byPop) },
  { id: 'heb-m-romance', name: '❤️ רומנטי', pick: l => l.filter(tags('romance')).sort(byPop) },
  { id: 'heb-m-horror', name: '👻 אימה', pick: l => l.filter(tags('horror')).sort(byPop) },
  { id: 'heb-m-classics', name: '🕰️ קלאסיקות', pick: l => l.filter(m => year(m) && year(m) <= 1999 && rate(m) >= 7.5).sort(byRating) },
  { id: 'heb-m-gems', name: '💎 פנינים נסתרות', pick: l => l.filter(m => rate(m) >= 7.8 && pop(m) > 150).sort(byRating) },
];

const ROWS = { series: SERIES, movie: MOVIES };

// Ids from the earlier manifest versions keep working for already-installed copies.
const LEGACY_GENRES = {
  'heb-genre-drama': ['drama'], 'heb-genre-comedy': ['comedy'], 'heb-genre-thriller': ['thriller', 'mystery'],
  'heb-genre-action': ['action', 'adventure'], 'heb-genre-crime': ['crime'], 'heb-genre-scifi': ['sci-fi', 'science fiction', 'fantasy'],
  'heb-genre-horror': ['horror'], 'heb-genre-romance': ['romance'], 'heb-genre-family': ['animation', 'family'], 'heb-genre-documentary': ['documentary'],
};
function legacyPick(catId, list) {
  if (catId === 'heb-new') return list.filter(isRecent).sort(byReleased);
  if (catId === 'heb-popular') return list.slice().sort(byPop);
  if (LEGACY_GENRES[catId]) return list.filter(tags(...LEGACY_GENRES[catId])).sort(byPop);
  return null;
}

const MANIFEST = {
  id: 'org.kanashti.hebrew-catalog',
  version: '3.3.0',
  name: 'עם עברית',
  description: 'סרטים וסדרות עם כתוביות בעברית בלבד, בעיצוב של נטפליקס: שורת סרטים בדיבוב עברית מלא (לא כתוביות), כרטיסים רחבים, טופ 10, פנינים נסתרות וקלאסיקות, עם שם, תקציר וטריילר מתורגם. מתעדכן אוטומטית כל 3 שעות.',
  logo: 'https://i0.wp.com/kodibeginner.com/wp-content/uploads/2020/10/ktuvit-me.jpg?w=300&ssl=1',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  // Home order: dubbed row first (his nephews), cinema row, then the series rows, then the rest of the movie rows.
  catalogs: [
    ...MOVIES.slice(0, 2).map(r => ({ type: 'movie', id: r.id, name: r.name, extra: EXTRA })),
    ...SERIES.map(r => ({ type: 'series', id: r.id, name: r.name, extra: EXTRA })),
    ...MOVIES.slice(2).map(r => ({ type: 'movie', id: r.id, name: r.name, extra: EXTRA })),
  ],
  behaviorHints: { configurable: false, configurationRequired: false },
};

let indexCache = { at: 0, items: [], generatedAt: null };

async function loadIndex() {
  if (Date.now() - indexCache.at < INDEX_TTL_MS && indexCache.items.length) return indexCache;
  const r = await fetch(INDEX_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) {
    if (indexCache.items.length) return indexCache;
    throw new Error('index fetch failed ' + r.status);
  }
  const d = await r.json();
  indexCache = { at: Date.now(), items: d.items || [], generatedAt: d.generatedAt || null };
  return indexCache;
}

let heCache = { at: 0, items: {} };

// Hebrew titles and synopses (docs/he.json, written by enrich.js). Missing file just means no overlay.
async function loadHe() {
  if (Date.now() - heCache.at < INDEX_TTL_MS && heCache.at) return heCache;
  try {
    const r = await fetch(HE_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) heCache = { at: Date.now(), items: (await r.json()).items || {} };
    else heCache.at = Date.now();
  } catch { heCache.at = Date.now(); }
  return heCache;
}

const heb = s => (typeof s === 'string' && HEBREW.test(s) ? s : null);

// Live Hebrew meta from the TMDB addon: episode titles/synopses, and titles enrich.js has not reached yet.
async function tmdbHe(type, id) {
  try {
    const r = await fetch(`${TMDB_HE}/meta/${type}/${encodeURIComponent(id)}.json`, { cf: { cacheTtl: 86400, cacheEverything: true }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return (await r.json()).meta || null;
  } catch { return null; }
}

// Cinemeta's full meta (episodes, cast, art) with the title, synopsis and episode texts swapped for Hebrew when we have them.
// Episode ids stay Cinemeta's, so streams and subtitles keep resolving as before.
async function metaFor(type, id) {
  const he = (await loadHe()).items[id];
  const [r, live] = await Promise.all([
    fetch(`${CINEMETA}/meta/${type}/${encodeURIComponent(id)}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } }),
    type === 'series' || !he ? tmdbHe(type, id) : null,
  ]);
  if (!r.ok) return null;
  const meta = (await r.json()).meta;
  if (!meta) return null;
  const name = (he && he.t) || (live && heb(live.name));
  const desc = (he && he.o) || (live && heb(live.description));
  if (name) meta.name = name;
  if (desc) meta.description = desc;
  if (type === 'movie' && (await loadDub()).items[id]) meta.description = withDubTag(meta.description, true);
  // Hebrew-subtitled trailers (Israeli distributors' uploads, via TMDB he-IL, or found on YouTube) replace Cinemeta's English ones.
  let hebTr = (he && Array.isArray(he.tr) ? he.tr : (live && Array.isArray(live.trailers) ? live.trailers.map(t => t && t.source).filter(Boolean) : [])).slice(0, 3);
  if (!hebTr.length) { const f = (await loadYt()).items[id]; if (f && f.yt) hebTr = [f.yt]; }
  // When a subtitled trailer exists it is the only one offered: apps do not all take the first entry.
  if (hebTr.length) {
    meta.trailers = hebTr.map(id => ({ source: id, type: 'Trailer' }));
    meta.trailerStreams = hebTr.map(id => ({ title: 'טריילר מתורגם', ytId: id }));
  }
  if (live && Array.isArray(live.videos) && Array.isArray(meta.videos)) {
    const key = v => `${v.season}:${v.number ?? v.episode}`;
    const byEp = new Map(live.videos.map(v => [key(v), v]));
    for (const v of meta.videos) {
      const l = byEp.get(key(v));
      if (!l) continue;
      const n = heb(l.name || l.title), o = heb(l.overview || l.description);
      if (n) { v.name = n; v.title = n; }
      if (o) { v.overview = o; v.description = o; }
    }
  }
  return meta;
}

let ytCache = { at: 0, items: {} };

// docs/yt.json (find_trailers.py on the PC): YouTube trailers proven by OCR to carry burned-in Hebrew subtitles.
async function loadYt() {
  if (Date.now() - ytCache.at < INDEX_TTL_MS && ytCache.at) return ytCache;
  try {
    const r = await fetch(YT_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) ytCache = { at: Date.now(), items: (await r.json()).items || {} };
    else ytCache.at = Date.now();
  } catch { ytCache.at = Date.now(); }
  return ytCache;
}

let dubCache = { at: 0, items: {} };

// docs/dub.json (dubscan.js): films with a Hebrew AUDIO track in a playable release, each stored with its catalog meta.
async function loadDub() {
  if (Date.now() - dubCache.at < INDEX_TTL_MS && dubCache.at) return dubCache;
  try {
    const r = await fetch(DUB_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) dubCache = { at: Date.now(), items: (await r.json()).items || {} };
    else dubCache.at = Date.now();
  } catch { dubCache.at = Date.now(); }
  return dubCache;
}

const DUB_TAG = '🗣️ דיבוב עברית מלא (לא כתוביות)';

// Sub-addon for the dubbed releases themselves (torrent streams). Meant to be wrapped by AIOStreams, which resolves
// torrents through his AllDebrid; our main manifest stays trailers + catalogs only.
const DUB_MANIFEST = {
  id: 'org.kanashti.hebrew-dub', version: '1.0.0', name: 'דיבוב עברית',
  description: 'סרטים בדיבוב עברית מלא: רק גרסאות שרצועת השמע בעברית אומתה בקובץ עצמו.',
  logo: 'https://i0.wp.com/kodibeginner.com/wp-content/uploads/2020/10/ktuvit-me.jpg?w=300&ssl=1',
  resources: ['stream'], types: ['movie'], idPrefixes: ['tt'], catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};
const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce', 'udp://exodus.desync.com:6969/announce', 'udp://open.demonii.com:1337/announce'];
// Up to two proven releases per film: a Hebrew-default file first, then a multi-audio one (Hebrew chosen in the player).
function dubStreams(item) {
  const list = Array.isArray(item.dubs) && item.dubs.length ? item.dubs : [{ hash: item.hash, fileIdx: item.fileIdx, rel: item.rel, hebOnly: item.hebOnly !== false, size: item.size }];
  return list.filter(d => d && d.hash).slice(0, 2).map(d => {
    const base = String(d.rel || 'dubbed').replace(/\.(mkv|mp4|avi)$/i, '').replace(/[\s_]+/g, '.');
    const gb = d.size ? ` · ${(d.size / 1024).toFixed(1)} GB` : '';
    const title = d.hebOnly
      ? `דיבוב עברית מלא, העברית מתנגנת אוטומטית${gb}\n${d.rel || ''}`
      : `דיבוב עברית מלא בקובץ רב-לשוני: בנגן בחר שמע ← עברית${gb}\n${d.rel || ''}`;
    return {
      name: d.hebOnly ? '🗣️ דיבוב עברית' : '🗣️ דיבוב עברית (רב-לשוני)', title,
      infoHash: d.hash, fileIdx: Number.isInteger(d.fileIdx) ? d.fileIdx : 0,
      sources: [...TRACKERS.map(t => 'tracker:' + t), 'dht:' + d.hash],
      // the filename hint carries "Hebrew Dubbed" so stream wrappers tag the audio language
      behaviorHints: { bingeGroup: 'hebdub', filename: `${base}.Hebrew.Dubbed.mkv` },
    };
  });
}
const withDubTag = (desc, dubbed) => (dubbed ? `${DUB_TAG}\n\n${desc || ''}`.trim() : desc);

let subsCache = { at: 0, items: {} };

// docs/subs/index.json (trailer_subs.py on the PC): English trailers that got a Hebrew .vtt (kind h = YouTube's own track, m = machine).
async function loadSubs() {
  if (Date.now() - subsCache.at < INDEX_TTL_MS && subsCache.at) return subsCache;
  try {
    const r = await fetch(SUBS_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) subsCache = { at: Date.now(), items: (await r.json()).items || {} };
    else subsCache.at = Date.now();
  } catch { subsCache.at = Date.now(); }
  return subsCache;
}

// One trailer stream per title, best available: subtitled distributor trailer (TMDB he-IL), then a found YouTube one,
// then Cinemeta's English trailer with our Hebrew .vtt, then plain English.
async function trailerStreams(type, id) {
  const he = (await loadHe()).items[id];
  let heb = he && Array.isArray(he.tr) ? he.tr : null;
  if (heb === null) {
    const live = await tmdbHe(type, id);
    heb = live && Array.isArray(live.trailers) ? live.trailers.map(t => t && t.source).filter(Boolean) : [];
  }
  const hints = { notWebReady: true, bingeGroup: 'trailer' };
  // a proven Hebrew-dubbed release goes first (this addon is first in his list, so it is the first stream he sees)
  const dubbed = type === 'movie' ? (await loadDub()).items[id] : null;
  const first = dubbed ? dubStreams(dubbed) : [];
  // `title` only: newer stremio-core treats `title` as an alias of `description` and rejects a stream carrying both.
  if (heb.length) return [...first, { name: '🎬 טריילר', title: 'טריילר מתורגם לעברית', ytId: heb[0], behaviorHints: hints }];
  const found = (await loadYt()).items[id];
  if (found && found.yt) return [...first, { name: '🎬 טריילר', title: found.dub ? 'טריילר מדובב לעברית' : 'טריילר מתורגם לעברית', ytId: found.yt, behaviorHints: hints }];
  const sub = (await loadSubs()).items[id];
  if (sub && sub.kind && sub.yt) {
    const subtitles = [{ id: 'he', lang: 'heb', url: `${SITE_URL}subs/${id}.vtt` }];
    const title = sub.kind === 'h' ? 'טריילר עם כתוביות בעברית' : 'טריילר עם כתוביות בעברית (תרגום מכונה)';
    return [...first, { name: '🎬 טריילר', title, ytId: sub.yt, subtitles, behaviorHints: hints }];
  }
  const r = await fetch(`${CINEMETA}/meta/${type}/${encodeURIComponent(id)}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
  const meta = r.ok ? (await r.json()).meta : null;
  const en = meta ? [...(meta.trailerStreams || []).map(t => t && t.ytId), ...(meta.trailers || []).map(t => t && t.source)].filter(Boolean)[0] : null;
  return en ? [...first, { name: '🎬 טריילר', title: 'טריילר באנגלית (אין מתורגם)', ytId: en, behaviorHints: hints }] : first;
}

function toMeta(m, row, rank, he, dub) {
  const h = he && he[m.id];
  const name = (h && h.t) || m.name;
  const meta = {
    id: m.id, type: m.type, name: row && row.numbered && rank != null ? `${rank + 1}. ${name}` : name,
    poster: m.poster, posterShape: 'poster',
    background: `https://images.metahub.space/background/medium/${m.id}/img`,
    logo: `https://images.metahub.space/logo/medium/${m.id}/img`,
    description: withDubTag((h && h.o) || m.description, m.type === 'movie' && dub && dub[m.id]),
    releaseInfo: m.year ? String(m.year) : undefined,
    imdbRating: m.imdbRating, genres: m.genres,
  };
  if (row && row.shape === 'landscape') {
    meta.poster = `https://images.metahub.space/background/small/${m.id}/img`;
    meta.posterShape = 'landscape';
  }
  // Some apps read the trailer from the row item, not from the full meta.
  if (h && Array.isArray(h.tr) && h.tr.length) {
    meta.trailers = h.tr.map(id => ({ source: id, type: 'Trailer' }));
    meta.trailerStreams = h.tr.map(id => ({ title: 'טריילר מתורגם', ytId: id }));
  }
  return meta;
}

function parseExtra(seg) {
  const extra = {};
  if (!seg) return extra;
  for (const part of seg.split('&')) {
    const i = part.indexOf('=');
    if (i > 0) extra[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return extra;
}

function catalog(items, type, catId, extra, he, dub) {
  const all = items.filter(m => m.type === type);
  const row = (ROWS[type] || []).find(r => r.id === catId);
  let list = row ? row.pick(all, { dub }) : legacyPick(catId, all);
  if (list === null) return null;
  if (extra.search) {
    const q = extra.search.toLowerCase().trim();
    list = list.filter(m => [m.name, he && he[m.id] && he[m.id].t].some(s => String(s || '').toLowerCase().includes(q)));
  }
  const skip = Number(extra.skip) || 0;
  return list.slice(skip, skip + PAGE).map((m, i) => toMeta(m, row, skip + i, he, dub));
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const json = (body, status = 200, cache = 'public, max-age=300') => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
});

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') return Response.redirect(SITE_URL, 302);
    if (p === '/manifest.json') return json(MANIFEST);
    if (p === '/dub/manifest.json') return json(DUB_MANIFEST);
    const md = p.match(/^\/dub\/stream\/movie\/(tt\d+)\.json$/);
    if (md) {
      try {
        const d = (await loadDub()).items[md[1]];
        return json({ streams: d ? dubStreams(d) : [] });
      } catch (e) {
        return json({ streams: [], error: e.message }, 502);
      }
    }
    const m = p.match(/^\/catalog\/(movie|series)\/(heb-[a-z0-9-]+)(?:\/(.+?))?\.json$/);
    if (m) {
      try {
        const [idx, he, dub] = await Promise.all([loadIndex(), loadHe(), m[1] === 'movie' ? loadDub() : { items: {} }]);
        const metas = catalog(idx.items, m[1], m[2], parseExtra(m[3]), he.items, dub.items);
        if (metas === null) return json({ error: 'unknown catalog' }, 404);
        return json({ metas });
      } catch (e) {
        return json({ metas: [], error: e.message }, 503);
      }
    }
    const mm = p.match(/^\/meta\/(movie|series)\/(tt\d+)\.json$/);
    if (mm) {
      try {
        const meta = await metaFor(mm[1], mm[2]);
        if (!meta) return json({ meta: null }, 404);
        return json({ meta });
      } catch (e) {
        return json({ meta: null, error: e.message }, 502);
      }
    }
    const ms = p.match(/^\/stream\/(movie|series)\/(tt\d+)(?::\d+:\d+)?\.json$/);
    if (ms) {
      try {
        return json({ streams: await trailerStreams(ms[1], ms[2]) }, 200, 'no-store');
      } catch (e) {
        return json({ streams: [], error: e.message }, 502);
      }
    }
    if (p === '/status') {
      try {
        const idx = await loadIndex();
        const he = Object.values((await loadHe()).items);
        const dub = (await loadDub()).items;
        const sizes = {};
        for (const [t, rows] of Object.entries(ROWS)) for (const r of rows) sizes[`${t}/${r.id}`] = r.pick(idx.items.filter(x => x.type === t), { dub }).length;
        return json({ items: idx.items.length, generatedAt: idx.generatedAt, cachedAt: new Date(indexCache.at).toISOString(), catalogs: MANIFEST.catalogs.length, hebrew: { entries: he.length, overview: he.filter(x => x.o).length, title: he.filter(x => x.t).length }, dubbed: Object.keys(dub).length, rows: sizes });
      } catch (e) { return json({ error: e.message }, 503); }
    }
    return json({ error: 'not found' }, 404);
  },
};
