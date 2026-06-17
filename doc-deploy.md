# Building & Deploying

Guide for building realvirtual WEB locally for testing versus publishing it to the public web.

> **The important distinction:** *building* produces a `dist/` folder on your machine and publishes nothing. *Deploying* builds **and** uploads that build to the public CDN at `web.realvirtual.io` — it goes live for everyone. Know which one you are running.

---

## 1. Local build (testing only — nothing is published)

Use these while developing or to verify a production build before it goes out. They never touch the CDN.

| Command | What it does | Where it runs |
|---------|--------------|---------------|
| `npm run dev` | Dev server with hot-module reload | `localhost:5173` |
| `npm run build` | Production build into `dist/` | your machine only |
| `npm run preview` | Serves the built `dist/` as it will look in production | `localhost` |

```bash
npm run dev                  # iterate with HMR
npm run build                # produce dist/ locally
npm run preview              # check the production build before deploying
```

`npm run build` writes `dist/` and stops. The output stays on disk — share it, inspect it, or run `npm run preview` against it. Nothing is uploaded.

---

## 2. Deploy to public (goes live on web.realvirtual.io)

`npm run deploy` is the publish step. It **builds** the app (public build, `VITE_PUBLIC_BUILD=1`) and then **uploads** the result to Bunny CDN. After it finishes, the new version is live.

```bash
npm run deploy                       # build + upload to the public demo
npm run deploy -- --path demo        # upload under a specific remote path prefix
npm run deploy -- --no-build         # upload an already-built dist/ (skip the build)
npm run deploy -- --dry-run          # show exactly what would happen, upload nothing
```

What happens, in order:

1. **Build** — `npm run build` with `VITE_PUBLIC_BUILD=1` (the private project folder is excluded from a public build).
2. **Diff** — the remote file list is fetched; unchanged files (same size) are skipped. `index.html`, `settings.json`, `models.json` and `manifest.json` are always re-uploaded.
3. **Upload** — changed files are uploaded; assets first, `index.html` last, so the live site never points at missing assets mid-deploy.
4. **Purge** — the CDN cache is purged once (only if something was uploaded).

> **Tip:** run `npm run deploy -- --dry-run` first when unsure. It prints the build mode, the target zone/path, and every file that would upload — without changing anything.

### Analytics

The committed `settings.json` ships with an empty Google Analytics id so public forks send no traffic into our property. The real id is injected into the **deployed** `settings.json` only, from the `GA_MEASUREMENT_ID` environment variable. Leave it unset for no analytics.

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

---

## 4. Credentials

All credentials come from environment variables — there is no key stored in the repo. Copy `.env.example` to `.env` (gitignored) for local use, or provide the values as CI secrets.

| Variable | Required | Purpose |
|----------|----------|---------|
| `BUNNY_STORAGE_KEY` | yes | Storage-zone password (upload / list) |
| `BUNNY_STORAGE_ZONE` | yes | Storage-zone name |
| `BUNNY_ACCOUNT_KEY` | for purge | Account API key (cache purge) |
| `BUNNY_PULL_ZONE_ID` | for purge | Pull-zone id (cache purge) |
| `BUNNY_REGION` | no | Region hostname (default `storage.bunnycdn.com`) |
| `BUNNY_REMOTE_PATH` | no | Public remote path prefix (e.g. `demo`) |
| `BUNNY_PRIVATE_PROJECTS_DIR` | no | Private projects root (for `--private`) |
| `GA_MEASUREMENT_ID` | no | GA4 id injected into the deployed `settings.json` |

These are the same values configured in the Unity Editor under **WebViewer Tools > Publish** (stored there as EditorPrefs). If you rotate a key, update both places so the two deploy paths stay in sync.

---

## 5. Continuous deployment

A push to `main` triggers `.github/workflows/deploy-bunny.yml`, which runs `npm run deploy` on a runner using the repository secrets. No Unity is involved — the CLI builds and uploads on its own.

---

## 6. Two ways to deploy, same result

| Path | When to use |
|------|-------------|
| **Unity — WebViewer Tools > Publish** | Interactive work in the Editor; uploads the current build with one click |
| **CLI — `npm run deploy`** | No Unity needed; for the console, CI/CD, and automation |

Both produce identical CDN output. The CLI is the Unity-independent path; pick whichever fits the situation.

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

- [README](README.md) — quick start and overview
- [Debugging Guide](doc-web-debugging.md) — debugging tools and workflow
- [Architecture](doc-webviewer.md) — full architecture and configuration
