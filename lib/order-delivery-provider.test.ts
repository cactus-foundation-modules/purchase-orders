import { describe, expect, it } from 'vitest'
import type { PoShipTo } from './types'

const { mergeShipTo, UNSENT_STATUSES } = await import('./order-delivery-provider')

const address = (postcode: string) => ({ line1: '1 High St', line2: '', city: 'Leeds', region: '', postcode, country: 'GB' })

const current: PoShipTo = {
  name: 'Old Co',
  contact: 'Old Person',
  phone: '0113 000',
  address: address('LS1 1AA'),
  instructions: 'Typed by hand on the PO',
}

const fresh: PoShipTo = {
  name: 'New Co',
  contact: 'New Person',
  phone: '0113 999',
  address: address('LS2 2BB'),
  instructions: 'Leave with neighbour',
}

describe('mergeShipTo', () => {
  it('replaces label, contact, phone and address on an address change, keeping the instructions', () => {
    const next = mergeShipTo(current, fresh, { addressChanged: true, instructionsChanged: false })
    expect(next).toEqual({ ...fresh, instructions: current.instructions })
  })

  it('replaces only the instructions on an instructions change', () => {
    const next = mergeShipTo(current, fresh, { addressChanged: false, instructionsChanged: true })
    expect(next).toEqual({ ...current, instructions: fresh.instructions })
  })

  it('takes everything when both changed', () => {
    expect(mergeShipTo(current, fresh, { addressChanged: true, instructionsChanged: true })).toEqual(fresh)
  })

  it('changes nothing when neither did', () => {
    expect(mergeShipTo(current, fresh, { addressChanged: false, instructionsChanged: false })).toEqual(current)
  })
})

describe('UNSENT_STATUSES', () => {
  it('stops at the point the supplier is sent the order', () => {
    expect([...UNSENT_STATUSES]).toEqual(['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'])
  })
})
