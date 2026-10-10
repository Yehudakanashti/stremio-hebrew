// Cloudflare Worker: serves the Stremio addon (manifest + catalogs with search and skip)
// from the index published by GitHub Pages. Free tier, always on.
const INDEX_URL = 'https://yehudakanashti.github.io/stremio-hebrew/index.json';
const SITE_URL = 'https://yehudakanashti.github.io/stremio-hebrew/';
const PAGE = 100;
const INDEX_TTL_MS = 5 * 60 * 1000;

const MANIFEST = {
  id: 'org.kanashti.hebrew-catalog',
  version: '2.0.0',
  name: 'עם עברית',
  description: 'מציג רק סרטים וסדרות שיש להם כתוביות בעברית ב-Ktuvit או Wizdom. מתעדכן אוטומטית כל 3 שעות.',
  logo: 'https://i0.wp.com/kodibeginner.com/wp-content/uploads/2020/10/ktuvit-me.jpg?w=300&ssl=1',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie', id: 'heb-new', name: 'סרטים חדשים עם עברית', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'series', id: 'heb-new', name: 'סדרות חדשות עם עברית', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'movie', id: 'heb-popular', name: 'סרטים פופולריים עם עברית', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'series', id: 'heb-popular', name: 'סדרות פופולריות עם עברית', extra: [{ name: 'search' }, { name: 'skip' }] },
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
  if (catId === 'heb-new') list = list.filter(isRecent).sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')));
  else list = list.sort((a, b) => (a.popRank ?? 99999) - (b.popRank ?? 99999));
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
    const m = p.match(/^\/catalog\/(movie|series)\/(heb-new|heb-popular)(?:\/(.+?))?\.json$/);
    if (m) {
      try {
        const idx = await loadIndex();
        return json({ metas: catalog(idx.items, m[1], m[2], parseExtra(m[3])) });
      } catch (e) {
        return json({ metas: [], error: e.message }, 503);
      }
    }
    if (p === '/status') {
      try {
        const idx = await loadIndex();
        return json({ items: idx.items.length, generatedAt: idx.generatedAt, cachedAt: new Date(indexCache.at).toISOString() });
      } catch (e) { return json({ error: e.message }, 503); }
    }
    return json({ error: 'not found' }, 404);
  },
};
