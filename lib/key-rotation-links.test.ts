import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetKeyringState, setKeyringState } from '@/lib/crypto/keyring'
import {
  signPoPackingSlipToken,
  signPoPrintToken,
  signPoReturnPrintToken,
  verifyPoPackingSlipToken,
  verifyPoPrintToken,
  verifyPoReturnPrintToken,
} from '@/modules/purchase-orders/lib/print-token'
import { hashPortalIp } from '@/modules/purchase-orders/lib/portal-token'

// Document links survive a change of encryption key (core's lib/crypto/keyring
// .ts), and the hashed portal addresses do not change with it.

const OLD = '1a'.repeat(32)
const NEW = '2b'.repeat(32)
const saved = process.env.ENCRYPTION_KEY

const links = [
  { name: 'order document', sign: () => signPoPrintToken('PO-1'), verify: (t: string) => verifyPoPrintToken('PO-1', t) },
  { name: 'returns note', sign: () => signPoReturnPrintToken('SRN-1'), verify: (t: string) => verifyPoReturnPrintToken('SRN-1', t) },
  { name: 'packing slip', sign: () => signPoPackingSlipToken('SH-1'), verify: (t: string) => verifyPoPackingSlipToken('SH-1', t) },
]

beforeEach(() => {
  resetKeyringState()
  process.env.ENCRYPTION_KEY = OLD
})
afterEach(() => {
  resetKeyringState()
  if (saved === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = saved
})

describe.each(links)('$name link after a key rotation', (link) => {
  it('accepts one signed with the previous key', () => {
    const before = link.sign()
    process.env.ENCRYPTION_KEY = NEW
    setKeyringState({ previous: [OLD] })
    expect(link.verify(before)).toBe(true)
  })

  it('signs new ones with the current key only', () => {
    process.env.ENCRYPTION_KEY = NEW
    setKeyringState({ previous: [OLD] })
    const after = link.sign()
    process.env.ENCRYPTION_KEY = OLD
    resetKeyringState()
    expect(link.verify(after)).toBe(false)
  })
})

describe('hashed portal addresses', () => {
  it('are exactly what they were before the salt existed', () => {
    expect(hashPortalIp('203.0.113.9')).toBe(
      createHmac('sha256', OLD).update('purchase-order-portal:203.0.113.9').digest('hex'),
    )
  })

  it('do not change when the key does', () => {
    const before = hashPortalIp('203.0.113.9')
    process.env.ENCRYPTION_KEY = NEW
    setKeyringState({ previous: [OLD], derivationSalt: OLD })
    expect(hashPortalIp('203.0.113.9')).toBe(before)
  })
})
