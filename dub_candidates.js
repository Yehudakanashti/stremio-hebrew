// Builds the universe of films worth checking for a Hebrew dub: data/dubcands.json.
// Cinemeta "top" is only ~1,200 films, so the kids/family universe is pulled by genre and by year as well.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'data', 'dubcands.json');
const CACHE = path.join(ROOT, 'data', 'cache.json');
const CINEMETA = 'https://v3-cinemeta.strem.io';
const GENRES = { Animation: 25, Family: 25, Adventure: 15, Fantasy: 10, 'Sci-Fi': 8, Action: 8, Comedy: 6 };
const YEARS = []; for (let y = new Date().getFullYear(); y >= 1990; y--) YEARS.push(y);
const PAGE = 100;

const log = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

async function getJson(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
  try { const r = await fetch(url, { signal: ctrl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

async function main() {
  const items = {};
  let rank = 0;
  const add = (m, tag) => {
    const id = m.imdb_id || m.id;
    if (!id || !/^tt\d+$/.test(id)) return false;
    if (!items[id]) items[id] = { id, type: 'movie', name: m.name, poster: m.poster, description: m.description, year: m.year, released: m.released, imdbRating: m.imdbRating, genres: m.genre || m.genres || [], popRank: ++rank, tags: [] };
    if (!items[id].tags.includes(tag)) items[id].tags.push(tag);
    return true;
  };
  try { for (const v of Object.values(JSON.parse(fs.readFileSync(CACHE, 'utf8')).items)) if (v.type === 'movie') add(v, 'top'); } catch { /* no cache */ }
  log(`from cache: ${Object.keys(items).length}`);
  for (const [g, pages] of Object.entries(GENRES)) {
    let got = 0;
    for (let p = 0; p < pages; p++) {
      let d;
      try { d = await getJson(`${CINEMETA}/catalog/movie/top/genre=${encodeURIComponent(g)}&skip=${p * PAGE}.json`); } catch (e) { log(`${g} ${p}: ${e.message}`); break; }
      const metas = d.metas || [];
      if (!metas.length) break;
      for (const m of metas) if (add(m, 'g:' + g)) got++;
      if (metas.length < 20) break;
    }
    log(`genre ${g}: +${got} (total ${Object.keys(items).length})`);
  }
  for (const y of YEARS) {
    let got = 0;
    for (let p = 0; p < 4; p++) {
      let d;
      try { d = await getJson(`${CINEMETA}/catalog/movie/year/genre=${y}&skip=${p * PAGE}.json`); } catch (e) { break; }
      const metas = d.metas || [];
      if (!metas.length) break;
      for (const m of metas) if (add(m, 'y')) got++;
      if (metas.length < 20) break;
    }
    log(`year ${y}: +${got}`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), items }));
  log(`done: ${Object.keys(items).length} candidate films`);
}

main().catch(e => { console.error(e); process.exit(1); });
