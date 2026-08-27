import { describe, expect, it } from 'vitest'
import { chaseDecision, chaseReview, type ChaseFact, type ChaseSettings } from './chasing'

const TODAY = '2026-08-20'

const SETTINGS: ChaseSettings = { chaseEnabled: true, chaseAfterDays: 3, chaseRepeatDays: 7 }

const BASE: ChaseFact = {
  orderId: 'o1',
  orderNumber: 'PO-1',
  status: 'SENT',
  supplierId: 's1',
  supplierName: 'Dynamic',
  supplierEmail: 'sales@dynamic.example',
  supplierEmailCc: null,
  sentAt: '2026-08-01T09:00:00.000Z',
  expectedDate: '2026-08-10',
  requiredByDate: null,
  lastChasedAt: null,
  outstandingLines: 2,
}

function fact(patch: Partial<ChaseFact>): ChaseFact {
  return { ...BASE, ...patch }
}

describe('chaseDecision', () => {
  it('chases an order that is comfortably late', () => {
    const decision = chaseDecision(fact({}), SETTINGS, TODAY)
    expect(decision.due).toBe(true)
    expect(decision.daysLate).toBe(10)
  })

  it('holds off until it is late enough', () => {
    const decision = chaseDecision(fact({ expectedDate: '2026-08-19' }), SETTINGS, TODAY)
    expect(decision.due).toBe(false)
    expect(decision.daysLate).toBe(1)
    expect(decision.reason).toContain('Not late enough')
  })

  it('says nothing about an order nobody sent', () => {
    const decision = chaseDecision(fact({ sentAt: null, status: 'APPROVED' }), SETTINGS, TODAY)
    expect(decision.due).toBe(false)
    expect(decision.reason).toContain('not out with a supplier')
  })

  it('leaves an order on hold alone', () => {
    const decision = chaseDecision(fact({ status: 'ON_HOLD' }), SETTINGS, TODAY)
    expect(decision.due).toBe(false)
  })

  it('says nothing once everything has arrived', () => {
    const decision = chaseDecision(fact({ outstandingLines: 0 }), SETTINGS, TODAY)
    expect(decision.due).toBe(false)
    expect(decision.reason).toContain('arrived')
  })

  it('will not chase against a date nobody set, and says which field to fill in', () => {
    const decision = chaseDecision(fact({ expectedDate: null, requiredByDate: null }), SETTINGS, TODAY)
    expect(decision.due).toBe(false)
    expect(decision.reason).toContain('expected date')
  })

  it('falls back to the date we asked for when the supplier never gave one', () => {
    const decision = chaseDecision(fact({ expectedDate: null, requiredByDate: '2026-08-01' }), SETTINGS, TODAY)
    expect(decision.due).toBe(true)
    expect(decision.dueDate).toBe('2026-08-01')
  })

  it('refuses when there is nowhere to send it', () => {
    const decision = chaseDecision(fact({ supplierEmail: null }), SETTINGS, TODAY)
    expect(decision.due).toBe(false)
    expect(decision.reason).toContain('no email address')
  })

  it('waits out the repeat interval', () => {
    const decision = chaseDecision(fact({ lastChasedAt: '2026-08-18T06:00:00.000Z' }), SETTINGS, TODAY)
    expect(decision.due).toBe(false)
    expect(decision.reason).toContain('2 days ago')
  })

  it('chases again once the interval is up', () => {
    const decision = chaseDecision(fact({ lastChasedAt: '2026-08-13T06:00:00.000Z' }), SETTINGS, TODAY)
    expect(decision.due).toBe(true)
    expect(decision.reason).toContain('another nudge')
  })

  it('treats a repeat of zero as "chase once, then leave them alone"', () => {
    const once = { ...SETTINGS, chaseRepeatDays: 0 }
    expect(chaseDecision(fact({}), once, TODAY).due).toBe(true)
    const after = chaseDecision(fact({ lastChasedAt: '2026-08-13T06:00:00.000Z' }), once, TODAY)
    expect(after.due).toBe(false)
    expect(after.reason).toContain('repeats are switched off')
  })

  it('chases the day it becomes late when the threshold is zero', () => {
    const eager = { ...SETTINGS, chaseAfterDays: 0 }
    expect(chaseDecision(fact({ expectedDate: '2026-08-19' }), eager, TODAY).due).toBe(true)
    // Still not on the day it was due - a delivery arriving that afternoon is
    // not late, and zero must not mean "chase on the morning of the due date".
    expect(chaseDecision(fact({ expectedDate: TODAY }), eager, TODAY).due).toBe(false)
  })
})

describe('chaseReview', () => {
  it('puts what is due first, worst first inside that', () => {
    const decisions = chaseReview(
      [
        fact({ orderId: 'a', orderNumber: 'PO-A', expectedDate: '2026-08-19' }),
        fact({ orderId: 'b', orderNumber: 'PO-B', expectedDate: '2026-08-01' }),
        fact({ orderId: 'c', orderNumber: 'PO-C', expectedDate: '2026-08-14' }),
      ],
      SETTINGS,
      TODAY,
    )
    expect(decisions.map((d) => d.orderNumber)).toEqual(['PO-B', 'PO-C', 'PO-A'])
    expect(decisions.map((d) => d.due)).toEqual([true, true, false])
  })

  it('works out who is late whether or not chasing is switched on', () => {
    const off = { ...SETTINGS, chaseEnabled: false }
    expect(chaseReview([fact({})], off, TODAY)[0]!.due).toBe(true)
  })
})
