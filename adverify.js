// Fills the "דיבוב עברית מלא" row with films that PLAY: a Hebrew-dub release that AllDebrid already has cached (instant
// through AIOStreams) and whose file really carries a Hebrew audio track (ffprobe on the AllDebrid link).
// Input: docs/dubrel.json (every known Hebrew-dub release per film). Output: docs/dub.json items (the row).
// Budget-safe: AllDebrid allows ~1000 magnet uploads per period (MAGNET_TOO_MANY on 31.10.26), so at most --budget uploads
// per run (default 300), at most 2 per film, every probe magnet deleted at once, his own magnets never touched.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DUBREL = path.join(ROOT, 'docs', 'dubrel.json');
const OUT = path.join(ROOT, 'docs', 'dub.json');
const KEY = fs.readFileSync(path.join(path.dirname(ROOT), 'alldebrid.key'), 'utf8').trim();
const AD = 'https://api.alldebrid.com';
const Q = `agent=stremio-hebrew&apikey=${encodeURIComponent(KEY)}`;
const args = process.argv.slice(2);
const BUDGET = Number(args.includes('--budget') ? args[args.indexOf('--budget') + 1] : 300);
const CONC = 4;
const HEB = /^(he|heb|hebrew|iw)$/i;
const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm|mpg)$/i;
const log = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().replace(/['’"]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

async function j(url, ms = 40000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return r.json();
}

function ffprobe(url) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-probesize', '32M', '-analyzeduration', '5M', '-rw_timeout', '45000000',
      '-show_entries', 'stream=codec_type:stream_tags=language,title:format=duration', '-of', 'json', url], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 120000);
    p.on('close', code => { clearTimeout(t); try { resolve(code === 0 ? JSON.parse(out) : null); } catch { resolve(null); } });
    p.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

let used = 0, blocked = false;
const PRE = new Set();

async function del(id, hash) {
  if (!id || PRE.has(hash)) return;
  try { await j(`${AD}/v4/magnet/delete?${Q}&id=${id}`); } catch { /* best effort */ }
}

// one release: cached on AllDebrid? which audio tracks? (magnet deleted afterwards)
async function check(rel, filmName) {
  if (blocked || used >= BUDGET) return { skip: true };
  used++;
  let up;
  try { up = await j(`${AD}/v4/magnet/upload?${Q}&magnets[]=${rel.h}`); } catch (e) { return { err: e.message }; }
  if (up.status !== 'success') {
    if (/TOO_MANY/.test(JSON.stringify(up.error || ''))) { blocked = true; log('AllDebrid limit reached: stopping'); }
    return { err: (up.error && up.error.code) || 'upload' };
  }
  const m = up.data.magnets[0];
  if (!m || m.error) return { err: 'magnet' };
  try {
    if (!m.ready) return { cached: false };
    let mg = null;
    for (let i = 0; i < 4 && !mg; i++) {
      const st = await j(`${AD}/v4.1/magnet/status?${Q}&id=${m.id}`);
      const x = st.data && st.data.magnets;
      if (x && (x.statusCode === 4 || /^Ready$/i.test(x.status || ''))) mg = x; else await sleep(3000);
    }
    if (!mg) return { cached: false };
    const files = [];
    const walk = (arr, pre) => (arr || []).forEach(f => Array.isArray(f.e) ? walk(f.e, pre + f.n + '/') : files.push({ n: pre + (f.n || f.filename || ''), l: f.l || f.link, s: f.s || f.size || 0 }));
    walk(mg.files || mg.links, '');
    const videos = files.filter(f => f.l && VIDEO.test(f.n) && f.s > 100 * 1048576).sort((a, b) => b.s - a.s);
    let v = videos[0];
    if (videos.length > 1) {
      const toks = norm(filmName).split(' ').filter(t => t.length > 1);
      const match = videos.filter(f => { const n = norm(f.n); return toks.length && toks.filter(t => n.includes(t)).length >= Math.ceil(toks.length * 0.7); });
      if (match.length !== 1) return { cached: true, err: 'pack' };
      v = match[0];
    }
    if (!v) return { cached: true, err: 'no video' };
    const un = await j(`${AD}/v4/link/unlock?${Q}&link=${encodeURIComponent(v.l)}`);
    if (un.status !== 'success' || !un.data || !un.data.link) return { cached: true, err: 'unlock' };
    const d = await ffprobe(un.data.link);
    if (!d) return { cached: true, err: 'ffprobe' };
    const audio = (d.streams || []).filter(x => x.codec_type === 'audio');
    const langs = audio.map(x => String((x.tags && (x.tags.language || x.tags.LANGUAGE)) || 'und').toLowerCase());
    const titles = audio.map(x => String((x.tags && (x.tags.title || x.tags.TITLE)) || ''));
    const hi = langs.findIndex((l, i) => HEB.test(l) || /hebrew|עברית/i.test(titles[i]));
    const single = audio.length === 1 && langs[0] === 'und' && /hebdub|heb[ ._-]?dub|hebrew|מדובב/i.test(rel.n);
    const hebrew = hi >= 0 || single;
    return { cached: true, hebrew, hebDefault: hebrew && (audio.length === 1 || hi <= 0), langs, sizeMB: Math.round(v.s / 1048576), file: videos.length > 1 ? v.n : undefined, mins: Math.round((Number(d.format && d.format.duration) || 0) / 60) };
  } finally { await del(m.id, rel.h); }
}

async function main() {
  const films = JSON.parse(fs.readFileSync(DUBREL, 'utf8')).films || {};
  const dub = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  dub.items = dub.items || {};
  try {
    const st = await j(`${AD}/v4.1/magnet/status?${Q}`, 60000);
    for (const m of (st.data && st.data.magnets) || []) PRE.add(String(m.hash || '').toLowerCase());
  } catch { /* none */ }
  // newest films first; within a film: Hebrew-default proven releases, explicit HebDub names, then the rest
  const order = Object.entries(films).sort((a, b) => (b[1].y || 0) - (a[1].y || 0));
  const results = {};
  let next = 0, okCount = 0;
  const worker = async () => {
    while (next < order.length && !blocked && used < BUDGET) {
      const [tt, f] = order[next++];
      const rels = f.r.slice().sort((a, b) => ((b.d || 0) - (a.d || 0)) || ((b.p ? 1 : 0) - (a.p ? 1 : 0)) || ((b.s || 0) - (a.s || 0)));
      let best = null, tries = 0;
      for (const r of rels) {
        if (tries >= 2 || blocked || used >= BUDGET) break;
        tries++;
        const res = await check(r, f.n);
        if (res.skip) break;
        log(`${tt} ${String(f.n || '').slice(0, 30)} | ${r.n.slice(0, 50)} | ${res.cached ? 'CACHED' : 'not cached'}${res.err ? ' ' + res.err : ''}${res.langs ? ' audio [' + res.langs.join(',') + ']' : ''}`);
        if (res.cached && res.hebrew) { best = { r, res }; if (res.hebDefault) break; }
      }
      results[tt] = best;
      if (best) {
        okCount++;
        const old = dub.items[tt] || {};
        dub.items[tt] = {
          ...old, id: tt, type: 'movie', name: old.name || f.n, year: old.year || (f.y ? String(f.y) : undefined),
          released: old.released || (f.y ? `${f.y}-01-01T00:00:00.000Z` : undefined), poster: old.poster || `https://images.metahub.space/poster/small/${tt}/img`,
          description: old.description, genres: old.genres, imdbRating: old.imdbRating, popRank: old.popRank ?? 99999,
          dubs: [{ hash: best.r.h, fileIdx: 0, rel: best.r.n, langs: best.res.langs, hebOnly: best.res.hebDefault, size: best.res.sizeMB, ad: true, ...(best.res.file ? { file: best.res.file } : {}) }],
          rel: best.r.n, hash: best.r.h, langs: best.res.langs, hebOnly: best.res.hebDefault, adAt: Date.now(),
        };
        delete dub.items[tt].miss;
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  // the row keeps only what plays: films checked now without a cached Hebrew release leave it
  let dropped = 0;
  for (const [tt, best] of Object.entries(results)) if (!best && dub.items[tt]) { delete dub.items[tt]; dropped++; }
  dub.generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(dub));
  log(`done: uploads ${used}/${BUDGET}${blocked ? ' (stopped by AllDebrid limit)' : ''}, films checked ${Object.keys(results).length}/${order.length}, playable ${okCount}, dropped ${dropped}, row ${Object.keys(dub.items).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
