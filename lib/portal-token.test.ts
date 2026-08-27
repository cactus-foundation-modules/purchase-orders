import { describe, it, expect, beforeAll } from 'vitest'
import {
  hashPortalIp, hashPortalToken, looksLikePortalToken, mintPortalToken, portalPath, samePortalHash,
} from '@/modules/purchase-orders/lib/portal-token'

// A supplier link is the one credential on this platform that is handed to
// somebody outside the building. Worth a test on every property it leans on.

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'test-key-for-purchase-order-portal-tokens'
})

describe('supplier portal tokens', () => {
  it('never mints the same token twice', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(mintPortalToken().token)
    expect(seen.size).toBe(500)
  })

  it('hands back a hash that is not the token', () => {
    const { token, hash } = mintPortalToken()
    expect(hash).not.toBe(token)
    // Only the hash is ever stored, so it has to be the thing a lookup can find.
    expect(hash).toBe(hashPortalToken(token))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hashes the same token to the same value every time', () => {
    const { token } = mintPortalToken()
    expect(hashPortalToken(token)).toBe(hashPortalToken(token))
  })

  it('recognises its own tokens and nothing else', () => {
    expect(looksLikePortalToken(mintPortalToken().token)).toBe(true)
    for (const bad of ['', 'nonsense', 'a'.repeat(42), 'a'.repeat(44), 'a/b+c', null, undefined]) {
      expect(looksLikePortalToken(bad)).toBe(false)
    }
  })

  it('compares hashes without leaking a mismatch by length alone', () => {
    const a = hashPortalToken('one')
    expect(samePortalHash(a, a)).toBe(true)
    expect(samePortalHash(a, hashPortalToken('two'))).toBe(false)
    expect(samePortalHash(a, 'short')).toBe(false)
  })

  it('builds a link carrying the order and the key', () => {
    const path = portalPath('PO-00147', 'abc123')
    expect(path).toBe('/purchase-order/PO-00147?k=abc123')
  })

  it('escapes a number or a token that would otherwise break the link', () => {
    expect(portalPath('PO/00147', 'a+b/c')).toBe('/purchase-order/PO%2F00147?k=a%2Bb%2Fc')
  })

  it('hashes an address rather than keeping it, and never reversibly', () => {
    const hash = hashPortalIp('203.0.113.9')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('203')
    expect(hashPortalIp('203.0.113.9')).toBe(hash)
    expect(hashPortalIp('203.0.113.10')).not.toBe(hash)
  })

  it('keeps no address at all rather than a guessable digest', () => {
    // A bare sha256 of an IPv4 address is reversible by counting to four
    // billion, so with no key there is nothing safe to store.
    const key = process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    expect(hashPortalIp('203.0.113.9')).toBeNull()
    process.env.ENCRYPTION_KEY = key
    expect(hashPortalIp(null)).toBeNull()
  })
})
