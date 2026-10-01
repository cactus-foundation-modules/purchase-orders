import { beforeEach, describe, expect, it, vi } from 'vitest'

// The inline half of filing emailed paperwork: what the inbox's five seconds
// are spent on. Off means nothing at all; a stranger's email means one loop
// over the supplier list and nothing else.

const config = vi.hoisted(() => vi.fn())
const suppliers = vi.hoisted(() => vi.fn())
const queue = vi.hoisted(() => vi.fn())
const run = vi.hoisted(() => vi.fn())
const rows = vi.hoisted(() => vi.fn())
const track = vi.hoisted(() => vi.fn())

vi.mock('./config', () => ({ getPoConfigCached: config }))
vi.mock('./inbound-run', () => ({
  senderSuppliers: suppliers,
  queueAttachments: queue,
  runInboundQueue: run,
  rowsForMessage: rows,
}))

vi.mock('./inbound-tracking', () => ({ handleTrackingMessage: track }))

const { handleInboundMessage, purchaseOrdersInboundHandler } = await import('./inbound-handler')

const event = {
  messageId: 'm1',
  threadId: 't1',
  fromAddress: 'accounts@acme.example',
  toAddresses: ['buying@our-shop.example'],
  ccAddresses: [] as string[],
  subject: 'Invoice 0000900001',
  bodyText: '',
  sentAt: '2026-09-28T09:00:00.000Z',
  attachments: [
    { attachmentId: 'a1', filename: 'Invoice.pdf', mimeType: 'application/pdf', sizeBytes: 40_000, mediaId: 'media-1' },
    { attachmentId: 'a2', filename: 'logo.png', mimeType: 'image/png', sizeBytes: 900, mediaId: null },
  ],
}

function signal(aborted = false): AbortSignal {
  const controller = new AbortController()
  if (aborted) controller.abort()
  return controller.signal
}

beforeEach(() => {
  for (const mock of [config, suppliers, queue, run, rows, track]) mock.mockReset()
  track.mockResolvedValue({ match: null, recorded: null, note: null, orderId: null, orderNumber: null })
  config.mockResolvedValue({ inboundFilingEnabled: true })
  suppliers.mockResolvedValue([{ id: 'acme', email: 'orders@acme.example', emailCc: null, inboundSenders: [] }])
  queue.mockResolvedValue(undefined)
  run.mockResolvedValue({ read: 1, filed: 1, needsEyes: 0, waiting: false })
  rows.mockResolvedValue([
    { outcome: 'READ', orderId: null, orderNumber: null, filedAs: null },
    { outcome: 'FILED', orderId: 'o12', orderNumber: 'PO-00012', filedAs: 'invoice' },
  ])
})

describe('the inbox handler', () => {
  it('asks for PDFs only, on the export', () => {
    expect(purchaseOrdersInboundHandler.attachmentTypes).toEqual(['application/pdf'])
    expect(purchaseOrdersInboundHandler.handle).toBe(handleInboundMessage)
  })

  it('does nothing whatever with the setting off', async () => {
    config.mockResolvedValue({ inboundFilingEnabled: false })
    expect(await handleInboundMessage(event, { signal: signal() })).toBeUndefined()
    expect(suppliers).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
  })

  it('ignores an email with no PDF on it without reading the suppliers', async () => {
    await handleInboundMessage({ ...event, attachments: [event.attachments[1]!] }, { signal: signal() })
    expect(suppliers).not.toHaveBeenCalled()
  })

  it('never takes a colleague for a supplier by our own domain', async () => {
    suppliers.mockResolvedValue([{ id: 'acme', email: 'orders@acme.example', emailCc: 'kim@our-shop.example', inboundSenders: [] }])
    expect(await handleInboundMessage({ ...event, fromAddress: 'jo@our-shop.example' }, { signal: signal() })).toBeUndefined()
    expect(queue).not.toHaveBeenCalled()
  })

  it('passes the Cc line: a supplier writing To their own colleague with us in Cc is queued', async () => {
    const toTheirColleague = { ...event, toAddresses: ['jo@acme.example'], ccAddresses: ['buying@our-shop.example'] }
    await handleInboundMessage(toTheirColleague, { signal: signal() })
    expect(queue).toHaveBeenCalled()
    queue.mockClear()
    // Without the Cc line it looks like their internal mail.
    await handleInboundMessage({ ...event, toAddresses: ['jo@acme.example'] }, { signal: signal() })
    expect(queue).not.toHaveBeenCalled()
  })

  it('copes with an older inbox that sends no Cc line at all', async () => {
    const { ccAddresses: _dropped, ...older } = event
    void _dropped
    await handleInboundMessage(older, { signal: signal() })
    expect(queue).toHaveBeenCalled()
  })

  it('ignores anybody who is not a supplier', async () => {
    expect(await handleInboundMessage({ ...event, fromAddress: 'a.customer@gmail.com' }, { signal: signal() })).toBeUndefined()
    expect(queue).not.toHaveBeenCalled()
  })

  it('queues only the PDFs, files them while it clearly has time, and says where they went', async () => {
    const outcome = await handleInboundMessage(event, { signal: signal() })
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', threadId: 't1' }),
      ['acme'],
      [{ attachmentId: 'a1', filename: 'Invoice.pdf', mediaId: 'media-1' }],
    )
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1' }))
    expect(outcome).toEqual({
      links: [{ moduleName: 'purchase-orders', recordType: 'purchase-order', recordId: 'o12', label: 'Purchase order PO-00012' }],
      note: 'Filed on PO-00012 as the invoice',
    })
  })

  it('leaves a big file to the half-hourly job', async () => {
    rows.mockResolvedValue([{ outcome: 'QUEUED', orderId: null, orderNumber: null, filedAs: null }])
    const big = { ...event, attachments: [{ ...event.attachments[0]!, sizeBytes: 9_000_000 }] }
    expect(await handleInboundMessage(big, { signal: signal() })).toEqual({ note: 'Passed to Purchasing to file (see the order or the Paperwork list)' })
    expect(run).not.toHaveBeenCalled()
  })

  it('stops when the inbox has given up on it', async () => {
    expect(await handleInboundMessage(event, { signal: signal(true) })).toBeUndefined()
    expect(queue).not.toHaveBeenCalled()
  })

  it('files nothing inline when the reading throws, and still answers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    run.mockRejectedValue(new Error('a broken PDF'))
    rows.mockResolvedValue([{ outcome: 'QUEUED', orderId: null, orderNumber: null, filedAs: null }])
    expect(await handleInboundMessage(event, { signal: signal() })).toEqual({ note: 'Passed to Purchasing to file (see the order or the Paperwork list)' })
  })
})

describe('the same handler, reading for tracking', () => {
  const tracking = {
    ...event,
    fromAddress: 'noreply@carrier.example',
    subject: 'Your parcel is on its way',
    bodyText: 'Your parcel: 1234 5678 9012',
    attachments: [],
  }

  it('reads nothing for tracking with its switch off, even with paperwork on', async () => {
    await handleInboundMessage(tracking, { signal: signal() })
    expect(track).not.toHaveBeenCalled()
  })

  it('reads every email with its switch on, and leaves the supplier list to the reader', async () => {
    config.mockResolvedValue({ inboundFilingEnabled: false, inboundTrackingEnabled: true })
    expect(await handleInboundMessage(tracking, { signal: signal() })).toBeUndefined()
    expect(track).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm1', recipients: ['buying@our-shop.example'], bodyText: 'Your parcel: 1234 5678 9012' }),
      expect.any(Function),
    )
    expect(suppliers).not.toHaveBeenCalled()
    expect(queue).not.toHaveBeenCalled()
    expect(rows).not.toHaveBeenCalled()
  })

  it('says what became of the tracking, alongside any paperwork', async () => {
    config.mockResolvedValue({ inboundFilingEnabled: true, inboundTrackingEnabled: true })
    track.mockResolvedValue({ match: { kind: 'apply' }, recorded: null, note: null, orderId: 'o12', orderNumber: 'PO-00012' })
    rows.mockResolvedValue([
      { outcome: 'FILED', orderId: 'o12', orderNumber: 'PO-00012', filedAs: 'invoice', kind: 'invoice', trackingNote: null },
      { outcome: 'FILED', orderId: 'o12', orderNumber: 'PO-00012', filedAs: 'despatch', kind: 'tracking', trackingNote: 'Tracking recorded on PO-00012 as despatch DSP-00001' },
    ])
    expect(await handleInboundMessage(event, { signal: signal() })).toEqual({
      links: [{ moduleName: 'purchase-orders', recordType: 'purchase-order', recordId: 'o12', label: 'Purchase order PO-00012' }],
      note: 'Filed on PO-00012 as the invoice; Tracking recorded on PO-00012 as despatch DSP-00001',
    })
  })

  it('links nothing for a proposal, and says where it waits', async () => {
    config.mockResolvedValue({ inboundFilingEnabled: false, inboundTrackingEnabled: true })
    track.mockResolvedValue({ match: { kind: 'propose' }, recorded: null, note: null, orderId: 'o14', orderNumber: 'PO-00014' })
    rows.mockResolvedValue([
      { outcome: 'NEEDS_EYES', orderId: 'o14', orderNumber: 'PO-00014', filedAs: null, kind: 'tracking', trackingNote: 'Delivery tracking that may be for PO-00014 is on the Paperwork list in Purchasing' },
    ])
    expect(await handleInboundMessage(tracking, { signal: signal() })).toEqual({
      note: 'Delivery tracking that may be for PO-00014 is on the Paperwork list in Purchasing',
    })
  })

  it('still answers for the paperwork when reading for tracking throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    config.mockResolvedValue({ inboundFilingEnabled: true, inboundTrackingEnabled: true })
    track.mockRejectedValue(new Error('the database blinked'))
    expect((await handleInboundMessage(event, { signal: signal() }))?.note).toBe('Filed on PO-00012 as the invoice')
  })
})
