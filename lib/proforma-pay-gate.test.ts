import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Marking a proforma paid while a warning from email stands on it: refused
// until somebody says they have checked the bank details, and then the warning
// is answered in their name. The route's own logic, with everything around it
// stood in for; the SQL behind the warnings is exercised against a real
// Postgres in inbound-filing.live.test.ts.

const warnings = vi.hoisted(() => vi.fn())
const clearWarnings = vi.hoisted(() => vi.fn())
const markPaid = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/session', () => ({ getSessionFromCookie: async () => ({ id: 'user-1' }) }))
vi.mock('@/modules/purchase-orders/lib/permissions', () => ({
  getPoAccess: async () => ({ canApprove: true, canBills: true }),
}))
vi.mock('@/modules/purchase-orders/lib/db', () => ({
  getOrder: async () => ({ id: 'o1', number: 'PO-00040', proformaRequired: true, supplierId: 's1', proformaPaymentProofMediaId: null }),
  getSupplier: async () => null,
}))
vi.mock('@/modules/purchase-orders/lib/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/modules/purchase-orders/lib/email', () => ({ proformaPaidRecipients: () => null, sendProformaPaid: vi.fn() }))
vi.mock('@/modules/purchase-orders/lib/portal', () => ({ mintPortalLink: vi.fn() }))
vi.mock('@/modules/purchase-orders/lib/inbound-run', () => ({
  liveProformaWarnings: warnings,
  clearProformaWarnings: clearWarnings,
}))
vi.mock('@/modules/purchase-orders/lib/proforma', () => ({
  clearProformaPayment: vi.fn(),
  markProformaPaid: markPaid,
  markProofSent: vi.fn(),
  mediaAttachment: vi.fn(),
  setProformaRequired: vi.fn(),
}))

const { POST } = await import('@/modules/purchase-orders/app/api/admin/orders/[id]/proforma/route')

function pay(body: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost/api/m/purchase-orders/admin/orders/o1/proforma', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'o1' }) },
  )
}

const WARNING = 'A revised proforma arrived by email and replaced the one on this order. Check the bank details.'

beforeEach(() => {
  warnings.mockReset()
  clearWarnings.mockReset()
  markPaid.mockReset()
  markPaid.mockResolvedValue(true)
})

const AT = '2026-09-30T10:00:00.000Z'

describe('marking a proforma paid', () => {
  it('refuses while a warning stands and nobody has said they checked', async () => {
    warnings.mockResolvedValue({ warnings: [WARNING], newestAt: AT })
    const res = await pay({ paymentRef: 'BACS-1' })
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toContain(WARNING)
    expect(data.error).toMatch(/checked the bank details/)
    expect(markPaid).not.toHaveBeenCalled()
    expect(clearWarnings).not.toHaveBeenCalled()
  })

  it('refuses a tick with no record of which warnings it answered', async () => {
    warnings.mockResolvedValue({ warnings: [WARNING], newestAt: AT })
    expect((await pay({ acknowledgedWarning: true })).status).toBe(409)
    expect(markPaid).not.toHaveBeenCalled()
  })

  it('refuses a tick given before a newer warning arrived', async () => {
    warnings.mockResolvedValue({ warnings: [WARNING, 'A second proforma arrived.'], newestAt: '2026-09-30T10:05:00.000Z' })
    const res = await pay({ acknowledgedWarning: true, warningsSeenUpTo: AT })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/Another warning/)
    expect(markPaid).not.toHaveBeenCalled()
    expect(clearWarnings).not.toHaveBeenCalled()
  })

  it('answers the warnings it was shown in the payer’s name, then pays', async () => {
    warnings.mockResolvedValue({ warnings: [WARNING], newestAt: AT })
    const res = await pay({ paymentRef: 'BACS-1', acknowledgedWarning: true, warningsSeenUpTo: AT })
    expect(res.status).toBe(200)
    expect(clearWarnings).toHaveBeenCalledWith('o1', [WARNING], AT, 'user-1')
    expect(markPaid).toHaveBeenCalled()
  })

  it('asks nothing when no warning stands', async () => {
    warnings.mockResolvedValue({ warnings: [], newestAt: null })
    const res = await pay({ paymentRef: 'BACS-1' })
    expect(res.status).toBe(200)
    expect(clearWarnings).not.toHaveBeenCalled()
  })
})
