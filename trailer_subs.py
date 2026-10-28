# Hebrew subtitles for trailers that have no subtitled (Israeli distributor) version in TMDB.
# For each such title: take the English trailer (Cinemeta), prefer YouTube's human Hebrew caption track,
# otherwise translate the English captions (manual, else auto) with Google Translate, and write docs/subs/<tt>.vtt.
# docs/subs/index.json: { generatedAt, items: { tt: { yt, kind: "h" (human track) | "m" (machine), at } } }
# Runs on the PC (YouTube blocks datacenter IPs). Flags: --limit N, --only tt123, --force.
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(ROOT, "docs", "index.json")
HE = os.path.join(ROOT, "docs", "he.json")
SUBS_DIR = os.path.join(ROOT, "docs", "subs")
SUBS_INDEX = os.path.join(SUBS_DIR, "index.json")
CINEMETA = "https://v3-cinemeta.strem.io/meta/{type}/{id}.json"
DAY = 86400
UA = "stremio-hebrew trailer_subs (github.com/Yehudakanashti/stremio-hebrew)"

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)

def http_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))

def cinemeta_trailer(type_, id_):
    try:
        meta = http_json(CINEMETA.format(type=type_, id=id_)).get("meta") or {}
    except Exception:
        return None
    ids = [t.get("ytId") for t in meta.get("trailerStreams") or []] + [t.get("source") for t in meta.get("trailers") or []]
    ids = [i for i in ids if i and re.fullmatch(r"[\w-]{11}", i)]
    return ids[0] if ids else None

def ytdlp_info(yt):
    r = subprocess.run([sys.executable, "-m", "yt_dlp", "-j", "--no-download", "--no-warnings", "--socket-timeout", "20",
                        f"https://www.youtube.com/watch?v={yt}"], capture_output=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.decode("utf-8", "replace").strip()[-200:])
    return json.loads(r.stdout.decode("utf-8", "replace").strip().splitlines()[-1])

def fetch_json3(tracks, langs):
    # tracks = info["subtitles"] or info["automatic_captions"]; returns parsed json3 for the first matching language
    for lang in langs:
        for t in tracks.get(lang) or []:
            if t.get("ext") == "json3":
                try:
                    return http_json(t["url"], 60)
                except Exception:
                    continue
    return None

NOISE = re.compile(r"\[[^\]]*\]|\([^)]*\)|♪|>>|^\s*-\s+")  # [Music], (applause), ♪ lyric markers, >> speaker marks

def cues_from_json3(d, max_chars=42, max_gap_ms=900):
    # Build readable cues from YouTube's word/segment events (auto captions roll word by word).
    words = []
    for ev in d.get("events") or []:
        if ev.get("aAppend") or "segs" not in ev:
            continue
        start = ev.get("tStartMs", 0)
        for s in ev["segs"]:
            txt = NOISE.sub("", (s.get("utf8") or "").replace("\n", " ")).strip()
            if not txt:
                continue
            words.append((start + (s.get("tOffsetMs") or 0), txt))
    cues, cur, cur_start, last_t = [], [], None, None
    for t, w in words:
        if cur and (len(" ".join(cur)) + len(w) + 1 > max_chars or t - last_t > max_gap_ms):
            cues.append((cur_start, last_t + 600, " ".join(cur)))
            cur, cur_start = [], None
        if cur_start is None:
            cur_start = t
        cur.append(w); last_t = t
    if cur:
        cues.append((cur_start, last_t + 1500, " ".join(cur)))
    # end never past the next start
    out = []
    for i, (s, e, txt) in enumerate(cues):
        if i + 1 < len(cues):
            e = min(e, cues[i + 1][0])
        out.append((s, max(e, s + 700), txt))
    return out

def cues_from_manual_json3(d):
    cues = []
    for ev in d.get("events") or []:
        if "segs" not in ev:
            continue
        txt = NOISE.sub("", " ".join((s.get("utf8") or "") for s in ev["segs"]).replace("\n", " ")).strip()
        txt = re.sub(r"\s+", " ", txt)
        if txt:
            cues.append((ev.get("tStartMs", 0), ev.get("tStartMs", 0) + (ev.get("dDurationMs") or 2000), txt))
    return cues

def translate(lines, src="en", dst="iw"):
    out = []
    for i in range(0, len(lines), 40):
        chunk = lines[i:i + 40]
        q = "&".join("q=" + urllib.parse.quote(x) for x in chunk)
        url = f"https://translate.googleapis.com/translate_a/t?client=gtx&sl={src}&tl={dst}&{q}"
        for attempt in range(4):
            try:
                res = http_json(url, 40)
                break
            except Exception as e:
                time.sleep(3 * (attempt + 1))
        else:
            raise RuntimeError("translate failed")
        # response: ["tr", ...] or [["tr","src"], ...] depending on the endpoint mood
        for item in (res if isinstance(res, list) else [res]):
            out.append(item[0] if isinstance(item, list) else str(item))
        time.sleep(0.4)
    if len(out) != len(lines):
        raise RuntimeError(f"translate count mismatch {len(out)} != {len(lines)}")
    return out

def ts(ms):
    return "%02d:%02d:%02d.%03d" % (ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000)

def write_vtt(path, cues):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("WEBVTT\n\n")
        for i, (s, e, txt) in enumerate(cues, 1):
            f.write(f"{i}\n{ts(s)} --> {ts(e)}\n{txt}\n\n")

def process(m, force=False):
    yt = cinemeta_trailer(m["type"], m["id"])
    if not yt:
        return {"at": time.time(), "yt": None, "kind": None}
    info = ytdlp_info(yt)
    manual = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    he_track = fetch_json3(manual, ["he", "iw", "he-IL"])
    if he_track:
        cues = cues_from_manual_json3(he_track)
        if cues:
            write_vtt(os.path.join(SUBS_DIR, m["id"] + ".vtt"), cues)
            return {"at": time.time(), "yt": yt, "kind": "h"}
    en = fetch_json3(manual, ["en", "en-US", "en-GB"])
    cues = cues_from_manual_json3(en) if en else None
    if not cues:
        en = fetch_json3(auto, ["en", "en-orig", "en-US"])
        cues = cues_from_json3(en) if en else None
    if not cues:
        return {"at": time.time(), "yt": yt, "kind": None}
    heb = translate([c[2] for c in cues])
    write_vtt(os.path.join(SUBS_DIR, m["id"] + ".vtt"), [(s, e, t) for (s, e, _), t in zip(cues, heb)])
    return {"at": time.time(), "yt": yt, "kind": "m"}

def main():
    os.makedirs(SUBS_DIR, exist_ok=True)
    items = json.load(open(INDEX, encoding="utf-8"))["items"]
    he = json.load(open(HE, encoding="utf-8"))["items"]
    try:
        subs = json.load(open(SUBS_INDEX, encoding="utf-8"))
    except Exception:
        subs = {"items": {}}
    subs.setdefault("items", {})
    args = sys.argv[1:]
    only = args[args.index("--only") + 1] if "--only" in args else None
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    force = "--force" in args
    now = time.time()
    def stale(e):
        if not e or force:
            return True
        return (now - e.get("at", 0) > 30 * DAY) if e.get("kind") else (now - e.get("at", 0) > 7 * DAY)
    todo = [m for m in items if (not only or m["id"] == only)
            and not (he.get(m["id"]) or {}).get("tr")            # has a subtitled trailer already
            and stale(subs["items"].get(m["id"]))]
    if limit:
        todo = todo[:limit]
    log(f"titles {len(items)}, without subtitled trailer {sum(1 for m in items if not (he.get(m['id']) or {}).get('tr'))}, to process {len(todo)}")
    done = 0
    def work(m):
        try:
            return m["id"], process(m, force)
        except Exception as e:
            log("fail", m["id"], str(e)[:120])
            return m["id"], None
    with ThreadPoolExecutor(3) as ex:
        for id_, res in ex.map(work, todo):
            done += 1
            if res:
                subs["items"][id_] = res
            if done % 25 == 0:
                log(f"{done}/{len(todo)}")
                subs["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                json.dump(subs, open(SUBS_INDEX, "w", encoding="utf-8"), ensure_ascii=False)
    subs["generatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    json.dump(subs, open(SUBS_INDEX, "w", encoding="utf-8"), ensure_ascii=False)
    vals = list(subs["items"].values())
    log(f"done: human {sum(1 for v in vals if v.get('kind') == 'h')}, machine {sum(1 for v in vals if v.get('kind') == 'm')}, none {sum(1 for v in vals if not v.get('kind'))}")

if __name__ == "__main__":
    main()
