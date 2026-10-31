# archive.org part of the self-updating dubbed row: Hebrew-dubbed film files people upload to archive.org.
#   discover  new items from Hebrew-dub searches -> every full-length video file -> the audio track the player opens with
#             (flagged default, else the first) must be Hebrew -> the film is identified strictly (name agrees, kids genre,
#             runtime fits, one answer only: an ambiguous name is skipped) -> Whisper on 4 clips of that track
#   health    files that disappeared (404/401) are marked dead after two failed checks in a row
# State in data/ia: ia_verified.json (proof, read by ytdub_publish.py), seen.json (items handled), dead.json
import os, re, time, urllib.parse, urllib.request
from common import (IA, REPO, load, save, log, tmdb_search, cinemeta, runtime_mins, year_of, is_kids, names_agree,
                    runtime_fits, ffprobe, ffmpeg_clip, whisper_lang, hebrew_verdict, get_json, UA)

VER, SEEN, DEAD = os.path.join(IA, 'ia_verified.json'), os.path.join(IA, 'seen.json'), os.path.join(IA, 'dead.json')
QUERIES = ['identifier:*hebdub*', 'identifier:*heb-dub*', 'identifier:*hebrew-dub*', 'identifier:*h.dub*', 'identifier:*hebrewdub*',
           'identifier:*heb.dub*', 'subject:(מדובב)', 'subject:(hebrew dub)', 'subject:(hebrew dubbed)', 'subject:(hebdub)',
           'description:(מדובב לעברית)', 'title:(מדובב)', 'title:(hebrew) AND title:(dub*)', 'description:(hebrew dub)',
           'subject:(סרט מדובב)', 'subject:(דיבוב)', 'title:(hebdub)', 'title:(דיבוב)']
VID = re.compile(r'\.(mp4|mkv|m4v|avi|mpg|mpeg|ogv)$', re.I)
MARK = re.compile(r'h\.?dub|heb[ ._-]?dub|hebrew[ ._-]?dub|מדובב|דיבוב|עברית', re.I)
HEBL = re.compile(r'^(he|heb|hebrew|iw)$', re.I)
NOISE = re.compile(r'\b(19[3-9]\d|20[0-3]\d)\b|h\.?dub|heb[ ._-]?dub(bed)?|hebrew[ ._-]?dub(bed)?|hebrew|dubbed|dub\b|dvdrip|xvid|1080p?|720p?|480p|ntsc|pal|web[ ._-]?dl|dsnp|also|english|ddp?\s*5\.?1|atmos|h\.?\s*264|x264|full movie|the movie|מדובב לעברית|מדובב|לעברית|בעברית|עברית|אנגלית|כתוביות|ו?וכתוביות|דיבוב|סרט|[\[\](){}|!+_.,:;\-–—/\\"״׳\']', re.I)


def search_items():
    found = {}
    for q in QUERIES:
        url = 'https://archive.org/advancedsearch.php?' + urllib.parse.urlencode(
            [('q', f'({q}) AND mediatype:movies'), ('fl[]', 'identifier'), ('fl[]', 'title'), ('fl[]', 'addeddate'),
             ('sort[]', 'addeddate desc'), ('rows', '200'), ('output', 'json')])
        d = get_json(url, timeout=60)
        for x in ((d or {}).get('response') or {}).get('docs') or []:
            t = x.get('title')
            found[x['identifier']] = (t[0] if isinstance(t, list) else t) or ''
    return found


def secs(x):
    try:
        if ':' in str(x):
            p = [float(t) for t in str(x).split(':')]
            return p[-1] + 60 * p[-2] + (3600 * p[-3] if len(p) > 2 else 0)
        return float(x)
    except Exception:
        return 0


def clean(s):
    return re.sub(r'\s+', ' ', NOISE.sub(' ', s)).strip()


def identify(names, year, dur):
    # every TMDB answer whose name agrees with one of ours, a kids film whose runtime fits; one answer or nothing
    hits = {}
    for q in names:
        if len(q) < 2:
            continue
        for m in tmdb_search(q)[:6]:
            tt = m.get('imdb_id')
            if not tt or not str(tt).startswith('tt') or tt in hits:
                continue
            c = None
            if not names_agree(q, m.get('name')):
                c = cinemeta(tt)
                if not names_agree(q, c.get('name')):
                    continue
            c = c or cinemeta(tt)
            y = year_of(c) or year_of(m)
            if year and y and abs(year - y) > 1:
                continue
            if not is_kids(c) or not runtime_fits(dur, runtime_mins(c)):
                continue
            hits[tt] = (m.get('name') if re.search('[א-ת]', m.get('name') or '') else c.get('name'), y)
    if len(hits) > 1 and year:
        hits = {t: v for t, v in hits.items() if v[1] and abs(v[1] - year) <= 1}
    if len(hits) != 1:
        return None, len(hits)
    tt, (he, y) = next(iter(hits.items()))
    return (tt, he, y), 1


def opener(audio):
    d = next((i for i, a in enumerate(audio) if (a.get('disposition') or {}).get('default')), 0)
    return d


def check_file(ident, title, f, many):
    url = f"https://archive.org/download/{ident}/{urllib.parse.quote(f['name'])}"
    dur = secs(f.get('length'))
    if dur and not (45 * 60 <= dur <= 180 * 60):
        return {'res': 'length %d min' % (dur / 60)}
    p = ffprobe(url)
    if not p:
        return {'res': 'ffprobe failed', 'retry': True}
    dur = dur or float((p.get('format') or {}).get('duration') or 0)
    if not (45 * 60 <= dur <= 180 * 60):
        return {'res': 'length %d min' % (dur / 60)}
    audio = [s for s in p.get('streams') or [] if s.get('codec_type') == 'audio']
    if not audio:
        return {'res': 'no audio'}
    k = opener(audio)
    tags = audio[k].get('tags') or {}
    lang, ttl = str(tags.get('language') or 'und'), str(tags.get('title') or '')
    marked = MARK.search(f['name']) or MARK.search(title)
    # one audio track in an item that says it is a Hebrew dub: the language tag is often wrong ("eng" on home-made
    # uploads), and the player has no other track to open, so the speech check decides
    if not (HEBL.match(lang) or re.search(r'hebrew|עברית', ttl, re.I) or (len(audio) == 1 and marked)):
        return {'res': f'opens {lang}'}
    base = re.sub(VID, '', f['name']).split('/')[-1]
    names = [clean(base.split(' - ')[0])]
    if not many:
        names.append(clean(title))
    yrs = [int(y) for y in re.findall(r'\b(19[3-9]\d|20[0-3]\d)\b', base + ' ' + ('' if many else title))]
    year = yrs[0] if yrs else 0
    got, n = identify([x for x in dict.fromkeys(names) if x], year, dur)
    if not got:
        return {'res': 'ambiguous name' if n > 1 else 'not identified'}
    if not many and len(names) == 2 and names[0] != names[1]:
        # the file and the item must not name different films (an item "Despicable Me 2" held another film)
        a, _ = identify([names[0]], year, dur)
        b, _ = identify([names[1]], year, dur)
        if a and b and a[0] != b[0]:
            return {'res': f'file says {a[0]}, item says {b[0]}'}
    tt, he, y = got
    seen = []
    for frac in (0.10, 0.35, 0.60, 0.85):
        wav = ffmpeg_clip(url, dur * frac, 40, track=k)
        seen.append(whisper_lang(wav) if wav else ('nodl', 0.0))
    if sum(1 for l, _ in seen if l == 'nodl') >= 3:
        return {'res': 'download failed', 'retry': True}
    if not hebrew_verdict(seen):
        return {'res': f'speech {seen}', 'tt': tt}
    return {'res': 'ok', 'tt': tt, 'he': he, 'y': y, 'url': url, 'mins': int(dur / 60), 'seen': seen, 'file': f['name']}


def discover(budget=900):
    t0, ver, seen = time.time(), load(VER, {}), load(SEEN, {})
    items = search_items()
    new = [i for i in items if not (seen.get(i) or {}).get('done')]
    added = []
    for ident in new:
        if time.time() - t0 > budget:
            break
        st = seen.setdefault(ident, {'files': {}})
        meta = get_json(f'https://archive.org/metadata/{ident}', timeout=60)
        if meta is None:
            st['tries'] = st.get('tries', 0) + 1  # restricted items answer 401/403 every time, a timeout only once
            st['done'] = st['tries'] >= 3
            continue
        if meta.get('is_dark') or not meta.get('files'):
            st.update(done=True, res='restricted or empty')
            continue
        files = []
        for f in meta['files']:
            if not VID.search(f.get('name') or '') or f.get('source') != 'original':
                continue
            if not re.search(r'\.(mp4|mkv|m4v)$', f['name'], re.I):
                # avi/mpg do not play everywhere: take archive.org's mp4 copy of the same file when it has one
                mp4 = next((d for d in meta['files'] if d.get('original') == f['name'] and d.get('name', '').lower().endswith('.mp4')), None)
                if mp4:
                    f = {**mp4, 'length': mp4.get('length') or f.get('length')}
            files.append(f)
        long = [f for f in files if not f.get('length') or secs(f['length']) >= 45 * 60]
        many = len(long) > 1
        for f in long:
            if f['name'] in st['files'] and not st['files'][f['name']].get('retry'):
                continue
            if time.time() - t0 > budget:
                break
            r = check_file(ident, items[ident], f, many)
            st['files'][f['name']] = {k: v for k, v in r.items() if k in ('res', 'tt', 'retry')}
            if r['res'] == 'ok':
                v = ver.get(r['tt'])
                u = {'url': r['url'], 'file': r['file'], 'mins': r['mins']}
                if v:
                    urls = v.get('urls') or [{'url': v['url'], 'file': v.get('file'), 'mins': v.get('mins')}]
                    if all(x['url'] != u['url'] for x in urls) and len(urls) < 2:
                        v['urls'] = urls + [u]
                else:
                    ver[r['tt']] = {'ident': ident, 'url': r['url'], 'title': items[ident][:120], 'mins': r['mins'], 'seen': r['seen'],
                                    'he': r['he'], 'y': r['y'], 'file': r['file'], 'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
                                    'note': 'auto: Hebrew opens by default, strict identity, 4-clip Whisper'}
                    added.append(r['tt'])
                    log(f'ia verified {r["tt"]} {r["he"]} | {ident} | {r["file"][:60]} | {r["seen"]}')
                save(VER, ver, indent=1)
            else:
                log(f'ia skip {ident} | {f["name"][:50]} | {r["res"]}')
        else:
            st['done'] = all(not x.get('retry') for x in st['files'].values())
            st['at'] = time.strftime('%Y-%m-%d')
        save(SEEN, seen, indent=1)
    log(f'ia discover: {len(items)} items found, {len(new)} new, films proven {len(added)}')
    return added


def alive(url):
    try:
        req = urllib.request.Request(url, headers=UA, method='HEAD')
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status < 400
    except urllib.error.HTTPError as e:
        return False if e.code in (401, 403, 404, 410) else None
    except Exception:
        return None


def health():
    items = load(os.path.join(REPO, 'docs', 'ytdub.json'), {}).get('items', {})
    dead = load(DEAD, {})
    gone = n = 0
    for tt, m in items.items():
        for u in m.get('urls') or []:
            if dead.get(u['url'], {}).get('dead'):
                continue
            n += 1
            ok = alive(u['url'])
            if ok:
                dead.pop(u['url'], None)
            elif ok is False:
                d = dead.setdefault(u['url'], {'tt': tt, 'fails': 0})
                d['fails'] += 1
                if d['fails'] >= 2:
                    d['dead'] = time.strftime('%Y-%m-%d')
                    gone += 1
                    log(f'ia dead {tt} {u["url"]}')
    save(DEAD, dead, indent=1)
    log(f'ia health: {n} files checked, newly dead {gone}')
    return gone
