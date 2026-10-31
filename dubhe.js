// Hebrew names and synopses for the dub row (docs/dub.json), from the public TMDB addon in he-IL.
// The English name stays in enName: dubrel.js matches Torznab title searches with it.
const fs = require('fs');
const path = require('path');
const TMDB_HE = 'https://tmdb.elfhosted.com/%7B%22language%22%3A%22he-IL%22%7D';
const HEB = /[֐-׿]/;
const FILE = path.join(__dirname, 'docs', 'dub.json');

(async () => {
  const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  let names = 0, descs = 0;
  for (const [tt, v] of Object.entries(d.items || {})) {
    if (HEB.test(v.name || '') && HEB.test(v.description || '')) continue;
    try {
      const r = await fetch(`${TMDB_HE}/meta/movie/${tt}.json`, { signal: AbortSignal.timeout(15000) });
      const m = (await r.json()).meta || {};
      if (HEB.test(m.name || '') && !HEB.test(v.name || '')) { v.enName = v.enName || v.name; v.name = m.name; names++; }
      if (HEB.test(m.description || '') && !HEB.test(v.description || '')) { v.enDescription = v.enDescription || v.description; v.description = m.description; descs++; }
    } catch { /* keep English */ }
  }
  fs.writeFileSync(FILE, JSON.stringify(d));
  console.log(`dubhe: hebrew names ${names}, synopses ${descs}`);
})();
