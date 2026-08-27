import { describe, it, expect } from 'vitest'
import {
  isPortalOpen, parsePortalDate, portalEventSummary, portalView,
} from '@/modules/purchase-orders/lib/portal-view'
import type { PoOrder, PoOrderLine, PoStatus } from '@/modules/purchase-orders/lib/types'

// The projection is the wall between "what this business is doing about this
// order" and "what the supplier is allowed to see". A test that only checked the
// fields it DOES carry would pass just as happily on the day somebody spread the
// order row in, so the important test here is the one that looks for what is
// missing.

function line(patch: Partial<PoOrderLine> = {}): PoOrderLine {
  return {
    id: 'line-1',
    position: 0,
    productId: null,
    productName: null,
    supplierSku: 'ND-1600-OAK',
    ourSku: 'DSK-1600-OAK',
    description: 'Oak desk 1600mm',
    qty: '12.000',
    unit: 'each',
    unitCost: '165.0000',
    discountPercent: null,
    taxRatePercent: '20.00',
    taxRateCode: null,
    vatTreatment: null,
    categoryId: null,
    lineTotal: '1980.00',
    expectedDate: '2026-04-24',
    qtyCancelled: '0.000',
    serviceName: 'Pre-assembled delivery, two-man',
    serviceCost: '39.0000',
    qtyReceived: '0.000',
    qtyInvoiced: '0.000',
    qtyReturned: '0.000',
    ...patch,
  }
}

function order(patch: Partial<PoOrder> = {}): PoOrder {
  return {
    id: 'order-1',
    number: 'PO-00147',
    revision: 2,
    status: 'SENT' as PoStatus,
    supplierId: 'supplier-1',
    supplierName: 'Northern Clay Co.',
    supplierSnapshot: {},
    shipToKind: 'CUSTOMER',
    shipTo: {
      name: 'Sample Customer Ltd',
      contact: 'Site office',
      phone: '0113 496 0000',
      address: { line1: 'Unit 4', line2: '', city: 'Leeds', region: '', postcode: 'LS1 1AA', country: '' },
      instructions: '',
    },
    sourceKind: 'MANUAL',
    sourceRef: null,
    currency: 'GBP',
    baseCurrency: 'GBP',
    fxRate: '1',
    taxMode: 'EXCLUSIVE',
    subtotal: '1980.00',
    discountAmount: '0.00',
    carriageAmount: '0.00',
    taxAmount: '396.00',
    total: '2376.00',
    raisedDate: '2026-04-06',
    requiredByDate: '2026-04-27',
    expectedDate: '2026-04-24',
    paymentTerms: 'Net 30',
    deliveryTerms: '',
    notesSupplier: 'Book the delivery in first.',
    notesInternal: 'Check they have not stitched us up on carriage again.',
    approvalRequired: true,
    approvedByUserId: 'user-9',
    approvedAt: '2026-04-06T11:20:00.000Z',
    approvalNote: 'Fine, but watch the carriage.',
    sentAt: '2026-04-06T12:00:00.000Z',
    acknowledgedAt: null,
    acknowledgedNote: null,
    cancelledAt: null,
    cancelReason: null,
    closedAt: null,
    closeReason: null,
    lineCount: 1,
    createdAt: '2026-04-06T10:00:00.000Z',
    updatedAt: '2026-04-06T12:00:00.000Z',
    lines: [line()],
    ...patch,
  }
}

describe('the supplier projection', () => {
  it("carries nothing that is none of the supplier's business", () => {
    const wire = JSON.stringify(portalView(order(), []))
    expect(wire).not.toContain('stitched us up')
    expect(wire).not.toContain('watch the carriage')
    expect(wire).not.toContain('user-9')
    expect(wire).not.toContain('supplier-1')
    // No money at all: the document above the panel already prints their own
    // prices, and the panel has no use for a total. That includes what we are
    // paying for the delivery service - they get its name, never its cost.
    expect(wire).not.toContain('2376.00')
    expect(wire).not.toContain('165.0000')
    expect(wire).not.toContain('39.0000')
  })

  it('carries what they do need to answer', () => {
    const view = portalView(order(), [])
    expect(view.orderNumber).toBe('PO-00147')
    expect(view.revision).toBe(2)
    expect(view.expectedDate).toBe('2026-04-24')
    expect(view.requiredByDate).toBe('2026-04-27')
    expect(view.lines).toHaveLength(1)
    expect(view.lines[0]!.description).toBe('Oak desk 1600mm')
    expect(view.lines[0]!.qty).toBe('12')
    // A deliberate disclosure: they cannot send a line on the right service
    // without being told which one it is.
    expect(view.lines[0]!.serviceName).toBe('Pre-assembled delivery, two-man')
  })

  it('takes the cancelled quantity off what they can be short of', () => {
    const view = portalView(order({ lines: [line({ qty: '12.000', qtyCancelled: '4.000' })] }), [])
    expect(view.lines[0]!.qty).toBe('8')
  })

  it('drops a line that has been given up on entirely', () => {
    const view = portalView(order({ lines: [line({ qty: '12.000', qtyCancelled: '12.000' })] }), [])
    expect(view.lines).toHaveLength(0)
  })

  it('says whether the order is still one they can answer', () => {
    for (const status of ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'ON_HOLD'] as PoStatus[]) {
      expect(isPortalOpen(status)).toBe(true)
    }
    for (const status of ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as PoStatus[]) {
      expect(isPortalOpen(status)).toBe(false)
    }
  })

  it('reads the acknowledgement off the order rather than off the status alone', () => {
    expect(portalView(order(), []).acknowledged).toBe(false)
    expect(portalView(order({ acknowledgedAt: '2026-04-07T09:00:00.000Z' }), []).acknowledged).toBe(true)
  })
})

describe('what the supplier said, as a sentence', () => {
  it('reads an acknowledgement with and without a note', () => {
    expect(portalEventSummary('ACKNOWLEDGED', {})).toBe('Accepted the order.')
    expect(portalEventSummary('ACKNOWLEDGED', { note: 'Out Friday.' })).toBe('Accepted the order: Out Friday.')
  })

  it('reads a date, and survives one that is not a date', () => {
    expect(portalEventSummary('DATE_PROPOSED', { date: '2026-05-04' })).toBe('Offered 2026-05-04 instead.')
    expect(portalEventSummary('DATE_PROPOSED', { date: 'next Tuesday' })).toBe('Offered a different date.')
  })

  it('reads a shortage, however odd the payload', () => {
    expect(
      portalEventSummary('SHORTAGE', {
        lines: [{ description: 'Oak desk 1600mm', qty: '4' }],
        note: 'Veneer is short.',
      }),
    ).toBe('Short on Oak desk 1600mm (4 short). Veneer is short.')
    expect(portalEventSummary('SHORTAGE', { lines: 'nonsense' })).toBe('Said something is short.')
    expect(portalEventSummary('SHORTAGE', { lines: [{}] })).toBe('Short on a line.')
  })

  it('reads a message as what they typed', () => {
    expect(portalEventSummary('MESSAGE', { text: '  Can we split the delivery?  ' })).toBe('Can we split the delivery?')
    expect(portalEventSummary('MESSAGE', {})).toBe('')
  })
})

describe('dates off the wire', () => {
  it('takes a plain day and refuses everything else', () => {
    expect(parsePortalDate('2026-05-04')).toBe('2026-05-04')
    for (const bad of ['4 May', '2026-5-4', '2026-05-04T00:00:00Z', 42, null, undefined, {}]) {
      expect(parsePortalDate(bad)).toBeNull()
    }
  })
})
