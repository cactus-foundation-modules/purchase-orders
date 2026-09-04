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
    // Acknowledged is the more useful fact, and on these terms it cannot happen
    // until the money has moved anyway.
    expect(orderStatusLabel({ ...proforma, status: 'ACKNOWLEDGED', proformaPaid: true })).toBe('Acknowledged')
    expect(orderStatusLabel({ ...proforma, status: 'PART_RECEIVED' })).toBe('Part received')
  })

  it('marks only the stage that is ours to move', () => {
    expect(proformaWaitsOnUs(proforma)).toBe(false)
    expect(proformaWaitsOnUs({ ...proforma, proformaReceived: true })).toBe(true)
    expect(proformaWaitsOnUs({ ...proforma, proformaReceived: true, proformaPaid: true })).toBe(false)
  })
})
