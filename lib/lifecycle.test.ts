import { describe, it, expect } from 'vitest'
import { availableTransitions, canSend, checkTransition, editMode, isAmendable, isFreelyEditable, needsApproval } from './lifecycle'
import { receiptStatus } from './progress'
import type { PoAccess } from './permissions'

const buyer: PoAccess = {
  isAdminUser: false,
  canAccess: true,
  canCreate: true,
  canApprove: false,
  canReceive: false,
  canBills: false,
  canCatalogues: false,
  canSettings: false,
}

const approver: PoAccess = { ...buyer, canCreate: false, canApprove: true }

describe('checkTransition', () => {
  it('lets a buyer send a draft straight out when nothing needs approving', () => {
    expect(checkTransition('send', 'DRAFT', buyer)).toEqual({ ok: true, to: 'SENT', label: 'Sent to supplier' })
  })

  it('refuses a transition the state does not allow', () => {
    const result = checkTransition('approve', 'DRAFT', approver)
    expect(result.ok).toBe(false)
  })

  it('refuses a transition the permission does not allow', () => {
    const result = checkTransition('approve', 'AWAITING_APPROVAL', buyer)
    expect(result).toEqual({ ok: false, reason: 'You do not have permission to do that.' })
  })

  it('will not cancel an order that has already been received', () => {
    expect(checkTransition('cancel', 'RECEIVED', buyer).ok).toBe(false)
  })

  it('offers an approver exactly the two things they can do to a waiting order', () => {
    expect(availableTransitions('AWAITING_APPROVAL', approver).sort()).toEqual(['approve', 'reject'])
  })

  it('leaves nothing to do on a cancelled order', () => {
    expect(availableTransitions('CANCELLED', { ...buyer, canApprove: true })).toEqual([])
  })
})

describe('isFreelyEditable', () => {
  it('stops at the point the supplier has it', () => {
    expect(isFreelyEditable('DRAFT')).toBe(true)
    expect(isFreelyEditable('AWAITING_APPROVAL')).toBe(true)
    expect(isFreelyEditable('SENT')).toBe(false)
    expect(isFreelyEditable('PART_RECEIVED')).toBe(false)
  })
})

describe('needsApproval', () => {
  it('never asks when approvals are switched off', () => {
    expect(needsApproval('9999.00', { approvalRequired: false, approvalThreshold: 100 })).toBe(false)
  })

  it('asks at the threshold, not just above it', () => {
    const config = { approvalRequired: true, approvalThreshold: 500 }
    expect(needsApproval('499.99', config)).toBe(false)
    expect(needsApproval('500.00', config)).toBe(true)
  })

  it('asks on everything when the threshold is zero', () => {
    expect(needsApproval('0.00', { approvalRequired: true, approvalThreshold: 0 })).toBe(true)
  })
})

describe('receiptStatus', () => {
  it('says nothing until something has actually arrived', () => {
    expect(receiptStatus([{ qty: '5', qtyCancelled: '0', qtyReceived: '0' }])).toBeNull()
  })

  it('is part received while any line is short', () => {
    expect(
      receiptStatus([
        { qty: '5', qtyCancelled: '0', qtyReceived: '5' },
        { qty: '2', qtyCancelled: '0', qtyReceived: '1' },
      ]),
    ).toBe('PART_RECEIVED')
  })

  it('counts a cancelled quantity as never expected', () => {
    expect(receiptStatus([{ qty: '10', qtyCancelled: '4', qtyReceived: '6' }])).toBe('RECEIVED')
  })

  it('treats an over-delivery as met, not as short', () => {
    expect(receiptStatus([{ qty: '3', qtyCancelled: '0', qtyReceived: '4' }])).toBe('RECEIVED')
  })

  it('ignores a line cancelled down to nothing', () => {
    expect(
      receiptStatus([
        { qty: '5', qtyCancelled: '5', qtyReceived: '0' },
        { qty: '2', qtyCancelled: '0', qtyReceived: '2' },
      ]),
    ).toBe('RECEIVED')
  })
})

describe('amending an order the supplier already has', () => {
  it('lets a draft be saved over with nothing filed', () => {
    expect(editMode('DRAFT')).toBe('free')
    expect(editMode('AWAITING_APPROVAL')).toBe('free')
  })

  it('treats an edit to a sent order as an amendment', () => {
    for (const status of ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'ON_HOLD'] as const) {
      expect(isAmendable(status)).toBe(true)
      expect(editMode(status)).toBe('amend')
    }
  })

  it('refuses an edit to an order that is finished with', () => {
    // Nothing left to amend. A fully received order is history whatever anybody
    // would now like it to have said, and a cancelled one is superseded by a
    // fresh order rather than rewritten.
    for (const status of ['RECEIVED', 'CLOSED', 'CANCELLED', 'APPROVED'] as const) {
      expect(editMode(status)).toBe('refused')
    }
  })
})

describe('canSend', () => {
  it('lets an ordinary draft go straight out', () => {
    expect(canSend('DRAFT', false)).toEqual({ ok: true, amendment: false })
    expect(canSend('APPROVED', false)).toEqual({ ok: true, amendment: false })
  })

  it('holds a draft that is over the approval threshold', () => {
    // The transition table cannot express this on its own: whether approval
    // applies is a per-ORDER fact, not a per-state one.
    const check = canSend('DRAFT', true)
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('approving')
    expect(canSend('AWAITING_APPROVAL', true).ok).toBe(false)
  })

  it('lets an approved order over the threshold go', () => {
    expect(canSend('APPROVED', true)).toEqual({ ok: true, amendment: false })
  })

  it('calls a second send of a live order an amendment', () => {
    expect(canSend('SENT', false)).toEqual({ ok: true, amendment: true })
    expect(canSend('PART_RECEIVED', false)).toEqual({ ok: true, amendment: true })
  })

  it('refuses to send something nobody can act on', () => {
    for (const status of ['CANCELLED', 'CLOSED', 'RECEIVED'] as const) {
      expect(canSend(status, false).ok).toBe(false)
    }
  })
})
