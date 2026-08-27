import { describe, it, expect } from 'vitest'
import {
  availableBillTransitions,
  billTotals,
  checkBillTransition,
  dueDateFor,
  fullyInvoiced,
  isBillEditable,
  isMatchLive,
  matchBill,
  shouldAutoClose,
  validateBillDrafts,
  varianceTotal,
  type BillLineDraft,
  type MatchOrderLine,
} from './billing'
import type { PoAccess } from './permissions'
import type { PoBillableLine } from './types'

const ALL: PoAccess = {
  isAdminUser: true,
  canAccess: true,
  canCreate: true,
  canApprove: true,
  canReceive: true,
  canBills: true,
  canSettings: true,
}

const NO_BILLS: PoAccess = { ...ALL, isAdminUser: false, canBills: false }

function orderLine(over: Partial<MatchOrderLine> = {}): MatchOrderLine {
  return {
    id: 'ol1',
    description: 'Oak desk',
    qty: '10',
    qtyCancelled: '0',
    qtyReceived: '10',
    qtyInvoicedElsewhere: '0',
    unitCost: '100',
    ...over,
  }
}

function billable(over: Partial<PoBillableLine> = {}): PoBillableLine {
  return {
    orderLineId: 'ol1',
    description: 'Oak desk',
    supplierSku: null,
    unit: 'each',
    unitCost: '100',
    taxRatePercent: '20',
    taxRateCode: null,
    vatTreatment: null,
    categoryId: null,
    qtyOrdered: '10',
    qtyCancelled: '0',
    qtyReceived: '10',
    qtyInvoiced: '0',
    ...over,
  }
}

function draft(over: Partial<BillLineDraft> = {}): BillLineDraft {
  return {
    orderLineId: 'ol1',
    description: 'Oak desk',
    qty: '10',
    unitCost: '100',
    taxRatePercent: '20',
    taxRateCode: null,
    vatTreatment: null,
    categoryId: null,
    ...over,
  }
}

const TOLERANCES = { pricePercent: 2, quantityPercent: 0 }

describe('billTotals', () => {
  it('adds a bill up through the same arithmetic the order uses', () => {
    const totals = billTotals({
      lines: [
        { qty: '10', unitCost: '100', taxRatePercent: '20' },
        { qty: '2', unitCost: '25.50', taxRatePercent: '20' },
      ],
    })
    expect(totals.subtotal).toBe('1051.00')
    expect(totals.taxAmount).toBe('210.20')
    expect(totals.total).toBe('1261.20')
  })

  it('rounds the line once at seven places, not per unit', () => {
    // 250 at 1.0050 is exactly 251.25. Rounding per unit first gives 251.00 and
    // is a pound short of what the supplier will chase.
    const totals = billTotals({ lines: [{ qty: '250', unitCost: '1.0050' }] })
    expect(totals.subtotal).toBe('251.25')
  })

  it('taxes carriage at its own rate, defaulting to the highest on the bill', () => {
    const totals = billTotals({
      lines: [{ qty: '1', unitCost: '100', taxRatePercent: '20' }],
      carriageAmount: '10',
    })
    expect(totals.carriageAmount).toBe('10.00')
    expect(totals.taxAmount).toBe('22.00')
    expect(totals.total).toBe('132.00')
  })

  it("takes the supplier's own VAT figure when it is overtyped, and still reports ours", () => {
    const totals = billTotals({
      lines: [{ qty: '3', unitCost: '33.33', taxRatePercent: '20' }],
      taxOverride: '20.00',
    })
    expect(totals.computedTax).toBe('20.00')
    expect(totals.taxAmount).toBe('20.00')

    const drifted = billTotals({
      lines: [{ qty: '3', unitCost: '33.33', taxRatePercent: '20' }],
      taxOverride: '19.98',
    })
    // Ours is unchanged; the total follows theirs, because theirs is the
    // document that would be shown to anybody who asked.
    expect(drifted.computedTax).toBe('20.00')
    expect(drifted.taxAmount).toBe('19.98')
    expect(drifted.total).toBe('119.97')
  })

  it('treats a blank override as no override at all', () => {
    const totals = billTotals({ lines: [{ qty: '1', unitCost: '10', taxRatePercent: '20' }], taxOverride: '' })
    expect(totals.taxAmount).toBe('2.00')
  })
})

describe('dueDateFor', () => {
  it('counts from the invoice date, not from today', () => {
    expect(dueDateFor('2026-08-02', 30)).toBe('2026-09-01')
  })

  it('has no answer when the supplier has no terms', () => {
    expect(dueDateFor('2026-08-02', null)).toBeNull()
    expect(dueDateFor('2026-08-02', 0)).toBeNull()
  })

  it('refuses to guess at a date it cannot read', () => {
    expect(dueDateFor('not a date', 30)).toBeNull()
  })
})

describe('matchBill', () => {
  it('has nothing to say about a bill with no order behind it', () => {
    const match = matchBill(false, [], [{ orderLineId: null, description: 'Electricity', qty: '1', unitCost: '210' }], TOLERANCES)
    expect(match.status).toBe('NOT_MATCHED')
    expect(match.flags).toEqual([])
  })

  it('agrees when the invoice says what the order and the delivery say', () => {
    const match = matchBill(
      true,
      [orderLine()],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '10', unitCost: '100' }],
      TOLERANCES,
    )
    expect(match.status).toBe('MATCHED')
    expect(match.flags).toEqual([])
  })

  it('lets a price drift inside the tolerance through', () => {
    const match = matchBill(
      true,
      [orderLine()],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '10', unitCost: '101' }],
      TOLERANCES,
    )
    expect(match.status).toBe('MATCHED')
  })

  it('flags a price past the tolerance, with what it is worth', () => {
    const match = matchBill(
      true,
      [orderLine()],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '10', unitCost: '110' }],
      TOLERANCES,
    )
    expect(match.status).toBe('VARIANCE')
    expect(match.flags).toHaveLength(1)
    expect(match.flags[0]!.kind).toBe('PRICE')
    expect(match.flags[0]!.amount).toBe('100.00')
  })

  it('flags a price that has come DOWN too, as a negative amount', () => {
    const match = matchBill(
      true,
      [orderLine()],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '10', unitCost: '90' }],
      TOLERANCES,
    )
    expect(match.flags[0]!.kind).toBe('PRICE')
    expect(match.flags[0]!.amount).toBe('-100.00')
  })

  it('flags being invoiced for more than turned up', () => {
    const match = matchBill(
      true,
      [orderLine({ qtyReceived: '8' })],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '10', unitCost: '100' }],
      TOLERANCES,
    )
    expect(match.status).toBe('VARIANCE')
    expect(match.flags[0]!.kind).toBe('QUANTITY')
    expect(match.flags[0]!.amount).toBe('200.00')
    expect(match.flags[0]!.message).toContain('only 8 turned up')
  })

  it('says so plainly when nothing has been delivered at all', () => {
    const match = matchBill(
      true,
      [orderLine({ qtyReceived: '0' })],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '10', unitCost: '100' }],
      TOLERANCES,
    )
    expect(match.flags[0]!.kind).toBe('NOT_RECEIVED')
  })

  it('is quiet about a part invoice, which is entirely ordinary', () => {
    const match = matchBill(
      true,
      [orderLine({ qtyReceived: '10' })],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '4', unitCost: '100' }],
      TOLERANCES,
    )
    expect(match.status).toBe('MATCHED')
  })

  it('counts what OTHER bills have already claimed on the same line', () => {
    const match = matchBill(
      true,
      [orderLine({ qtyReceived: '10', qtyInvoicedElsewhere: '7' })],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '4', unitCost: '100' }],
      TOLERANCES,
    )
    expect(match.flags[0]!.kind).toBe('QUANTITY')
    expect(match.flags[0]!.message).toContain('invoiced for 11')
  })

  it('adds two bill lines against one order line together before judging them', () => {
    const match = matchBill(
      true,
      [orderLine({ qtyReceived: '10' })],
      [
        { orderLineId: 'ol1', description: 'Oak desk', qty: '6', unitCost: '100' },
        { orderLineId: 'ol1', description: 'Oak desk', qty: '6', unitCost: '100' },
      ],
      TOLERANCES,
    )
    const quantity = match.flags.filter((f) => f.kind === 'QUANTITY')
    expect(quantity).toHaveLength(1)
    expect(quantity[0]!.message).toContain('invoiced for 12')
  })

  it('honours a quantity tolerance', () => {
    const match = matchBill(
      true,
      [orderLine({ qtyReceived: '10' })],
      [{ orderLineId: 'ol1', description: 'Oak desk', qty: '10.5', unitCost: '100' }],
      { pricePercent: 2, quantityPercent: 5 },
    )
    expect(match.status).toBe('MATCHED')
  })

  it('flags a charge that is on no order line', () => {
    const match = matchBill(
      true,
      [orderLine()],
      [
        { orderLineId: 'ol1', description: 'Oak desk', qty: '10', unitCost: '100' },
        { orderLineId: null, description: 'Pallet fee', qty: '1', unitCost: '18' },
      ],
      TOLERANCES,
    )
    expect(match.flags).toHaveLength(1)
    expect(match.flags[0]!.kind).toBe('NOT_ORDERED')
    expect(match.flags[0]!.amount).toBe('18.00')
  })

  it('treats a bill line pointing at somebody else’s order line as unordered', () => {
    const match = matchBill(
      true,
      [orderLine()],
      [{ orderLineId: 'somebody-elses', description: 'Chair', qty: '1', unitCost: '50' }],
      TOLERANCES,
    )
    expect(match.flags[0]!.kind).toBe('NOT_ORDERED')
  })

  it('adds the disagreement up for the line the screen leads with', () => {
    const match = matchBill(
      true,
      [orderLine({ qtyReceived: '8' })],
      [
        { orderLineId: 'ol1', description: 'Oak desk', qty: '10', unitCost: '110' },
        { orderLineId: null, description: 'Pallet fee', qty: '1', unitCost: '18' },
      ],
      TOLERANCES,
    )
    // 100 of price drift, 220 of goods nobody has seen, 18 nobody ordered.
    expect(varianceTotal(match.flags)).toBe('338.00')
  })
})

describe('the bill state machine', () => {
  it('needs the bills permission for every move', () => {
    expect(checkBillTransition('approve', 'DRAFT', NO_BILLS).ok).toBe(false)
    expect(availableBillTransitions('DRAFT', NO_BILLS)).toEqual([])
  })

  it('approves from draft and from queried alike', () => {
    expect(checkBillTransition('approve', 'DRAFT', ALL)).toMatchObject({ ok: true, to: 'APPROVED' })
    expect(checkBillTransition('approve', 'QUERIED', ALL)).toMatchObject({ ok: true, to: 'APPROVED' })
  })

  it('refuses a move the bill cannot make, in words', () => {
    const check = checkBillTransition('approve', 'VOID', ALL)
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('void')
  })

  it('leaves a voided bill alone', () => {
    expect(availableBillTransitions('VOID', ALL)).toEqual([])
  })

  it('will not put a bill in the books from here', () => {
    expect(availableBillTransitions('APPROVED', ALL)).not.toContain('post')
  })

  it('freezes the figures and the match once somebody has approved it', () => {
    expect(isBillEditable('DRAFT')).toBe(true)
    expect(isBillEditable('QUERIED')).toBe(true)
    expect(isBillEditable('APPROVED')).toBe(false)
    expect(isMatchLive('APPROVED')).toBe(false)
    expect(isMatchLive('QUERIED')).toBe(true)
  })
})

describe('validateBillDrafts', () => {
  it('takes the description off the order line when the form left it blank', () => {
    const check = validateBillDrafts([billable()], [draft({ description: '' })])
    expect(check.ok).toBe(true)
    expect(check.ok === true && check.lines[0]!.description).toBe('Oak desk')
  })

  it('refuses a line that says nothing at all', () => {
    const check = validateBillDrafts([], [draft({ orderLineId: null, description: '  ' })])
    expect(check.ok).toBe(false)
  })

  it('refuses a line with no quantity on it', () => {
    const check = validateBillDrafts([billable()], [draft({ qty: '0' })])
    expect(check.ok).toBe(false)
  })

  it('drops an order line id that is not on this order rather than filing against it', () => {
    const check = validateBillDrafts([billable()], [draft({ orderLineId: 'somebody-elses' })])
    expect(check.ok).toBe(true)
    expect(check.ok === true && check.lines[0]!.orderLineId).toBeNull()
  })

  it('refuses a bill with nothing on it', () => {
    const check = validateBillDrafts([billable()], [])
    expect(check.ok).toBe(false)
  })
})

describe('closing an order once it is done', () => {
  const line = { qty: '10', qtyCancelled: '0', qtyReceived: '10', qtyInvoiced: '10' }

  it('knows when every line has been invoiced in full', () => {
    expect(fullyInvoiced([line])).toBe(true)
    expect(fullyInvoiced([{ ...line, qtyInvoiced: '9' }])).toBe(false)
  })

  it('ignores a line that was cancelled in its entirety', () => {
    expect(fullyInvoiced([line, { qty: '4', qtyCancelled: '4', qtyReceived: '0', qtyInvoiced: '0' }])).toBe(true)
  })

  it('has no opinion about an order with no live lines', () => {
    expect(fullyInvoiced([{ qty: '4', qtyCancelled: '4', qtyReceived: '0', qtyInvoiced: '0' }])).toBe(false)
  })

  it('closes a received, fully invoiced order with nothing outstanding', () => {
    expect(shouldAutoClose('RECEIVED', [line], 0)).toBe(true)
  })

  it('leaves an order alone while a supplier still owes a credit', () => {
    expect(shouldAutoClose('RECEIVED', [line], 1)).toBe(false)
  })

  it('never closes an order that is not fully delivered', () => {
    expect(shouldAutoClose('PART_RECEIVED', [line], 0)).toBe(false)
    expect(shouldAutoClose('ON_HOLD', [line], 0)).toBe(false)
  })
})
