# Shared helpers for the self-updating dubbed row (grow/round.py runs every 20 minutes on the owner's PC).
# Run everything with py -3.10: faster-whisper and yt-dlp both live there.
import json, math, os, re, subprocess, sys, time, urllib.parse, urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO, 'data')
YT = os.path.join(DATA, 'yt')
IA = os.path.join(DATA, 'ia')
LOG = os.path.join(REPO, 'grow', 'grow.log')
CLIPS = os.path.join(REPO, 'grow', 'clips')
TMDB = 'https://tmdb.elfhosted.com/%7B%22language%22%3A%22he-IL%22%7D'
CINE = 'https://v3-cinemeta.strem.io'
HEB = re.compile('[֐-׿]')
UA = {'User-Agent': 'Mozilla/5.0'}
for d in (YT, IA, CLIPS):
    os.makedirs(d, exist_ok=True)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def log(msg):
    line = time.strftime('%Y-%m-%dT%H:%M:%S') + ' ' + str(msg)
    print(line, flush=True)
    with open(LOG, 'a', encoding='utf-8', newline='\n') as f:
        f.write(line + '\n')


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def save(path, obj, indent=None):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent)
    os.replace(tmp, path)


def get_json(url, timeout=30, tries=3, headers=None, data=None):
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, **(headers or {})}, data=data)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404):
                return None
            time.sleep(3 * (a + 1))
        except Exception:
            time.sleep(3 * (a + 1))
    return None


def cinemeta(tt):
    return ((get_json(f'{CINE}/meta/movie/{tt}.json') or {}).get('meta')) or {}


def tmdb_he(tt):
    return ((get_json(f'{TMDB}/meta/movie/{tt}.json') or {}).get('meta')) or {}


def tmdb_search(q):
    return ((get_json(f'{TMDB}/catalog/movie/tmdb.search/search={urllib.parse.quote(q)}.json') or {}).get('metas')) or []


def cinemeta_search(q):
    return ((get_json(f'{CINE}/catalog/movie/top/search={urllib.parse.quote(q)}.json') or {}).get('metas')) or []


def runtime_mins(meta):
    m = re.search(r'\d+', str(meta.get('runtime') or ''))
    return int(m.group(0)) if m else 0


def year_of(meta):
    m = re.search(r'(19|20)\d\d', str(meta.get('year') or meta.get('releaseInfo') or meta.get('released') or ''))
    return int(m.group(0)) if m else 0


def is_kids(meta):
    # the row is for children: animation or family films only
    return bool(set(meta.get('genres') or meta.get('genre') or []) & {'Animation', 'Family'})


def runtime_fits(secs, mins):
    return not mins or not secs or (0.8 * mins * 60 <= secs <= mins * 60 * 1.25 + 600)


STOP = {'של', 'את', 'עם', 'על', 'הסרט', 'סרט', 'the', 'and', 'of', 'a'}
tok = lambda s: [t for t in re.sub(r'[^0-9a-zא-ת]+', ' ', str(s or '').lower().replace('׳', "'")).split() if t not in STOP and (len(t) > 1 or t.isdigit())]


def title_match(he, title):
    # every word of a short Hebrew title, 80% of a long one, must be in the video title; a sequel number alone never
    # counts ("גשם של פלאפל 2" once matched Zootopia 2 and Sing 2 through the "2"); digits must all be there.
    # Main title = before ":"; a one-word main title ("ברבי:", "פוקימון:") also needs most of its subtitle.
    main, _, sub = str(he).partition(':')
    mt, st = tok(main), [t for t in tok(sub) if not t.isdigit()]
    words = [t for t in mt if not t.isdigit()]
    vt = set(tok(title))
    if not words:
        return False
    has = lambda t: t in vt or ('ה' + t) in vt or ('ו' + t) in vt or (t[:1] in 'הו' and len(t) > 2 and t[1:] in vt)
    need = len(words) if len(words) <= 3 else math.ceil(len(words) * 0.8)
    if sum(has(t) for t in words) < need or not all(t in vt for t in mt if t.isdigit()):
        return False
    if st and len(words) == 1 and sum(has(t) for t in st) < math.ceil(len(st) * 0.6):
        return False
    return True


def names_agree(a, b):
    # both directions: most words of each name appear in the other, and the numbers are the same
    ta, tb = tok(a), tok(b)
    if not ta or not tb:
        return False
    sa, sb = set(ta), set(tb)
    if {t for t in ta if t.isdigit()} != {t for t in tb if t.isdigit()}:
        return False
    return sum(t in sb for t in ta) >= max(1, round(len(ta) * 0.8)) and sum(t in sa for t in tb) >= max(1, round(len(tb) * 0.6))


_model = None


def whisper_lang(wav):
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel('base', device='cpu', compute_type='int8')
    try:
        _, info = _model.transcribe(wav, language=None, vad_filter=True, beam_size=1, without_timestamps=True)
        return info.language, round(float(info.language_probability), 2)
    except Exception:
        return 'err', 0.0


def hebrew_verdict(seen, need=2):
    # identical ('en', 0.58) = silent/failed clip; songs and credits come out de/fr/nl: several clips, a majority rule
    heb = sum(1 for l, p in seen if l == 'he' and p >= 0.6)
    other = any(l not in ('he', 'nodl', 'err') and p >= 0.85 for l, p in seen)
    return heb >= need and not other


def ffmpeg_clip(url, start, secs=40, track=None):
    wav = os.path.join(CLIPS, 'c_%d.wav' % os.getpid())
    if os.path.exists(wav):
        os.remove(wav)
    cmd = ['ffmpeg', '-v', 'error', '-y', '-ss', str(int(start)), '-t', str(secs), '-i', url]
    cmd += (['-map', f'0:a:{track}'] if track is not None else ['-vn'])
    cmd += ['-ac', '1', '-ar', '16000', wav]
    try:
        subprocess.run(cmd, capture_output=True, timeout=300)
    except subprocess.TimeoutExpired:
        return None
    return wav if os.path.exists(wav) and os.path.getsize(wav) > 200000 else None


def ffprobe(url):
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                              'stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default:format=duration',
                              '-of', 'json', url], capture_output=True, timeout=180, encoding='utf-8', errors='replace').stdout
        return json.loads(out)
    except Exception:
        return None


def ytdlp(*args, timeout=180):
    try:
        return subprocess.run([sys.executable, '-m', 'yt_dlp', '--no-warnings', *args], capture_output=True, timeout=timeout,
                              encoding='utf-8', errors='replace')
    except subprocess.TimeoutExpired:
        return None


def due(state, key, hours):
    return time.time() - state.get(key, 0) >= hours * 3600
