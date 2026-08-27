import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import {
  PRINT_TOKEN_TTL_MINUTES, poDocumentBasePath, poDocumentPath, signPoPrintToken, verifyPoPrintToken,
} from '@/modules/purchase-orders/lib/print-token'

// The token is the only thing standing between "a headless browser can open this
// page" and "anybody who can count can read what this business pays its
// suppliers". Worth a test each way.

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'test-key-for-purchase-order-print-tokens'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('purchase order print tokens', () => {
  it('opens the order it was minted for', () => {
    const token = signPoPrintToken('PO-00147')
    expect(verifyPoPrintToken('PO-00147', token)).toBe(true)
  })

  it('does not open the next order along', () => {
    // The whole point: purchase order numbers run in sequence, so the number is
    // no lock at all and the token has to be the one doing the work.
    const token = signPoPrintToken('PO-00147')
    expect(verifyPoPrintToken('PO-00148', token)).toBe(false)
  })

  it('stops working once it has aged out', () => {
    const token = signPoPrintToken('PO-00147')
    expect(verifyPoPrintToken('PO-00147', token)).toBe(true)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + (PRINT_TOKEN_TTL_MINUTES + 2) * 60_000)
    expect(verifyPoPrintToken('PO-00147', token)).toBe(false)
  })

  it('refuses a token whose expiry has been edited', () => {
    // The expiry rides in the token rather than in a table, so it has to be
    // inside the signature - otherwise anybody could push it forward a year.
    const token = signPoPrintToken('PO-00147')
    const [, digest] = token.split('.')
    const forged = `${Math.floor(Date.now() / 60_000) + 99_999}.${digest}`
    expect(verifyPoPrintToken('PO-00147', forged)).toBe(false)
  })

  it('answers false rather than throwing on rubbish', () => {
    for (const bad of ['', 'nonsense', '.', 'abc.def', '12x.def', null, undefined]) {
      expect(verifyPoPrintToken('PO-00147', bad)).toBe(false)
    }
  })

  it('builds a path carrying the number and a live token', () => {
    expect(poDocumentBasePath('PO-00147')).toBe('/purchase-order/PO-00147')
    const path = poDocumentPath('PO-00147')
    expect(path.startsWith('/purchase-order/PO-00147?t=')).toBe(true)
    expect(verifyPoPrintToken('PO-00147', decodeURIComponent(path.split('t=')[1]!))).toBe(true)
  })

  it('escapes a number that would otherwise break the path', () => {
    expect(poDocumentBasePath('PO/00147 A')).toBe('/purchase-order/PO%2F00147%20A')
  })
})
