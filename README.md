# עם עברית - Stremio catalog

Shows only movies and series that have Hebrew subtitles on Ktuvit or Wizdom.

- `scan.js` runs every 3 hours in GitHub Actions, checks popular and recent titles, and writes `data/cache.json` + `docs/`.
- `docs/` is served by GitHub Pages: the phone page, `index.json`, and static catalog files.
- `worker/` is a Cloudflare Worker that serves the addon with search and paging, reading `docs/index.json`.
