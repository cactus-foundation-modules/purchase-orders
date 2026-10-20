import { describe, expect, it } from 'vitest'
import { autoSettleVerdict, type SettleFacts } from './auto-settle'

const fullyInvoicedLine = { qty: '2', qtyCancelled: '0', qtyReceived: '2', qtyInvoiced: '2' }

function facts(over: Partial<SettleFacts> = {}): SettleFacts {
  return {
    orderStatus: 'PENDING_CLOSE',
    orderTotal: '231.79',
    dropships: false,
    lines: [fullyInvoicedLine],
    openReturns: 0,
    bills: [{ id: 'b1', status: 'DRAFT', total: '231.79', matchStatus: 'MATCHED' }],
    ...over,
  }
}

describe('autoSettleVerdict', () => {
  it('approves a clean draft that comes to exactly the order total', () => {
    expect(autoSettleVerdict(facts())).toEqual({ ok: true, approve: ['b1'] })
  })

  it('closes an order whose only bill is already approved, approving nothing', () => {
    const verdict = autoSettleVerdict(facts({ bills: [{ id: 'b1', status: 'APPROVED', total: '231.79', matchStatus: 'MATCHED' }] }))
    expect(verdict).toEqual({ ok: true, approve: [] })
  })

  it('treats an order a person typed the invoice into (still Received) the same way', () => {
    expect(autoSettleVerdict(facts({ orderStatus: 'RECEIVED' })).ok).toBe(true)
  })

  it('leaves it alone with no bill, or only a void one', () => {
    expect(autoSettleVerdict(facts({ bills: [] })).ok).toBe(false)
    expect(autoSettleVerdict(facts({ bills: [{ id: 'b1', status: 'VOID', total: '231.79', matchStatus: 'MATCHED' }] })).ok).toBe(false)
  })

  it('leaves it alone when a bill is queried', () => {
    const verdict = autoSettleVerdict(facts({ bills: [{ id: 'b1', status: 'QUERIED', total: '231.79', matchStatus: 'MATCHED' }] }))
    expect(verdict.ok).toBe(false)
  })

  it('leaves it alone when the match is not clean', () => {
    expect(autoSettleVerdict(facts({ bills: [{ id: 'b1', status: 'DRAFT', total: '231.79', matchStatus: 'VARIANCE' }] })).ok).toBe(false)
    expect(autoSettleVerdict(facts({ bills: [{ id: 'b1', status: 'DRAFT', total: '231.79', matchStatus: 'NOT_MATCHED' }] })).ok).toBe(false)
  })

  it('wants the total to the penny, not within a tolerance', () => {
    expect(autoSettleVerdict(facts({ bills: [{ id: 'b1', status: 'DRAFT', total: '231.80', matchStatus: 'MATCHED' }] })).ok).toBe(false)
    expect(autoSettleVerdict(facts({ bills: [{ id: 'b1', status: 'DRAFT', total: '231.78', matchStatus: 'MATCHED' }] })).ok).toBe(false)
  })

  it('adds several bills up before comparing, and ignores a void one', () => {
    const verdict = autoSettleVerdict(
      facts({
        orderTotal: '300.00',
        bills: [
          { id: 'a', status: 'DRAFT', total: '100.00', matchStatus: 'MATCHED' },
          { id: 'b', status: 'POSTED', total: '200.00', matchStatus: 'MATCHED' },
          { id: 'v', status: 'VOID', total: '999.00', matchStatus: 'VARIANCE' },
        ],
      }),
    )
    expect(verdict).toEqual({ ok: true, approve: ['a'] })
  })

  it('does not close an order that is not fully invoiced', () => {
    const verdict = autoSettleVerdict(facts({ lines: [{ ...fullyInvoicedLine, qtyInvoiced: '1' }] }))
    expect(verdict.ok).toBe(false)
  })

  it('does not close an order with a return still owed', () => {
    expect(autoSettleVerdict(facts({ openReturns: 1 })).ok).toBe(false)
  })

  it('does not close an undelivered order, unless the supplier drop-ships', () => {
    expect(autoSettleVerdict(facts({ orderStatus: 'SENT' })).ok).toBe(false)
    expect(autoSettleVerdict(facts({ orderStatus: 'SENT', dropships: true })).ok).toBe(true)
  })
})
