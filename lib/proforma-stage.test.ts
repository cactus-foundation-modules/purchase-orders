import { describe, expect, it } from 'vitest'

import {
  orderStatusLabel,
  proformaStage,
  proformaWaitsOnUs,
  type PoStageFacts,
} from '@/modules/purchase-orders/lib/proforma-stage'

const onAccount: PoStageFacts = {
  status: 'SENT',
  proformaRequired: false,
  proformaReceived: false,
  proformaPaid: false,
}
const proforma: PoStageFacts = { ...onAccount, proformaRequired: true }

describe('proformaStage', () => {
  it('has nothing to say about an order on the supplier’s account', () => {
    expect(proformaStage(onAccount)).toBe('NONE')
    expect(orderStatusLabel(onAccount)).toBe('Sent')
  })

  it('walks through the dance', () => {
    expect(orderStatusLabel(proforma)).toBe('Waiting for proforma')
    expect(orderStatusLabel({ ...proforma, proformaReceived: true })).toBe('Proforma received')
    expect(orderStatusLabel({ ...proforma, proformaReceived: true, proformaPaid: true })).toBe('Proforma paid')
  })

  it('reads paid off the payment alone, for a proforma nobody filed', () => {
    // Somebody can mark a proforma paid off an invoice that arrived by post and
    // never got uploaded. "Paid" is still the truer thing to say than "waiting".
    expect(orderStatusLabel({ ...proforma, proformaPaid: true })).toBe('Proforma paid')
  })

  it('stands aside for every other status', () => {
    expect(orderStatusLabel({ ...proforma, status: 'DRAFT' })).toBe('Draft')
    expect(orderStatusLabel({ ...proforma, status: 'ON_HOLD' })).toBe('On hold')
    // Once the proforma is paid, acknowledged is the more useful fact.
    expect(orderStatusLabel({ ...proforma, status: 'ACKNOWLEDGED', proformaPaid: true })).toBe('Acknowledged')
    expect(orderStatusLabel({ ...proforma, status: 'PART_RECEIVED' })).toBe('Part received')
    // And an order on their account never mentions a proforma at all.
    expect(orderStatusLabel({ ...onAccount, status: 'ACKNOWLEDGED' })).toBe('Acknowledged')
  })

  it('keeps an unpaid proforma in sight once they have acknowledged the order', () => {
    // Their emailed sales order acknowledges an order whether or not we have
    // paid yet. The badge must still say money is owed.
    const acknowledged: PoStageFacts = { ...proforma, status: 'ACKNOWLEDGED' }
    expect(proformaStage({ ...acknowledged, proformaReceived: true })).toBe('RECEIVED')
    expect(orderStatusLabel({ ...acknowledged, proformaReceived: true })).toBe('Acknowledged, proforma to pay')
    expect(orderStatusLabel(acknowledged)).toBe('Acknowledged, proforma awaited')
    expect(proformaStage({ ...acknowledged, proformaReceived: true, proformaPaid: true })).toBe('NONE')
  })

  it('marks only the stage that is ours to move', () => {
    expect(proformaWaitsOnUs(proforma)).toBe(false)
    expect(proformaWaitsOnUs({ ...proforma, proformaReceived: true })).toBe(true)
    expect(proformaWaitsOnUs({ ...proforma, proformaReceived: true, proformaPaid: true })).toBe(false)
    expect(proformaWaitsOnUs({ ...proforma, status: 'ACKNOWLEDGED', proformaReceived: true })).toBe(true)
    expect(proformaWaitsOnUs({ ...proforma, status: 'ACKNOWLEDGED' })).toBe(false)
    expect(proformaWaitsOnUs({ ...proforma, status: 'ACKNOWLEDGED', proformaReceived: true, proformaPaid: true })).toBe(false)
  })
})
