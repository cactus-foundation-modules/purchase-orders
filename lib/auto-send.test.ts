import { describe, expect, it } from 'vitest'
import {
  afterFailedSend,
  autoSendDueAt,
  autoSendLine,
  editRecordSentence,
  heldNote,
  MAX_SEND_ATTEMPTS,
  queueDecision,
  RECORD_SIZE,
  sendRefusal,
  type SendFacts,
} from './auto-send'
import { autoSendReportHtml, autoSendReportSummary } from './auto-send-report'
import { AUTO_SEND_ON, paperworkReportHtml } from './inbound-report'

// Whether an automatic draft may go by itself: every rule, as pure functions.
// The job that reads the facts and writes the outcome is exercised against a
// real Postgres in auto-send.live.test.ts.

function facts(patch: Partial<SendFacts> = {}): SendFacts {
  return {
    masterOn: true,
    supplier: { name: 'Acme Supplies', autoSend: true, status: 'ENABLED', hasEmail: true },
    order: { status: 'DRAFT', approvalRequired: false, approvalNowRequired: false, sentAt: null, autoSendState: 'QUEUED' },
    customer: { readable: true, orderNumber: 'SO-1001', paymentStatus: 'PAID', status: 'PROCESSING', shortfall: [] },
    lines: [{ description: 'Oak desk', unitCost: '120.00', catalogue: 'MATCH' }],
    ...patch,
  }
}

describe('queueing a fresh automatic draft', () => {
  const base = { masterOn: true, supplierOn: true, skippedLines: 0, customerOrderNumber: 'SO-1001' }

  it('queues it when both switches are on', () => {
    expect(queueDecision(base)).toEqual({ state: 'QUEUED', note: null })
  })

  it('leaves it an ordinary draft when either switch is off', () => {
    expect(queueDecision({ ...base, masterOn: false })).toBeNull()
    expect(queueDecision({ ...base, supplierOn: false })).toBeNull()
  })

  it('refuses straight away when something on the customer order could not be drafted', () => {
    expect(queueDecision({ ...base, skippedLines: 1 })).toEqual({
      state: 'REFUSED',
      note: 'One thing on customer order SO-1001 could not be drafted, so a person should check this before it goes.',
    })
    expect(queueDecision({ ...base, skippedLines: 3 })?.note).toMatch(/^3 things on customer order SO-1001/)
  })
})

describe('refusing at send time', () => {
  it('sends a draft that passes everything', () => {
    expect(sendRefusal(facts())).toBeNull()
  })

  it('never sends one that is not queued any more', () => {
    expect(sendRefusal(facts({ order: { ...facts().order, autoSendState: 'HELD' } }))).toMatch(/no longer waiting/)
  })

  it('refuses when either switch has gone off since', () => {
    expect(sendRefusal(facts({ masterOn: false }))).toMatch(/switched off in settings/)
    expect(sendRefusal(facts({ supplier: { ...facts().supplier!, autoSend: false } }))).toBe(
      'Automatic sending has been switched off for Acme Supplies since this was drafted.',
    )
    expect(sendRefusal(facts({ supplier: null }))).toMatch(/no longer on your list/)
    expect(sendRefusal(facts({ supplier: { ...facts().supplier!, status: 'ON_HOLD' } }))).toMatch(/on hold/)
  })

  it('never sends an amendment of an order already sent', () => {
    expect(sendRefusal(facts({ order: { ...facts().order, sentAt: '2026-09-30T10:00:00.000Z' } }))).toMatch(
      /never sent automatically/,
    )
  })

  it('refuses an order that is not a draft any more', () => {
    expect(sendRefusal(facts({ order: { ...facts().order, status: 'ON_HOLD' } }))).toMatch(/on hold now/)
  })

  it('refuses where the customer order was cancelled, refunded, or refunded in part', () => {
    expect(sendRefusal(facts({ customer: { readable: true, orderNumber: 'SO-1001', paymentStatus: 'PAID', status: 'REFUNDED', shortfall: [] } }))).toBe(
      'Customer order SO-1001 has been refunded since this was drafted.',
    )
    expect(sendRefusal(facts({ customer: { readable: true, orderNumber: 'SO-1001', paymentStatus: 'PAID', status: 'CANCELLED', shortfall: [] } }))).toMatch(
      /cancelled/,
    )
    expect(
      sendRefusal(facts({ customer: { readable: true, orderNumber: 'SO-1001', paymentStatus: 'PAID', status: 'PROCESSING', shortfall: ['Oak desk'] } })),
    ).toMatch(/refunded since this was drafted \(Oak desk\)/)
  })

  it('refuses where the customer order cannot be read, or there is none', () => {
    expect(sendRefusal(facts({ customer: { readable: false, orderNumber: 'SO-1001' } }))).toMatch(/SO-1001 could not be read/)
    expect(sendRefusal(facts({ customer: { readable: false, orderNumber: null } }))).toMatch(/^The customer order could not be read/)
    expect(sendRefusal(facts({ customer: null }))).toMatch(/not drafted for a customer order/)
  })

  it('buys only for a customer order that is paid for and going ahead', () => {
    const customer = (status: string, paymentStatus: string | null = 'PAID') =>
      facts({ customer: { readable: true, orderNumber: 'SO-1001', status, paymentStatus, shortfall: [] } })
    for (const status of ['PROCESSING', 'SHIPPED', 'COMPLETED', 'PARTIALLY_REFUNDED']) {
      expect(sendRefusal(customer(status))).toBeNull()
    }
    expect(sendRefusal(customer('ON_HOLD'))).toBe('Customer order SO-1001 is on hold, so a person decides whether to buy for it.')
    expect(sendRefusal(customer('PENDING'))).toMatch(/is pending/)
    // A status shop has not got yet is refused, not bought for.
    expect(sendRefusal(customer('SOMETHING_NEW'))).toMatch(/is something new/)
    expect(sendRefusal(customer('PROCESSING', 'FAILED'))).toBe(
      "Customer order SO-1001's payment is failed, so a person decides whether to buy for it.",
    )
    expect(sendRefusal(customer('PROCESSING', 'AWAITING_CONFIRMATION'))).toMatch(/awaiting confirmation/)
    expect(sendRefusal(customer('PROCESSING', 'PARTIALLY_REFUNDED'))).toBeNull()
    // A shop that could not say: the order status alone decides.
    expect(sendRefusal(customer('PROCESSING', null))).toBeNull()
  })

  it('refuses where today’s approval threshold catches it, even if the draft’s did not', () => {
    expect(sendRefusal(facts({ order: { ...facts().order, approvalNowRequired: true } }))).toMatch(
      /approval threshold as things stand now/,
    )
  })

  it('refuses a line the supplier’s list marks discontinued', () => {
    expect(sendRefusal(facts({ lines: [{ ...facts().lines[0]!, catalogue: 'DISCONTINUED' }] }))).toBe(
      '"Oak desk" is marked discontinued on Acme Supplies\'s current price list.',
    )
  })

  it('never approves anything that needs approving', () => {
    expect(sendRefusal(facts({ order: { ...facts().order, approvalRequired: true } }))).toMatch(/approval threshold/)
  })

  it('refuses a supplier with no email address', () => {
    expect(sendRefusal(facts({ supplier: { ...facts().supplier!, hasEmail: false } }))).toMatch(/no email address/)
  })

  it('refuses a line with no price, or one not off the current price list', () => {
    const line = facts().lines[0]!
    expect(sendRefusal(facts({ lines: [] }))).toMatch(/nothing on it/)
    expect(sendRefusal(facts({ lines: [{ ...line, unitCost: '0.00' }] }))).toBe('"Oak desk" has no price on it.')
    expect(sendRefusal(facts({ lines: [{ ...line, unitCost: '' }] }))).toBe('"Oak desk" has no price on it.')
    expect(sendRefusal(facts({ lines: [{ ...line, catalogue: 'MISSING' }] }))).toMatch(/not on Acme Supplies's current price list/)
    expect(sendRefusal(facts({ lines: [{ ...line, catalogue: 'DIFFERENT' }] }))).toMatch(/not at the price/)
    // Price lists switched off: the product's own cost price is all there is.
    expect(sendRefusal(facts({ lines: [{ ...line, catalogue: 'NOT_CHECKED' }] }))).toBeNull()
  })
})

describe('mail that would not go', () => {
  it('is tried again, then refused with the mailer’s words', () => {
    expect(afterFailedSend(0, 'down')).toEqual({ retry: true })
    expect(afterFailedSend(MAX_SEND_ATTEMPTS - 2, 'down')).toEqual({ retry: true })
    const last = afterFailedSend(MAX_SEND_ATTEMPTS - 1, '550 mailbox full')
    expect(last.retry).toBe(false)
    expect(!last.retry && last.note).toMatch(/after 3 tries\. The mail server said: 550 mailbox full$/)
  })
})

describe('what the screens say', () => {
  const now = new Date('2026-10-01T12:00:00.000Z')

  it('works out when a queued draft is due', () => {
    expect(autoSendDueAt('2026-10-01T12:00:00.000Z', 60)).toBe('2026-10-01T13:00:00.000Z')
    expect(autoSendDueAt('2026-10-01T12:00:00.000Z', 0)).toBe('2026-10-01T12:00:00.000Z')
  })

  it('gives the time on the business’s own clock, and the day when it is not today', () => {
    const queued = { status: 'DRAFT' as const, autoSendState: 'QUEUED', autoSendNote: null }
    // 13:30 UTC is 14:30 in a British October.
    expect(autoSendLine({ ...queued, autoSendDueAt: '2026-10-01T13:30:00.000Z' }, now, 'Europe/London')).toEqual({
      tone: 'info',
      text: 'Sends automatically at 14:30 unless you open it and change it.',
    })
    expect(autoSendLine({ ...queued, autoSendDueAt: '2026-10-02T08:00:00.000Z' }, now, 'Europe/London')?.text).toBe(
      'Sends automatically at 09:00 on Friday 2 Oct unless you open it and change it.',
    )
    expect(autoSendLine({ ...queued, autoSendDueAt: '2026-10-01T11:00:00.000Z' }, now, 'Europe/London')?.text).toMatch(
      /next half-hourly check/,
    )
  })

  it('says why a draft is held or refused, and nothing once it is not a draft', () => {
    expect(autoSendLine({ status: 'DRAFT', autoSendState: 'HELD', autoSendNote: heldNote('Pat'), autoSendDueAt: null }, now, 'UTC')?.text).toBe(
      'Not sending automatically: Changed by Pat, so a person sends it.',
    )
    const refused = autoSendLine({ status: 'DRAFT', autoSendState: 'REFUSED', autoSendNote: 'It is wrong.', autoSendDueAt: null }, now, 'UTC')
    expect(refused?.tone).toBe('warning')
    expect(refused?.text).toMatch(/^Not sent automatically: It is wrong\./)
    expect(autoSendLine({ status: 'SENT', autoSendState: 'SENT', autoSendNote: null, autoSendDueAt: null }, now, 'UTC')).toBeNull()
    expect(autoSendLine({ status: 'DRAFT', autoSendState: null, autoSendNote: null, autoSendDueAt: null }, now, 'UTC')).toBeNull()
  })

  it('names somebody in a held note, even with no name to go on', () => {
    expect(heldNote('  ')).toBe('Changed by somebody, so a person sends it.')
    expect(heldNote(null)).toBe('Changed by somebody, so a person sends it.')
  })

  it('puts the edit record beside the switch in plain words', () => {
    expect(editRecordSentence(undefined, RECORD_SIZE)).toMatch(/No automatic drafts/)
    expect(editRecordSentence({ drafts: 10, changed: 3 }, RECORD_SIZE)).toBe(
      'Of the last 10 automatic drafts to this supplier, 3 were changed before they were sent.',
    )
    expect(editRecordSentence({ drafts: 4, changed: 1 }, RECORD_SIZE)).toBe(
      'Of the 4 automatic drafts to this supplier so far, 1 was changed before it was sent.',
    )
    expect(editRecordSentence({ drafts: 1, changed: 1 }, RECORD_SIZE)).toBe(
      'Of the one automatic draft to this supplier so far, it was changed before it was sent.',
    )
    expect(editRecordSentence({ drafts: 2, changed: 0 }, RECORD_SIZE)).toMatch(/none was changed/)
  })
})

describe('the reports', () => {
  it('escapes everything in the refusal report and counts them', () => {
    const html = autoSendReportHtml([{ orderNumber: 'PO-1', supplierName: 'A & B <Ltd>', note: '"Desk <b>" has no price on it.' }])
    expect(html).toContain('A &amp; B &lt;Ltd&gt;')
    expect(html).not.toContain('<b>')
    expect(autoSendReportHtml([])).toBe('')
    expect(autoSendReportSummary([{ orderNumber: 'PO-1', supplierName: 'A', note: 'x' }])).toBe('One draft was not sent automatically.')
  })

  it('says beside a disagreeing total that the supplier’s automatic sending is on, only while it is', () => {
    const problems = [
      { what: 'PO-00012: Proforma.pdf', problem: 'Their total is £180.00.', autoSendSupplier: true },
      { what: 'Other.pdf', problem: 'Not ours.', autoSendSupplier: false },
    ]
    const on = paperworkReportHtml(problems, true)
    expect(on.split(AUTO_SEND_ON.slice(0, 40)).length - 1).toBe(1)
    expect(paperworkReportHtml(problems, false)).not.toContain(AUTO_SEND_ON.slice(0, 40))
  })
})
