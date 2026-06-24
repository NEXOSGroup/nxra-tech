# Building & Deploying

*Guide for building realvirtual WEB locally for testing, publishing it with realvirtual's own pipeline, and self-hosting it on your own infrastructure.*

> **The important distinction:** *building* produces a `dist/` folder on your machine and publishes nothing. *Deploying* builds **and** uploads that build somewhere. The built-in `npm run deploy` is **realvirtual's own** publish pipeline — it targets realvirtual's Bunny CDN account and goes live at `web.realvirtual.io`. If you are not realvirtual, you do not have those credentials; see [Deploy it yourself](#7-deploy-it-yourself).

---

## 1. Local build (testing only — nothing is published)

Use these while developing or to verify a production build before it goes out. They never touch any CDN.

| Command | What it does | Where it runs |
|---------|--------------|---------------|
| `npm run dev` | Dev server with hot-module reload | `localhost:5173` |
| `npm run build` | Production build into `dist/` | your machine only |
| `npm run preview` | Serves the built `dist/` as it will look in production | `localhost:4173` |

```bash
npm run dev                  # iterate with HMR
npm run build                # produce dist/ locally
npm run preview              # check the production build before deploying
```

`npm run build` runs `vite build`, writes `dist/`, and stops. The output stays on disk — share it, inspect it, host it yourself (see section 7), or run `npm run preview` against it. Nothing is uploaded.

---

## 2. realvirtual's deploy pipeline (publishes to web.realvirtual.io)

> **This is realvirtual's own pipeline.** `npm run deploy` builds the app and uploads it to **realvirtual's** Bunny CDN account, where it goes live at `web.realvirtual.io`. It only writes to that account when `BUNNY_STORAGE_KEY` (realvirtual's secret storage-zone password) is provided. A third party does **not** have that key — a bare `npm run deploy` with no environment configured fails fast with `Missing required env BUNNY_STORAGE_KEY` before anything is uploaded. To publish your own build, point the tool at your own account or host the static files yourself — see [Deploy it yourself](#7-deploy-it-yourself).

`npm run deploy` maps to `node scripts/bunny-deploy.mjs`. It **builds** the app (public build, `VITE_PUBLIC_BUILD=1`) and then **uploads** the result to Bunny CDN.

```bash
npm run deploy                       # build + upload to the configured remote path
npm run deploy -- --path demo        # upload under a specific remote path prefix
npm run deploy -- --no-build         # upload an already-built dist/ (skip the build)
npm run deploy -- --dry-run          # show exactly what would happen, upload nothing
```

The remote path comes from `BUNNY_REMOTE_PATH` (default empty = storage-zone root, printed as `(root)/`) and can be overridden per run with `--path`.

What happens, in order:

1. **Build** — `vite build` with `VITE_PUBLIC_BUILD=1` (the private project folder is excluded from a public build).
2. **Diff** — the remote file list is fetched; unchanged files (same size) are skipped. `*.html`, `settings.json`, `models.json` and `manifest.json` are always re-uploaded. `*.map` files are never uploaded.
3. **Upload** — changed files are uploaded; assets first, `index.html` last, so the live site never points at missing assets mid-deploy.
4. **Purge** — the CDN cache is purged once (only if something was uploaded, and only when the account/pull-zone purge credentials are present).

> **Tip:** run `npm run deploy -- --dry-run` first when unsure. It prints the build mode, the target zone/path, and every file that would upload — without changing anything.

### Analytics

The committed `settings.json` ships with an empty Google Analytics id so forks send no traffic into realvirtual's property. The real id is injected into the **deployed** `settings.json` only, from the `GA_MEASUREMENT_ID` environment variable. Leave it unset for no analytics.

**Consent gate.** Google Analytics is a non-essential tracker (it sets cookies and transfers usage data to Google), so it only loads after the visitor opts in. When `analytics.googleAnalyticsId` is set, a blocking consent dialog is shown at startup and the app does not boot — and no GA script is loaded — until the visitor accepts. When no id is configured (every private/self-hosted deploy), there is no gate and nothing is tracked. Consent is persisted and can be withdrawn under **Settings → Backup → Privacy**. Optionally set `analytics.privacyPolicyUrl` in `settings.json` to show a privacy-policy link on the gate. Once granted, the viewer emits GA4 events that distinguish what the visitor looks at (`model_view`, `workspace_mode`).

---

## 3. Deploy a private project

Private customer projects publish to an unguessable URL `web.realvirtual.io/{code}/`, isolated from the public demo. Each project lives in its own folder under the private projects directory and carries its own GLB models.

```bash
npm run deploy:private -- --list                       # list available private projects
npm run deploy:private -- --project "Customer XY"      # build + publish one project
```

The private deploy stages the build together with the project's own GLBs (the public demo models are excluded), generates the project `settings.json` and `models.json`, uploads everything to `{code}/`, and uploads any extra project assets to `{code}/private-assets/`. The project's `lastPublished` timestamp is updated on success.

Set the private projects root with `--projects-dir <dir>` or the `BUNNY_PRIVATE_PROJECTS_DIR` environment variable.

> The GLB files themselves are produced in Unity (the realvirtual.io GLB export). This tool deploys existing GLBs — it does not generate them.

> The success line printed in private mode (`https://web.realvirtual.io/{code}/`) is realvirtual's own domain. On your own Bunny account the files upload correctly to your zone, but that printed URL is cosmetic — substitute your own pull-zone hostname.

---

## 4. Credentials

All credentials come from environment variables — there is no key stored in the repo. Copy `.env.example` to `.env` (gitignored) for local use, or provide the values as CI secrets.

| Variable | Required | Purpose |
|----------|----------|---------|
| `BUNNY_STORAGE_KEY` | yes | Storage-zone password (upload / list / delete). No default — committed empty |
| `BUNNY_STORAGE_ZONE` | yes | Storage-zone name. The committed `.env.example` default is realvirtual's own zone — override it with your own |
| `BUNNY_ACCOUNT_KEY` | for purge | Account API key (cache purge). If missing, purge is silently skipped; upload still succeeds |
| `BUNNY_PULL_ZONE_ID` | for purge | Pull-zone id (cache purge). If missing, purge is silently skipped |
| `BUNNY_REGION` | no | Region hostname (default `storage.bunnycdn.com`) |
| `BUNNY_REMOTE_PATH` | no | Public remote path prefix (default empty = storage-zone root) |
| `BUNNY_PRIVATE_PROJECTS_DIR` | no | Private projects root (for `--private`) |
| `GA_MEASUREMENT_ID` | no | GA4 id injected into the deployed `settings.json` (default empty = no analytics) |
| `VITE_BASE` | no | Build-time base path (default `./`). Settable per-run via `--base` |

These mirror the values configured in the Unity Editor under **Tools > realvirtual > Export > WebViewer Tools** (Publish tab, stored there as EditorPrefs). If you rotate a key, update both places so the two deploy paths stay in sync.

> Only `BUNNY_STORAGE_KEY` is the actual secret, and it is never committed. The `.env.example` zone name is just a default placeholder — without realvirtual's storage key, nothing can be written to realvirtual's account.

---

## 5. Continuous deployment

A push to `main` on realvirtual's private DEV repository triggers `.github/workflows/deploy-bunny.yml`, which runs `npm run deploy` on a runner using the **repository secrets** of that repo. No Unity is involved — the CLI builds and uploads on its own.

This workflow is hardwired to realvirtual's infrastructure: it sets `BUNNY_STORAGE_ZONE=realvitual-web`, `BUNNY_REMOTE_PATH=dev`, and a concrete `BUNNY_PULL_ZONE_ID` that only exists in realvirtual's account, then echoes `https://web.realvirtual.io/dev/`. The storage key, account key, and GA id come from GitHub secrets. A fork has none of those secrets, so this workflow will not publish anywhere on a fork until it is edited to point at the fork owner's own account.

---

## 6. Two ways to deploy, same result

| Path | When to use |
|------|-------------|
| **Unity — Tools > realvirtual > Export > WebViewer Tools (Publish tab)** | Interactive work in the Editor; uploads the current build with one click |
| **CLI — `npm run deploy`** | No Unity needed; for the console, CI/CD, and automation |

Both produce identical CDN output. The CLI is the Unity-independent path; pick whichever fits the situation.

---

## 7. Deploy it yourself

realvirtual WEB is the open standard for browser-based 3D HMI in manufacturing. You can run your own deployment two ways: reuse the built-in tool with your own Bunny account, or treat the build as plain static files and host them anywhere.

> **AGPL obligations apply to self-hosting.** realvirtual WEB is licensed under the **GNU Affero General Public License v3 (AGPL-3.0)**. Deploying it on your own infrastructure — including serving it as a network service — triggers the AGPL: you must publish your **complete project** under AGPL-3.0 and make it freely available. This includes all source code, configuration, and **all content delivered through the application**, such as GLB model files, `settings.json`, and plugins. This applies whether the application is served over a network or distributed directly.

> The "Powered by realvirtual WEB" watermark and the realvirtual logo must remain visible and unmodified in all AGPL deployments. Removing or modifying branding requires a commercial license.

> **Keeping a project private?** To self-host with proprietary models, private configuration, or closed plugins — or to remove branding — use a [commercial license](https://realvirtual.io/en/company/license). See the [README license section](README.md#license) for the canonical terms.

### 7a. Use the built-in tool with your own Bunny account

The deploy tool is account-agnostic by design. Every account-specific value comes from environment variables — nothing is hardcoded that you cannot override. Point it at your own Bunny Storage by setting your own credentials:

```bash
# Required — your own Bunny Storage zone
export BUNNY_STORAGE_KEY=your-storage-zone-password
export BUNNY_STORAGE_ZONE=your-storage-zone-name

# Optional — only needed to purge your CDN cache after upload
export BUNNY_ACCOUNT_KEY=your-account-api-key
export BUNNY_PULL_ZONE_ID=your-pull-zone-id

# Optional — region, sub-path, analytics
export BUNNY_REGION=storage.bunnycdn.com
export BUNNY_REMOTE_PATH=                 # empty = storage-zone root; or e.g. demo
export GA_MEASUREMENT_ID=                 # empty = no analytics

npm run deploy                            # builds + uploads to YOUR zone
```

| Variable | Required | Purpose |
|----------|----------|---------|
| `BUNNY_STORAGE_KEY` | yes | Your storage-zone password |
| `BUNNY_STORAGE_ZONE` | yes | Your storage-zone name |
| `BUNNY_ACCOUNT_KEY` | for purge | Your account API key |
| `BUNNY_PULL_ZONE_ID` | for purge | Your pull-zone id |
| `BUNNY_REGION` | no | Your region (default `storage.bunnycdn.com`) |
| `BUNNY_REMOTE_PATH` | no | Sub-path prefix (default empty = zone root) |
| `GA_MEASUREMENT_ID` | no | Your own GA4 id, or leave empty |

With those set, every upload, list, delete, and purge targets **your** account. The printed `web.realvirtual.io` lines (private mode and the CI workflow) are cosmetic and do not affect where files land — substitute your own pull-zone hostname. If you serve under a fixed sub-path with absolute asset URLs, add `--base /your-path/`.

### 7b. Host the static `dist/` anywhere

`npm run build` emits a self-contained static single-page app into `dist/`: `index.html`, hashed JS/CSS under `assets/`, and everything from `public/` (including `models/*.glb`, `settings.json`, and `models.json`). With the default relative base (`./`), the whole `dist/` tree can be served from a domain **root** or **any sub-path** without rebuilding. To "deploy it yourself," copy the contents of `dist/` to a web root and serve them as static files.

```bash
npm run build                # produce dist/
# copy dist/* to your web root, then serve over http(s)
```

| Host | How |
|------|-----|
| **nginx** | Copy `dist/` to the document root; add an SPA fallback and the MIME/cache rules below (see example) |
| **Apache** | Copy `dist/` to the DocumentRoot; add `.htaccess` with a rewrite to `/index.html` and `AddType application/wasm .wasm` / `AddType model/gltf-binary .glb` (needs `AllowOverride All`) |
| **AWS S3 + CloudFront** | `aws s3 sync dist/ s3://bucket --delete`; set `Content-Type` on upload (S3 misguesses `.wasm`/`.glb`); map CloudFront 403/404 → `/index.html` (200) for SPA fallback; add bucket CORS and forward the `Origin` header |
| **Netlify** | Build `npm run build`, publish dir `dist`; add `public/_redirects` (`/*  /index.html  200`) and `public/_headers` for cache/COOP-COEP |
| **Vercel** | Auto-detects Vite (`dist`); add `vercel.json` rewrite `"/(.*)" → "/index.html"` and custom headers |
| **Cloudflare Pages** | `npx wrangler pages deploy dist` or Git integration; `_headers` file for cache/COOP-COEP; watch the per-file size cap for large GLBs |
| **GitHub Pages** | Set Vite `base` to `'/<repo>/'`, publish `dist/`, copy `index.html` to `404.html` for SPA fallback; cannot set HTTP headers (no COOP/COEP, no custom MIME) |
| **Local — `vite preview`** | `npm run preview` serves `dist/` on `localhost:4173` with correct MIME types and SPA fallback already wired — the most faithful local check |
| **Local — `npx serve -s`** | From `dist/`, `npx serve -s` (single-page mode → fallback to `index.html`); use HTTPS for WebXR/secure-context testing |
| **Local — `python -m http.server`** | `cd dist && python -m http.server 8000` — quick smoke test only; no SPA fallback, may misreport `.glb`/`.wasm` MIME |

> `file://` does **not** work — `GLTFLoader` fetch is blocked by CORS (origin `null`) and WebXR/camera APIs are disabled. Always serve over an http(s) server, even locally.

### Server caveats (apply to any host)

| Concern | What to do |
|---------|-----------|
| **MIME types** | Serve `.glb` as `model/gltf-binary`, `.gltf` as `model/gltf+json`, `.wasm` as `application/wasm`. Many servers default to `application/octet-stream`, which downloads the GLB instead of loading it and makes `WebAssembly.instantiateStreaming` fail with *"Incorrect response MIME type"* |
| **SPA fallback** | A hard refresh on a deep link must return `index.html` (HTTP 200), not 404. Use `try_files`/rewrite/`_redirects`/`404.html` per host. A blanket fallback also turns missing assets into HTML 200s — scope it if you want real `/assets/*` 404s |
| **CORS** | If GLBs are served from a different origin than the page, the asset response needs `Access-Control-Allow-Origin` (and `GET, HEAD`). Same-origin serving avoids CORS entirely. On S3, also forward/cache the `Origin` header in CloudFront |
| **Cache-Control** | Hashed files in `assets/` are safe to cache forever: `public, max-age=31536000, immutable`. `index.html` is **not** hashed — set `no-cache` so users do not get stale HTML pointing at deleted chunks |
| **HTTPS / secure context** | WebXR (VR/AR) and camera access require a secure context: HTTPS or `localhost`. Plain `http://` on a real domain disables them. All cloud hosts provide free TLS; for local XR use an HTTPS dev server |
| **COOP/COEP** | Only needed if you use `SharedArrayBuffer` / threaded WASM. Then set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) — but COEP makes cross-origin assets require CORS/CORP. If you do **not** use SharedArrayBuffer, do not add these headers |
| **Large GLB** | Enable gzip/brotli and include `model/gltf-binary`/`model/gltf+json` in the compressible types (many servers compress text only). Mind per-file upload caps (nginx `client_max_body_size`, host limits) |
| **Base path** | Default base is `./` (relative) — serve from root or any sub-path without rebuilding. For absolute-rooted asset URLs under a fixed sub-path, build with `--base /your-path/` (or set Vite `base`) and put the SPA fallback under that sub-path too |

### nginx example

```nginx
# /etc/nginx/mime.types — add these so GLB/WASM load correctly:
#   model/gltf-binary  glb;
#   model/gltf+json    gltf;
#   application/wasm   wasm;

server {
    listen 443 ssl http2;
    server_name viewer.example.com;
    root /var/www/app;          # contents of dist/ copied here
    index index.html;

    # Compress GLB/WASM (text types are compressed by default)
    gzip on;
    gzip_types text/css application/javascript application/json
               application/wasm model/gltf-binary model/gltf+json;

    # SPA history fallback — deep links resolve to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Hashed assets: cache forever
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    # Entry point: never cache stale HTML
    location = /index.html {
        add_header Cache-Control "no-cache";
    }
}
```

---

## Command reference

| Flag | Effect |
|------|--------|
| `--private` | Private project mode |
| `--project <name>` | Project to publish (private mode) |
| `--list` | List private projects and exit |
| `--path <prefix>` | Public remote path prefix (overrides `BUNNY_REMOTE_PATH`) |
| `--dist <dir>` | Build output directory (default `./dist`) |
| `--projects-dir <dir>` | Private projects root |
| `--no-build` | Deploy an existing `dist/`, skip the build |
| `--base <path>` | Vite base path (`VITE_BASE`), e.g. `/demo/` |
| `--force` | Skip the diff, upload everything |
| `--dry-run` | Log only — build and upload nothing |
| `--no-purge` | Skip the cache purge |

## See Also

- [README](README.md) — quick start, overview, and [license terms](README.md#license)
- [Debugging Guide](doc-web-debugging.md) — debugging tools and workflow
- [Architecture](doc-webviewer.md) — full architecture and configuration
