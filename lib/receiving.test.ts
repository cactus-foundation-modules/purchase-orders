import { describe, it, expect } from 'vitest'
import { isReceivable, outstanding, overReceiptFlags, statusAfterReceipts } from './receiving'
import { receiptStatus } from './progress'
import type { PoOrderLine } from './types'

// Receiving is the point where the paperwork and the yard can start disagreeing,
// and every disagreement here is silent: nothing crashes, the screen looks
// perfectly reasonable, and six weeks later nobody can say what was delivered.

function line(patch: Partial<PoOrderLine> = {}): PoOrderLine {
  return {
    id: 'l1',
    position: 0,
    productId: null,
    productName: null,
    supplierSku: null,
    ourSku: null,
    description: 'Task chair',
    qty: '10',
    unit: 'each',
    unitCost: '100.0000',
    discountPercent: null,
    taxRatePercent: '20',
    taxRateCode: null,
    vatTreatment: null,
    categoryId: null,
    lineTotal: '1000.00',
    expectedDate: null,
    qtyCancelled: '0',
    serviceName: null,
    serviceCost: null,
    qtyReceived: '0',
    qtyInvoiced: '0',
    qtyReturned: '0',
    ...patch,
  }
}

describe('outstanding', () => {
  it('takes cancelled quantities off what is still expected', () => {
    expect(outstanding(line({ qty: '10', qtyCancelled: '4', qtyReceived: '2' }))).toBe(4)
  })

  it('never goes below zero on an over-delivery', () => {
    expect(outstanding(line({ qty: '10', qtyReceived: '12' }))).toBe(0)
  })
})

describe('overReceiptFlags', () => {
  it('says nothing about a delivery that matches the order', () => {
    const flags = overReceiptFlags([line()], [{ orderLineId: 'l1', qtyAccepted: 10, qtyRejected: 0 }], 0)
    expect(flags).toEqual([])
  })

  it('flags the excess once the tolerance is used up', () => {
    const flags = overReceiptFlags([line()], [{ orderLineId: 'l1', qtyAccepted: 12, qtyRejected: 0 }], 10)
    expect(flags).toHaveLength(1)
    expect(flags[0]!.overBy).toBe(2)
    expect(flags[0]!.allowed).toBe(11)
  })

  it('allows an excess that sits inside the tolerance', () => {
    expect(overReceiptFlags([line()], [{ orderLineId: 'l1', qtyAccepted: 11, qtyRejected: 0 }], 10)).toEqual([])
  })

  it('counts what has already arrived, not just this delivery', () => {
    const flags = overReceiptFlags(
      [line({ qtyReceived: '9' })],
      [{ orderLineId: 'l1', qtyAccepted: 3, qtyRejected: 0 }],
      0,
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]!.overBy).toBe(2)
  })

  it('ignores rejected quantities - they arrived and went straight back', () => {
    expect(overReceiptFlags([line()], [{ orderLineId: 'l1', qtyAccepted: 10, qtyRejected: 5 }], 0)).toEqual([])
  })

  it('does not flag a delivery of ten against a tolerance that floats', () => {
    // 10 * (1 + 3/100) is 10.299999999999999, and comparing raw floats has
    // flagged a perfectly ordinary delivery before now.
    expect(overReceiptFlags([line()], [{ orderLineId: 'l1', qtyAccepted: 10.3, qtyRejected: 0 }], 3)).toEqual([])
  })

  it('measures against what is live, not what was ordered before a cancellation', () => {
    const flags = overReceiptFlags(
      [line({ qty: '10', qtyCancelled: '6' })],
      [{ orderLineId: 'l1', qtyAccepted: 5, qtyRejected: 0 }],
      0,
    )
    expect(flags).toHaveLength(1)
    expect(flags[0]!.ordered).toBe(4)
  })
})

describe('statusAfterReceipts', () => {
  it('moves a sent order to part received', () => {
    expect(statusAfterReceipts('SENT', 'PART_RECEIVED', false)).toBe('PART_RECEIVED')
  })

  it('leaves an order where it already is', () => {
    expect(statusAfterReceipts('PART_RECEIVED', 'PART_RECEIVED', false)).toBeNull()
  })

  it('never trades a deliberate decision for arithmetic', () => {
    expect(statusAfterReceipts('ON_HOLD', 'RECEIVED', false)).toBeNull()
    expect(statusAfterReceipts('CLOSED', 'PART_RECEIVED', false)).toBeNull()
    expect(statusAfterReceipts('CANCELLED', 'RECEIVED', false)).toBeNull()
  })

  it('walks an order back when its last delivery is deleted', () => {
    expect(statusAfterReceipts('PART_RECEIVED', null, false)).toBe('SENT')
    expect(statusAfterReceipts('RECEIVED', null, true)).toBe('ACKNOWLEDGED')
  })

  it('does not promote an order that has not been sent', () => {
    expect(statusAfterReceipts('DRAFT', 'PART_RECEIVED', false)).toBeNull()
    expect(statusAfterReceipts('APPROVED', 'RECEIVED', false)).toBeNull()
  })
})

describe('receiptStatus with cancelled lines', () => {
  it('counts an order complete once the balance of a short line is given up on', () => {
    // Six of ten arrived and the rest are never coming: cancelling the balance
    // is what lets the order finish, which is the whole reason the operation
    // exists separately from an edit.
    expect(
      receiptStatus([{ qty: '10', qtyCancelled: '4', qtyReceived: '6' }]),
    ).toBe('RECEIVED')
  })

  it('is still short while anything is outstanding', () => {
    expect(receiptStatus([{ qty: '10', qtyCancelled: '0', qtyReceived: '6' }])).toBe('PART_RECEIVED')
  })
})

describe('isReceivable', () => {
  it('takes a delivery against anything the supplier is holding', () => {
    expect(isReceivable('SENT')).toBe(true)
    expect(isReceivable('ACKNOWLEDGED')).toBe(true)
    expect(isReceivable('PART_RECEIVED')).toBe(true)
    // A further delivery against a fully received order is how an over-delivery
    // that arrives in two lorries gets recorded.
    expect(isReceivable('RECEIVED')).toBe(true)
  })

  it('refuses one against an order nobody has sent, or that is finished with', () => {
    expect(isReceivable('DRAFT')).toBe(false)
    expect(isReceivable('APPROVED')).toBe(false)
    expect(isReceivable('CANCELLED')).toBe(false)
    expect(isReceivable('CLOSED')).toBe(false)
  })
})
