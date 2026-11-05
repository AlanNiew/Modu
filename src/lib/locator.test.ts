import { describe, expect, it } from 'vitest'

import { decodeLocator, encodeLocator } from './locator'

describe('locator', () => {
  it('roundtrips chapter index and in-chapter fraction', () => {
    const raw = encodeLocator(3, 0.25)
    expect(raw).toBe('{"v":2,"index":3,"fraction":0.25}')
    expect(decodeLocator(raw)).toEqual({ v: 2, index: 3, fraction: 0.25 })
  })

  it('clamps out-of-range values instead of writing garbage', () => {
    const raw = encodeLocator(-2, 1.5)
    expect(JSON.parse(raw)).toMatchObject({ index: 0, fraction: 1 })
  })

  it('treats non-finite inputs as the chapter start', () => {
    const raw = encodeLocator(Number.NaN, Number.POSITIVE_INFINITY)
    expect(decodeLocator(raw)).toEqual({ v: 2, index: 0, fraction: 0 })
  })

  it('rejects empty, malformed, or future-version payloads', () => {
    expect(decodeLocator(null)).toBeNull()
    expect(decodeLocator('')).toBeNull()
    expect(decodeLocator('not-json')).toBeNull()
    expect(decodeLocator('{"v":1,"index":-1,"fraction":0}')).toBeNull()
  })

  it('repairs a locator whose fraction is missing', () => {
    expect(decodeLocator('{"v":1,"index":7}')).toEqual({ v: 2, index: 7, fraction: 0 })
  })

  it('roundtrips the v2 text anchor', () => {
    const anchor = {
      quote: '纸上的灯亮了起来',
      prefix: '那年冬天，',
      suffix: '，照着一整条街。',
    }
    const raw = encodeLocator(3, 0.25, anchor)
    expect(JSON.parse(raw)).toMatchObject({ v: 2, index: 3, fraction: 0.25 })
    expect(decodeLocator(raw)).toEqual({ v: 2, index: 3, fraction: 0.25, ...anchor })
  })

  it('upgrades a v1 locator to v2 without inventing an anchor', () => {
    expect(decodeLocator('{"v":1,"index":4,"fraction":0.5}')).toEqual({
      v: 2,
      index: 4,
      fraction: 0.5,
    })
  })

  it('drops an empty or whitespace-only anchor instead of storing junk', () => {
    expect(JSON.parse(encodeLocator(1, 0, { quote: '   ' }))).toMatchObject({ v: 2, index: 1 })
    expect(decodeLocator(JSON.stringify({ v: 2, index: 1, fraction: 0, quote: '  ' }))).toEqual({
      v: 2,
      index: 1,
      fraction: 0,
    })
  })

  it('rejects future versions and out-of-range chapter numbers', () => {
    expect(decodeLocator('{"v":3,"index":1,"fraction":0}')).toBeNull()
    expect(decodeLocator('{"v":2,"index":-1,"fraction":0}')).toBeNull()
  })
})
