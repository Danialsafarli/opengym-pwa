# openGym — standalone PWA (GitHub Pages)

**Live app:** <https://danialsafarli.github.io/opengym-pwa/>
**Source:** <https://github.com/Danialsafarli/opengym-pwa>

This repository is a **modified fork of [openGym](https://github.com/DuarteSantos8/openGym)** by
Duarte Santos (© 2026, GNU AGPL-3.0-or-later), forked from upstream `v1.3.9`
(`e88062ed034edb232836b98619ae65eb6fd5851d`, 2026-09-28). It adds a *standalone web* build: the
full app as an installable Progressive Web App that runs entirely in the browser, with no server,
no account and no login. It is free to host on GitHub Pages and can be installed on an iPhone
from Safari without a Mac, Xcode or an Apple Developer account.

The upstream documentation (`README.md`, `docs/SELF_HOSTING.md`, `docs/MOBILE.md`, …) still
describes the self-hosted server and the native apps, which this fork leaves in place but does not
deploy.

---

## 1. Architecture

openGym's frontend is a React 19 + Vite single-page app (`frontend/`). The whole training state
(plan, routines, workouts, body weight, settings) is one object in a Zustand store
(`frontend/src/store/useStore.js`), and all the training logic — progression, 1RM, stats, recovery
— runs in the browser (`frontend/src/lib/`). The backend (`api/`) only stores and syncs that object
and handles sign-in, which is why the app can run without it.

The same source builds several flavors, chosen at build time:

| Build | Command | What it is |
|---|---|---|
| Self-hosted web | `npm run build` | Talks to the openGym server (`api/`), passkey sign-in, sync |
| Demo | `VITE_DEMO=1` | Upstream's GitHub Pages demo: guest mode + seeded example data |
| Native mobile | `npm run build:mobile` | Capacitor iOS/Android shells, file storage (`docs/MOBILE.md`) |
| **Standalone PWA** (this fork) | **`npm run build:pwa`** | No server; IndexedDB storage; deployed to GitHub Pages |

Routing is `HashRouter` (`#/home`, `#/plan`, …) and every asset path is relative
(`base: './'` in `vite.config.js`), so the build works from any subpath, including
`/opengym-pwa/`. The part after `#` never reaches the server, so reloading or deep-linking any
screen cannot 404 on GitHub Pages.

## 2. Standalone mode

`npm run build:pwa` runs `vite build --mode pwa`, which loads `frontend/.env.pwa`:

```sh
VITE_STANDALONE_WEB=1          # the flag — frontend/src/lib/standalone.js
VITE_IMG_BASE=…jsdelivr…/images/   # exercise pictures from the CDN (see §4)
VITE_GIF_BASE=…jsdelivr…/videos/
VITE_SOURCE_URL=https://github.com/Danialsafarli/opengym-pwa   # "source code" link in Settings
```

With the flag set (and only then, since Vite removes the dead branches from other builds):

- **Boot** (`useStore.boot()`) skips every server request. There's no `/api/config`, `/api/me`,
  sync or sign-in. It restores the durable copy (§3) and opens straight into the local profile.
  First launch shows the normal welcome screen (*Load starter plan* / *Build my own plan*).
- **Nothing can reach a server.** `api()`, `apiBlob()`, `apiUpload()` and the page-leave beacon in
  `frontend/src/lib/api.js` refuse before any request is made, the same guard the native app
  uses when it isn't paired. `frontend/src/lib/api.standalone.test.js` pins this.
- **The sign-in screen is never shown** (`App.jsx`), and the sync banner is off.
- **Settings** shows *Your data* ("stays on this device — export a backup now and then") instead
  of the account/passkey/pairing rows. It hides Web Push notifications (they need a server to send
  them) and the *Updates* section (it points at the Android APK and "your server"). The AI Coach
  stays hidden because it needs a server configuration.
- Everything else is unchanged: plans, routines, guided workouts, supersets, drop-sets, timers,
  history, stats, 1RM, recovery, body weight, the exercise library, custom exercises with photos,
  QR gym check-in, imports from other apps, and backup export/import.

## 3. Storage

| What | Where |
|---|---|
| Working copy of the whole state | `localStorage`, key `gym_state_v1` (read synchronously at start; `index.html` also reads it for the language before first paint) |
| **Durable copy** of the whole state | **IndexedDB**, database `opengym-standalone`, store `kv`, key `state` (JSON text, exactly what an export contains) |
| Photos/videos of your own exercises | IndexedDB (upstream's media store, `frontend/src/lib/media-store-idb.js`) |
| The app itself (HTML/JS/CSS/icons) | Service-worker cache (§4) |

**Why IndexedDB:** measured on this build, a logged set takes ~150 bytes, so a full session is
~2–3 KB. At four sessions a week that's ~0.5 MB a year, and a multi-year log plus routines
approaches Safari's ~5 MB localStorage limit. IndexedDB allows far more, and it's the storage
`navigator.storage.persist()` protects.

**How it works** (`frontend/src/lib/standalone.js`, `useStore.js`):

- Every change is written to localStorage immediately and to IndexedDB 0.5 s later. It's also
  written at once when the app is hidden or closed (the existing `flush` on `visibilitychange`/
  `pagehide`). Writes are queued, so a slow write never lands after a newer one.
- On start, `pickStart()` compares the two copies by their change stamp (`_ts`). If IndexedDB is
  newer, or localStorage has been emptied, the IndexedDB copy is restored. If localStorage has
  data IndexedDB doesn't (the first start of this build on a browser that already had data), it's
  **migrated** into IndexedDB. Both paths are covered by `standalone.test.js` and by the browser
  test in §11.
- On every start the app asks for **persistent storage** (`navigator.storage.persist()`). Safari
  grants it to Home Screen apps; elsewhere the browser may refuse. It's a request, not a
  guarantee.
- If IndexedDB can't be written (the device is full), the app shows one warning asking you to
  export a backup.

**What this does not promise:** browser storage *can* be deleted. That happens when you remove the
app from the Home Screen, clear website data in iOS Settings, or, rarely, when iOS reclaims space.
**Export a backup regularly (§5).**

## 4. Offline behavior

`frontend/public/sw.js` (upstream's service worker, unchanged) is registered on HTTPS, which
GitHub Pages always is. On install it pre-caches `index.html` and every script, stylesheet, icon
and the manifest that the page references. Requests for the app are network-first with a
3-second fallback to the cache, so a launch with no signal still opens.

After the app has been opened online once, all of these work with no network: launch, every
screen, routines and plans, starting and logging a workout, finishing it, history, stats, settings,
and data surviving a reload.

**Exercise pictures and animations are not offline.** They're third-party content that openGym
does not redistribute (see `NOTICE.md`), so they load from the upstream dataset on jsDelivr.
The service worker only caches same-origin files, so a picture you haven't viewed recently (and
that isn't in Safari's normal HTTP cache) is missing offline. The app then shows its neutral
dumbbell tile, and tapping the tile retries. Logging is unaffected.

## 5. Backup — export and import

**Settings → Data**:

- **Export backup (JSON)**: on an iPhone/iPad (or Android) this opens the **share sheet**, where
  you choose *Save to Files*, AirDrop, Mail, and so on. On a computer it downloads
  `opengym-backup-YYYY-MM-DD.json`. It contains the whole state: plan, routines, workouts, body
  weight and settings.
- **Export with photos & videos (.zip)**: appears only if your own exercises have photos/videos.
  It's the same JSON plus those files.
- **Import backup**: pick a `.json` or `.zip` backup (for example from Files). After you confirm,
  it replaces the data on this device.

No Capacitor plugins are involved. Export uses the Web Share API with a download fallback
(`saveFile` in `standalone.js`), and import uses a normal file picker. Backups are compatible with
every other openGym build (self-hosted, native app), in both directions.

## 6. GitHub Pages deployment

- **Site:** <https://danialsafarli.github.io/opengym-pwa/>, served from the `/opengym-pwa/` subpath.
- **Source:** *Settings → Pages → Build and deployment → Source: GitHub Actions*. No `gh-pages`
  branch, and no build output is committed.
- The manifest (`manifest.webmanifest`, generated at build time from `frontend/public/manifest.json`)
  uses relative `id`, `start_url` and `scope` (`./`), which resolve to `/opengym-pwa/`. The service
  worker is registered as `sw.js` relative to the page, so its scope is `/opengym-pwa/` as well.

> **Shared origin:** every GitHub Pages project site of one account shares the origin
> `https://danialsafarli.github.io`, so it also shares localStorage and IndexedDB. Don't publish
> another openGym build (or anything you don't trust) under the same account, since it could read
> or overwrite this app's data. A custom domain would give the app its own origin.

## 7. GitHub Actions

`.github/workflows/pages.yml` runs on every push to `main` (or manually from the *Actions* tab):

1. `npm ci` in `frontend/`
2. `npm test` (the whole unit suite), `check-locales`, `check-source-strings`
3. `npm run build:pwa`
4. `actions/upload-pages-artifact` → `actions/deploy-pages`

If a test fails, nothing is deployed and the site keeps the last good build. Permissions are
per job: the build job only gets `contents: read`, and the deploy job only gets `pages: write` and
`id-token: write`. Upstream's other workflows (Docker image publishing, the GitLab mirror, and a
test job that builds the server's Docker images) are removed from this fork because it publishes
no images and has no server.

To build locally (Node 20+; Windows, macOS and Linux alike):

```sh
cd frontend
npm ci
npm test
npm run build:pwa        # → frontend/dist
npm run dev:pwa          # dev server in standalone mode (http://localhost:5173)
```

The service worker only registers on HTTPS, so offline behavior can only be tested on the
deployed site, not on the local dev server.

## 8. iPhone installation

1. Open **<https://danialsafarli.github.io/opengym-pwa/>** in **Safari**.
2. Tap **Share** (the square with the arrow).
3. Tap **Add to Home Screen** (scroll down the sheet if needed).
4. If iOS shows **Open as Web App**, leave it **on**.
5. Tap **Add**.
6. Launch **openGym** from the Home Screen. It opens full screen with no Safari address bar.
7. Load a starter plan or build your own, and log a workout.
8. Swipe the app away in the app switcher, then reopen it. Your data should still be there.
9. Turn on Airplane Mode and open the app again. It should launch and let you log (exercise
   pictures may be missing).
10. **Settings → Export backup (JSON) → Save to Files.** Do this again regularly.

Use the **Home Screen app**, not a Safari tab. iOS gives each its own separate storage, so data
logged in a Safari tab doesn't appear in the installed app, and vice versa.

## 9. Updating the app

A push to `main` redeploys the site within a few minutes. The installed app loads the new version
the next time it's opened **with a network connection** (occasionally the launch after that). The
new service worker then replaces the old cache. Your data isn't touched by updates, because it
lives in the browser's storage and not in the app files.

To pull in newer upstream openGym releases:

```sh
git remote add upstream https://github.com/DuarteSantos8/openGym.git   # once
git fetch upstream
git merge upstream/main          # resolve conflicts if any, run npm test, push
```

## 10. Known iOS / PWA limitations

- **Storage can be lost** when you delete the Home Screen app (its data goes with it), clear
  Safari/website data, or, rarely, when iOS reclaims space. Export backups.
- **Separate storage per context:** the Safari tab and the Home Screen app don't share data.
- **No notifications while closed.** Workout-day reminders and rest-timer alerts with the app
  closed rely on Web Push, which needs a server. The rest timer works while the app is open.
- **No sync between devices.** Each device has its own data. Move data with export/import.
- **Exercise pictures need a network** (§4).
- **AI Coach unavailable.** It needs an openGym server or the native app.
- **Shared github.io origin** (§6).
- Updates arrive on the next online launch, not in the background.

## 11. What this fork changed (and how it was tested)

| File | Change |
|---|---|
| `frontend/src/lib/standalone.js` (new) | `STANDALONE_WEB` flag, IndexedDB durable copy, start-copy choice, persistent-storage request, share-or-download for backups |
| `frontend/src/store/useStore.js` | IndexedDB mirror on every change and on hide; standalone boot branch (no server, restore/migrate, persist request); storage-full warning |
| `frontend/src/lib/api.js` | Every server transport refuses in the standalone build |
| `frontend/src/App.jsx`, `components/SyncBanner.jsx` | No sign-in screen or sync banner in the standalone build |
| `frontend/src/views/Settings.jsx` | Standalone *Your data* section; Web Push and *Updates* hidden; export via share sheet; source link from `VITE_SOURCE_URL` |
| `frontend/src/locales/*.js` | One new message (storage full), in all 16 languages |
| `frontend/vite.config.js`, `package.json`, `.env.pwa` | `build:pwa` / `dev:pwa` mode; `manifest.webmanifest` for that build |
| `frontend/src/lib/standalone.test.js`, `api.standalone.test.js` (new) | Unit tests for all of the above |
| `.github/workflows/` | `pages.yml` deploys the PWA; `docker-publish.yml`, `mirror.yml`, `test.yml` removed |
| `.gitignore` | Secrets, signing material, local DBs, IDE/OS files |
| `README.md`, this file | Fork notice and documentation |

The other builds (self-hosted, demo, native) behave exactly as upstream's. The flag is `false`
there and its code is removed at build time.

Testing: the full upstream unit suite plus the new tests (`npm test`). The standalone build was
also checked in a real browser (Microsoft Edge via Playwright) from the `/opengym-pwa/` subpath:
first launch, loading a plan, renaming a routine, logging and finishing a workout, reload, restore
from IndexedDB after localStorage was wiped, deep links on every tab, export, import into a fresh
browser, no request to `/api`, and, on the live HTTPS site, service-worker registration and an
offline relaunch with navigation and workout logging.

## 12. Upstream attribution

- openGym © 2026 **Duarte Santos**: <https://github.com/DuarteSantos8/openGym> (canonical:
  <https://gitlab.com/DuarteSantos8/opengym>).
- `LICENSE` (AGPL-3.0) and `NOTICE.md` (third-party notices: MuscleMap, the exercise dataset,
  lean-qr, jsQR, the ML Kit plugin, and the status of the exercise media) are kept **unchanged**.
- Exercise names/instructions: ExerciseDB via hasaneyldrm/exercises-dataset (MIT). Exercise
  images and animations are © their rights holder (see `NOTICE.md`). They are **not** included in
  this repository or the deployed site, only loaded from the CDN at runtime.

## 13. AGPL obligations

openGym is licensed under the **GNU Affero General Public License v3.0 or later**. For this fork
that means:

- **Keep the license and notices:** `LICENSE`, `NOTICE.md` and the copyright lines stay.
- **Mark modifications:** this file and the notice at the top of `README.md` say that this is a
  modified version and when it was forked (§5(a)).
- **Same license:** the modified version is licensed as a whole under AGPL-3.0-or-later (§5(c)).
- **Corresponding source:** anyone who receives or uses the app must be able to get the complete
  source of *the version they run* (§6, §13). This public repository is that source: the site is
  built by GitHub Actions from exactly the commit on `main`, and *Settings → source code* links here.
  If you ever deploy from somewhere else, publish that source too.
- **Renaming/rebranding is allowed**, but the attribution above must remain.
