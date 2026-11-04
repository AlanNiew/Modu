import { describe, expect, it } from 'vitest'

import { decodeLocator, encodeLocator } from './locator'

describe('locator', () => {
  it('roundtrips chapter index and in-chapter fraction', () => {
    const raw = encodeLocator(3, 0.25)
    expect(raw).toBe('{"v":1,"index":3,"fraction":0.25}')
    expect(decodeLocator(raw)).toEqual({ v: 1, index: 3, fraction: 0.25 })
  })

  it('clamps out-of-range values instead of writing garbage', () => {
    const raw = encodeLocator(-2, 1.5)
    expect(JSON.parse(raw)).toMatchObject({ index: 0, fraction: 1 })
  })

  it('treats non-finite inputs as the chapter start', () => {
    const raw = encodeLocator(Number.NaN, Number.POSITIVE_INFINITY)
    expect(decodeLocator(raw)).toEqual({ v: 1, index: 0, fraction: 0 })
  })

  it('rejects empty, malformed, or future-version payloads', () => {
    expect(decodeLocator(null)).toBeNull()
    expect(decodeLocator('')).toBeNull()
    expect(decodeLocator('not-json')).toBeNull()
    expect(decodeLocator('{"v":2,"index":1,"fraction":0}')).toBeNull()
    expect(decodeLocator('{"v":1,"index":-1,"fraction":0}')).toBeNull()
  })

  it('repairs a locator whose fraction is missing', () => {
    expect(decodeLocator('{"v":1,"index":7}')).toEqual({ v: 1, index: 7, fraction: 0 })
  })
})
