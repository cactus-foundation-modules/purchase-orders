import { describe, expect, it } from 'vitest'
import { nextPaperworkStep, type PoPaperworkFacts } from './next-step'

function facts(patch: Partial<PoPaperworkFacts> = {}): PoPaperworkFacts {
  return {
    status: 'SENT',
    proformaRequired: true,
    proformaReceived: false,
    proformaPaid: false,
    acknowledged: false,
    fullyInvoiced: false,
    ...patch,
  }
}

describe('nextPaperworkStep', () => {
  it('walks an order on proforma terms through all four, in order', () => {
    expect(nextPaperworkStep(facts())).toBe('PROFORMA')
    expect(nextPaperworkStep(facts({ proformaReceived: true }))).toBe('PAYMENT')
    expect(nextPaperworkStep(facts({ proformaReceived: true, proformaPaid: true }))).toBe('ACKNOWLEDGEMENT')
    expect(
      nextPaperworkStep(facts({ status: 'ACKNOWLEDGED', proformaReceived: true, proformaPaid: true, acknowledged: true })),
    ).toBe('INVOICE')
    expect(
      nextPaperworkStep(
        facts({ status: 'ACKNOWLEDGED', proformaReceived: true, proformaPaid: true, acknowledged: true, fullyInvoiced: true }),
      ),
    ).toBeNull()
  })

  it('skips the proforma for a supplier on a credit account', () => {
    expect(nextPaperworkStep(facts({ proformaRequired: false }))).toBe('ACKNOWLEDGEMENT')
  })

  it('treats a payment recorded with no proforma filed as paid', () => {
    // Paid is paid: somebody paid off an email and never filed the document.
    expect(nextPaperworkStep(facts({ proformaPaid: true }))).toBe('ACKNOWLEDGEMENT')
  })

  it('does not chase an acknowledgement for goods that have already turned up', () => {
    expect(nextPaperworkStep(facts({ status: 'PART_RECEIVED', proformaRequired: false }))).toBe('INVOICE')
  })

  it('has nothing to ask of an order the supplier is not holding', () => {
    for (const status of ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'ON_HOLD', 'PENDING_CLOSE', 'CLOSED', 'CANCELLED'] as const) {
      expect(nextPaperworkStep(facts({ status })), status).toBeNull()
    }
  })
})
