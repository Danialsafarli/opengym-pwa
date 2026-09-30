// Standalone web build (VITE_STANDALONE_WEB=1) — the installable PWA with no server at all, the
// way this fork serves it from GitHub Pages (docs/PWA_STANDALONE.md).
//
// Like the mobile build (lib/mobile.js), there is nothing to sign in to and the device is the only
// copy of the training log. Unlike it, there is no native file system: the durable copy is
// IndexedDB. localStorage stays the working copy the store reads synchronously at start (and
// index.html reads for the language before the first paint), but it is capped at a few MB and is
// the first thing a browser gives up under pressure; IndexedDB holds far more and is what
// navigator.storage.persist() protects. Every persist() therefore also lands in IndexedDB, and
// boot() restores from it when it holds a newer copy than localStorage — the same rule the phone
// applies to its file mirror.
//
// Vite replaces the flag at build time, so every branch on it folds away in the other builds.
export const STANDALONE_WEB = import.meta.env.VITE_STANDALONE_WEB === '1'

// Its own database, not the media store's: the two are cleared and versioned independently.
export const DB_NAME = 'opengym-standalone'
const STORE = 'kv'
const STATE_KEY = 'state'

const idbFactory = () => (typeof indexedDB !== 'undefined' ? indexedDB : null)

function open(factory) {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(new Error('IndexedDB unavailable')); return }
    const req = factory.open(DB_NAME, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB blocked'))
  })
}

function run(factory, mode, fn) {
  return open(factory).then(db => new Promise((resolve, reject) => {
    let out
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    if (req) req.onsuccess = () => { out = req.result }
    // Resolved on complete, not on the request's success: only then is a write on disk.
    tx.oncomplete = () => { db.close(); resolve(out) }
    tx.onerror = () => { db.close(); reject(tx.error) }
    tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB transaction aborted')) }
  }))
}

/** The durable copy, or null (first start, or IndexedDB unusable — localStorage then stands). */
export async function idbLoad(factory = idbFactory()) {
  try {
    const raw = await run(factory, 'readonly', s => s.get(STATE_KEY))
    if (typeof raw !== 'string') return null
    const S = JSON.parse(raw)
    return S && typeof S === 'object' ? S : null
  } catch { return null }
}

/** Writes the copy. Kept as the JSON text the backup export writes, so what is stored is exactly
 *  what an export would contain. Resolves false when the write did not land. */
export async function idbSave(S, factory = idbFactory()) {
  try { await run(factory, 'readwrite', s => s.put(JSON.stringify(S), STATE_KEY)); return true } catch { return false }
}

/**
 * Which copy boot starts from. The durable copy wins when localStorage has nothing worth keeping
 * (evicted, first start after a clear) or when it is at least as new — `_ts` is when the device
 * last changed the data. Returns 'durable' to take the IndexedDB copy, 'seed' when localStorage
 * holds data IndexedDB does not have yet (the first start of this build on a browser that already
 * had data: the migration), or null when there is nothing to do.
 */
export function pickStart(durable, working, hasData) {
  if (durable && (!hasData(working) || (durable._ts || 0) >= (working?._ts || 0))) return 'durable'
  if (hasData(working)) return 'seed'
  return null
}

// Ask the browser not to evict this origin's storage under pressure. Safari grants it to a site
// added to the Home Screen; elsewhere it may be refused or ignored. Either way nothing else changes:
// it is a request, never a guarantee.
export async function requestPersistence(nav = typeof navigator !== 'undefined' ? navigator : null) {
  try {
    if (!nav?.storage?.persist) return false
    if (nav.storage.persisted && await nav.storage.persisted()) return true
    return await nav.storage.persist()
  } catch { return false }
}

// A backup file handed to the user. A Home Screen web app on iOS has no download manager worth
// the name — a blob link opens a preview with no way back into the app on some versions — so a
// phone gets the OS share sheet ("Save to Files", AirDrop, Mail) through the Web Share API, and
// everything else, or a phone whose browser refuses to share files, the ordinary download.
// Resolves 'shared', 'downloaded', or 'cancelled' (the share sheet was closed without a choice).
export async function saveFile(blob, name, { nav = navigator, doc = document, touch } = {}) {
  const mobile = touch ?? (/iPhone|iPad|iPod|Android/.test(nav.userAgent || '') ||
    (/Macintosh/.test(nav.userAgent || '') && (nav.maxTouchPoints || 0) > 1))   // iPadOS reports a Mac
  if (mobile && typeof nav.share === 'function' && typeof nav.canShare === 'function' && typeof File === 'function') {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
    if (nav.canShare({ files: [file] })) {
      try { await nav.share({ files: [file], title: name }); return 'shared' } catch (e) {
        if (e?.name === 'AbortError') return 'cancelled'
        // NotAllowedError: the tap's activation ran out while the file was being built. Download.
      }
    }
  }
  const a = doc.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.rel = 'noopener'
  doc.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 60000)
  return 'downloaded'
}
