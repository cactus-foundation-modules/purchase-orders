import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// A second proforma arriving through the supplier's own link: the same rules
// as one from email. Refused outright once the proforma is paid (before any
// file is stored), and a replacement that is not provably the same document
// raises the warning the pay gate reads. The route's own logic, with the
// database and the media library stood in for; the SQL behind both is run
// against a real Postgres in inbound-filing.live.test.ts.

const order = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
const stored = vi.hoisted(() => vi.fn())
const setDoc = vi.hoisted(() => vi.fn())
const replaceDoc = vi.hoisted(() => vi.fn())
const setWarning = vi.hoisted(() => vi.fn())

vi.mock('@/modules/purchase-orders/lib/db', () => ({ getOrder: async () => order.current }))
vi.mock('@/modules/purchase-orders/lib/config', () => ({
  getPoConfigCached: async () => ({ portalEnabled: true, portalUploadsEnabled: true }),
}))
vi.mock('@/modules/purchase-orders/lib/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/modules/purchase-orders/lib/email', () => ({ sendPortalReplyToBuyer: vi.fn() }))
vi.mock('@/modules/purchase-orders/lib/portal-response', () => ({ buildPortalView: async () => ({}) }))
vi.mock('@/modules/purchase-orders/lib/portal-upload', () => ({
  readPortalUpload: async () => ({ ok: true, buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf', filename: 'PF.pdf' }),
  storePortalUpload: stored,
}))
vi.mock('@/modules/purchase-orders/lib/document-reference', () => ({ guessDocumentReference: () => null }))
vi.mock('@/modules/purchase-orders/lib/proforma', () => ({
  replaceProformaDocument: replaceDoc,
  setAcknowledgementDocument: vi.fn(),
  setProformaDocument: setDoc,
  setProformaWarning: setWarning,
}))
vi.mock('@/modules/purchase-orders/lib/portal', () => ({
  acknowledgeFromPortal: vi.fn(),
  portalNoticeRecipient: async () => '',
  recordPortalEvent: vi.fn(),
  resolvePortalToken: async () => ({ id: 't1', orderId: 'o1', hash: 'h' }),
}))
vi.mock('@/modules/purchase-orders/lib/portal-rate-limit', () => ({
  allowPortalWriteIp: () => true,
  allowPortalWriteToken: () => true,
  portalClientIp: () => '127.0.0.1',
}))

const { POST } = await import('@/modules/purchase-orders/app/api/public/portal/upload/route')

function send(fields: Record<string, string>) {
  const form = new FormData()
  form.set('token', 'a'.repeat(43))
  form.set('kind', 'proforma')
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  form.set('file', new File([Buffer.from('%PDF-1.4')], 'PF.pdf', { type: 'application/pdf' }))
  return POST(new NextRequest('http://localhost/api/m/purchase-orders/public/portal/upload', { method: 'POST', body: form }))
}

const OPEN = {
  id: 'o1', number: 'PO-00050', status: 'SENT', currency: 'GBP', supplierName: 'Acme', proformaRequired: true,
  proformaPaidAt: null, proformaMediaId: null, proformaRef: null, proformaAmount: null, ackRef: null,
}

beforeEach(() => {
  for (const mock of [stored, setDoc, replaceDoc, setWarning]) mock.mockReset()
  stored.mockResolvedValue({ ok: true, mediaId: 'media-new' })
  replaceDoc.mockResolvedValue(true)
})

describe('a proforma through the supplier’s own link', () => {
  it('files the first one as it always did', async () => {
    order.current = { ...OPEN }
    expect((await send({ ref: 'PF-1', amount: '120.00' })).status).toBe(200)
    expect(setDoc).toHaveBeenCalledWith('o1', 'media-new', 'PF-1', '120.00')
    expect(setWarning).not.toHaveBeenCalled()
  })

  it('refuses one for an order whose proforma is paid, before storing anything', async () => {
    order.current = { ...OPEN, proformaPaidAt: '2026-09-29T10:00:00.000Z', proformaMediaId: 'media-old', proformaRef: 'PF-1' }
    const res = await send({ ref: 'PF-2', amount: '120.00' })
    expect(res.status).toBe(409)
    expect(stored).not.toHaveBeenCalled()
    expect(replaceDoc).not.toHaveBeenCalled()
  })

  it('replaces with the new figures and raises the warning when it is not the same document', async () => {
    order.current = { ...OPEN, proformaMediaId: 'media-old', proformaRef: 'PF-1', proformaAmount: '120' }
    expect((await send({ ref: 'PF-2', amount: '120.00' })).status).toBe(200)
    expect(replaceDoc).toHaveBeenCalledWith('o1', 'media-new', 'PF-2', '120.00', null)
    expect(setWarning).toHaveBeenCalledWith('o1', expect.stringMatching(/bank details/))
  })

  it('does not warn about the same document sent again', async () => {
    order.current = { ...OPEN, proformaMediaId: 'media-old', proformaRef: 'PF-1', proformaAmount: '120' }
    await send({ ref: 'PF-1', amount: '120.00' })
    expect(setWarning).not.toHaveBeenCalled()
  })

  it('refuses when the payment lands between the check and the write', async () => {
    order.current = { ...OPEN, proformaMediaId: 'media-old', proformaRef: 'PF-1', proformaAmount: '120' }
    replaceDoc.mockResolvedValue(false)
    expect((await send({ ref: 'PF-2', amount: '120.00' })).status).toBe(409)
    expect(setWarning).not.toHaveBeenCalled()
  })
})
