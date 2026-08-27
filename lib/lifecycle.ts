import type { PoStatus } from './types'
import type { PoAccess } from './permissions'

// Every status change in this module comes through here. One table, one guard,
// and every transition written to the audit log by the caller - which is the
// only way a state machine stays honest once six screens are pushing at it.

export type PoTransition =
  | 'submit'      // draft -> awaiting approval
  | 'approve'
  | 'reject'      // awaiting approval -> draft, with a note
  | 'send'
  | 'acknowledge'
  | 'hold'
  | 'resume'
  | 'close'
  | 'reopen'
  | 'cancel'

type Rule = {
  from: readonly PoStatus[]
  to: PoStatus
  /** Which permission the transition needs. */
  needs: keyof Pick<PoAccess, 'canCreate' | 'canApprove' | 'canReceive'>
  label: string
}

// `send` deliberately accepts APPROVED and DRAFT alike: an order that never
// needed approving goes straight out, and requiring a pointless approval step on
// a site that switched approvals off would be a fine way to make people stop
// using the module.
export const TRANSITIONS: Record<PoTransition, Rule> = {
  submit: { from: ['DRAFT'], to: 'AWAITING_APPROVAL', needs: 'canCreate', label: 'Submitted for approval' },
  approve: { from: ['AWAITING_APPROVAL'], to: 'APPROVED', needs: 'canApprove', label: 'Approved' },
  reject: { from: ['AWAITING_APPROVAL'], to: 'DRAFT', needs: 'canApprove', label: 'Sent back to draft' },
  send: { from: ['DRAFT', 'APPROVED'], to: 'SENT', needs: 'canCreate', label: 'Sent to supplier' },
  acknowledge: { from: ['SENT'], to: 'ACKNOWLEDGED', needs: 'canCreate', label: 'Acknowledged by supplier' },
  hold: {
    from: ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'ACKNOWLEDGED', 'PART_RECEIVED'],
    to: 'ON_HOLD',
    needs: 'canCreate',
    label: 'Put on hold',
  },
  resume: { from: ['ON_HOLD'], to: 'DRAFT', needs: 'canCreate', label: 'Taken off hold' },
  close: {
    from: ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'RECEIVED'],
    to: 'CLOSED',
    needs: 'canCreate',
    label: 'Closed',
  },
  reopen: { from: ['CLOSED'], to: 'RECEIVED', needs: 'canCreate', label: 'Reopened' },
  cancel: {
    from: ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'ACKNOWLEDGED', 'ON_HOLD'],
    to: 'CANCELLED',
    needs: 'canCreate',
    label: 'Cancelled',
  },
}

export type TransitionCheck = { ok: true; to: PoStatus; label: string } | { ok: false; reason: string }

export function checkTransition(
  transition: PoTransition,
  from: PoStatus,
  access: PoAccess,
): TransitionCheck {
  const rule = TRANSITIONS[transition]
  if (!rule) return { ok: false, reason: 'That is not something an order can do.' }
  if (!access[rule.needs]) return { ok: false, reason: 'You do not have permission to do that.' }
  if (!rule.from.includes(from)) {
    return { ok: false, reason: `An order that is ${from.toLowerCase().replace(/_/g, ' ')} cannot be ${rule.label.toLowerCase()}.` }
  }
  return { ok: true, to: rule.to, label: rule.label }
}

/** Which transitions this user could run on an order in this state, for the buttons. */
export function availableTransitions(from: PoStatus, access: PoAccess): PoTransition[] {
  return (Object.keys(TRANSITIONS) as PoTransition[]).filter(
    (t) => checkTransition(t, from, access).ok,
  )
}

/**
 * Whether an order in this state may still be edited freely.
 *
 * A draft is. Anything already sent is not: an edit past that point bumps the
 * revision and snapshots what the supplier was sent, which arrives with the
 * document work in the next release. Until then, editing a sent order is
 * refused rather than quietly rewriting history.
 */
export function isFreelyEditable(status: PoStatus): boolean {
  return status === 'DRAFT' || status === 'AWAITING_APPROVAL'
}

/** Whether this total needs somebody with the approve permission before it can go out. */
export function needsApproval(
  total: string | number,
  config: { approvalRequired: boolean; approvalThreshold: number },
): boolean {
  if (!config.approvalRequired) return false
  return Number(total) >= config.approvalThreshold
}
