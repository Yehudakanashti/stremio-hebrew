// Cloudflare Worker: serves the Stremio addon "עם עברית" (manifest + themed catalogs, search, paging)
// from the index published by GitHub Pages. Free tier, always on.
const INDEX_URL = 'https://yehudakanashti.github.io/stremio-hebrew/index.json';
const SITE_URL = 'https://yehudakanashti.github.io/stremio-hebrew/';
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
  version: '3.0.0',
  name: 'עם עברית',
  description: 'סרטים וסדרות עם כתוביות בעברית בלבד, בעיצוב של נטפליקס: כרטיסים רחבים, טופ 10, פנינים נסתרות וקלאסיקות. מתעדכן אוטומטית כל 3 שעות.',
  logo: 'https://i0.wp.com/kodibeginner.com/wp-content/uploads/2020/10/ktuvit-me.jpg?w=300&ssl=1',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    ...MOVIES.slice(0, 1).map(r => ({ type: 'movie', id: r.id, name: r.name, extra: EXTRA })),
    ...SERIES.map(r => ({ type: 'series', id: r.id, name: r.name, extra: EXTRA })),
    ...MOVIES.slice(1).map(r => ({ type: 'movie', id: r.id, name: r.name, extra: EXTRA })),
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

function toMeta(m, row, rank) {
  const meta = {
    id: m.id, type: m.type, name: row && row.numbered && rank != null ? `${rank + 1}. ${m.name}` : m.name,
    poster: m.poster, posterShape: 'poster',
    background: `https://images.metahub.space/background/medium/${m.id}/img`,
    logo: `https://images.metahub.space/logo/medium/${m.id}/img`,
    description: m.description, releaseInfo: m.year ? String(m.year) : undefined,
    imdbRating: m.imdbRating, genres: m.genres,
  };
  if (row && row.shape === 'landscape') {
    meta.poster = `https://images.metahub.space/background/small/${m.id}/img`;
    meta.posterShape = 'landscape';
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

function catalog(items, type, catId, extra) {
  const all = items.filter(m => m.type === type);
  const row = (ROWS[type] || []).find(r => r.id === catId);
  let list = row ? row.pick(all) : legacyPick(catId, all);
  if (list === null) return null;
  if (extra.search) {
    const q = extra.search.toLowerCase().trim();
    list = list.filter(m => String(m.name || '').toLowerCase().includes(q));
  }
  const skip = Number(extra.skip) || 0;
  return list.slice(skip, skip + PAGE).map((m, i) => toMeta(m, row, skip + i));
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
    const m = p.match(/^\/catalog\/(movie|series)\/(heb-[a-z0-9-]+)(?:\/(.+?))?\.json$/);
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
        const sizes = {};
        for (const [t, rows] of Object.entries(ROWS)) for (const r of rows) sizes[`${t}/${r.id}`] = r.pick(idx.items.filter(x => x.type === t)).length;
        return json({ items: idx.items.length, generatedAt: idx.generatedAt, cachedAt: new Date(indexCache.at).toISOString(), catalogs: MANIFEST.catalogs.length, rows: sizes });
      } catch (e) { return json({ error: e.message }, 503); }
    }
    return json({ error: 'not found' }, 404);
  },
};
