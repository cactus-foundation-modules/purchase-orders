import { describe, expect, it } from 'vitest'
import { believedLinks, matchTracking, normaliseRef, poNumbersIn, type TrackingDespatch, type TrackingOrder } from './tracking-match'
import type { RecognisedTracking } from './tracking-recognise'

// Which order an email's tracking belongs to. Strongest rule first, each rule
// exact, the postcode only ever a question - and who sent it decides which
// rules it may use at all.

function order(overrides: Partial<TrackingOrder> & Pick<TrackingOrder, 'id' | 'number'>): TrackingOrder {
  return {
    supplierId: 'acme',
    status: 'ACKNOWLEDGED',
    dropShip: true,
    postcode: null,
    supplierRefs: [],
    awaitingDespatch: true,
    awaitingDeliveryNews: false,
    hasDespatch: false,
    ...overrides,
  }
}

const ORDERS: TrackingOrder[] = [
  order({ id: 'o12', number: 'PO-00012', supplierRefs: ['0000123456'], postcode: 'AB1 2DE' }),
  order({ id: 'o13', number: 'PO-00013', supplierRefs: ['0000123999', 'PF-0008642'], postcode: 'ZE1 0AA' }),
  order({ id: 'o14', number: 'PO-00014', supplierRefs: [], postcode: 'SW1A 1AA' }),
  order({ id: 'o15', number: 'PO-00015', supplierRefs: [], postcode: 'SW1A 1AA', awaitingDespatch: false }),
  order({ id: 'o90', number: 'PO-00090', supplierId: 'other', supplierRefs: ['555777'], postcode: 'EH1 1AA' }),
  order({ id: 'o91', number: 'PO-00091', supplierId: 'other', status: 'CANCELLED', supplierRefs: ['555888'] }),
]

const DESPATCHES: TrackingDespatch[] = [
  { id: 'd1', orderId: 'o13', trackingKey: 'F99988877766', trackingRef: 'F99988877766', trackingCode: null, trackingUrl: null },
  { id: 'd2', orderId: 'o14', trackingKey: 'CODE:multidrop:Q9XZ7A', trackingRef: null, trackingCode: 'Q9XZ7A', trackingUrl: 'https://multidrop.link/Q9XZ7A/SW1A1AA' },
]

function found(overrides: Partial<RecognisedTracking> = {}): RecognisedTracking {
  return { candidates: [], deliveryDate: null, deliverySlot: null, supplierRefs: [], looseRefs: [], postcodes: [], addressPostcodes: [], ...overrides }
}

const parcel = (trackingNumber: string | null, shortCode: string | null = null, trackingUrl: string | null = null) => ({
  carrier: null, trackingNumber, trackingUrl, shortCode,
})

function match(input: { sender: 'supplier' | 'internal' | 'other'; supplierIds?: string[]; text?: string; found: RecognisedTracking }) {
  return matchTracking({
    sender: input.sender,
    supplierIds: input.supplierIds ?? (input.sender === 'supplier' ? ['acme'] : []),
    text: input.text ?? '',
    found: input.found,
    orders: ORDERS,
    despatches: DESPATCHES,
  })
}

describe('matching tracking to an order', () => {
  it('rule 1: our order number from that supplier, tracking or just a day', () => {
    const result = match({ sender: 'supplier', text: 'RE: Purchase order PO-00012', found: found({ candidates: [parcel('11112222333344')] }) })
    expect(result).toMatchObject({ kind: 'apply', rule: 1, order: { id: 'o12' }, despatchId: null })
    const dayOnly = match({ sender: 'supplier', text: 'RE: PO-00012\nout for delivery today', found: found({ deliveryDate: '2026-09-28' }) })
    expect(dayOnly).toMatchObject({ kind: 'apply', rule: 1, order: { id: 'o12' } })
  })

  it('rule 1 with the email giving a different delivery postcode only proposes, saying so', () => {
    const result = match({ sender: 'supplier', text: 'RE: Purchase order PO-00012', found: found({ candidates: [parcel('11112222333344')], postcodes: ['LS1 4AP'] }) })
    expect(result).toMatchObject({ kind: 'propose', rule: 1, order: { id: 'o12' }, reason: expect.stringMatching(/LS1 4AP.*AB1 2DE/) })
    // The right postcode, or none at all, still applies.
    expect(match({ sender: 'supplier', text: 'PO-00012', found: found({ candidates: [parcel('11112222333344')], postcodes: ['AB1 2DE'] }) }).kind).toBe('apply')
  })

  it('rule 1 is the supplier’s alone: a carrier quoting our number does not get it', () => {
    const result = match({ sender: 'other', text: 'Your order PO-00012', found: found({ candidates: [parcel('11112222333344')] }) })
    expect(result.kind).toBe('ignore')
  })

  it('rule 1 never reaches another supplier’s order, and refuses two of ours', () => {
    expect(match({ sender: 'supplier', text: 'PO-00090', found: found({ candidates: [parcel('11112222333344')] }) }).kind).toBe('ignore')
    expect(match({ sender: 'supplier', text: 'PO-00012 and PO-00014', found: found({ candidates: [parcel('11112222333344')] }) }))
      .toMatchObject({ kind: 'ignore', reason: expect.stringMatching(/2 of our orders/) })
  })

  it('rule 2: their reference with the leading zeros off, from the carrier, the postcode agreeing', () => {
    const result = match({ sender: 'other', found: found({ candidates: [parcel('F12345678901')], supplierRefs: ['123456'], postcodes: ['AB1 2DE'] }) })
    expect(result).toMatchObject({ kind: 'apply', rule: 2, order: { id: 'o12' } })
  })

  it('B1: a short reference and a different postcode never lands on somebody else’s order', () => {
    // The proven case: "Order number 1234", a consignment, delivery to LS1 4AP,
    // and an order whose sales order is 0000001234 going to SW1A 1AA.
    const orders = [...ORDERS, order({ id: 'o40', number: 'PO-00040', supplierRefs: ['0000001234'], postcode: 'SW1A 1AA' })]
    const email = found({ candidates: [parcel('F12345678901')], supplierRefs: ['1234'], postcodes: ['LS1 4AP'] })
    const result = matchTracking({ sender: 'other', supplierIds: [], text: '', found: email, orders, despatches: DESPATCHES })
    expect(result.kind).toBe('ignore')
    // With no postcode to compare, four characters are not enough either.
    const bare = found({ candidates: [parcel('F12345678901')], supplierRefs: ['1234'] })
    expect(matchTracking({ sender: 'other', supplierIds: [], text: '', found: bare, orders, despatches: DESPATCHES }).kind).toBe('ignore')
    // From the supplier, a short reference is theirs and stands.
    const fromSupplier = matchTracking({ sender: 'supplier', supplierIds: ['acme'], text: '', found: bare, orders, despatches: DESPATCHES })
    expect(fromSupplier).toMatchObject({ kind: 'apply', rule: 2, order: { id: 'o40' } })
  })

  it('B1: a long reference with the wrong postcode only proposes, saying so', () => {
    const result = match({ sender: 'other', found: found({ candidates: [parcel('F12345678901')], supplierRefs: ['123456'], postcodes: ['LS1 4AP'] }) })
    expect(result).toMatchObject({ kind: 'propose', rule: 2, order: { id: 'o12' }, reason: expect.stringMatching(/LS1 4AP.*AB1 2DE/) })
  })

  it('B1: the looser labels count from the supplier, never from a courier', () => {
    const loose = found({ candidates: [parcel('F12345678901')], looseRefs: ['123456'], postcodes: ['AB1 2DE'] })
    // Not rule 2 from a courier: at most the postcode's question.
    expect(match({ sender: 'other', found: loose })).toMatchObject({ kind: 'propose', rule: 4 })
    expect(match({ sender: 'supplier', found: loose })).toMatchObject({ kind: 'apply', rule: 2, order: { id: 'o12' } })
  })

  it('B2: a stranger is never the first word an order has gone, except by rule 2 with the postcode agreeing', () => {
    // A long reference alone, no postcode: proposed, not recorded.
    expect(match({ sender: 'other', found: found({ candidates: [parcel('F12345678901')], supplierRefs: ['123456'] }) }))
      .toMatchObject({ kind: 'propose', rule: 2, reason: expect.stringMatching(/first word/) })
    // Postcode agreeing but a link was thrown away: proposed.
    expect(matchTracking({
      sender: 'other', supplierIds: [], text: '', orders: ORDERS, despatches: DESPATCHES, linkDropped: true,
      found: found({ candidates: [parcel('F12345678901')], supplierRefs: ['123456'], postcodes: ['AB1 2DE'] }),
    })).toMatchObject({ kind: 'propose', rule: 2 })
    // An order already despatched, a dropped link and lines still to go: a new
    // despatch would start, so proposed.
    const part = ORDERS.map((o) => (o.id === 'o12' ? { ...o, hasDespatch: true } : o))
    expect(matchTracking({
      sender: 'other', supplierIds: [], text: '', orders: part, despatches: DESPATCHES, linkDropped: true,
      found: found({ candidates: [parcel('F12345678901')], supplierRefs: ['123456'], postcodes: ['AB1 2DE'] }),
    })).toMatchObject({ kind: 'propose' })
  })

  it('B2: the evil.example link is thrown away, its postcode with it, and the number kept', () => {
    const read = found({
      candidates: [{ carrier: null, trackingNumber: 'F12345678901', trackingUrl: 'https://evil.example/track/F12345678901', shortCode: null }],
      supplierRefs: ['123456'],
      postcodes: ['AB1 2DE'],
      addressPostcodes: [],
    })
    const { found: kept, linkDropped } = believedLinks(read, 'noreply@courier.example', [])
    expect(linkDropped).toBe(true)
    expect(kept.candidates).toEqual([{ carrier: null, trackingNumber: 'F12345678901', trackingUrl: null, shortCode: null }])
    expect(kept.postcodes).toEqual([])
    // ...which leaves nothing to agree the postcode with, so nothing is recorded.
    expect(matchTracking({ sender: 'other', supplierIds: [], text: '', orders: ORDERS, despatches: DESPATCHES, found: kept, linkDropped }).kind)
      .not.toBe('apply')
    // A link with no number goes altogether.
    const linkOnly = found({ candidates: [{ carrier: null, trackingNumber: null, trackingUrl: 'https://evil.example/track/X12345', shortCode: null }] })
    expect(believedLinks(linkOnly, 'noreply@courier.example', []).found.candidates).toEqual([])
    // A known carrier's link stays.
    const dpd = found({ candidates: [{ carrier: 'DPD', trackingNumber: null, trackingUrl: 'https://www.dpd.co.uk/d/AbC123dEf456', shortCode: 'AbC123dEf456' }] })
    expect(believedLinks(dpd, 'noreply@evil.example', [])).toMatchObject({ linkDropped: false, found: { candidates: dpd.candidates } })
  })

  it('rule 2 answers a cancelled order by name rather than recording on it', () => {
    expect(match({ sender: 'other', found: found({ candidates: [parcel('F12345678901')], supplierRefs: ['555888'] }) }))
      .toMatchObject({ kind: 'ignore', reason: expect.stringMatching(/PO-00091.*not expecting/) })
  })

  it('rule 3: a parcel already on one of our despatches, by number or by its link’s code', () => {
    expect(match({ sender: 'other', found: found({ candidates: [parcel('F99988877766')] }) }))
      .toMatchObject({ kind: 'apply', rule: 3, order: { id: 'o13' }, despatchId: 'd1' })
    expect(match({ sender: 'other', found: found({ candidates: [parcel(null, 'Q9XZ7A', 'https://multidrop.link/Q9XZ7A/SW1A1AA')], deliveryDate: '2026-10-02' }) }))
      .toMatchObject({ kind: 'apply', rule: 3, order: { id: 'o14' }, despatchId: 'd2' })
  })

  it('N1: a short code only matches the same service’s code', () => {
    const dpdSameCode = parcel(null, 'Q9XZ7A', 'https://www.dpd.co.uk/d/Q9XZ7A')
    expect(match({ sender: 'other', found: found({ candidates: [dpdSameCode] }) }).kind).not.toBe('apply')
  })

  it('B1: rule 3 with the email giving a different delivery postcode only proposes', () => {
    expect(match({ sender: 'other', found: found({ candidates: [parcel('F99988877766')], postcodes: ['LS1 4AP'] }) }))
      .toMatchObject({ kind: 'propose', rule: 3, order: { id: 'o13' }, reason: expect.stringMatching(/LS1 4AP/) })
  })

  it('rule 4: the postcode alone only ever proposes, and only one order waiting to go', () => {
    expect(match({ sender: 'other', found: found({ candidates: [parcel('F12121212121')], postcodes: ['AB1 2DE'] }) }))
      .toMatchObject({ kind: 'propose', rule: 4, order: { id: 'o12' } })
    // PO-00015 shares the postcode but has gone already, so PO-00014 is the one.
    expect(match({ sender: 'other', found: found({ candidates: [parcel('F12121212121')], postcodes: ['SW1A 1AA'] }) }))
      .toMatchObject({ kind: 'propose', order: { id: 'o14' } })
  })

  it('rule 4 also asks about an order already despatched and still waiting to hear its slot', () => {
    const sent = [...ORDERS.filter((o) => o.id !== 'o12'), order({ id: 'o12', number: 'PO-00012', postcode: 'AB1 2DE', awaitingDespatch: false, awaitingDeliveryNews: true })]
    const timeslot = found({ candidates: [parcel(null, 'NEWCODE1')], postcodes: ['AB1 2DE'], deliveryDate: '2026-10-06', deliverySlot: ['10:00', '13:00'] })
    expect(matchTracking({ sender: 'other', supplierIds: [], text: '', despatches: DESPATCHES, orders: sent, found: timeslot }))
      .toMatchObject({ kind: 'propose', rule: 4, order: { id: 'o12' } })
    const settled = sent.map((o) => (o.id === 'o12' ? { ...o, awaitingDeliveryNews: false } : o))
    expect(matchTracking({ sender: 'other', supplierIds: [], text: '', despatches: DESPATCHES, orders: settled, found: timeslot }).kind).toBe('ignore')
  })

  it('rule 4 refuses two orders waiting at one postcode', () => {
    const twins = [...ORDERS, order({ id: 'o16', number: 'PO-00016', postcode: 'AB1 2DE' })]
    expect(matchTracking({
      sender: 'other', supplierIds: [], text: '', despatches: DESPATCHES, orders: twins,
      found: found({ candidates: [parcel('F12121212121')], postcodes: ['AB1 2DE'] }),
    })).toMatchObject({ kind: 'ignore', reason: expect.stringMatching(/2 of our orders/) })
  })

  it('ignores a carrier email with no tracking, and colleagues outright', () => {
    expect(match({ sender: 'other', found: found({ deliveryDate: '2026-10-01', supplierRefs: ['123456'] }) }).kind).toBe('ignore')
    expect(match({ sender: 'internal', text: 'PO-00012', found: found({ candidates: [parcel('F99988877766')] }) }).kind).toBe('ignore')
  })

  it('narrows every rule to a supplier’s own orders', () => {
    // PO-00090's reference, from acme: not theirs.
    expect(match({ sender: 'supplier', found: found({ candidates: [parcel('F12345678901')], supplierRefs: ['555777'] }) }).kind).toBe('ignore')
  })
})

describe('the pieces', () => {
  it('compares references without their leading zeros or punctuation', () => {
    expect(normaliseRef('0000123456')).toBe('123456')
    expect(normaliseRef('PF-0008642')).toBe('PF0008642')
    expect(normaliseRef('0')).toBe('0')
  })

  it('finds our numbers exactly, never inside a longer one', () => {
    expect(poNumbersIn('Re: po-00012 and PO-000123', ['PO-00012', 'PO-000123', 'PO-00099'])).toEqual(['PO-00012', 'PO-000123'])
    expect(poNumbersIn('PO-000123', ['PO-00012'])).toEqual([])
  })
})
