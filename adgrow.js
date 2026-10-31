// Grows the "דיבוב עברית מלא" row by itself while AllDebrid blocks new magnets (MAGNET_TOO_MANY since 31.10.26).
// Every 20 minutes: try one magnet; once AllDebrid accepts again, check candidates slowly (max 15 per round, 60 per day).
// A film joins the row only when its file is READY on AllDebrid (plays at once) and the audio track the player
// opens with (the one flagged default, else the first) is Hebrew. Uncached releases with seeders are left
// downloading on AllDebrid (max 12 at a time) and checked again when ready. Magnets it adds and rejects are deleted;
// magnets that were already in his list are never deleted. Row changes are committed, pushed and Pages is rebuilt.
// Run: node adgrow.js [--hours 48] [--once]
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const DUB = path.join(ROOT, 'docs', 'dub.json');
const DUBREL = path.join(ROOT, 'docs', 'dubrel.json');
const PEND = path.join(ROOT, 'data', 'dub_pending.json');
const RDB = path.join(ROOT, 'data', 'remuxdb_heb.json');
const STATE = path.join(ROOT, 'data', 'adgrow_state.json');
const LOG = path.join(ROOT, 'adgrow.log');
const KEY = fs.readFileSync(path.join(path.dirname(ROOT), 'alldebrid.key'), 'utf8').trim();
const AD = 'https://api.alldebrid.com';
const Q = `agent=stremio-hebrew&apikey=${encodeURIComponent(KEY)}`;
const args = process.argv.slice(2);
const HOURS = Number(args.includes('--hours') ? args[args.indexOf('--hours') + 1] : 48);
const ONCE = args.includes('--once');
const ROUND_MS = 20 * 60 * 1000;
const PER_ROUND = 15, PER_DAY = 60, MAX_DL = 12, DL_HOURS = 36;
const HEB = /^(he|heb|hebrew|iw)$/i;
const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm|mpg)$/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => { const l = `${new Date().toISOString()} ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
const norm = s => String(s || '').toLowerCase().replace(/['’"]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o, pretty) => fs.writeFileSync(f, JSON.stringify(o, null, pretty ? 1 : 0));

async function j(url, ms = 40000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return r.json();
}

function ffprobe(url) {
  return new Promise(resolve => {
    const p = spawn('ffprobe', ['-v', 'error', '-probesize', '32M', '-analyzeduration', '5M', '-rw_timeout', '45000000',
      '-show_entries', 'stream=codec_type,codec_name:stream_tags=language,title:stream_disposition=default:format=duration', '-of', 'json', url], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 120000);
    p.on('close', code => { clearTimeout(t); try { resolve(code === 0 ? JSON.parse(out) : null); } catch { resolve(null); } });
    p.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

// the file of a READY magnet: does it open in Hebrew?
async function verify(id, rel, filmName) {
  const st = await j(`${AD}/v4.1/magnet/status?${Q}&id=${id}`);
  const mg = st.data && st.data.magnets;
  if (!mg || !(mg.statusCode === 4 || /^Ready$/i.test(mg.status || ''))) return { ready: false, code: mg && mg.statusCode };
  const files = [];
  const walk = (arr, pre) => (arr || []).forEach(f => Array.isArray(f.e) ? walk(f.e, pre + f.n + '/') : files.push({ n: pre + (f.n || ''), l: f.l, s: f.s || 0 }));
  walk(mg.files, '');
  const videos = files.filter(f => f.l && VIDEO.test(f.n) && f.s > 100 * 1048576).sort((a, b) => b.s - a.s);
  let v = videos[0];
  if (videos.length > 1) {
    const toks = norm(filmName).split(' ').filter(t => t.length > 1);
    const match = videos.filter(f => { const n = norm(f.n); return toks.length && toks.filter(t => n.includes(t)).length >= Math.ceil(toks.length * 0.7); });
    if (match.length !== 1) return { ready: true, err: 'pack' };
    v = match[0];
  }
  if (!v) return { ready: true, err: 'no video' };
  const un = await j(`${AD}/v4/link/unlock?${Q}&link=${encodeURIComponent(v.l)}`);
  if (un.status !== 'success' || !un.data || !un.data.link) return { ready: true, err: 'unlock' };
  const d = await ffprobe(un.data.link);
  if (!d) return { ready: true, err: 'ffprobe' };
  const audio = (d.streams || []).filter(x => x.codec_type === 'audio');
  const langs = audio.map(x => String((x.tags && (x.tags.language || x.tags.LANGUAGE)) || 'und').toLowerCase());
  const titles = audio.map(x => String((x.tags && (x.tags.title || x.tags.TITLE)) || ''));
  const isHeb = i => HEB.test(langs[i]) || /hebrew|עברית/i.test(titles[i]) ||
    (audio.length === 1 && langs[0] === 'und' && /hebdub|heb[ ._-]?dub|hebrew|מדובב/i.test(rel.n));
  const di = audio.findIndex(x => x.disposition && x.disposition.default);
  const opener = di >= 0 ? di : 0;
  const mins = Math.round((Number(d.format && d.format.duration) || 0) / 60);
  return { ready: true, hebOpen: audio.length > 0 && isHeb(opener), langs, opener, mins, sizeMB: Math.round(v.s / 1048576), file: videos.length > 1 ? v.n : undefined };
}

async function cinemeta(tt) {
  try { return (await j(`https://v3-cinemeta.strem.io/meta/movie/${tt}.json`, 20000)).meta || {}; } catch { return {}; }
}

function git(...a) { return spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true }); }

function publish(added) {
  spawnSync(process.execPath, [path.join(ROOT, 'dubrel.js')], { cwd: ROOT, windowsHide: true });
  git('add', 'docs/dub.json', 'docs/dubrel.json', 'data/dub_pending.json');
  const msg = `dub row: +${added.length} film(s) that open in Hebrew and play now (${added.join(', ')})\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  const c = git('commit', '-m', msg);
  const p = git('push');
  spawnSync('gh', ['api', '-X', 'POST', 'repos/Yehudakanashti/stremio-hebrew/pages/builds'], { windowsHide: true });
  log(`published row +${added.length}: commit ${c.status === 0 ? 'ok' : 'FAILED ' + (c.stderr || c.stdout).slice(0, 200)} push ${p.status === 0 ? 'ok' : 'FAILED ' + (p.stderr || '').slice(0, 200)}`);
}

function candidates(state, row) {
  const rel = readJ(DUBREL, { films: {} }).films || {};
  const pend = readJ(PEND, { items: {} }).items || {};
  const rdb = readJ(RDB, { ok: {} }).ok || {};
  const out = [];
  const year = new Date().getUTCFullYear();
  // films waiting since the limit hit: their release was proved cached; the default track gets checked on arrival
  const all = { ...rel };
  for (const [tt, p] of Object.entries(pend)) {
    const d = p.dubs && p.dubs[0];
    if (!d || !d.hash) continue;
    const h = String(d.hash).toLowerCase();
    const f = all[tt] = all[tt] ? { ...all[tt], r: all[tt].r.slice() } : { n: p.name, y: Number(String(p.year || '').slice(0, 4)) || null, r: [] };
    if (!f.r.some(r => r.h === h)) f.r.push({ h, n: String(d.rel || p.name), mb: Number(d.size) || 0, s: 0 });
  }
  for (const [tt, f] of Object.entries(all)) {
    if (row[tt]) continue;
    const p = pend[tt];
    if (p && p.notDefault) continue;
    const pendHash = p && p.dubs && p.dubs[0] && String(p.dubs[0].hash).toLowerCase();
    const rdbHashes = new Set(((rdb[tt] || {}).r || []).map(r => String(r.h).toLowerCase()));
    for (const r of f.r) {
      const t = state.tried[r.h];
      if (t && t.final) continue;
      if (state.downloading[r.h]) continue;
      // priority: proved cached before > probed (RemuxDB) > seeded explicit dub releases; newer films first
      let score = 0;
      if (r.h === pendHash) score += 1000;
      if (rdbHashes.has(r.h)) score += 300;
      score += Math.min(r.s || 0, 50) * 4;
      score += Math.max(0, 30 - (year - (f.y || 1990))) * 3;
      if ((r.mb || 0) > 30000) score -= 200;
      out.push({ tt, name: f.n, year: f.y, r, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

async function round(state) {
  const today = new Date().toISOString().slice(0, 10);
  state.day = state.day === today ? state.day : today;
  state.used = state.usedDay === today ? state.used : 0;
  state.usedDay = today;
  const dub = readJ(DUB, { items: {} });
  const pend = readJ(PEND, { items: {} });
  const row = dub.items;
  const added = [];
  let list = [];
  try { list = ((await j(`${AD}/v4.1/magnet/status?${Q}`, 60000)).data || {}).magnets || []; } catch (e) { log('list failed ' + e.message); return; }
  const mine = new Map(list.map(m => [String(m.hash).toLowerCase(), m]));

  const accept = async (c, res) => {
    const meta = await cinemeta(c.tt);
    const old = pend.items[c.tt] || {};
    row[c.tt] = {
      ...old, id: c.tt, type: 'movie', name: old.name || meta.name || c.name, year: old.year || String(meta.year || c.year || '').slice(0, 4),
      released: old.released || meta.released, poster: old.poster || `https://images.metahub.space/poster/small/${c.tt}/img`,
      description: old.description || meta.description, genres: old.genres || meta.genres, imdbRating: old.imdbRating || meta.imdbRating, popRank: old.popRank ?? 99999,
      dubs: [{ hash: c.r.h, fileIdx: 0, rel: c.r.n, langs: res.langs, hebOnly: true, hebDef: true, size: res.sizeMB, ad: true, ...(res.file ? { file: res.file } : {}) }],
      rel: c.r.n, hash: c.r.h, langs: res.langs, hebOnly: true, hebDef: true, adAt: Date.now(), grownAt: new Date().toISOString(),
    };
    delete row[c.tt].pendingWhy; delete row[c.tt].notDefault;
    delete pend.items[c.tt];
    added.push(row[c.tt].name || c.tt);
    log(`ADDED ${c.tt} ${row[c.tt].name} | ${c.r.n.slice(0, 70)} | audio [${res.langs.join(',')}] opens ${res.langs[res.opener]} | ${res.mins} min`);
  };

  // 1. downloads we left running: ready now?
  for (const [h, dl] of Object.entries(state.downloading)) {
    const m = mine.get(h);
    if (!m) { delete state.downloading[h]; state.tried[h] = { at: Date.now(), res: 'download vanished', final: true }; continue; }
    if (row[dl.tt]) { if (dl.ours) await j(`${AD}/v4/magnet/delete?${Q}&id=${m.id}`).catch(() => {}); delete state.downloading[h]; continue; }
    const res = await verify(m.id, { n: dl.n }, dl.name).catch(e => ({ err: e.message }));
    if (res.ready) {
      delete state.downloading[h];
      if (res.hebOpen && res.mins > 40) await accept({ tt: dl.tt, name: dl.name, year: dl.year, r: { h, n: dl.n } }, res);
      else { state.tried[h] = { at: Date.now(), res: res.err || `opens ${res.langs && res.langs[res.opener]}`, final: true }; if (dl.ours) await j(`${AD}/v4/magnet/delete?${Q}&id=${m.id}`).catch(() => {}); }
    } else if (m.statusCode >= 5 || Date.now() - dl.at > DL_HOURS * 3600e3) {
      delete state.downloading[h];
      state.tried[h] = { at: Date.now(), res: `download failed (${m.status || m.statusCode})`, final: true };
      if (dl.ours) await j(`${AD}/v4/magnet/delete?${Q}&id=${m.id}`).catch(() => {});
    }
  }

  // 2. new candidates, gently
  let n = 0;
  for (const c of candidates(state, row)) {
    if (n >= PER_ROUND || state.used >= PER_DAY) break;
    if (row[c.tt]) continue;
    const have = mine.get(c.r.h);
    let id, ours = false, ready = false;
    if (have) { id = have.id; ready = have.statusCode === 4; }
    else {
      const up = await j(`${AD}/v4/magnet/upload?${Q}&magnets[]=${c.r.h}`).catch(e => ({ status: 'error', error: { code: e.message } }));
      if (up.status !== 'success') {
        const code = JSON.stringify(up.error || '');
        if (/TOO_MANY/.test(code)) { log(`still limited (${(up.error && up.error.code) || ''})`); state.limited = true; break; }
        state.tried[c.r.h] = { at: Date.now(), res: 'upload ' + code.slice(0, 80), final: false };
        continue;
      }
      if (state.limited) log('AllDebrid accepts magnets again');
      state.limited = false;
      n++; state.used++;
      const m = up.data.magnets[0];
      if (!m || m.error) { state.tried[c.r.h] = { at: Date.now(), res: 'magnet error', final: true }; continue; }
      id = m.id; ours = true; ready = !!m.ready;
    }
    if (ready) {
      const res = await verify(id, c.r, c.name).catch(e => ({ err: e.message }));
      if (res.ready && res.hebOpen && res.mins > 40) { await accept(c, res); continue; }
      state.tried[c.r.h] = { at: Date.now(), res: res.err || (res.ready ? `opens ${res.langs && res.langs[res.opener]}` : 'not ready'), final: true };
      if (ours) await j(`${AD}/v4/magnet/delete?${Q}&id=${id}`).catch(() => {});
      log(`rejected ${c.tt} ${c.name} | ${c.r.n.slice(0, 60)} | ${state.tried[c.r.h].res}`);
    } else if ((c.r.s || 0) >= 1 && Object.keys(state.downloading).length < MAX_DL) {
      state.downloading[c.r.h] = { id, tt: c.tt, name: c.name, year: c.year, n: c.r.n, at: Date.now(), ours };
      log(`downloading ${c.tt} ${c.name} | ${c.r.n.slice(0, 60)} | seeders ${c.r.s}`);
    } else {
      state.tried[c.r.h] = { at: Date.now(), res: 'not cached, no seeders', final: true };
      if (ours) await j(`${AD}/v4/magnet/delete?${Q}&id=${id}`).catch(() => {});
    }
    await sleep(8000);
  }

  writeJ(PEND, pend, true);
  if (added.length) {
    dub.items = row;
    dub.generatedAt = new Date().toISOString();
    writeJ(DUB, dub);
    publish(added);
  }
  log(`round: row ${Object.keys(row).length} | added ${added.length} | uploads today ${state.used}/${PER_DAY} | downloading ${Object.keys(state.downloading).length}${state.limited ? ' | AllDebrid still limited' : ''}`);
}

(async () => {
  const end = Date.now() + HOURS * 3600e3;
  const state = readJ(STATE, { tried: {}, downloading: {}, used: 0 });
  state.tried = state.tried || {}; state.downloading = state.downloading || {};
  do {
    try { await round(state); } catch (e) { log('round error ' + (e && e.stack || e)); }
    writeJ(STATE, state, true);
    if (ONCE) break;
    await sleep(ROUND_MS);
  } while (Date.now() < end);
  log('adgrow finished');
  process.exit(0);
})();
