// Adds a Hebrew title + synopsis for every title in docs/index.json. The text is TMDB's own Hebrew (he-IL)
// data, read through the public TMDB Stremio addon, so no API key is needed.
// Writes docs/he.json: { generatedAt, items: { imdbId: { t?: hebrewTitle, o?: hebrewOverview, at: epochMs } } }
// Env: HE_SOURCE (addon base incl. config, optional). Flags: --limit N (testing).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INDEX = path.join(ROOT, 'docs', 'index.json');
const OUT = path.join(ROOT, 'docs', 'he.json');
const SOURCE = (process.env.HE_SOURCE || 'https://tmdb.elfhosted.com/%7B%22language%22%3A%22he-IL%22%7D').replace(/\/$/, '');
const UA = 'stremio-hebrew enrich (github.com/Yehudakanashti/stremio-hebrew)';
const DAY = 864e5;
const CONCURRENCY = 3;
const HEBREW = /[֐-׿]/;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Only real Hebrew text is kept; the addon falls back to English when TMDB has no Hebrew translation.
const heb = s => (typeof s === 'string' && HEBREW.test(s) ? s.trim() : null);

async function lookup(type, id) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(`${SOURCE}/meta/${type}/${id}.json`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return { at: Date.now() };
      if (!r.ok) { await sleep(2000 * (attempt + 1)); continue; }
      const meta = (await r.json()).meta;
      const entry = { at: Date.now() };
      if (!meta) return entry;
      const t = heb(meta.name), o = heb(meta.description);
      if (t) entry.t = t;
      if (o) entry.o = o;
      return entry;
    } catch {
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
  let todo = items.filter(m => stale(he.items[m.id]));
  const lim = process.argv.indexOf('--limit');
  if (lim > 0) todo = todo.slice(0, Number(process.argv[lim + 1]) || 20);
  log(`titles ${items.length}, to fetch ${todo.length}`);

  let done = 0, failed = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const m = todo[i++];
      const e = await lookup(m.type, m.id);
      if (e) he.items[m.id] = e; else failed++;
      if (++done % 200 === 0) log(`${done}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  he.generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(he));
  const vals = Object.values(he.items);
  log(`done: fetched ${done - failed}, failed ${failed}; overview ${vals.filter(v => v.o).length}, title ${vals.filter(v => v.t).length} of ${vals.length}`);
  // Mostly failures means the source is down: keep the partial file, but make the run visibly red.
  if (done && failed > done / 2) { console.error(`source unreachable: ${failed}/${done} failed`); process.exit(1); }
})().catch(e => { console.error(e.message); process.exit(1); });
