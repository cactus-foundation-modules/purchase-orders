import { describe, it, expect } from 'vitest'
import {
  availableReturnTransitions,
  canSendReturn,
  checkReturnTransition,
  creditOutstanding,
  isReturnEditable,
  isReturnStockable,
  overReturnProblems,
  returnableQty,
  returnTotals,
  validateReturnDrafts,
} from './returning'
import type { PoAccess } from './permissions'
import type { PoReturnableLine } from './types'

const all: PoAccess = {
  isAdminUser: true,
  canAccess: true,
  canCreate: true,
  canApprove: true,
  canReceive: true,
  canBills: true,
  canSettings: true,
}

const goodsInOnly: PoAccess = { ...all, isAdminUser: false, canBills: false }
const booksOnly: PoAccess = { ...all, isAdminUser: false, canReceive: false }

function line(patch: Partial<PoReturnableLine> = {}): PoReturnableLine {
  return {
    orderLineId: 'l1',
    description: 'Oak desk 1600mm',
    supplierSku: 'ND-1600-OAK',
    productId: 'p1',
    unit: 'each',
    unitCost: '165.0000',
    taxRatePercent: '20.00',
    qtyReceived: '10.000',
    qtyReturned: '0.000',
    receipts: [
      {
        receiptLineId: 'rl1',
        receiptId: 'r1',
        receiptNumber: 'GRN-00032',
        receivedDate: '2026-05-01',
        qtyAccepted: '10.000',
        stockApplied: true,
      },
    ],
    ...patch,
  }
}

describe('what is left to send back', () => {
  it('is what arrived less what has already gone', () => {
    expect(returnableQty({ qtyReceived: '10.000', qtyReturned: '3.000' })).toBe(7)
  })

  it('never goes below zero, even when somebody has over-credited us', () => {
    expect(returnableQty({ qtyReceived: '2', qtyReturned: '5' })).toBe(0)
  })
})

describe('over-returning', () => {
  it('refuses more than ever turned up', () => {
    const problems = overReturnProblems(
      [{ id: 'l1', description: 'Oak desk', qtyReceived: '10', qtyReturned: '0' }],
      [{ orderLineId: 'l1', qty: 12 }],
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]!.allowed).toBe(10)
    expect(problems[0]!.returning).toBe(12)
  })

  it('counts what has already gone back on an earlier note', () => {
    const problems = overReturnProblems(
      [{ id: 'l1', description: 'Oak desk', qtyReceived: '10', qtyReturned: '8' }],
      [{ orderLineId: 'l1', qty: 3 }],
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]!.allowed).toBe(2)
  })

  it('allows sending back exactly everything that is left', () => {
    expect(
      overReturnProblems(
        [{ id: 'l1', description: 'Oak desk', qtyReceived: '10', qtyReturned: '8' }],
        [{ orderLineId: 'l1', qty: 2 }],
      ),
    ).toEqual([])
  })

  it('is not tripped by a floating-point crumb on a fractional quantity', () => {
    // 0.1 + 0.2 is 0.30000000000000004. Rounded to the three places the column
    // holds, sending back the last 0.3 of a metre is exactly the last 0.3.
    expect(
      overReturnProblems(
        [{ id: 'l1', description: 'Cable', qtyReceived: '0.3', qtyReturned: '0' }],
        [{ orderLineId: 'l1', qty: 0.1 + 0.2 }],
      ),
    ).toEqual([])
  })

  it('ignores lines nobody is sending back', () => {
    expect(
      overReturnProblems(
        [{ id: 'l1', description: 'Oak desk', qtyReceived: '0', qtyReturned: '0' }],
        [{ orderLineId: 'l1', qty: 0 }],
      ),
    ).toEqual([])
  })
})

describe('what a return is worth', () => {
  it('adds up the lines and their tax', () => {
    const totals = returnTotals([
      { qty: '2', unitCost: '165.0000', taxRatePercent: '20' },
      { qty: '1', unitCost: '55.0000', taxRatePercent: '20' },
    ])
    expect(totals.subtotal).toBe('385.00')
    expect(totals.taxAmount).toBe('77.00')
    expect(totals.creditExpected).toBe('462.00')
    expect(totals.lineTotals).toEqual(['330.00', '55.00'])
  })

  it('rounds a sub-penny unit cost once, at the line', () => {
    // 250 at 1.005 is 251.25 exactly. Rounding per unit first gives 250.00 or
    // 252.50 depending on which way it goes, and either is an argument with the
    // supplier about a pound.
    expect(returnTotals([{ qty: '250', unitCost: '1.0050', taxRatePercent: '0' }]).creditExpected).toBe('251.25')
  })

  it('is nothing at all when nothing is going back', () => {
    expect(returnTotals([]).creditExpected).toBe('0.00')
  })
})

describe('what is still owed', () => {
  it('is the claim less whatever has been credited', () => {
    expect(creditOutstanding('396.00', '100.00')).toBe('296.00')
  })

  it('never reads as a negative when a supplier over-credits', () => {
    expect(creditOutstanding('396.00', '500.00')).toBe('0.00')
  })
})

describe('the state machine', () => {
  it('lets the goods-in desk send a draft', () => {
    expect(checkReturnTransition('send', 'DRAFT', goodsInOnly)).toEqual({
      ok: true, to: 'SENT', label: 'Sent to supplier',
    })
  })

  it('refuses to send one twice', () => {
    const check = checkReturnTransition('send', 'SENT', all)
    expect(check.ok).toBe(false)
  })

  it('keeps recording the credit to whoever does the books', () => {
    expect(checkReturnTransition('credited', 'SENT', goodsInOnly).ok).toBe(false)
    expect(checkReturnTransition('credited', 'SENT', booksOnly).ok).toBe(true)
  })

  it('accepts a credit that arrives without being promised first', () => {
    // Plenty of suppliers simply send the credit note. Making somebody click
    // "they have promised" about money already in the bank is silly.
    expect(checkReturnTransition('credited', 'SENT', all).ok).toBe(true)
    expect(checkReturnTransition('credited', 'CREDIT_EXPECTED', all).ok).toBe(true)
  })

  it('will not cancel one that has already been credited', () => {
    expect(checkReturnTransition('cancel', 'CREDITED', all).ok).toBe(false)
  })

  it('offers nothing at all on a cancelled note', () => {
    expect(availableReturnTransitions('CANCELLED', all)).toEqual([])
  })

  it('offers only what this user may actually do', () => {
    expect(availableReturnTransitions('SENT', goodsInOnly)).not.toContain('credited')
  })
})

describe('what may still be done to a return', () => {
  it('only edits a draft', () => {
    expect(isReturnEditable('DRAFT')).toBe(true)
    expect(isReturnEditable('SENT')).toBe(false)
  })

  it('re-sends anything the supplier could still be looking for', () => {
    expect(canSendReturn('SENT')).toBe(true)
    expect(canSendReturn('CREDITED')).toBe(true)
    expect(canSendReturn('CANCELLED')).toBe(false)
    expect(canSendReturn('CLOSED')).toBe(false)
  })

  it('takes stock off only once the goods have actually left', () => {
    expect(isReturnStockable('DRAFT')).toBe(false)
    expect(isReturnStockable('CANCELLED')).toBe(false)
    expect(isReturnStockable('SENT')).toBe(true)
    expect(isReturnStockable('CREDITED')).toBe(true)
  })
})

describe('checking a note before it is written', () => {
  it('takes the cost off the order line, never off the browser', () => {
    const check = validateReturnDrafts([line()], [{ orderLineId: 'l1', receiptLineId: 'rl1', qty: '2' }])
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.lines[0]!.unitCost).toBe('165.0000')
    expect(check.lines[0]!.taxRatePercent).toBe('20.00')
  })

  it('refuses a line that is not on this order', () => {
    const check = validateReturnDrafts([line()], [{ orderLineId: 'somebody-elses', receiptLineId: null, qty: '1' }])
    expect(check.ok).toBe(false)
  })

  it('refuses more than turned up, in words somebody can act on', () => {
    const check = validateReturnDrafts([line()], [{ orderLineId: 'l1', receiptLineId: 'rl1', qty: '99' }])
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toContain('Oak desk')
  })

  it('drops a delivery reference that belongs to a different line', () => {
    // It would print the wrong delivery number on the note and, worse, settle
    // the stock question off somebody else's paperwork.
    const check = validateReturnDrafts([line()], [{ orderLineId: 'l1', receiptLineId: 'not-ours', qty: '1' }])
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.lines[0]!.receiptLineId).toBeNull()
  })

  it('keeps a delivery reference that is this line s own', () => {
    const check = validateReturnDrafts([line()], [{ orderLineId: 'l1', receiptLineId: 'rl1', qty: '1' }])
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.lines[0]!.receiptLineId).toBe('rl1')
  })
})
