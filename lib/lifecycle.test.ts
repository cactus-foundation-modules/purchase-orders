import { describe, it, expect } from 'vitest'
import { availableTransitions, checkTransition, isFreelyEditable, needsApproval } from './lifecycle'
import { receiptStatus } from './progress'
import type { PoAccess } from './permissions'

const buyer: PoAccess = {
  isAdminUser: false,
  canAccess: true,
  canCreate: true,
  canApprove: false,
  canReceive: false,
  canBills: false,
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
