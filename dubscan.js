// Finds films that have a Hebrew AUDIO track (a real dub, not subtitles) in a release Stremio can play.
// 1) candidates = movies in data/cache.json (kids/animation/family/recent first)
// 2) public Torrentio stream list per title; keep releases whose name says HebDub or whose language line carries 🇮🇱
//    (Torrentio mixes audio and subtitle languages, so a flag alone proves nothing)
// 3) PROOF: ffprobe reads the container header of the actual file and lists its audio tracks:
//    - through the local Stremio server (http://127.0.0.1:11470/<infoHash>/<fileIdx>) on the PC, or
//    - through AllDebrid when ALLDEBRID_KEY is set (CI)
// Writes docs/dub.json: { generatedAt, items: { tt: {catalog meta..., rel, hash, fileIdx, langs, at} }, checked: { tt: {at, tried, n} } }
// Flags: --limit N (titles per run), --only ttXXXX, --force, --no-probe (dry run: list candidates only)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CACHE = path.join(ROOT, 'data', 'cache.json');
const OUT = process.env.DUB_OUT || path.join(ROOT, 'docs', 'dub.json');
const TORRENTIO = 'https://torrentio.strem.fun/stream/movie/';
const STREMIO_SERVER = process.env.STREMIO_SERVER || 'http://127.0.0.1:11470';
// AllDebrid refuses API calls from datacenter IPs (AUTH_BLOCKED on GitHub Actions), so the proof runs on the PC:
// the key lives in a file outside the repo (never committed), pasted there by the owner.
const KEY_FILE = process.env.ALLDEBRID_KEY_FILE || path.join(path.dirname(ROOT), 'alldebrid.key');
const ALLDEBRID_KEY = process.env.ALLDEBRID_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const DAY = 864e5;
const IL = '\u{1F1EE}\u{1F1F1}';
const DUB_NAME = /heb(?:rew)?[\s._-]*(?:dub|audio)|dub(?:bed)?[\s._-]*heb|hebdub|מדובב/i;
const HEB_LANG = /^(he|heb|hebrew|iw)$/i;
const MAX_PROBES_PER_TITLE = 3;
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 150000);
const KIDS = new Set(['animation', 'family']);

const log = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const LIMIT = Number(flag('--limit', 0)) || 0;
const ONLY = flag('--only', null);
const FORCE = args.includes('--force');
const NO_PROBE = args.includes('--no-probe');

async function getJson(url, ms = 40000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Torrentio stream text: "<release name>\n👤 seeds 💾 size ⚙️ provider\n<languages>"
function parseStream(s) {
  const text = s.title || s.description || '';
  const lines = text.split('\n');
  const name = lines[0] || '';
  const langLine = lines[lines.length - 1] || '';
  const seeds = Number((text.match(/👤\s*(\d+)/) || [])[1] || 0);
  const explicit = DUB_NAME.test(name);
  const flagged = langLine.includes(IL);
  const multi = /multi audio/i.test(langLine);
  // a lone 🇮🇱 that comes from a "Sub (... Heb ...)" note is subtitles, not audio
  const subNote = /sub(?:s|titles?)?\s*\([^)]*heb/i.test(name);
  if (!explicit && !(flagged && !subNote)) return null;
  return { hash: String(s.infoHash || '').toLowerCase(), fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : 0, name, seeds, explicit, multi, score: (explicit ? 100 : 0) + (multi ? 10 : 0) + Math.min(seeds, 500) / 100 };
}

function runProbe(url) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-probesize', '32M', '-analyzeduration', '5M', '-rw_timeout', '60000000',
    '-show_entries', 'stream=index,codec_type:stream_tags=language,title', '-of', 'json', url], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (r.status !== 0) return { ok: false, err: (r.stderr || r.error && r.error.message || 'ffprobe failed').trim().slice(0, 160) };
  let d;
  try { d = JSON.parse(r.stdout); } catch { return { ok: false, err: 'bad ffprobe json' }; }
  const audio = (d.streams || []).filter(x => x.codec_type === 'audio');
  const langs = audio.map(x => String((x.tags && (x.tags.language || x.tags.LANGUAGE)) || 'und').toLowerCase());
  const titles = audio.map(x => String((x.tags && (x.tags.title || x.tags.TITLE)) || ''));
  const hebrew = langs.some(l => HEB_LANG.test(l)) || titles.some(t => /hebrew|עברית/i.test(t));
  return { ok: true, langs, hebrew, audio: audio.length };
}

async function stremioUrl(c) {
  return `${STREMIO_SERVER}/${c.hash}/${c.fileIdx}`;
}

async function stremioRelease(c) {
  try { await fetch(`${STREMIO_SERVER}/${c.hash}/remove`, { signal: AbortSignal.timeout(5000) }); } catch { /* best effort */ }
}

// AllDebrid: upload the magnet, wait for the file list, unlock the video link, probe it, then delete the magnet again.
async function alldebridUrl(c) {
  const base = 'https://api.alldebrid.com/v4';
  const q = `agent=stremio-hebrew&apikey=${encodeURIComponent(ALLDEBRID_KEY)}`;
  const adError = (r, what) => new Error(`alldebrid ${what}: ${(r && r.error && (r.error.code || r.error.message)) || JSON.stringify(r).slice(0, 100)}`);
  // upload tells whether the release is already in AllDebrid's cache (`ready`): those are the ones Stremio plays instantly.
  // A release that is not cached is deleted again right away, so nothing starts downloading on the account.
  const up = await getJson(`${base}/magnet/upload?${q}&magnets[]=${c.hash}`);
  if (up.status !== 'success') throw adError(up, 'upload');
  const m = up.data && up.data.magnets && up.data.magnets[0];
  if (!m || m.error) throw adError(m, 'magnet');
  c.adId = m.id;
  if (!m.ready) { await alldebridRelease(c); throw new Error('not cached'); }
  for (let i = 0; i < 6; i++) {
    // v4 magnet/status answers DISCONTINUED; v4.1 is the live one (files come as a tree)
    const st = await getJson(`https://api.alldebrid.com/v4.1/magnet/status?${q}&id=${m.id}`);
    if (st.status !== 'success') throw adError(st, 'status');
    const mg = st.data && st.data.magnets;
    const ready = mg && (mg.statusCode === 4 || /^Ready$/i.test(mg.status || ''));
    if (ready) {
      // v4.1 nests files as {n, s, l, e:[children]}; older responses list links as {filename, size, link}
      const files = [];
      const walk = (arr, prefix) => (arr || []).forEach(f => Array.isArray(f.e) ? walk(f.e, prefix + f.n + '/') : files.push({ n: prefix + (f.n || f.filename || ''), l: f.l || f.link, s: f.s || f.size || 0 }));
      walk(mg.files || mg.links, '');
      const video = files.filter(f => f.l && /\.(mkv|mp4|avi|m4v|ts|webm)$/i.test(f.n)).sort((a, b) => b.s - a.s)[0];
      if (!video) throw new Error('no video file in ' + files.length + ' files');
      const un = await getJson(`${base}/link/unlock?${q}&link=${encodeURIComponent(video.l)}`);
      if (un.status !== 'success' || !un.data || !un.data.link) throw adError(un, 'unlock');
      return un.data.link;
    }
    if (mg && (mg.statusCode >= 5 || /Error|Expired|Upload fail/i.test(mg.status || ''))) throw new Error('alldebrid ' + mg.status);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('alldebrid not ready');
}

async function alldebridRelease(c) {
  if (!c.adId) return;
  try {
    const r = await getJson(`https://api.alldebrid.com/v4/magnet/delete?agent=stremio-hebrew&apikey=${encodeURIComponent(ALLDEBRID_KEY)}&id=${c.adId}`);
    if (r.status !== 'success') log(`  alldebrid delete ${c.adId} failed: ${(r.error && r.error.code) || JSON.stringify(r).slice(0, 80)}`);
  } catch (e) { log(`  alldebrid delete ${c.adId} failed: ${e.message.slice(0, 80)}`); }
}

async function probe(c) {
  const viaAd = Boolean(ALLDEBRID_KEY);
  let url;
  try { url = viaAd ? await alldebridUrl(c) : await stremioUrl(c); }
  catch (e) { return { ok: false, err: e.message.slice(0, 120) }; }
  try { return runProbe(url); }
  finally { if (viaAd) await alldebridRelease(c); else await stremioRelease(c); }
}

function load() {
  try { const d = JSON.parse(fs.readFileSync(OUT, 'utf8')); return { items: d.items || {}, checked: d.checked || {} }; }
  catch { return { items: {}, checked: {} }; }
}

function save(res) {
  res.generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(res));
}

const isKids = m => (m.genres || []).some(g => KIDS.has(String(g).toLowerCase()));
const yearOf = m => parseInt(String(m.year || '').replace(/\D/g, '').slice(0, 4), 10) || 0;

function needsCheck(m, res, now) {
  if (FORCE) return true;
  const c = res.checked[m.id];
  if (!c) return true;
  if (res.items[m.id]) return now - c.at > 30 * DAY;
  return now - c.at > (yearOf(m) >= new Date().getFullYear() - 1 ? 2 * DAY : 30 * DAY);
}

async function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')).items;
  const movies = Object.values(cache).filter(m => m.type === 'movie' && /^tt\d+$/.test(m.id) && m.name);
  const res = load();
  const now = Date.now();
  let todo = movies.filter(m => (!ONLY || m.id === ONLY) && needsCheck(m, res, now));
  // kids films first, then the newest, then the most popular
  todo.sort((a, b) => (isKids(b) - isKids(a)) || (yearOf(b) - yearOf(a)) || ((a.popRank ?? 99999) - (b.popRank ?? 99999)));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  log(`movies ${movies.length}, dubbed so far ${Object.keys(res.items).length}, to check ${todo.length}, proof via ${ALLDEBRID_KEY ? 'alldebrid' : 'stremio server'}`);
  let n = 0, found = 0, probes = 0;
  for (const m of todo) {
    n++;
    const entry = { at: Date.now(), tried: [], n: 0 };
    try {
      const d = await getJson(`${TORRENTIO}${m.id}.json`);
      const streams = (d.streams || []);
      entry.n = streams.length;
      const cands = streams.map(parseStream).filter(Boolean).filter(c => c.hash).sort((a, b) => b.score - a.score);
      const seen = new Set();
      let hit = null;
      for (const c of cands) {
        if (seen.has(c.hash)) continue;
        seen.add(c.hash);
        if (entry.tried.length >= MAX_PROBES_PER_TITLE) break;
        entry.tried.push(c.hash);
        if (NO_PROBE) { log(`  cand ${m.id} ${m.name}: ${c.name.slice(0, 70)} explicit=${c.explicit} multi=${c.multi} seeds=${c.seeds}`); continue; }
        probes++;
        const p = await probe(c);
        if (!p.ok) { log(`  probe ${m.id} ${c.name.slice(0, 50)}: ${p.err}`); continue; }
        log(`  probe ${m.id} ${c.name.slice(0, 50)}: audio [${p.langs.join(',')}]`);
        if (p.hebrew) { hit = { ...c, langs: p.langs }; break; }
      }
      if (hit) {
        found++;
        res.items[m.id] = {
          id: m.id, type: 'movie', name: m.name, poster: m.poster, description: m.description, year: m.year, released: m.released,
          imdbRating: m.imdbRating, genres: m.genres, popRank: m.popRank,
          rel: hit.name.slice(0, 120), hash: hit.hash, fileIdx: hit.fileIdx, langs: hit.langs, at: Date.now(),
        };
        log(`FOUND ${m.id} ${m.name} (${m.year}) -> ${hit.name.slice(0, 80)}`);
      } else if (!NO_PROBE && res.items[m.id] && entry.tried.length) {
        // the proven release is gone and nothing else proved Hebrew audio: keep it once more, drop on the next miss
        if (res.items[m.id].miss) { delete res.items[m.id]; log(`DROP ${m.id} ${m.name}`); } else res.items[m.id].miss = 1;
      }
    } catch (e) {
      log(`fail ${m.id} ${m.name}: ${e.message.slice(0, 100)}`);
      entry.err = e.message.slice(0, 80);
    }
    res.checked[m.id] = entry;
    if (n % 10 === 0) { save(res); log(`${n}/${todo.length} probes ${probes} found ${found}`); }
    await new Promise(r => setTimeout(r, 400));
  }
  save(res);
  log(`done: checked ${n}, probes ${probes}, found now ${found}, dubbed total ${Object.keys(res.items).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
