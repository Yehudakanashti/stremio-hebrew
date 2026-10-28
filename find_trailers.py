# Finds Hebrew-subtitled trailers on YouTube for titles that have none in TMDB (he.json `tr` empty).
# Search several Hebrew phrasings, filter candidates by title/duration, then PROVE burned-in Hebrew by
# grabbing short clips (yt-dlp + ffmpeg) and running Tesseract (heb) on the lower band of a few frames.
# Writes docs/yt.json: { generatedAt, items: { tt: { yt?, ch?, at, tried: [ids] } } }   (yt present = verified)
# Needs: python -m yt_dlp, ffmpeg, tesseract with heb.traineddata. Flags: --limit N, --only tt123, --force.
import json, os, re, subprocess, sys, tempfile, time, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(ROOT, "docs", "index.json")
HE = os.path.join(ROOT, "docs", "he.json")
OUT = os.path.join(ROOT, "docs", "yt.json")
DAY = 86400
HEB = re.compile(r"[\u0590-\u05FF]")
TRAILER = re.compile(r"טריילר|קדימון|טיזר|trailer|teaser", re.I)
# channels seen uploading Hebrew-titled but UNsubtitled trailers: never trust by name, but still OCR them last
LOW_PRIORITY = re.compile(r"trailer feed|^netflix$|sony pictures|ynet|walla|וואלה|mako|n12", re.I)
TESSDATA = os.environ.get("TESSDATA_DIR") or os.path.join(os.path.dirname(ROOT), "tessdata")  # heb.traineddata lives here (no admin needed)
_ocr = None
def ocr_hebrew(path):
    # tesserocr wheel = Tesseract without an installer (run with py -3.10, where it is installed)
    global _ocr
    import tesserocr
    if _ocr is None:
        _ocr = tesserocr.PyTessBaseAPI(path=TESSDATA, lang="heb", psm=tesserocr.PSM.SINGLE_BLOCK)
    _ocr.SetImageFile(path)
    return _ocr.GetUTF8Text()

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)

def run(args, timeout=180):
    return subprocess.run(args, capture_output=True, timeout=timeout)

def ytsearch(q, n=6):
    r = run([sys.executable, "-m", "yt_dlp", "--no-warnings", "--socket-timeout", "20", f"ytsearch{n}:{q}", "--flat-playlist", "-j"], 150)
    out = []
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        try:
            d = json.loads(line)
        except Exception:
            continue
        out.append({"id": d.get("id"), "title": d.get("title") or "", "ch": d.get("channel") or d.get("uploader") or "", "dur": d.get("duration") or 0})
    return out

def name_tokens(s):
    return [t for t in re.split(r"[^\w\u0590-\u05FF]+", s.lower()) if len(t) > 1]

def candidates(m, heb_title):
    queries = [f"{heb_title} טריילר מתורגם", f"{heb_title} טריילר", f"{heb_title} טריילר עם כתוביות", f"{m['name']} טריילר מתורגם"]
    if m["type"] == "series":
        queries.append(f"{heb_title} עונה 1 טריילר")
    seen, cands = set(), []
    toks = set(name_tokens(heb_title))
    for q in queries:
        for c in ytsearch(q):
            if not c["id"] or c["id"] in seen:
                continue
            seen.add(c["id"])
            t = c["title"]
            if not (20 <= c["dur"] <= 420):
                continue
            if not HEB.search(t) or not TRAILER.search(t):
                continue
            # the Hebrew title must mostly appear in the video title
            tt = set(name_tokens(t))
            if toks and len(toks & tt) < max(1, (len(toks) + 1) // 2):
                continue
            c["score"] = (0 if LOW_PRIORITY.search(c["ch"]) else 2) + (1 if re.search(r"מתורגם|כתוביות", t) else 0)
            cands.append(c)
        if len(cands) >= 4:
            break
    return sorted(cands, key=lambda c: -c["score"])[:4]

def hebrew_burned_in(yt, dur):
    # 3 one-second clips at 35/55/75% of the video; Hebrew letters found by OCR in the lower third = verified
    tmp = tempfile.mkdtemp(prefix="trl_")
    try:
        hits = 0
        for frac in (0.35, 0.55, 0.75):
            sec = max(5, int(dur * frac))
            base = os.path.join(tmp, f"c{sec}")
            run([sys.executable, "-m", "yt_dlp", "--no-warnings", "-f", "bv*[height<=480][ext=mp4]/bv*[height<=480]/bv*",
                 "--download-sections", f"*{sec}-{sec + 2}", "-o", base + ".%(ext)s", f"https://www.youtube.com/watch?v={yt}"], 180)
            clip = next((os.path.join(tmp, f) for f in os.listdir(tmp) if f.startswith(f"c{sec}.")), None)
            if not clip:
                continue
            for k, off in enumerate((0.3, 1.0, 1.7)):
                frame = f"{base}_{k}.png"
                run(["ffmpeg", "-loglevel", "error", "-y", "-ss", str(off), "-i", clip, "-frames:v", "1",
                     "-vf", "crop=iw:ih*0.4:0:ih*0.6,scale=1280:-1,negate,format=gray", frame], 60)
                if not os.path.exists(frame):
                    continue
                txt = ocr_hebrew(frame)
                if len(HEB.findall(txt)) >= 6:
                    hits += 1
                    break
            if hits >= 1:
                return True
        return False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def main():
    items = json.load(open(INDEX, encoding="utf-8"))["items"]
    he = json.load(open(HE, encoding="utf-8"))["items"]
    try:
        res = json.load(open(OUT, encoding="utf-8"))
    except Exception:
        res = {"items": {}}
    res.setdefault("items", {})
    args = sys.argv[1:]
    only = args[args.index("--only") + 1] if "--only" in args else None
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    force = "--force" in args
    now = time.time()
    def stale(e):
        return not e or force or (not e.get("yt") and now - e.get("at", 0) > 14 * DAY)
    todo = [m for m in items if (not only or m["id"] == only)
            and (he.get(m["id"]) or {}).get("t") and not (he.get(m["id"]) or {}).get("tr")
            and stale(res["items"].get(m["id"]))]
    if limit:
        todo = todo[:limit]
    log(f"to search {len(todo)}")
    found = 0
    for n, m in enumerate(todo, 1):
        heb_title = he[m["id"]]["t"]
        entry = {"at": time.time(), "tried": []}
        try:
            for c in candidates(m, heb_title):
                entry["tried"].append(c["id"])
                if hebrew_burned_in(c["id"], c["dur"]):
                    entry.update({"yt": c["id"], "ch": c["ch"], "title": c["title"][:80]})
                    found += 1
                    log("FOUND", m["id"], heb_title, "->", c["id"], c["ch"])
                    break
        except Exception as e:
            log("fail", m["id"], str(e)[:120])
        res["items"][m["id"]] = entry
        if n % 10 == 0:
            res["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
            log(f"{n}/{len(todo)} found so far {found}")
    res["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    json.dump(res, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    vals = res["items"].values()
    log(f"done: verified {sum(1 for v in vals if v.get('yt'))} of {len(res['items'])} searched")

if __name__ == "__main__":
    main()
