import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  PORTAL_WRITE_LIMIT, allowPortalReadIp, allowPortalReadToken, allowPortalWriteIp, allowPortalWriteToken,
  checkPortalRateLimit, portalClientIpFrom, resetPortalRateLimits,
} from '@/modules/purchase-orders/lib/portal-rate-limit'

// The limiter is a secondary guard - the lock on the door is 32 random bytes -
// but it is the only thing standing between one supplier's browser and a
// thousand rows in po_portal_events, so it wants to actually work.

beforeEach(() => {
  resetPortalRateLimits()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the portal rate limiter', () => {
  it('lets a burst through and then stops it', () => {
    for (let i = 0; i < 3; i++) expect(checkPortalRateLimit('key', 3, 60_000)).toBe(true)
    expect(checkPortalRateLimit('key', 3, 60_000)).toBe(false)
  })

  it('opens again once the window has passed', () => {
    vi.useFakeTimers()
    expect(checkPortalRateLimit('key', 1, 60_000)).toBe(true)
    expect(checkPortalRateLimit('key', 1, 60_000)).toBe(false)
    vi.setSystemTime(Date.now() + 61_000)
    expect(checkPortalRateLimit('key', 1, 60_000)).toBe(true)
  })

  it('counts each key on its own', () => {
    expect(checkPortalRateLimit('one', 1, 60_000)).toBe(true)
    expect(checkPortalRateLimit('two', 1, 60_000)).toBe(true)
    expect(checkPortalRateLimit('one', 1, 60_000)).toBe(false)
  })

  it('keeps reading and writing in separate buckets', () => {
    // A supplier who has used up their replies for the hour can still read the
    // order they are supplying.
    for (let i = 0; i < PORTAL_WRITE_LIMIT.max; i++) expect(allowPortalWriteToken('hash')).toBe(true)
    expect(allowPortalWriteToken('hash')).toBe(false)
    expect(allowPortalReadToken('hash')).toBe(true)
  })

  it('keeps one token and one address in separate buckets', () => {
    for (let i = 0; i < PORTAL_WRITE_LIMIT.max; i++) expect(allowPortalWriteToken('hash-a')).toBe(true)
    expect(allowPortalWriteToken('hash-a')).toBe(false)
    // The whole sales desk shares an address; one busy token must not shut the
    // rest of them out.
    expect(allowPortalWriteToken('hash-b')).toBe(true)
    expect(allowPortalWriteIp('203.0.113.9')).toBe(true)
    expect(allowPortalReadIp('203.0.113.9')).toBe(true)
  })
})

describe('the address a portal request came from', () => {
  it('takes the last hop, not the first', () => {
    // The leftmost entry is whatever the caller typed. Believing it is how a
    // per-address limit stops being per-address.
    const get = (name: string) => (name === 'x-forwarded-for' ? '9.9.9.9, 203.0.113.9' : null)
    expect(portalClientIpFrom(get)).toBe('203.0.113.9')
  })

  it('falls back to the platform header, then to nothing at all', () => {
    expect(portalClientIpFrom((name) => (name === 'x-real-ip' ? '203.0.113.10' : null))).toBe('203.0.113.10')
    expect(portalClientIpFrom(() => null)).toBe('unknown')
  })
})
