// Builds docs/dubrel.json: every Hebrew-dub release we know, per film, for the Torznab feed that AIOStreams reads.
// AIOStreams resolves these torrents through his debrid service (AllDebrid), so they play like any other stream:
// instantly when cached, at full quality, no P2P. Sources: data/dub_sources.json (agent sweeps) + docs/dub.json (proven).
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'data', 'dub_sources.json');
const DUB = path.join(ROOT, 'docs', 'dub.json');
const OUT = path.join(ROOT, 'docs', 'dubrel.json');
const PEND = path.join(ROOT, 'data', 'dub_pending.json');
const RDB = path.join(ROOT, 'data', 'remuxdb_heb.json');
const HEB_NAME = /hebdub|heb[ ._-]?dub|hebrew[ ._-]?dub|dubbed[ ._-]?heb|hebrew[ ._-]?audio|also[ ._-]?hebrew|מדובב|דיבוב/i;
// Only releases that OPEN in Hebrew belong in the feed: the player starts the track flagged default (else the first).
// Multi-audio rips (SomniWare, Waves...) carry Hebrew as one track of 30 and open in English or Hindi (proved 31.10.26
// on Mufasa and Pokémon), so they stay out. RemuxDB (real probes of real files) vetoes any file whose default is not Hebrew.
let rdb = { ok: {}, notDefault: [] };
try { rdb = JSON.parse(fs.readFileSync(RDB, 'utf8')); } catch { /* optional */ }
const VETO = new Set((rdb.notDefault || []).map(h => String(h).toLowerCase()));

const films = {};
const add = (tt, meta, r) => {
  if (!/^tt\d+$/.test(tt || '') || !/^[0-9a-f]{40}$/.test(r.h)) return;
  if (VETO.has(r.h) && !r.proved) return;
  const f = films[tt] || (films[tt] = { n: meta.name || '', y: Number(meta.year) || null, r: [] });
  if (!f.n && meta.name) f.n = meta.name;
  if (!f.y && meta.year) f.y = Number(meta.year) || null;
  const old = f.r.find(x => x.h === r.h);
  if (old) { old.p = old.p || r.p; old.s = Math.max(old.s || 0, r.s || 0); old.mb = old.mb || r.mb; return; }
  f.r.push(r);
};

let src = { releases: [] };
try { src = JSON.parse(fs.readFileSync(SRC, 'utf8')); } catch { /* none yet */ }
for (const x of src.releases || []) {
  const ev = String(x.evidence || '');
  // explicit Hebrew-dub names only (Israeli dub releases open in Hebrew); multi-audio rips and weak "heb" tags stay out
  if (!HEB_NAME.test(x.name || '') || /^weak/i.test(ev)) continue;
  add(x.tt, { name: x.name && x.tt ? null : null, year: x.year }, { h: String(x.hash).toLowerCase(), n: String(x.name || '').slice(0, 160), mb: Number(x.size_mb) || 0, s: Number(x.seeds) || 0, p: /probed heb/i.test(ev) });
}
let dub = { items: {} };
try { dub = JSON.parse(fs.readFileSync(DUB, 'utf8')); } catch { /* none yet */ }
for (const [tt, v] of Object.entries(dub.items || {})) {
  for (const d of v.dubs || [{ hash: v.hash, rel: v.rel, size: v.size }]) {
    if (d && d.hash) add(tt, { ...v, name: v.enName || v.name }, { h: String(d.hash).toLowerCase(), n: String(d.rel || v.rel || v.enName || v.name).slice(0, 160), mb: Number(d.size) || 0, s: 0, p: true, d: 1, proved: true });
  }
  if (!films[tt]) continue;
  films[tt].n = v.enName || v.name || films[tt].n;
  films[tt].y = Number(v.year) || films[tt].y;
}
// waiting films (cached on AllDebrid, not yet playable): only those whose Hebrew track is the first one
let pend = { items: {} };
try { pend = JSON.parse(fs.readFileSync(PEND, 'utf8')); } catch { /* none */ }
for (const [tt, v] of Object.entries(pend.items || {})) {
  if (v.notDefault) continue;
  for (const d of v.dubs || []) if (d && d.hash && (d.hebDef || d.hebOnly)) add(tt, v, { h: String(d.hash).toLowerCase(), n: String(d.rel || v.name).slice(0, 160), mb: Number(d.size) || 0, s: 0, p: true, d: 1 });
}
// RemuxDB: files whose probed default audio track is Hebrew
for (const [tt, v] of Object.entries(rdb.ok || {})) {
  for (const r of v.r || []) add(tt, { name: v.n, year: v.y }, { h: String(r.h).toLowerCase(), n: String(r.n || v.n).slice(0, 160), mb: Number(r.mb) || 0, s: 0, p: true, d: 1 });
}
// names for q= searches: from the candidate universe when the sweep did not carry one
try {
  const cands = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dubcands.json'), 'utf8')).items || {};
  for (const [tt, f] of Object.entries(films)) if (!f.n && cands[tt]) { f.n = cands[tt].name; f.y = f.y || Number(String(cands[tt].year || '').slice(0, 4)) || null; }
} catch { /* optional */ }
let prev = {};
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')).films || {}; } catch { /* first run */ }
// an unchanged feed keeps its file, so the 20-minute updater (grow/round.py) commits only real changes
if (JSON.stringify(prev) !== JSON.stringify(films)) fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), films }));
const nrel = Object.values(films).reduce((s, f) => s + f.r.length, 0);
console.log(`dubrel: ${Object.keys(films).length} films, ${nrel} releases`);
