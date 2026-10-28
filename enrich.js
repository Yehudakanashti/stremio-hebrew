// Adds Hebrew title + synopsis (TMDB, language he-IL) for every title in docs/index.json.
// Writes docs/he.json: { generatedAt, items: { imdbId: { t?: hebrewTitle, o?: overview, at: epochMs } } }
// Env: TMDB_KEY (v3 api key or v4 read-access token). Flags: --limit N (testing).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INDEX = path.join(ROOT, 'docs', 'index.json');
const OUT = path.join(ROOT, 'docs', 'he.json');
const KEY = (process.env.TMDB_KEY || '').trim();
const DAY = 864e5;
const CONCURRENCY = 8;
const HEBREW = /[֐-׿]/;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!KEY) { console.error('TMDB_KEY is not set'); process.exit(1); }

const bearer = KEY.length > 40;
function url(id) {
  const u = new URL(`https://api.themoviedb.org/3/find/${id}`);
  u.searchParams.set('external_source', 'imdb_id');
  u.searchParams.set('language', 'he-IL');
  if (!bearer) u.searchParams.set('api_key', KEY);
  return u;
}

async function lookup(id) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url(id), { headers: bearer ? { Authorization: `Bearer ${KEY}` } : {}, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep((Number(r.headers.get('retry-after')) || 2) * 1000); continue; }
      if (r.status === 401) throw new Error('TMDB rejected the key (401)');
      if (!r.ok) { await sleep(1000 * (attempt + 1)); continue; }
      const d = await r.json();
      const hit = (d.movie_results || [])[0] || (d.tv_results || [])[0];
      if (!hit) return { at: Date.now() };
      const entry = { at: Date.now() };
      const title = hit.title || hit.name;
      if (title && HEBREW.test(title)) entry.t = title;
      if (hit.overview && hit.overview.trim()) entry.o = hit.overview.trim();
      return entry;
    } catch (e) {
      if (/401/.test(e.message)) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

(async () => {
  const items = JSON.parse(fs.readFileSync(INDEX, 'utf8')).items || [];
  let he = { items: {} };
  try { he = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  he.items = he.items || {};

  const now = Date.now();
  const stale = e => !e || (e.o ? now - e.at > 60 * DAY : now - e.at > 7 * DAY);
  let todo = items.map(m => m.id).filter(id => stale(he.items[id]));
  const lim = process.argv.indexOf('--limit');
  if (lim > 0) todo = todo.slice(0, Number(process.argv[lim + 1]) || 20);
  log(`titles ${items.length}, to fetch ${todo.length}`);

  let done = 0, failed = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const id = todo[i++];
      const e = await lookup(id);
      if (e) he.items[id] = e; else failed++;
      if (++done % 200 === 0) log(`${done}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  he.generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(he));
  const vals = Object.values(he.items);
  log(`done: fetched ${done - failed}, failed ${failed}; overview ${vals.filter(v => v.o).length}, title ${vals.filter(v => v.t).length} of ${vals.length}`);
})().catch(e => { console.error(e.message); process.exit(1); });
