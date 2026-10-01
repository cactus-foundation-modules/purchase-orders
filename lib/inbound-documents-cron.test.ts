import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The half-hourly job runs when either email switch is on, and reports each
// job's problems only while that job is on: a site reading tracking with the
// paperwork filing off still hears about postcode proposals and despatches
// that could not be passed on.

const config = vi.hoisted(() => vi.fn())
const report = vi.hoisted(() => vi.fn())
const announce = vi.hoisted(() => vi.fn())
const queued = vi.hoisted(() => vi.fn())
const run = vi.hoisted(() => vi.fn())

vi.mock('@/modules/purchase-orders/lib/config', () => ({ getPoConfigCached: config }))
vi.mock('@/modules/purchase-orders/lib/inbound-report', () => ({ reportPaperworkProblems: report }))
vi.mock('@/modules/purchase-orders/lib/inbound-tracking', () => ({ announcePendingDespatches: announce }))
vi.mock('@/modules/purchase-orders/lib/inbound-run', () => ({ anythingQueued: queued, runInboundQueue: run }))

const { GET } = await import('@/modules/purchase-orders/app/api/cron/inbound-documents/route')

function request() {
  return new NextRequest('https://site.example/api/m/purchase-orders/cron/inbound-documents', {
    headers: { authorization: 'Bearer secret' },
  })
}

beforeEach(() => {
  process.env.CRON_SECRET = 'secret'
  for (const mock of [config, report, announce, queued, run]) mock.mockReset()
  report.mockResolvedValue(0)
  announce.mockResolvedValue(0)
  queued.mockResolvedValue(false)
})

describe('the inbound-documents job', () => {
  it('reports tracking problems with only tracking switched on', async () => {
    config.mockResolvedValue({ inboundFilingEnabled: false, inboundTrackingEnabled: true })
    await GET(request())
    expect(report).toHaveBeenCalledWith({ documents: false, tracking: true })
    expect(announce).toHaveBeenCalled()
    expect(queued).not.toHaveBeenCalled()
  })

  it('reports paperwork problems with only filing switched on', async () => {
    config.mockResolvedValue({ inboundFilingEnabled: true, inboundTrackingEnabled: false })
    await GET(request())
    expect(report).toHaveBeenCalledWith({ documents: true, tracking: false })
    expect(announce).not.toHaveBeenCalled()
  })

  it('does nothing at all with both off', async () => {
    config.mockResolvedValue({ inboundFilingEnabled: false, inboundTrackingEnabled: false })
    await GET(request())
    expect(report).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
  })
})
