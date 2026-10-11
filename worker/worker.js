// Cloudflare Worker: serves the Stremio addon (manifest + catalogs with search, skip and genre rows)
// from the index published by GitHub Pages. Free tier, always on.
const INDEX_URL = 'https://yehudakanashti.github.io/stremio-hebrew/index.json';
const SITE_URL = 'https://yehudakanashti.github.io/stremio-hebrew/';
const PAGE = 100;
const INDEX_TTL_MS = 5 * 60 * 1000;

const GENRES = [
  { key: 'drama', name: 'דרמה', tags: ['Drama'] },
  { key: 'comedy', name: 'קומדיה', tags: ['Comedy'] },
  { key: 'thriller', name: 'מתח ומסתורין', tags: ['Thriller', 'Mystery'] },
  { key: 'action', name: 'אקשן והרפתקאות', tags: ['Action', 'Adventure'] },
  { key: 'crime', name: 'פשע', tags: ['Crime'] },
  { key: 'scifi', name: 'מדע בדיוני ופנטזיה', tags: ['Sci-Fi', 'Science Fiction', 'Fantasy'] },
  { key: 'horror', name: 'אימה', tags: ['Horror'] },
  { key: 'romance', name: 'רומנטי', tags: ['Romance'] },
  { key: 'family', name: 'אנימציה ומשפחה', tags: ['Animation', 'Family'] },
  { key: 'documentary', name: 'דוקומנטרי', tags: ['Documentary'] },
];
const EXTRA = [{ name: 'search' }, { name: 'skip' }];

function catalogsFor(type) {
  const label = type === 'series' ? 'סדרות' : 'סרטים';
  return [
    { type, id: 'heb-new', name: type === 'series' ? 'סדרות חדשות עם עברית' : 'סרטים חדשים עם עברית', extra: EXTRA },
    { type, id: 'heb-popular', name: type === 'series' ? 'סדרות פופולריות עם עברית' : 'סרטים פופולריים עם עברית', extra: EXTRA },
    ...GENRES.map(g => ({ type, id: `heb-genre-${g.key}`, name: `${label}: ${g.name}`, extra: EXTRA })),
  ];
}

const MANIFEST = {
  id: 'org.kanashti.hebrew-catalog',
  version: '2.1.0',
  name: 'עם עברית',
  description: 'מציג רק סרטים וסדרות שיש להם כתוביות בעברית ב-Ktuvit או Wizdom, מסודרים לפי ז\'אנר. מתעדכן אוטומטית כל 3 שעות.',
  logo: 'https://i0.wp.com/kodibeginner.com/wp-content/uploads/2020/10/ktuvit-me.jpg?w=300&ssl=1',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie', id: 'heb-cinema-new', name: 'קולנוע: חדש בעברית', extra: EXTRA },
    ...catalogsFor('series'), ...catalogsFor('movie'),
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

const isRecent = m => Number(m.year) >= new Date().getFullYear() - 1;
const byPop = (a, b) => (a.popRank ?? 99999) - (b.popRank ?? 99999);
const byReleased = (a, b) => String(b.released || '').localeCompare(String(a.released || ''));

function toMeta(m) {
  return {
    id: m.id, type: m.type, name: m.name, poster: m.poster, posterShape: 'poster',
    description: m.description, releaseInfo: m.year ? String(m.year) : undefined,
    imdbRating: m.imdbRating, genres: m.genres,
  };
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

function catalog(items, type, catId, extra) {
  let list = items.filter(m => m.type === type);
  if (catId === 'heb-cinema-new') {
    if (type !== 'movie') return null;
    const cutoff = Date.now() - 180 * 864e5;
    list = list.filter(m => m.released && Date.parse(m.released) >= cutoff)
      .sort((a, b) => ((b.hebrewSince || 0) - (a.hebrewSince || 0)) || byReleased(a, b));
  }
  else if (catId === 'heb-new') list = list.filter(isRecent).sort(byReleased);
  else if (catId === 'heb-popular') list = list.sort(byPop);
  else {
    const g = GENRES.find(x => `heb-genre-${x.key}` === catId);
    if (!g) return null;
    const tags = new Set(g.tags.map(t => t.toLowerCase()));
    list = list.filter(m => (m.genres || []).some(x => tags.has(String(x).toLowerCase()))).sort(byPop);
  }
  if (extra.search) {
    const q = extra.search.toLowerCase().trim();
    list = list.filter(m => String(m.name || '').toLowerCase().includes(q));
  }
  const skip = Number(extra.skip) || 0;
  return list.slice(skip, skip + PAGE).map(toMeta);
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
});

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') return Response.redirect(SITE_URL, 302);
    if (p === '/manifest.json') return json(MANIFEST);
    const m = p.match(/^\/catalog\/(movie|series)\/(heb-[a-z-]+)(?:\/(.+?))?\.json$/);
    if (m) {
      try {
        const idx = await loadIndex();
        const metas = catalog(idx.items, m[1], m[2], parseExtra(m[3]));
        if (metas === null) return json({ error: 'unknown catalog' }, 404);
        return json({ metas });
      } catch (e) {
        return json({ metas: [], error: e.message }, 503);
      }
    }
    if (p === '/status') {
      try {
        const idx = await loadIndex();
        return json({ items: idx.items.length, generatedAt: idx.generatedAt, cachedAt: new Date(indexCache.at).toISOString(), catalogs: MANIFEST.catalogs.length });
      } catch (e) { return json({ error: e.message }, 503); }
    }
    return json({ error: 'not found' }, 404);
  },
};
