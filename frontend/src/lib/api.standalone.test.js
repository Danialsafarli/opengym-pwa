// @vitest-environment happy-dom

/* The standalone web build (lib/standalone.js) has no server. On a static host such as GitHub
   Pages, /api/* is answered by the host's 404 page — or, behind a catch-all, by index.html with a
   200 — so nothing may ever be sent there: every transport refuses before a request goes out. */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./mobile.js', () => ({ MOBILE: false }))
vi.mock('./standalone.js', () => ({ STANDALONE_WEB: true }))

import { api, apiBlob, apiUpload, beacon, setRemoteAuth } from './api.js'

afterEach(() => { vi.unstubAllGlobals(); setRemoteAuth('', null) })

describe('the standalone web build never talks to a server', () => {
  it('api() refuses with not-paired (status 0) and never calls fetch', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(api('/api/me')).rejects.toMatchObject({ code: 'not-paired', status: 0 })
    await expect(api('/api/data', { method: 'PUT', body: '{}' })).rejects.toMatchObject({ code: 'not-paired', status: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('the media transports refuse the same way', async () => {
    const fetchImpl = vi.fn()
    await expect(apiBlob('/api/media/abc', { fetchImpl })).rejects.toMatchObject({ code: 'not-paired' })
    await expect(apiUpload('/api/media/abc', new Blob(['x']), 'image/png')).rejects.toMatchObject({ code: 'not-paired' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('the "left" beacon is never sent', () => {
    const sendBeacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon })
    expect(beacon('/api/activity', { active: false })).toBe(false)
    expect(sendBeacon).not.toHaveBeenCalled()
  })
})
