# One round of the self-updating "🗣️ דיבוב עברית מלא" row, every 20 minutes: either one detached `--loop` process (stops
# when the PC restarts) or, once the owner approves it, a Windows scheduled task that survives restarts. A round:
#   1. git pull (the CI scan pushes every 3 hours)
#   2. AllDebrid: node adgrow.js --once (proves cached Hebrew-dub torrents, adds them to docs/dub.json, pushes by itself)
#   3. at most ONE heavier job that is due (YouTube searches, archive.org, torrent lists, RemuxDB, health checks...)
#   4. Whisper proof for a few waiting YouTube videos
#   5. publish: docs/ytdub.json + docs/dubrel.json rebuilt; a commit + push + Pages build only when the row changed
#      (state files are backed up to git once a day)
# Run by hand: py -3.10 grow\round.py [job] [--no-ad]   (job = force one job now, e.g. yt_broad; --no-ad skips AllDebrid)
# Without the scheduled task: py -3.10 grow\round.py --loop --hours 240   (detached; stops on reboot)
import os, subprocess, sys, time, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import REPO, DATA, LOG, load, save, log
import yt_grow, ia_grow, src_grow

STATE = os.path.join(DATA, 'grow_state.json')
LOCK = os.path.join(REPO, 'grow', 'round.lock')
ADLOG = os.path.join(REPO, 'adgrow.log')
YTDUB, DUBREL = os.path.join(REPO, 'docs', 'ytdub.json'), os.path.join(REPO, 'docs', 'dubrel.json')
TRACKED = ['docs/ytdub.json', 'docs/dubrel.json', 'data/yt', 'data/ia', 'data/dub_sources.json', 'data/remuxdb_heb.json',
           'data/remuxdb_raw.json', 'data/remuxdb_seen.json']
ATTRIB = '\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
JOBS = [  # key, hours between runs, job
    ('yt_health', 24, yt_grow.health),
    ('ia_discover', 24, ia_grow.discover),
    ('torrents', 24, src_grow.torrents),
    ('yt_broad', 24, yt_grow.search_broad),
    ('yt_names', 24, yt_grow.search_names),
    ('remuxdb', 24, src_grow.remuxdb),
    ('ia_health', 24 * 7, ia_grow.health),
    ('universe', 24 * 7, src_grow.refresh_universe),
    ('ytdlp_update', 24 * 7, lambda: run([sys.executable, '-m', 'pip', 'install', '-q', '-U', 'yt-dlp'], 600)),
]


def run(cmd, timeout=1800):
    try:
        return subprocess.run(cmd, cwd=REPO, capture_output=True, timeout=timeout, encoding='utf-8', errors='replace')
    except subprocess.TimeoutExpired:
        log('timeout: ' + ' '.join(cmd)[:120])
        return None


def git(*a, timeout=300):
    return run(['git', *a], timeout)


def rotate(path, limit=5 * 1048576):
    try:
        if os.path.getsize(path) > limit:
            os.replace(path, path + '.1')
    except OSError:
        pass


def names_of(path):
    return {tt: v.get('name') or tt for tt, v in load(path, {}).get('items', {}).items()}


def publish(state, before):
    run([sys.executable, os.path.join(REPO, 'ytdub_publish.py'), os.path.join(DATA, 'yt'), os.path.join(DATA, 'ia')], 900)
    run(['node', os.path.join(REPO, 'dubrel.js')], 300)
    d = git('diff', '--quiet', '--', 'docs/ytdub.json', 'docs/dubrel.json')
    row_changed = bool(d) and d.returncode != 0
    if not row_changed and not (time.time() - state.get('backup', 0) >= 24 * 3600):
        return
    git('add', '--', *[p for p in TRACKED if os.path.exists(os.path.join(REPO, p))])
    s = git('diff', '--cached', '--quiet')
    if not s or s.returncode == 0:
        state['backup'] = time.time()
        return
    after = names_of(YTDUB)
    plus = [after[t] for t in after if t not in before]
    minus = [before[t] for t in before if t not in after]
    if plus or minus:
        msg = 'dub row auto: ' + ' '.join(x for x in (f'+{len(plus)} ({", ".join(plus[:8])})' if plus else '',
                                                   f'-{len(minus)} ({", ".join(minus[:8])})' if minus else '') if x)
    else:
        msg = 'dub row auto: sources and updater state'
    c = git('commit', '-m', msg + ATTRIB)
    if not c or c.returncode != 0:
        log('commit failed ' + ((c.stderr or c.stdout) if c else 'timeout')[-200:])
        return
    for _ in range(2):
        git('pull', '--rebase', '--autostash')
        p = git('push')
        if p and p.returncode == 0:
            break
    else:
        log('push failed ' + ((p.stderr if p else '') or '')[-200:])
        return
    state['backup'] = time.time()
    if row_changed:
        run(['gh', 'api', '-X', 'POST', 'repos/Yehudakanashti/stremio-hebrew/pages/builds'], 120)
    log(f'published: {msg}')


def main(force=None, ad=True):
    if os.path.exists(LOCK) and time.time() - os.path.getmtime(LOCK) < 3 * 3600:
        return  # the previous round is still working
    with open(LOCK, 'w') as f:
        f.write(str(os.getpid()))
    rotate(LOG)
    rotate(ADLOG)
    state = load(STATE, {})
    try:
        p = git('pull', '--rebase', '--autostash')
        if p and p.returncode != 0:
            git('rebase', '--abort')
            log('pull failed ' + (p.stderr or '')[-200:])
        before = names_of(YTDUB)
        if ad:
            a = run(['node', os.path.join(REPO, 'adgrow.js'), '--once'], 1800)
            if a and a.returncode != 0:
                log('adgrow failed ' + (a.stderr or '')[-200:])
        due =[(time.time() - state.get(k, 0) - h * 3600, k, f) for k, h, f in JOBS if k == force or (not force and time.time() - state.get(k, 0) >= h * 3600)]
        if due:
            _, key, job = max(due)  # the most overdue one
            t0 = time.time()
            try:
                job()
                state[key] = time.time()
            except Exception:
                log(f'{key} crashed: ' + traceback.format_exc()[-400:])
                state[key] = time.time() - 20 * 3600  # try again in about 4 hours
            log(f'job {key} took {int(time.time() - t0)} s')
            save(STATE, state)
        try:
            yt_grow.verify(limit=4)
        except Exception:
            log('verify crashed: ' + traceback.format_exc()[-400:])
        publish(state, before)
        save(STATE, state)
    finally:
        try:
            os.remove(LOCK)
        except OSError:
            pass


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--loop' in args:  # one long process instead of the scheduled task: a round every 20 minutes for --hours
        hours = float(args[args.index('--hours') + 1]) if '--hours' in args else 240
        end = time.time() + hours * 3600
        log(f'updater loop started for {hours:g} h')
        while time.time() < end:
            t0 = time.time()
            try:
                main(None, '--no-ad' not in args)
            except Exception:
                log('round crashed: ' + traceback.format_exc()[-400:])
            time.sleep(max(60, 20 * 60 - (time.time() - t0)))
        log('updater loop finished')
    else:
        main(next((a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] != '--hours')), None),
             '--no-ad' not in args)
