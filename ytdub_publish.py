# docs/ytdub.json from the YouTube dub pipeline (scratchpad yt/verified.json + names.json): full Hebrew-dubbed films on
# YouTube whose speech was detected as Hebrew by Whisper on clips cut from inside the film. Each entry carries the
# catalog meta the Worker's dubbed row needs (Hebrew name/synopsis from TMDB he-IL, poster, year, rating).
# Usage: python ytdub_publish.py <dir with verified.json and names.json>
import json, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # Hebrew/emoji titles on a cp1255 console

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1]
OUT = os.path.join(ROOT, 'docs', 'ytdub.json')
TMDB_HE = 'https://tmdb.elfhosted.com/%7B%22language%22%3A%22he-IL%22%7D/meta/movie/{}.json'
CINE = 'https://v3-cinemeta.strem.io/meta/movie/{}.json'
HEB = re.compile('[֐-׿]')
ver = json.load(open(os.path.join(SRC, 'verified.json'), encoding='utf-8'))
names = json.load(open(os.path.join(SRC, 'names.json'), encoding='utf-8'))
cands = json.load(open(os.path.join(ROOT, 'data', 'dubcands.json'), encoding='utf-8'))['items']
try:
    old = json.load(open(OUT, encoding='utf-8')).get('items', {})
except Exception:
    old = {}

def get(url):
    for a in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode('utf-8')).get('meta') or {}
        except Exception:
            time.sleep(2 * (a + 1))
    return {}

def build(tt):
    v = ver[tt]['ok']
    prev = old.get(tt, {})
    keep = [x for x in prev.get('yt', []) if x['id'] != v['id']]
    yt = [{'id': v['id'], 'ch': v.get('ch', ''), 'dur': v.get('dur'), 'title': v.get('title', '')[:120]}] + keep
    if prev.get('name') and HEB.search(prev.get('name', '')):
        return tt, {**prev, 'yt': yt[:2]}
    he, c = get(TMDB_HE.format(tt)), get(CINE.format(tt))
    n = names.get(tt, {})
    cd = cands.get(tt, {})
    return tt, {
        'id': tt, 'type': 'movie',
        'name': (he.get('name') if HEB.search(he.get('name') or '') else None) or n.get('he') or c.get('name') or n.get('en'),
        'enName': c.get('name') or n.get('en'),
        'poster': f'https://images.metahub.space/poster/small/{tt}/img',
        'description': (he.get('description') if HEB.search(he.get('description') or '') else None) or c.get('description') or '',
        'year': str(c.get('year') or n.get('year') or '')[:4], 'released': c.get('released'),
        'genres': c.get('genres') or cd.get('genres'), 'imdbRating': c.get('imdbRating'),
        'popRank': cd.get('popRank', 99999), 'yt': yt[:2], 'ytAt': ver[tt].get('at'),
    }

ok = [tt for tt, v in ver.items() if v.get('ok')]
tok = lambda s: set(t for t in re.sub(r'[^0-9a-zא-ת]+', ' ', str(s or '').lower()).split() if len(t) > 1)
toks = lambda s: [t for t in re.sub(r'[^0-9a-zא-ת]+', ' ', str(s or '').lower()).split()]
heb_name = lambda tt: (names.get(tt) or {}).get('he') or ver[tt]['ok'].get('he') or ''
# franchise main titles ("הפוני הקטן שלי", "ברבי") shared by several films
mains = {}
for t, f in names.items():
    if f.get('he'):
        mains.setdefault(f['he'].partition(':')[0].strip(), set()).add(t)

def strict_ok(tt):
    he, title = heb_name(tt), ver[tt]['ok'].get('title') or ''
    vt, ht = toks(title), toks(he)
    # sequel guard: a small number in the video title ("גשם של פלאפל 2") must be in the film's name
    if {t for t in vt if t.isdigit() and len(t) <= 2} - {t for t in ht if t.isdigit()}:
        return False
    main, _, sub = he.partition(':')
    sw = [t for t in toks(sub) if len(t) > 1 and not t.isdigit()]
    if sw and len(mains.get(main.strip(), ())) > 1:
        has = lambda w: any(x == w or x == 'ה' + w or x == 'ו' + w for x in vt)
        if sum(has(w) for w in sw) < max(1, -(-len(sw) * 6 // 10)):
            return False
    return True

for tt in list(ok):
    if not strict_ok(tt):
        ok.remove(tt)
        print('strict gate dropped', tt, heb_name(tt), '<-', ver[tt]['ok'].get('title', '')[:60])
# one video belongs to one film: when a video was matched to several films keep the one whose Hebrew title shares
# the most words with the video title (the longer, more specific name)
by_vid = {}
for tt in ok:
    by_vid.setdefault(ver[tt]['ok']['id'], []).append(tt)
for vid, tts in by_vid.items():
    if len(tts) > 1:
        title = tok(ver[tts[0]]['ok'].get('title'))
        best = max(tts, key=lambda t: (len(tok((names.get(t) or {}).get('he')) & title), len(tok((names.get(t) or {}).get('he')))))
        for t in tts:
            if t != best:
                ok.remove(t)
        print('video', vid, 'kept for', best, 'dropped', [t for t in tts if t != best])
with ThreadPoolExecutor(max_workers=4) as ex:
    items = dict(ex.map(build, ok))
for tt, v in old.items():  # keep earlier proven films (a later run may only add)
    items.setdefault(tt, v)
json.dump({'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'items': items},
          open(OUT, 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
print('ytdub: %d films' % len(items))
