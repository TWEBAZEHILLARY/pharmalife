# PharmaLife POS — Cloudflare Worker

Repository layout:
```
.gitignore
package.json
wrangler.jsonc
README.md
src/worker.js
public/index.html
```

## Fresh redeploy (keeps your data)
1. On GitHub, delete everything in the repo (old `worker.js`, `public/`, `wrangler.jsonc`, any `index.html` or `functions/`).
2. Upload all files from this folder, keeping the `src` and `public` folders. Commit.
3. Cloudflare → Workers & Pages → pharmalife → Settings → Build: deploy command `npx wrangler deploy`, root directory `/`.
4. Cloudflare redeploys on commit. Data stays in D1 database `pharmalife-db` (ID already in `wrangler.jsonc`).
5. Open https://pinnaclepowersystems.cc or https://pharmalife.twebazehillary.workers.dev and sign in.

The custom domain is declared in `wrangler.jsonc`; if Cloudflare reports it already exists, remove the `routes` block.
