# YouTube part of the self-updating dubbed row: full Hebrew-dubbed films uploaded to YouTube.
#   search_names  rotating per-film searches ("<Hebrew title> מדובב סרט מלא"), every film again after ~a month
#   search_broad  generic Hebrew searches that catch new uploads of any film; the film is identified by TMDB search
#   verify        Whisper on clips cut from inside the video (40% / 65%): Hebrew speech or it stays out
#   health        published videos that YouTube removed are marked dead (two failed checks in a row), the row drops them
# State in data/yt: names.json (universe), cands.json (hits), verified.json (proof), searched.json, broad_seen.json, dead.json
import json, os, re, time
from common import (YT, REPO, CLIPS, load, save, log, tok, title_match, tmdb_search, cinemeta, runtime_mins, year_of,
                    is_kids, whisper_lang, ytdlp, get_json)

NAMES, CANDS, VER = os.path.join(YT, 'names.json'), os.path.join(YT, 'cands.json'), os.path.join(YT, 'verified.json')
SEARCHED, BSEEN, DEAD = os.path.join(YT, 'searched.json'), os.path.join(YT, 'broad_seen.json'), os.path.join(YT, 'dead.json')
DUB = re.compile(r'מדובב|דיבוב|dubbed|dub\b', re.I)
BAD = re.compile(r'טריילר|trailer|טיזר|teaser|קטע|קליפ|שיר |פרק \d|episode|הצצה|reaction|ריאקשן|ביקורת|review|משחק|game|gameplay|קומיקס|עונה', re.I)
NOISE = re.compile(r'\b(19[3-9]\d|20[0-3]\d)\b|מדובבים|מדובבת|מדובב|לעברית|בעברית|עברית|דיבוב|הסרט המלא|סרט מלא|המלא|סרט|לצפייה ישירה|צפייה ישירה|איכות|גבוהה|בלעדי|full movie|hd|hdtv|720p|1080p|dvdrip|movie|\bnew\b|חדש|ילדים|לילדים|מצויר|אנימציה|[|!+()\[\]{}"״׳\'#:,.\-–—_/\\]', re.I)
QUERIES = [
    'סרט מלא מדובב לעברית', 'סרט ילדים מדובב לעברית סרט מלא', 'סרט מצויר מדובב לעברית', 'סרט אנימציה מדובב לעברית',
    'סרט מדובב לעברית HD', 'הסרט המלא מדובב', 'סרט משפחה מדובב לעברית', 'סרט מלא מדובב 2026', 'סרט מלא מדובב 2025',
    'סרט מלא מדובב 2024', 'סרט מלא מדובב 2023', 'סרט מלא מדובב 2022', 'סרט מלא מדובב 2021', 'סרט מלא מדובב 2020',
    'ברבי סרט מלא מדובב', 'טינקרבל סרט מלא מדובב', 'פוקימון הסרט מדובב', 'סקובי דו הסרט מדובב', 'ספוג בוב הסרט מדובב',
    'הדרדסים סרט מדובב', "תום וג'רי הסרט מדובב", 'מיקי מאוס סרט מדובב', 'דיסני סרט מלא מדובב', 'לגו סרט מלא מדובב',
    'מפרץ ההרפתקאות הסרט מדובב', 'סרט כלבים מדובב לעברית', 'סרט חג המולד מדובב לעברית', 'סרט דינוזאורים מדובב',
    'סרט נסיכות מדובב לעברית', 'סרט קסמים מדובב לעברית', 'דרגון בול סרט מדובב', "נינג'ה גו הסרט מדובב",
    'סרט חתולים מדובב', 'סרט סוסים מדובב', 'סרט הרפתקאות מדובב לעברית', 'סרט קומדיה מדובב לעברית',
    'סרטי אנימציה מדובבים', 'סרט מלא מדובב לעברית באיכות גבוהה', 'סרט מדובב לעברית לצפייה ישירה', 'סרט מלא מדובב ישן',
]


def search(q, n=10):
    r = ytdlp('--flat-playlist', '-J', f'ytsearch{n}:{q}', timeout=180)
    if not r or r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout).get('entries') or []
    except Exception:
        return None


def score(f, e):
    title, dur, mins = e.get('title') or '', e.get('duration') or 0, f.get('mins') or 0
    if BAD.search(title) or not DUB.search(title):
        return None
    if dur < 45 * 60 or (mins and (dur < 0.75 * mins * 60 or dur > mins * 60 * 1.35 + 900)):
        return None
    if not title_match(f['he'], title):
        return None
    yrs = [int(y) for y in re.findall(r'\b(19[3-9]\d|20[0-3]\d)\b', title)]
    fy = int(str(f.get('year') or '0')[:4] or 0)
    if yrs and fy and all(abs(y - fy) > 1 for y in yrs):
        return None  # remakes share Hebrew names
    s = 10 + (5 if 'מלא' in title else 0) + min(dur / 600, 5)
    return {'id': e.get('id'), 'title': title[:140], 'dur': dur, 'ch': (e.get('channel') or e.get('uploader') or '')[:60], 's': round(s, 1)}


def in_row():
    yt = load(os.path.join(REPO, 'docs', 'ytdub.json'), {}).get('items', {})
    own = load(os.path.join(REPO, 'docs', 'dub.json'), {}).get('items', {})
    return set(yt) | set(own)


def add_hits(cands, tt, hits):
    have = {h['id'] for h in cands.get(tt) or []}
    new = [h for h in hits if h['id'] not in have]
    if new:
        cands[tt] = (cands.get(tt) or []) + new
    return len(new)


def search_names(n=60):
    names, cands, searched = load(NAMES, {}), load(CANDS, {}), load(SEARCHED, {})
    row = in_row()
    order = sorted((tt for tt, f in names.items() if f.get('he') and tt not in row),
                   key=lambda tt: (searched.get(tt, 0), not names[tt].get('known'), -int(str(names[tt].get('year') or 0)[:4] or 0)))
    found = done = 0
    for tt in order[:n]:
        f = names[tt]
        hits, failed = [], False
        for q in (f"{f['he']} מדובב סרט מלא", f"{f['he']} מדובב"):
            es = search(q)
            if es is None:
                failed = True
                break
            for e in es:
                h = score(f, e)
                if h and not any(x['id'] == h['id'] for x in hits):
                    hits.append(h)
            if hits:
                break
        if failed:
            continue  # YouTube refused or timed out: this film stays first in line
        searched[tt] = int(time.time())
        done += 1
        found += add_hits(cands, tt, sorted(hits, key=lambda h: -h['s'])[:3])
    save(CANDS, cands)
    save(SEARCHED, searched)
    log(f'yt names: searched {done} films, new videos {found}')


def identify(e, names):
    title = e.get('title') or ''
    q = re.sub(r'\s+', ' ', NOISE.sub(' ', title)).strip()
    if len(q) < 2:
        return None
    yrs = [int(y) for y in re.findall(r'\b(19[3-9]\d|20[0-3]\d)\b', title)]
    qt = tok(q)
    for m in tmdb_search(q)[:5]:
        tt = m.get('imdb_id')
        if not tt or not str(tt).startswith('tt'):
            continue
        nt = tok(m.get('name'))
        if not nt or sum(t in qt for t in nt) < max(1, round(len(nt) * 0.8)) or sum(t in nt for t in qt) < max(1, round(len(qt) * 0.6)):
            continue
        if any(t.isdigit() and t not in qt for t in nt):
            continue
        y = year_of(m)
        if yrs and y and all(abs(y - x) > 1 for x in yrs):
            continue
        c = cinemeta(tt)
        if tt not in names and not is_kids(c):
            continue  # the row is for children
        mins, dur = runtime_mins(c), e.get('duration') or 0
        if mins and (dur < 0.75 * mins * 60 or dur > mins * 60 * 1.35 + 900):
            continue
        return tt, m.get('name'), y
    return None


def search_broad():
    names, cands, seen = load(NAMES, {}), load(CANDS, {}), set(load(BSEEN, []))
    vids, ok_q = [], 0
    for q in QUERIES:
        es = search(q, 100)
        if es is None:
            continue
        ok_q += 1
        for e in es:
            if not e.get('id') or e['id'] in seen:
                continue
            seen.add(e['id'])
            t, dur = e.get('title') or '', e.get('duration') or 0
            if 45 * 60 <= dur <= 180 * 60 and DUB.search(t) and not BAD.search(t):
                vids.append(e)
    found = 0
    for e in vids:
        r = identify(e, names)
        if r:
            tt, he, y = r
            found += add_hits(cands, tt, [{'id': e['id'], 'title': (e.get('title') or '')[:140], 'dur': e.get('duration'),
                                           'ch': (e.get('channel') or '')[:60], 's': 15, 'he': he, 'y': y}])
    save(CANDS, cands)
    save(BSEEN, sorted(seen))
    log(f'yt broad: {ok_q}/{len(QUERIES)} searches, {len(vids)} new full-length dubbed videos, {found} matched to a film')


def clip(vid, start, secs=35):
    tag = os.path.join(CLIPS, f'{vid}_{start}')
    for f in os.listdir(CLIPS):
        if f.startswith(f'{vid}_{start}'):
            os.remove(os.path.join(CLIPS, f))
    ytdlp('--js-runtimes', 'node', '-q', '-f', 'bestaudio/best', '--download-sections', f'*{start}-{start + secs}',
          '--force-overwrites', '-o', tag + '.%(ext)s', f'https://www.youtube.com/watch?v={vid}', timeout=240)
    got = [os.path.join(CLIPS, f) for f in os.listdir(CLIPS) if f.startswith(f'{vid}_{start}.') and not f.endswith('.part')]
    return got[0] if got else None


def check(h):
    seen = []
    for frac in (0.40, 0.65):
        p = clip(h['id'], int((h.get('dur') or 5400) * frac))
        if not p:
            seen.append(('nodl', 0.0))
            continue
        seen.append(whisper_lang(p))
        try:
            os.remove(p)
        except OSError:
            pass
        if seen[-1][0] == 'he' and seen[-1][1] >= 0.8:
            break  # one clear Hebrew clip is enough
    heb = any(l == 'he' and p >= 0.6 for l, p in seen)
    other = any(l not in ('he', 'nodl', 'err') and p >= 0.6 for l, p in seen)
    return heb and not other, seen


def verify(limit=8):
    cands, ver = load(CANDS, {}), load(VER, {})
    todo = []
    for tt, hits in cands.items():
        v = ver.get(tt) or {}
        if v.get('ok'):
            continue
        tried = {t['id']: t for t in v.get('tried') or []}
        dead = load(DEAD, {})
        fresh = [h for h in hits if not dead.get(h['id'], {}).get('dead') and
                 (h['id'] not in tried or (tried[h['id']].get('nodl', 0) and tried[h['id']]['nodl'] < 3))]
        if fresh:
            todo.append((tt, fresh))
    added = 0
    for tt, hits in todo[:limit]:
        v = ver.setdefault(tt, {'ok': None, 'tried': []})
        for h in sorted(hits, key=lambda h: -h.get('s', 0))[:2]:
            good, seen = check(h)
            old = next((t for t in v['tried'] if t['id'] == h['id']), None)
            if all(l == 'nodl' for l, _ in seen):  # YouTube throttled the download: try again next round, 3 times at most
                if old:
                    old['nodl'] = old.get('nodl', 0) + 1
                else:
                    v['tried'].append({'id': h['id'], 'seen': seen, 'nodl': 1})
                continue
            if old:
                v['tried'].remove(old)
            v['tried'].append({'id': h['id'], 'seen': seen})
            if good:
                v['ok'] = {**h, 'seen': seen}
                added += 1
                log(f'yt verified {tt} {h.get("title", "")[:60]} | {seen}')
                break
        v['at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        save(VER, ver)
    log(f'yt verify: checked {min(len(todo), limit)} of {len(todo)} films waiting, Hebrew proven {added}')
    return added


def health():
    items = load(os.path.join(REPO, 'docs', 'ytdub.json'), {}).get('items', {})
    dead = load(DEAD, {})
    gone = 0
    for tt, m in items.items():
        for y in m.get('yt') or []:
            vid = y['id']
            if dead.get(vid, {}).get('dead'):
                continue
            r = get_json(f'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json', tries=2)
            if r:
                dead.pop(vid, None)
                continue
            p = ytdlp('--js-runtimes', 'node', '--skip-download', '--print', 'id', f'https://www.youtube.com/watch?v={vid}', timeout=120)
            if not p:
                continue  # timed out: no verdict
            if p.returncode == 0 and vid in (p.stdout or ''):
                dead.pop(vid, None)  # oEmbed refused (embedding off) but the video plays
                continue
            msg = (p.stderr or '')[-200:]
            if not re.search(r'unavailable|private|removed|terminated|not available|does not exist', msg, re.I):
                continue  # a network hiccup, not a verdict
            d = dead.setdefault(vid, {'tt': tt, 'fails': 0})
            d['fails'] += 1
            d['last'] = msg.strip()[:160]
            if d['fails'] >= 2:
                d['dead'] = time.strftime('%Y-%m-%d')
                gone += 1
                log(f'yt dead {tt} {vid}: {d["last"]}')
                # the film goes back in line: its proof is cleared and it is searched again first
                ver, searched = load(VER, {}), load(SEARCHED, {})
                v = ver.get(tt) or {}
                if (v.get('ok') or {}).get('id') == vid:
                    v.setdefault('tried', []).append({'id': vid, 'seen': v['ok'].get('seen'), 'dead': d['dead']})
                    v['ok'] = None
                    save(VER, ver)
                searched[tt] = 0
                save(SEARCHED, searched)
    save(DEAD, dead)
    log(f'yt health: {sum(len(m.get("yt") or []) for m in items.values())} videos checked, newly dead {gone}')
    return gone
