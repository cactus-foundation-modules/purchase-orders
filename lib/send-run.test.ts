import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Sending a purchase order, by the button and by the automatic job. The route's
// body moved into lib/send-run.ts so the two share one implementation; these
// pin that a person pressing Send gets EXACTLY what they got before the move -
// the same gate, the same email, the same link, the same history, the same
// status change, the same "sending approves" stamp in their name - and that
// the job differs only where it has to: nobody's name, "Sent automatically".
//
// Everything around the run is stood in for, the mailer included. The SQL is
// exercised against a real Postgres in auto-send.live.test.ts.

const getOrder = vi.hoisted(() => vi.fn())
const getSupplier = vi.hoisted(() => vi.fn())
const recordOrderSent = vi.hoisted(() => vi.fn())
const setOrderStatus = vi.hoisted(() => vi.fn())
const loadPoDocContext = vi.hoisted(() => vi.fn())
const sendOrderToSupplier = vi.hoisted(() => vi.fn())
const recordAudit = vi.hoisted(() => vi.fn())
const mintPortalLink = vi.hoisted(() => vi.fn())
const executeRaw = vi.hoisted(() => vi.fn())
const queryRaw = vi.hoisted(() => vi.fn())
// What the row says, for the statements on the automatic queue.
const row = vi.hoisted(() => ({ takeable: true, claimed: false, markable: true }))
const session = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/session', () => ({ getSessionFromCookie: session }))
vi.mock('@/lib/db/prisma', () => ({ prisma: { $executeRaw: executeRaw, $queryRaw: queryRaw } }))
vi.mock('@/modules/purchase-orders/lib/permissions', () => ({
  getPoAccess: async (user: { id: string }) => ({ canCreate: user.id !== 'viewer' }),
}))
vi.mock('@/modules/purchase-orders/lib/db', () => ({ getOrder, getSupplier, recordOrderSent, setOrderStatus }))
vi.mock('@/modules/purchase-orders/lib/document', () => ({
  loadPoDocContext,
  supplierParty: (s: { name: string } | null) => ({ name: s?.name ?? '' }),
  wordingSnapshot: async () => ({ heading: 'Purchase order' }),
}))
vi.mock('@/modules/purchase-orders/lib/email', () => ({
  sendOrderToSupplier,
  supplierRecipients: (email: string | null, cc: string | null) =>
    email ? { to: email, cc: cc ? [cc] : [] } : null,
}))
vi.mock('@/modules/purchase-orders/lib/audit', () => ({ recordAudit }))
vi.mock('@/modules/purchase-orders/lib/portal', () => ({ mintPortalLink }))

const { POST } = await import('@/modules/purchase-orders/app/api/admin/orders/[id]/send/route')
const { sendOrderRun } = await import('./send-run')

function press(body: Record<string, unknown> = {}) {
  return POST(
    new NextRequest('http://localhost/api/m/purchase-orders/admin/orders/o1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'o1' }) },
  )
}

function order(patch: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    number: 'PO-00101',
    revision: 1,
    status: 'DRAFT',
    supplierId: 's1',
    approvalRequired: false,
    approvedAt: null,
    sentAt: null,
    autoSendState: null,
    ...patch,
  }
}

const CTX = { order: { number: 'PO-00101' } }
const LINK = 'https://example.test/purchase-order/PO-00101?t=abc'

beforeEach(() => {
  for (const fn of [getOrder, getSupplier, recordOrderSent, setOrderStatus, loadPoDocContext, sendOrderToSupplier, recordAudit, mintPortalLink, executeRaw, queryRaw, session]) {
    fn.mockReset()
  }
  Object.assign(row, { takeable: true, claimed: false, markable: true })
  queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?')
    if (text.includes(`"auto_send_state" = 'HELD'`)) return row.takeable ? [{ id: 'o1' }] : []
    if (text.includes('AS "busy"')) return [{ busy: row.claimed }]
    if (text.includes('::text AS "stamp"')) return [{ stamp: '2026-10-01 09:00:00.123456+00' }]
    if (text.includes('Being emailed now.')) return row.markable ? [{ id: 'o1' }] : []
    throw new Error(`unexpected query: ${text}`)
  })
  session.mockResolvedValue({ id: 'user-1', displayName: 'Pat Buyer' })
  getOrder.mockResolvedValue(order())
  getSupplier.mockResolvedValue({ name: 'Acme Supplies', email: 'orders@acme.example', emailCc: 'copy@acme.example' })
  loadPoDocContext.mockResolvedValue(CTX)
  mintPortalLink.mockResolvedValue(LINK)
  sendOrderToSupplier.mockResolvedValue(undefined)
  executeRaw.mockResolvedValue(0)
})

describe('a person pressing Send', () => {
  it('emails it, stamps it, approves it in their name and writes the same history as ever', async () => {
    const res = await press({ note: 'Ring before delivering' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, kind: 'sent', to: 'orders@acme.example', cc: ['copy@acme.example'] })

    expect(loadPoDocContext).toHaveBeenCalledWith('o1', { approvingUserId: 'user-1' })
    expect(mintPortalLink).toHaveBeenCalledWith('o1', 'PO-00101', 'user-1')
    expect(sendOrderToSupplier).toHaveBeenCalledWith(
      CTX,
      { to: 'orders@acme.example', cc: ['copy@acme.example'] },
      'sent',
      'Ring before delivering',
      LINK,
    )
    expect(recordOrderSent).toHaveBeenCalledWith('o1', { name: 'Acme Supplies' }, { heading: 'Purchase order' }, [
      'orders@acme.example',
      'copy@acme.example',
    ])
    expect(setOrderStatus).toHaveBeenCalledWith('o1', 'SENT', {}, 'user-1')
    expect(recordAudit.mock.calls).toEqual([
      ['order', 'o1', 'order.approved', { by: 'SENDING', note: 'Approved by sending it to the supplier.' }, 'user-1'],
      [
        'order',
        'o1',
        'order.sent',
        { to: 'orders@acme.example', cc: ['copy@acme.example'], revision: 1, note: 'Ring before delivering', portalLink: true },
        'user-1',
      ],
    ])
  })

  it('takes a queued draft out of the automatic queue first, then marks it sent by hand', async () => {
    getOrder.mockResolvedValue(order({ autoSendState: 'QUEUED' }))
    session.mockResolvedValue({ id: 'user-1', displayName: 'Pat Buyer' })
    expect((await press()).status).toBe(200)
    const gate = queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes(`'HELD'`))!
    expect(gate.slice(1)).toContain('Taken out of the automatic queue when Pat Buyer pressed Send.')
    // Taken BEFORE the email went.
    expect(queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(sendOrderToSupplier.mock.invocationCallOrder[0]!)
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect((executeRaw.mock.calls[0]![0] as TemplateStringsArray).join('?')).toContain(`'Sent by hand.'`)
  })

  it('refuses while the automatic job is sending it, sending nothing', async () => {
    getOrder.mockResolvedValue(order({ autoSendState: 'QUEUED' }))
    row.takeable = false
    const res = await press()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This draft is being sent automatically right now. Look again in a minute.')
    expect(sendOrderToSupplier).not.toHaveBeenCalled()
    expect(recordAudit).not.toHaveBeenCalled()

    // Read as the job's own send, still part way through.
    getOrder.mockResolvedValue(order({ autoSendState: 'SENT' }))
    row.claimed = true
    expect((await press()).status).toBe(409)
    expect(sendOrderToSupplier).not.toHaveBeenCalled()
  })

  it('touches nothing about the queue for an order that was never in it', async () => {
    await press()
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('refuses to send again an order that was sent after the screen was drawn', async () => {
    getOrder.mockResolvedValue(order({ status: 'SENT', sentAt: '2026-10-01T09:30:00.000Z', approvedAt: '2026-10-01T09:30:00.000Z', autoSendState: 'SENT' }))
    const res = await press({ seenSentAt: null })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/just been sent automatically/)
    expect(sendOrderToSupplier).not.toHaveBeenCalled()
    // The same screen, up to date: a deliberate second send goes.
    expect((await press({ seenSentAt: '2026-10-01T09:30:00.000Z' })).status).toBe(200)
  })

  it('sends an amendment without touching the status or the approval', async () => {
    getOrder.mockResolvedValue(order({ status: 'PART_RECEIVED', sentAt: '2026-09-01T09:00:00.000Z', approvedAt: '2026-09-01T09:00:00.000Z', revision: 3 }))
    const res = await press()
    expect((await res.json()).kind).toBe('amended')
    expect(loadPoDocContext).toHaveBeenCalledWith('o1', undefined)
    expect(setOrderStatus).not.toHaveBeenCalled()
    expect(recordAudit.mock.calls.map((c) => c[2])).toEqual(['order.amendment-sent'])
    expect(recordAudit.mock.calls[0]![3]).toMatchObject({ revision: 3, note: null, portalLink: true })
  })

  it('refuses an order over the approval threshold, sending nothing', async () => {
    getOrder.mockResolvedValue(order({ approvalRequired: true }))
    const res = await press()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/over your approval threshold/)
    expect(sendOrderToSupplier).not.toHaveBeenCalled()
    expect(recordAudit).not.toHaveBeenCalled()
  })

  it('refuses a supplier with no email address, sending nothing', async () => {
    getSupplier.mockResolvedValue({ name: 'Acme Supplies', email: null, emailCc: null })
    const res = await press()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This supplier has no email address on file, so there is nowhere to send it.')
    expect(sendOrderToSupplier).not.toHaveBeenCalled()
  })

  it('says 404 for an order that has gone', async () => {
    getOrder.mockResolvedValue(null)
    const res = await press()
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('That purchase order is not here any more.')
  })

  it('hands back the mailer’s own words, and writes nothing, when the email will not go', async () => {
    sendOrderToSupplier.mockRejectedValue(new Error('Mailbox unavailable'))
    const res = await press()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Mailbox unavailable' })
    expect(recordOrderSent).not.toHaveBeenCalled()
    expect(setOrderStatus).not.toHaveBeenCalled()
    expect(recordAudit).not.toHaveBeenCalled()
  })

  it('still wants a session and the create permission', async () => {
    session.mockResolvedValue(null)
    expect((await press()).status).toBe(401)
    session.mockResolvedValue({ id: 'viewer' })
    expect((await press()).status).toBe(403)
    expect(sendOrderToSupplier).not.toHaveBeenCalled()
  })

  it('turns away a note that is far too long', async () => {
    expect((await press({ note: 'x'.repeat(2001) })).status).toBe(400)
  })
})

describe('the automatic job sending', () => {
  it('sends it exactly the same way, with nobody’s name and "Sent automatically" in its place', async () => {
    getOrder.mockResolvedValue(order({ autoSendState: 'QUEUED' }))
    const result = await sendOrderRun({ orderId: 'o1', userId: null, by: 'AUTO' })
    expect(result).toEqual({ outcome: 'sent', kind: 'sent', to: 'orders@acme.example', cc: ['copy@acme.example'] })

    expect(loadPoDocContext).toHaveBeenCalledWith('o1', { approvingAutomatically: true })
    expect(mintPortalLink).toHaveBeenCalledWith('o1', 'PO-00101', null)
    expect(sendOrderToSupplier).toHaveBeenCalledWith(CTX, expect.anything(), 'sent', null, LINK)
    expect(setOrderStatus).toHaveBeenCalledWith('o1', 'SENT', { approvedAutomatically: true }, null)
    // Marked as being emailed before the email, as sent the moment it returned,
    // and only then everything else.
    const marking = queryRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('Being emailed now.'))!
    expect(marking.slice(1)).toContain('2026-10-01 09:00:00.123456+00')
    const mailed = executeRaw.mock.calls.findIndex((c) => (c[0] as TemplateStringsArray).join('?').includes(`'Sent automatically.'`))
    expect(mailed).toBeGreaterThanOrEqual(0)
    expect(executeRaw.mock.invocationCallOrder[mailed]!).toBeGreaterThan(sendOrderToSupplier.mock.invocationCallOrder[0]!)
    expect(executeRaw.mock.invocationCallOrder[mailed]!).toBeLessThan(recordOrderSent.mock.invocationCallOrder[0]!)
    expect(recordAudit.mock.calls).toEqual([
      ['order', 'o1', 'order.approved', { by: 'AUTO', note: 'Approved by sending it to the supplier automatically.' }, null],
      [
        'order',
        'o1',
        'order.sent',
        { to: 'orders@acme.example', cc: ['copy@acme.example'], revision: 1, note: null, portalLink: true, by: 'AUTO' },
        null,
      ],
    ])
  })

  it('stops where a person took it out of the queue after it was claimed', async () => {
    getOrder.mockResolvedValue(order({ autoSendState: 'HELD' }))
    const result = await sendOrderRun({ orderId: 'o1', userId: null, by: 'AUTO' })
    expect(result.outcome).toBe('refused')
    expect(sendOrderToSupplier).not.toHaveBeenCalled()
  })

  it('reports the mailer’s words as a failure to try again, putting the draft back in the queue', async () => {
    getOrder.mockResolvedValue(order({ autoSendState: 'QUEUED' }))
    sendOrderToSupplier.mockRejectedValue(new Error('421 try again later'))
    expect(await sendOrderRun({ orderId: 'o1', userId: null, by: 'AUTO' })).toEqual({
      outcome: 'failed',
      error: '421 try again later',
    })
    expect(setOrderStatus).not.toHaveBeenCalled()
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect((executeRaw.mock.calls[0]![0] as TemplateStringsArray).join('?')).toContain(`"auto_send_state" = 'QUEUED'`)
  })

  it('sends nothing when the draft changed, or the claim lapsed, while it was being drawn', async () => {
    getOrder.mockResolvedValue(order({ autoSendState: 'QUEUED' }))
    row.markable = false
    expect(await sendOrderRun({ orderId: 'o1', userId: null, by: 'AUTO', autoStamp: 'then' })).toEqual({ outcome: 'stale' })
    expect(sendOrderToSupplier).not.toHaveBeenCalled()
    expect(executeRaw).not.toHaveBeenCalled()
  })

  it('never lets a failure after the email has gone lead to a second email', async () => {
    getOrder.mockResolvedValue(order({ autoSendState: 'QUEUED' }))
    setOrderStatus.mockRejectedValue(new Error('connection reset'))
    expect(await sendOrderRun({ orderId: 'o1', userId: null, by: 'AUTO' })).toEqual({
      outcome: 'unrecorded',
      error: 'connection reset',
    })
    expect(sendOrderToSupplier).toHaveBeenCalledTimes(1)
    const refused = executeRaw.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes(`'REFUSED'`))!
    expect(String(refused[1])).toMatch(/^The email went to the supplier.*do not send it again\.$/)
    expect(recordAudit).toHaveBeenCalledWith('order', 'o1', 'order.auto-send-refused', expect.objectContaining({ by: 'AUTO' }), null)
  })
})
