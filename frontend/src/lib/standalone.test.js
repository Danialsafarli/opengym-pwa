// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { idbLoad, idbSave, pickStart, requestPersistence, saveFile, DB_NAME } from './standalone.js'

// Just enough of IndexedDB for one key-value store: requests settle on a later tick, and a
// transaction completes after its request, the order the real API guarantees.
function fakeIDB({ failWrites = false } = {}) {
  const dbs = new Map()
  const later = fn => setTimeout(fn, 0)
  return {
    dbs,
    open(name) {
      const req = {}
      later(() => {
        let db = dbs.get(name)
        const fresh = !db
        if (fresh) { db = { stores: new Map() }; dbs.set(name, db) }
        const handle = {
          objectStoreNames: { contains: n => db.stores.has(n) },
          createObjectStore: n => { db.stores.set(n, new Map()) },
          close() {},
          transaction(n, mode) {
            const data = db.stores.get(n)
            const tx = {}
            tx.objectStore = () => ({
              get: key => { const r = {}; later(() => { r.result = data.get(key); r.onsuccess?.(); later(() => tx.oncomplete?.()) }); return r },
              put: (value, key) => {
                const r = {}
                later(() => {
                  if (failWrites || mode !== 'readwrite') { tx.error = new Error('QuotaExceededError'); tx.onerror?.(); return }
                  data.set(key, value); r.onsuccess?.(); later(() => tx.oncomplete?.())
                })
                return r
              },
            })
            return tx
          },
        }
        req.result = handle
        if (fresh) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
}

const hasData = S => !!(S && (S.workouts?.length || S.routines?.length))

describe('the IndexedDB durable copy', () => {
  it('round-trips the whole state in its own database', async () => {
    const idb = fakeIDB()
    const S = { _ts: 5, routines: [{ id: 'r1', name: 'Push' }], workouts: [{ d: '2026-10-01', entries: [] }] }
    expect(await idbSave(S, idb)).toBe(true)
    expect(idb.dbs.has(DB_NAME)).toBe(true)
    expect(await idbLoad(idb)).toEqual(S)
  })

  it('reads as null on a first start, and when IndexedDB is not there at all', async () => {
    expect(await idbLoad(fakeIDB())).toBe(null)
    expect(await idbLoad(null)).toBe(null)
  })

  it('reports a write that did not land instead of throwing', async () => {
    expect(await idbSave({ _ts: 1 }, fakeIDB({ failWrites: true }))).toBe(false)
    expect(await idbSave({ _ts: 1 }, null)).toBe(false)
  })
})

describe('pickStart — which copy boot starts from', () => {
  const data = ts => ({ _ts: ts, workouts: [{ d: '2026-10-01' }] })
  const empty = { _ts: 0, workouts: [], routines: [] }

  it('takes the durable copy when localStorage was evicted', () => {
    expect(pickStart(data(10), empty, hasData)).toBe('durable')
  })
  it('takes the durable copy when it is newer, or the same copy', () => {
    expect(pickStart(data(20), data(10), hasData)).toBe('durable')
    expect(pickStart(data(10), data(10), hasData)).toBe('durable')
  })
  it('keeps a newer localStorage copy and seeds IndexedDB with it (a write the tab closed on)', () => {
    expect(pickStart(data(10), data(20), hasData)).toBe('seed')
  })
  it('migrates data that only localStorage has into IndexedDB', () => {
    expect(pickStart(null, data(3), hasData)).toBe('seed')
  })
  it('does nothing on a fresh start with no data anywhere', () => {
    expect(pickStart(null, empty, hasData)).toBe(null)
  })
})

describe('requestPersistence', () => {
  it('asks once the origin is not persisted yet, and says what the browser answered', async () => {
    const persist = vi.fn(async () => true)
    expect(await requestPersistence({ storage: { persisted: async () => false, persist } })).toBe(true)
    expect(persist).toHaveBeenCalledOnce()
  })
  it('does not ask again when it already is', async () => {
    const persist = vi.fn(async () => true)
    expect(await requestPersistence({ storage: { persisted: async () => true, persist } })).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })
  it('is false, never an error, where the API is missing or refuses', async () => {
    expect(await requestPersistence({})).toBe(false)
    expect(await requestPersistence({ storage: { persist: async () => { throw new Error('no') } } })).toBe(false)
  })
})

describe('saveFile — handing a backup to the user', () => {
  const blob = () => new Blob(['{"a":1}'], { type: 'application/json' })
  const iphone = extra => ({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', canShare: () => true, ...extra })

  it('uses the share sheet on a phone that can share files', async () => {
    const share = vi.fn(async () => {})
    expect(await saveFile(blob(), 'b.json', { nav: iphone({ share }) })).toBe('shared')
    expect(share.mock.calls[0][0].files[0].name).toBe('b.json')
  })

  it('says "cancelled" when the share sheet is closed, and downloads nothing', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const share = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) })
    expect(await saveFile(blob(), 'b.json', { nav: iphone({ share }) })).toBe('cancelled')
    expect(click).not.toHaveBeenCalled()
    click.mockRestore()
  })

  it('falls back to a download when sharing is refused (the tap expired)', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const share = vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }) })
    expect(await saveFile(blob(), 'b.json', { nav: iphone({ share }) })).toBe('downloaded')
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })

  it('downloads on a desktop browser even when it could share', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const share = vi.fn()
    const nav = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', canShare: () => true, share }
    expect(await saveFile(blob(), 'b.json', { nav })).toBe('downloaded')
    expect(share).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })
})
