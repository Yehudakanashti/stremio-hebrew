// Finds films that have a Hebrew AUDIO track (a real dub, not subtitles) in a release Stremio can play.
// Universe: data/dubcands.json (dub_candidates.js: Cinemeta top + kids/family/adventure genres + years), plus any film
// named by a Hebrew-dub keyword release found on Knaben / The Pirate Bay (mapped to IMDb through Cinemeta search).
// Per film: candidate releases = Torrentio's list filtered to explicit HebDub names, MULTi releases and 🇮🇱-flagged ones
// (Torrentio's flags mix audio and subtitle languages, so a flag alone proves nothing), plus the keyword releases.
// PROOF: ffprobe reads the container header of the actual file through AllDebrid and lists its audio tracks.
// Writes docs/dub.json: { generatedAt, items: { tt: {meta..., dubs:[{hash,fileIdx,rel,langs,hebOnly,size}], rel,hash,fileIdx,langs} },
//                        checked: { tt: {at, tried, n, v} }, kw: { hash: {t, tt, at} } }
// Flags: --limit N (titles per run), --only ttXXXX, --force, --no-probe (list candidates only)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CANDS = path.join(ROOT, 'data', 'dubcands.json');
const CACHE = path.join(ROOT, 'data', 'cache.json');
const OUT = process.env.DUB_OUT || path.join(ROOT, 'docs', 'dub.json');
const TORRENTIO = 'https://torrentio.strem.fun/stream/movie/';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
// AllDebrid refuses API calls from datacenter IPs (AUTH_BLOCKED on GitHub Actions), so the proof runs on the PC:
// the key lives in a file outside the repo (never committed), pasted there by the owner.
const KEY_FILE = process.env.ALLDEBRID_KEY_FILE || path.join(path.dirname(ROOT), 'alldebrid.key');
const ALLDEBRID_KEY = process.env.ALLDEBRID_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '');
const AD = 'https://api.alldebrid.com';
const DAY = 864e5;
const IL = '\u{1F1EE}\u{1F1F1}';
const RULES = 2;
const DUB_NAME = /heb(?:rew)?[\s._-]*(?:dub|audio)|dub(?:bed)?[\s._-]*heb|hebdub|מדובב/i;
const HEB_LANG = /^(he|heb|hebrew|iw)$/i;
const MAX_PROBES_PER_TITLE = 6;
const CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 150000);
const KIDS = new Set(['animation', 'family']);
const KW_QUERIES = ['hebrew dubbed', 'hebdub', 'heb dubbed', 'hebrew dub'];

const log = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const LIMIT = Number(flag('--limit', 0)) || 0;
const ONLY = flag('--only', null);
const FORCE = args.includes('--force');
const NO_PROBE = args.includes('--no-probe');

async function getJson(url, ms = 40000, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------- candidate releases ----------
// Torrentio stream text: "<release name>\n👤 seeds 💾 size ⚙️ provider\n<languages>"
function parseStream(s) {
  const text = s.title || s.description || '';
  const lines = text.split('\n');
  const name = lines[0] || '';
  const langLine = lines[lines.length - 1] || '';
  const seeds = Number((text.match(/👤\s*(\d+)/) || [])[1] || 0);
  const sizeM = text.match(/💾\s*([\d.]+)\s*(GB|MB)/i);
  const size = sizeM ? Math.round(parseFloat(sizeM[1]) * (sizeM[2].toUpperCase() === 'GB' ? 1024 : 1)) : 0; // MB
  const explicit = DUB_NAME.test(name);
  const flagged = langLine.includes(IL);
  const multi = /multi|dual[\s._-]*audio|multi[\s._-]*audio/i.test(name) || /multi audio/i.test(langLine);
  const fullAudioGroup = /somniware/i.test(name);
  const subNote = /sub(?:s|titles?)?\s*\([^)]*heb/i.test(name);
  // releases that are "multi" for another market (Russian/French/Latin/Polish/Italian dubs) rarely carry Hebrew
  const otherMarket = /[Ѐ-ӿ]|\b(?:vff?|vf2|vfq|truefrench|french|latino|dublado|pldub|lektor|ita-eng|ita\b|hindi|tamil|telugu)\b/i.test(name);
  if (!explicit && !multi && !(flagged && !subNote)) return null;
  const score = (explicit ? 100 : 0) + (multi && flagged ? 50 : 0) + (fullAudioGroup ? 30 : 0) + (multi ? 20 : 0) + (flagged && !subNote ? 10 : 0) - (otherMarket && !flagged ? 40 : 0) + Math.min(seeds, 500) / 100;
  return { hash: String(s.infoHash || '').toLowerCase(), fileIdx: Number.isInteger(s.fileIdx) ? s.fileIdx : 0, name, seeds, size, explicit, multi, score };
}

// ---------- keyword releases (Knaben + The Pirate Bay) mapped to IMDb ----------
const STOP = /\b(19\d\d|20\d\d|480p|576p|720p|1080p|2160p|4k|hd|sd|hq|dvdrip|dvdr|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|hdtv|pdtv|hdrip|hebdub|hebdubbed|hebrew|heb|dubbed|dubbing|dub|x264|x265|h264|h265|xvid|aac|ac3|dts|mkv|mp4|avi|mpg|multi|remux|hdr|dv|proper|repack|extended|unrated|israeli|also|english|disney)\b/i;
function parseRelease(t) {
  const s = String(t).replace(/&amp;/g, '&').replace(/\.(mkv|mp4|avi|m4v|mpg)$/i, '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  const year = (s.match(/\b(19[5-9]\d|20[0-4]\d)\b/) || [])[1];
  const name = s.split(STOP)[0].replace(/[\[\]()\-:,]+$/g, '').replace(/\s+1$/, '').trim();
  return { name, year: year ? Number(year) : null };
}
const norm = s => String(s || '').toLowerCase().replace(/['’"]/g, '').replace(/[^a-z0-9֐-׿]+/g, ' ').trim();

async function keywordReleases() {
  const out = new Map();
  for (const q of KW_QUERIES) {
    try {
      const d = await getJson('https://api.knaben.org/v1', 40000, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_type: '100%', search_field: 'title', query: q, order_by: 'seeders', order_direction: 'desc', size: 300, hide_unsafe: true, hide_xxx: true }) });
      for (const h of d.hits || []) if (h.hash && DUB_NAME.test(h.title || '')) out.set(String(h.hash).toLowerCase(), { t: h.title, seeds: h.seeders || 0, size: Math.round((h.bytes || 0) / 1048576), up: Number(String(h.date || '').slice(0, 4)) || 0 });
    } catch (e) { log(`knaben ${q}: ${e.message}`); }
    try {
      const d = await getJson(`https://apibay.org/q.php?q=${encodeURIComponent(q).replace(/%20/g, '+')}&cat=0`, 30000);
      for (const h of Array.isArray(d) ? d : []) if (h.info_hash && h.id !== '0' && DUB_NAME.test(h.name || '')) out.set(String(h.info_hash).toLowerCase(), { t: h.name, seeds: Number(h.seeders) || 0, size: Math.round(Number(h.size || 0) / 1048576), up: h.added ? new Date(Number(h.added) * 1000).getUTCFullYear() : 0 });
    } catch (e) { log(`apibay ${q}: ${e.message}`); }
  }
  return out;
}

// A keyword release maps to the films whose name is EXACTLY the parsed name (so "toy story" never becomes Toy Story 5),
// released no later than the torrent was uploaded. Several films can share a name (The Lion King 1994/2019); the probe
// then settles it by comparing the file's duration with each film's runtime.
async function mapToImdb(title, up, res) {
  const { name, year } = parseRelease(title);
  if (!name || name.length < 3) return [];
  let d = null;
  for (let i = 0; i < 3 && !d; i++) {
    try { d = await getJson(`${CINEMETA}/catalog/movie/top/search=${encodeURIComponent(name)}.json`, 20000); }
    catch { await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  if (!d) return [];
  const want = norm(name);
  const ids = [];
  for (const m of (d.metas || []).slice(0, 15)) {
    const id = m.imdb_id || m.id;
    if (!/^tt\d+$/.test(id) || norm(m.name) !== want) continue;
    if (year && Math.abs(Number(m.year) - year) > 1) continue;
    if (!year && up && Number(m.year) > up) continue;
    ids.push(id);
    if (!res.universe[id]) res.universe[id] = { id, type: 'movie', name: m.name, poster: m.poster, description: m.description, year: m.year, released: m.released, imdbRating: m.imdbRating, genres: m.genre || m.genres || [], popRank: 99999, tags: ['kw'] };
  }
  return ids;
}

const runtimes = new Map();
async function runtimeOf(tt) {
  if (runtimes.has(tt)) return runtimes.get(tt);
  let min = null;
  try {
    const meta = (await getJson(`${CINEMETA}/meta/movie/${tt}.json`, 20000)).meta || {};
    const m = String(meta.runtime || '').match(/(?:(\d+)\s*h)?\s*(\d+)\s*min/i);
    if (m) min = Number(m[1] || 0) * 60 + Number(m[2]);
  } catch { /* unknown */ }
  runtimes.set(tt, min);
  return min;
}
const durationFits = (seconds, min) => !min || !seconds || Math.abs(seconds / 60 - min) <= Math.max(4, min * 0.06);

// ---------- proof ----------
function runProbe(url) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-probesize', '32M', '-analyzeduration', '5M', '-rw_timeout', '60000000',
    '-show_entries', 'stream=index,codec_type:stream_tags=language,title:format=duration', '-of', 'json', url], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (r.status !== 0) return { ok: false, err: (r.stderr || (r.error && r.error.message) || 'ffprobe failed').trim().slice(0, 160) };
  let d;
  try { d = JSON.parse(r.stdout); } catch { return { ok: false, err: 'bad ffprobe json' }; }
  const seconds = Number(d.format && d.format.duration) || 0;
  const audio = (d.streams || []).filter(x => x.codec_type === 'audio');
  const langs = audio.map(x => String((x.tags && (x.tags.language || x.tags.LANGUAGE)) || 'und').toLowerCase());
  const titles = audio.map(x => String((x.tags && (x.tags.title || x.tags.TITLE)) || ''));
  const hebIdx = langs.findIndex((l, i) => HEB_LANG.test(l) || /hebrew|עברית/i.test(titles[i]));
  const hebrew = hebIdx >= 0;
  // Hebrew is what plays by default when it is the only track or the first one
  const hebOnly = hebrew && (audio.length === 1 || hebIdx === 0);
  return { ok: true, langs, hebrew, hebOnly, audio: audio.length, seconds };
}

const adError = (r, what) => new Error(`alldebrid ${what}: ${(r && r.error && (r.error.code || r.error.message)) || JSON.stringify(r).slice(0, 100)}`);

async function alldebridUrl(c) {
  const q = `agent=stremio-hebrew&apikey=${encodeURIComponent(ALLDEBRID_KEY)}`;
  // upload tells whether the release is already in AllDebrid's cache (`ready`): those are the ones Stremio plays instantly.
  const up = await getJson(`${AD}/v4/magnet/upload?${q}&magnets[]=${c.hash}`);
  if (up.status !== 'success') throw adError(up, 'upload');
  const m = up.data && up.data.magnets && up.data.magnets[0];
  if (!m || m.error) throw adError(m, 'magnet');
  c.adId = m.id;
  if (!m.ready) { await alldebridRelease(c); throw new Error('not cached'); }
  for (let i = 0; i < 6; i++) {
    const st = await getJson(`${AD}/v4.1/magnet/status?${q}&id=${m.id}`);
    if (st.status !== 'success') throw adError(st, 'status');
    const mg = st.data && st.data.magnets;
    const ready = mg && (mg.statusCode === 4 || /^Ready$/i.test(mg.status || ''));
    if (ready) {
      const files = [];
      const walk = (arr, prefix) => (arr || []).forEach(f => Array.isArray(f.e) ? walk(f.e, prefix + f.n + '/') : files.push({ n: prefix + (f.n || f.filename || ''), l: f.l || f.link, s: f.s || f.size || 0 }));
      walk(mg.files || mg.links, '');
      const video = files.filter(f => f.l && /\.(mkv|mp4|avi|m4v|ts|webm)$/i.test(f.n)).sort((a, b) => b.s - a.s)[0];
      if (!video) throw new Error('no video file in ' + files.length + ' files');
      c.size = c.size || Math.round(video.s / 1048576);
      const un = await getJson(`${AD}/v4/link/unlock?${q}&link=${encodeURIComponent(video.l)}`);
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
    const r = await getJson(`${AD}/v4/magnet/delete?agent=stremio-hebrew&apikey=${encodeURIComponent(ALLDEBRID_KEY)}&id=${c.adId}`);
    if (r.status !== 'success') log(`  alldebrid delete ${c.adId} failed: ${(r.error && r.error.code) || JSON.stringify(r).slice(0, 80)}`);
  } catch (e) { log(`  alldebrid delete ${c.adId} failed: ${e.message.slice(0, 80)}`); }
}

async function probe(c) {
  if (!ALLDEBRID_KEY) return { ok: false, err: 'no alldebrid key' };
  let url;
  try { url = await alldebridUrl(c); }
  catch (e) { return { ok: false, err: e.message.slice(0, 120) }; }
  let p;
  try { p = runProbe(url); }
  finally {
    // a proven dub STAYS in his AllDebrid list (so the debrid Library addon can serve it instantly); everything else is removed
    if (!(p && p.ok && p.hebrew)) await alldebridRelease(c);
  }
  return p;
}

// ---------- state ----------
function load() {
  try { const d = JSON.parse(fs.readFileSync(OUT, 'utf8')); return { items: d.items || {}, checked: d.checked || {}, kw: d.kw || {} }; }
  catch { return { items: {}, checked: {}, kw: {} }; }
}
function save(res) {
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), items: res.items, checked: res.checked, kw: res.kw }));
}

const isKids = m => (m.genres || []).some(g => KIDS.has(String(g).toLowerCase()));
const yearOf = m => parseInt(String(m.year || '').replace(/\D/g, '').slice(0, 4), 10) || 0;

function needsCheck(m, res, now) {
  if (FORCE) return true;
  const c = res.checked[m.id];
  if (!c || c.v !== RULES) return true;
  if (res.items[m.id]) return now - c.at > 30 * DAY;
  return now - c.at > (yearOf(m) >= new Date().getFullYear() - 1 ? 2 * DAY : 30 * DAY);
}

// best release first: Hebrew as the default track, then smaller files (1080p multi before 20 GB 4K multi)
const rank = d => (d.hebOnly ? 0 : 1) * 1e9 + (d.size || 1e6);

async function checkTitle(m, res, kwByTitle) {
  const entry = { at: Date.now(), tried: [], n: 0, v: RULES };
  const proven = [];
  try {
    let streams = [];
    try { streams = (await getJson(`${TORRENTIO}${m.id}.json`)).streams || []; } catch (e) { entry.err = 'torrentio ' + e.message.slice(0, 40); }
    entry.n = streams.length;
    const cands = streams.map(parseStream).filter(Boolean).filter(c => c.hash);
    for (const k of kwByTitle.get(m.id) || []) if (!cands.some(c => c.hash === k.hash)) cands.push({ hash: k.hash, fileIdx: 0, name: k.t, seeds: k.seeds, size: k.size, explicit: true, multi: false, kw: true, score: 100 + Math.min(k.seeds, 500) / 100 });
    cands.sort((a, b) => b.score - a.score);
    const seen = new Set();
    for (const c of cands) {
      if (seen.has(c.hash)) continue;
      seen.add(c.hash);
      if (entry.tried.length >= MAX_PROBES_PER_TITLE) break;
      entry.tried.push(c.hash);
      if (NO_PROBE) { log(`  cand ${m.id} ${m.name}: ${c.name.slice(0, 70)} explicit=${c.explicit} multi=${c.multi} seeds=${c.seeds}`); continue; }
      const p = await probe(c);
      if (!p.ok) { log(`  probe ${m.id} ${c.name.slice(0, 50)}: ${p.err}`); continue; }
      log(`  probe ${m.id} ${c.name.slice(0, 50)}: audio [${p.langs.join(',')}] ${Math.round(p.seconds / 60)}min`);
      // a keyword release was matched by name only: its duration must fit this film's runtime
      if (p.hebrew && c.kw && !durationFits(p.seconds, await runtimeOf(m.id))) { log(`  mismatch ${m.id} ${m.name}: file ${Math.round(p.seconds / 60)}min vs runtime ${runtimes.get(m.id)}min`); continue; }
      if (p.hebrew) {
        proven.push({ hash: c.hash, fileIdx: c.fileIdx, rel: c.name.slice(0, 120), langs: p.langs, hebOnly: p.hebOnly, size: c.size || 0 });
        // one Hebrew-default release is enough; keep probing briefly for a second (multi) option only if the first is huge
        if (p.hebOnly && proven.length >= 1) break;
        if (proven.length >= 2) break;
      }
    }
  } catch (e) {
    log(`fail ${m.id} ${m.name}: ${e.message.slice(0, 100)}`);
    entry.err = e.message.slice(0, 80);
  }
  if (proven.length) {
    proven.sort((a, b) => rank(a) - rank(b));
    const best = proven[0];
    res.items[m.id] = {
      id: m.id, type: 'movie', name: m.name, poster: m.poster, description: m.description, year: m.year, released: m.released,
      imdbRating: m.imdbRating, genres: m.genres, popRank: m.popRank,
      dubs: proven.slice(0, 2), rel: best.rel, hash: best.hash, fileIdx: best.fileIdx, langs: best.langs, hebOnly: best.hebOnly, at: Date.now(),
    };
    log(`FOUND ${m.id} ${m.name} (${m.year}) -> ${best.rel.slice(0, 70)} [${best.hebOnly ? 'hebrew default' : 'multi-audio'}]`);
  } else if (!NO_PROBE && res.items[m.id] && entry.tried.length) {
    if (res.items[m.id].miss) { delete res.items[m.id]; log(`DROP ${m.id} ${m.name}`); } else res.items[m.id].miss = 1;
  }
  res.checked[m.id] = entry;
  return proven.length > 0;
}

async function main() {
  const res = load();
  let universe = {};
  try { universe = JSON.parse(fs.readFileSync(CANDS, 'utf8')).items || {}; } catch { /* built below from cache */ }
  if (!Object.keys(universe).length) {
    for (const v of Object.values(JSON.parse(fs.readFileSync(CACHE, 'utf8')).items)) if (v.type === 'movie') universe[v.id] = { ...v, tags: ['top'] };
  }
  res.universe = universe;
  // keyword releases -> titles
  const kwByTitle = new Map();
  if (!ONLY || true) {
    const rel = await keywordReleases();
    log(`keyword releases: ${rel.size}`);
    for (const [hash, r] of rel) {
      let k = res.kw[hash];
      if (!k || !Array.isArray(k.tts) || (!k.tts.length && Date.now() - k.at > DAY)) {
        const tts = await mapToImdb(r.t, r.up, res);
        k = { t: r.t.slice(0, 100), tts, at: Date.now() };
        res.kw[hash] = k;
        log(`  kw ${tts.join(',') || '----'} <- ${r.t.slice(0, 70)}`);
      } else {
        // films already mapped must still exist in the universe (dubcands.json may have been rebuilt)
        for (const tt of k.tts) if (!res.universe[tt]) { const again = await mapToImdb(r.t, r.up, res); if (!again.includes(tt)) k.tts = again; break; }
      }
      for (const tt of k.tts) { if (!kwByTitle.has(tt)) kwByTitle.set(tt, []); kwByTitle.get(tt).push({ hash, t: r.t, seeds: r.seeds, size: r.size }); }
    }
  }
  const movies = Object.values(universe).filter(m => /^tt\d+$/.test(m.id) && m.name);
  const now = Date.now();
  let todo = movies.filter(m => (!ONLY || m.id === ONLY) && needsCheck(m, res, now));
  // keyword-named films and kids films first, then the newest, then the most popular
  todo.sort((a, b) => ((kwByTitle.has(b.id) ? 1 : 0) - (kwByTitle.has(a.id) ? 1 : 0)) || (isKids(b) - isKids(a)) || (yearOf(b) - yearOf(a)) || ((a.popRank ?? 99999) - (b.popRank ?? 99999)));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  log(`universe ${movies.length}, dubbed so far ${Object.keys(res.items).length}, to check ${todo.length}, proof via ${ALLDEBRID_KEY ? 'alldebrid' : 'none'}`);
  let n = 0, found = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const m = todo[next++];
      if (await checkTitle(m, res, kwByTitle)) found++;
      n++;
      if (n % 10 === 0) { save(res); log(`${n}/${todo.length} found ${found}`); }
      await new Promise(r => setTimeout(r, 300));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, todo.length)) }, worker));
  delete res.universe;
  save(res);
  log(`done: checked ${n}, found now ${found}, dubbed total ${Object.keys(res.items).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
