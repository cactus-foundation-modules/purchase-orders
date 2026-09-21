import { describe, expect, it } from 'vitest'
import { orderStanding, type PoStandingFacts } from './standing'

const when = (iso: string) => `on ${iso.slice(0, 10)}`

function facts(patch: Partial<PoStandingFacts> = {}): PoStandingFacts {
  return {
    status: 'DRAFT',
    proformaRequired: false,
    proformaReceived: false,
    proformaPaid: false,
    approvalRequired: false,
    sentAt: null,
    sourceKind: 'MANUAL',
    sourceOrderNumber: null,
    raisedAutomatically: false,
    cancelReason: null,
    closeReason: null,
    ...patch,
  }
}

describe('orderStanding', () => {
  it('says nothing has been sent only while that is true', () => {
    const draft = orderStanding(
      facts({ sourceKind: 'FROM_ORDER', sourceOrderNumber: 'DW000194', raisedAutomatically: true }),
      when,
    )
    expect(draft.headline).toContain('Nothing has been sent')
    expect(draft.detail).toContain('DW000194')
    expect(draft.detail).toContain('Nobody has checked it yet')

    // The same order, emailed. This is the whole reason the file exists: the
    // stored note went on saying "nothing has been sent" here.
    const sent = orderStanding(
      facts({
        status: 'SENT',
        sentAt: '2026-09-21T10:00:00.000Z',
        sourceKind: 'FROM_ORDER',
        sourceOrderNumber: 'DW000194',
        raisedAutomatically: true,
      }),
      when,
    )
    const everything = `${sent.headline} ${sent.detail ?? ''}`
    expect(sent.headline).toBe('Sent to the supplier on 2026-09-21.')
    expect(everything).not.toMatch(/nothing has been sent/i)
    expect(everything).not.toMatch(/nobody has/i)
  })

  it('never claims nothing was sent once a sent date is on the order', () => {
    const statuses = [
      'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SENT', 'ACKNOWLEDGED', 'PART_RECEIVED',
      'RECEIVED', 'PENDING_CLOSE', 'CLOSED', 'CANCELLED', 'ON_HOLD',
    ] as const
    for (const status of statuses) {
      // AWAITING_APPROVAL and APPROVED cannot carry a sent date - the only way
      // back from a sent order is a hold, and that resumes to DRAFT.
      if (status === 'AWAITING_APPROVAL' || status === 'APPROVED') continue
      const standing = orderStanding(facts({ status, sentAt: '2026-09-21T10:00:00.000Z' }), when)
      expect(`${standing.headline} ${standing.detail ?? ''}`, status).not.toMatch(/nothing has been sent/i)
    }
  })

  it('names the approval threshold on a draft that cannot go out', () => {
    const standing = orderStanding(facts({ approvalRequired: true }), when)
    expect(standing.tone).toBe('warning')
    expect(standing.detail).toContain('approval threshold')
  })

  it('follows the proforma while that is the only thing happening', () => {
    const base = { status: 'SENT' as const, sentAt: '2026-09-21T10:00:00.000Z', proformaRequired: true }
    expect(orderStanding(facts(base), when).detail).toContain('Waiting for their proforma')
    const ours = orderStanding(facts({ ...base, proformaReceived: true }), when)
    expect(ours.tone).toBe('warning')
    expect(ours.detail).toContain('waiting on you')
    expect(orderStanding(facts({ ...base, proformaReceived: true, proformaPaid: true }), when).detail).toContain('paid')
  })

  it('carries the reason on an order that has stopped', () => {
    expect(orderStanding(facts({ status: 'CANCELLED', cancelReason: 'Customer changed their mind' }), when)).toEqual({
      tone: 'danger',
      headline: 'Cancelled.',
      detail: 'Customer changed their mind',
    })
  })

  it('owns up to an order marked as sent with no date on it', () => {
    expect(orderStanding(facts({ status: 'SENT' }), when).headline).toBe('Marked as sent to the supplier.')
  })
})
