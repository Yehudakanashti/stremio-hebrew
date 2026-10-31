# Torrent part of the self-updating dubbed row. These releases play through his AllDebrid (adgrow.js proves each one:
# cached, opens in Hebrew, full length); this file only finds them.
#   torrents  new explicit Hebrew-dub releases (HebDub / Hebrew Dubbed) on apibay and Knaben -> film identified on Cinemeta
#             (name agrees, year fits, kids genre, one answer only) -> data/dub_sources.json releases
#   remuxdb   RemuxDB (public probes of real files) re-checked film by film, each again after ~a month -> files whose
#             default audio track is Hebrew -> data/remuxdb_heb.json (ok + notDefault veto list)
#   universe  Cinemeta's kids films refreshed (dub_candidates.js) + Hebrew titles for new ones (data/yt/names.json)
import json, os, re, subprocess, time, urllib.parse
from common import (REPO, DATA, YT, load, save, log, get_json, cinemeta, cinemeta_search, tmdb_he, names_agree, year_of,
                    is_kids, runtime_mins, HEB)

SRC = os.path.join(DATA, 'dub_sources.json')
RAW, RSEEN, RDB = os.path.join(DATA, 'remuxdb_raw.json'), os.path.join(DATA, 'remuxdb_seen.json'), os.path.join(DATA, 'remuxdb_heb.json')
CANDS = os.path.join(DATA, 'dubcands.json')
NAMES = os.path.join(YT, 'names.json')
HEB_NAME = re.compile(r'hebdub|heb[ ._-]?dub|hebrew[ ._-]?dub|dubbed[ ._-]?heb|hebrew[ ._-]?audio|also[ ._-]?hebrew|מדובב|דיבוב', re.I)
SERIES = re.compile(r'\bS\d{1,2}(E\d{1,3})?\b|\bseason\b|\bcomplete\b|עונה|פרק', re.I)
QUERIES = ['hebdub', 'hebrew dubbed', 'heb dub', 'hebrew dub']


def film_of(name):
    # "Inside Out 2 2024 1080p iT WEB-DL HebDub ..." -> ("Inside Out 2", 2024)
    s = re.sub(r'[._]+', ' ', name)
    m = re.search(r'^(.*?)[\s(\[]+((?:19|20)\d\d)\b', s)
    if not m:
        return None, 0
    return re.sub(r'\s+', ' ', m.group(1)).strip(' -'), int(m.group(2))


def map_tt(title, year, cache):
    key = f'{title}|{year}'
    if key in cache:
        return cache[key]
    hits = []
    for m in cinemeta_search(title)[:8]:
        if not str(m.get('id', '')).startswith('tt'):
            continue
        y = year_of(m)
        if not y or abs(y - year) > 1 or not names_agree(title, m.get('name')):
            continue
        hits.append(m['id'])
    tt = None
    if len(hits) == 1:
        c = cinemeta(hits[0])
        tt = hits[0] if is_kids(c) else None
    cache[key] = tt
    return tt


def torrents():
    src = load(SRC, {'releases': [], 'titles': []})
    have = {str(r.get('hash', '')).lower() for r in src.get('releases', [])}
    found = {}
    for q in QUERIES:
        for x in get_json('https://apibay.org/q.php?' + urllib.parse.urlencode({'q': q}), timeout=40) or []:
            h = str(x.get('info_hash') or '').lower()
            if re.fullmatch(r'[0-9a-f]{40}', h) and h != '0' * 40:
                found[h] = {'name': x.get('name') or '', 'seeds': int(x.get('seeders') or 0), 'size_mb': int(int(x.get('size') or 0) / 1048576),
                            'imdb': x.get('imdb') or '', 'from': 'apibay'}
        body = json.dumps({'search_type': '100%', 'search_field': 'title', 'query': q, 'order_by': 'date', 'order_direction': 'desc',
                           'size': 300, 'hide_unsafe': True, 'hide_xxx': True}).encode()
        for x in (get_json('https://api.knaben.org/v1', timeout=40, data=body, headers={'Content-Type': 'application/json'}) or {}).get('hits') or []:
            h = str(x.get('hash') or '').lower()
            if re.fullmatch(r'[0-9a-f]{40}', h) and h not in found:
                found[h] = {'name': (x.get('title') or '').replace('&amp;', '&'), 'seeds': int(x.get('seeders') or 0),
                            'size_mb': int(int(x.get('bytes') or 0) / 1048576), 'imdb': '', 'from': 'knaben'}
    cache, added = {}, []
    for h, r in found.items():
        if h in have or not HEB_NAME.search(r['name']) or SERIES.search(r['name']):
            continue
        title, year = film_of(r['name'])
        if not title:
            continue
        tt = map_tt(title, year, cache)
        if not tt:
            continue
        src.setdefault('releases', []).append({'tt': tt, 'name': r['name'][:200], 'hash': h, 'size_mb': r['size_mb'], 'seeds': r['seeds'],
                                               'year': year, 'evidence': f'auto-search {time.strftime("%Y-%m-%d")} ({r["from"]})'})
        have.add(h)
        added.append(f'{tt} {r["name"][:60]}')
    if added:
        save(SRC, src)
        for a in added:
            log('torrent new ' + a)
    log(f'torrents: {len(found)} Hebrew-dub releases listed, new for the queue {len(added)}')
    return len(added)


def is_heb(t):
    lang, title = str(t.get('language') or '').lower(), str(t.get('title') or '').lower()
    return lang in ('heb', 'he', 'iw', 'hebrew') or 'hebrew' in title or 'עברית' in title


def remux_versions(tt):
    for a in range(4):
        d = get_json(f'https://remuxdb.1632022.xyz/api/media/{tt}/versions', timeout=30, tries=2, headers={'x-client-id': 'heb-dub-grow'})
        if d is not None:
            return d
        time.sleep(3 * (a + 1))
    return None


def universe():
    cands = load(CANDS, {}).get('items', {})
    src = load(SRC, {'titles': []})
    names = load(NAMES, {})
    ids = {tt for tt, c in cands.items() if is_kids(c)} | {t['tt'] for t in src.get('titles', []) if t.get('tt')} | set(names)
    return ids, cands, src, names


def rebuild_rdb(raw, cands, src):
    # same rules as the first sweep: torrent files whose DEFAULT audio is Hebrew, for kids films (or an explicit dub
    # name), whose file name really is this film; Hebrew-but-not-default files go to the veto list
    titles = {t['tt']: t for t in src.get('titles', []) if t.get('tt')}
    norm = lambda s: re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower().replace("'", '').replace('&', ' and ')).split()

    def same_film(name, fn):
        nt, ft = [t for t in norm(name) if len(t) > 1 or t.isdigit()], set(norm(fn))
        return bool(nt) and not any(t.isdigit() and t not in ft for t in nt) and sum(t in ft for t in nt) >= max(1, round(len(nt) * 0.7))

    ok, veto = {}, set()
    for tt, v in raw.items():
        c = cands.get(tt, {})
        name = v.get('name') or c.get('name') or titles.get(tt, {}).get('name') or ''
        year = int(str(c.get('year') or titles.get(tt, {}).get('year') or 0)[:4] or 0) or None
        kids = is_kids(c)
        for h in v.get('hits', []):
            if h.get('kind') != 'torrent' or not h.get('hash'):
                continue
            fn = h.get('filename') or ''
            if not h.get('hebDef'):
                veto.add(h['hash'])
                continue
            if not same_film(name, fn) or not (HEB_NAME.search(fn) or kids):
                continue
            f = ok.setdefault(tt, {'n': name, 'y': year, 'r': []})
            if not any(x['h'] == h['hash'] for x in f['r']):
                f['r'].append({'h': h['hash'], 'n': fn.split('/')[-1][:160], 'mb': int((h.get('size') or 0) / 1048576), 'v': h.get('video')})
    veto -= {x['h'] for f in ok.values() for x in f['r']}
    old = load(RDB, {})
    out = {'generatedAt': old.get('generatedAt'), 'source': 'https://remuxdb.1632022.xyz', 'ok': ok, 'notDefault': sorted(veto)}
    if {k: out[k] for k in ('ok', 'notDefault')} != {k: old.get(k) for k in ('ok', 'notDefault')}:
        out['generatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        save(RDB, out, indent=1)
    return len(ok)


def remuxdb(n=90):
    ids, cands, src, names = universe()
    raw, seen = load(RAW, {}), load(RSEEN, {})
    order = sorted(ids, key=lambda tt: seen.get(tt, 0))[:n]
    checked = changed = 0
    for tt in order:
        d = remux_versions(tt)
        if d is None:
            continue
        checked += 1
        seen[tt] = int(time.time())
        hits = []
        for v in d if isinstance(d, list) else []:
            aud = [t for t in v.get('tracks', []) if t.get('kind') == 'audio']
            if not any(is_heb(t) for t in aud):
                continue
            defs = [t for t in aud if t.get('is_default')]
            opener = defs[0] if defs else aud[0]
            vid = next((t for t in v.get('tracks', []) if t.get('kind') == 'video'), {})
            for s in v.get('sources', []) or [{}]:
                hits.append({'kind': s.get('kind'), 'hash': (s.get('info_hash') or s.get('torrent_info_hash') or s.get('infohash') or '').lower() or None,
                             'filename': s.get('filename'), 'size': v.get('size'), 'hebDef': is_heb(opener),
                             'defLang': str(opener.get('language') or '?'), 'video': '%sx%s %s' % (vid.get('width'), vid.get('height'), vid.get('codec'))})
        before = json.dumps(raw.get(tt, {}).get('hits'), sort_keys=True)
        if hits:
            raw[tt] = {'name': (cands.get(tt) or {}).get('name') or (names.get(tt) or {}).get('en') or raw.get(tt, {}).get('name', ''), 'hits': hits}
        else:
            raw.pop(tt, None)
        changed += before != json.dumps(raw.get(tt, {}).get('hits'), sort_keys=True)
        time.sleep(0.5)
    save(RAW, raw)
    save(RSEEN, seen)
    films = rebuild_rdb(raw, cands, src)
    log(f'remuxdb: checked {checked} films, changed {changed}, films with a Hebrew-default file {films}')
    return changed


def refresh_universe(max_new=300):
    old_raw = open(CANDS, 'rb').read() if os.path.exists(CANDS) else b''
    old_n = len(load(CANDS, {}).get('items', {}))
    r = subprocess.run(['node', os.path.join(REPO, 'dub_candidates.js')], cwd=REPO, capture_output=True, timeout=1800,
                       encoding='utf-8', errors='replace')
    if r.returncode != 0:
        log('universe: dub_candidates.js failed ' + (r.stderr or '')[-200:])
    if len(load(CANDS, {}).get('items', {})) < 0.9 * old_n:  # Cinemeta was down: keep last week's universe
        open(CANDS, 'wb').write(old_raw)
        log('universe: refresh came back short, previous list kept')
    cands = load(CANDS, {}).get('items', {})
    names = load(NAMES, {})
    new = [tt for tt, c in cands.items() if is_kids(c) and tt not in names]
    new.sort(key=lambda tt: -int(str(cands[tt].get('year') or 0)[:4] or 0))
    for tt in new[:max_new]:
        c = cands[tt]
        he = tmdb_he(tt)
        name = he.get('name') if HEB.search(he.get('name') or '') else ''
        names[tt] = {'en': c.get('name') or '', 'year': c.get('year'), 'known': False, 'kids': True, 'he': name,
                     'mins': runtime_mins(cinemeta(tt)) or None}
    save(NAMES, names)
    log(f'universe: {len(cands)} films, {len(new)} new kids films, Hebrew titles added for {sum(1 for tt in new[:max_new] if names[tt]["he"])}')
