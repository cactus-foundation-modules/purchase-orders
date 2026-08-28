import { describe, expect, it, vi, beforeEach } from 'vitest'

// The two ways an automatic draft can start, and the one thing both of them must
// get right: doing absolutely nothing on a site that has not asked for this.
//
// Off is the default, off is what every existing install updates into, and "off"
// has to mean no run, no email, and - for the sweep - not so much as a read of
// another module's tables to find out there was nothing to do.

const config = vi.hoisted(() => vi.fn())
const capabilities = vi.hoisted(() => vi.fn())
const raise = vi.hoisted(() => vi.fn())
const report = vi.hoisted(() => vi.fn())
const queryRaw = vi.hoisted(() => vi.fn())

vi.mock('./config', () => ({ getPoConfigCached: config }))
vi.mock('./capabilities', () => ({ getCapabilities: capabilities }))
vi.mock('./from-order-run', () => ({ raisePurchaseOrdersFromShopOrder: raise }))
vi.mock('./auto-draft-report', () => ({ reportAutoDraft: report }))
vi.mock('@/lib/db/prisma', () => ({ prisma: { $queryRaw: queryRaw } }))

const { purchaseOrdersOrderPaidObserver } = await import('./order-paid-provider')
const { runPaidSweep } = await import('./paid-sweep')

const event = {
  orderId: 'ord_1',
  orderNumber: 'SO-1001',
  paymentMethod: 'card',
  clearedManually: false,
}

const ranNothing = { ordersCreated: [], skipped: [], refused: null }

beforeEach(() => {
  config.mockReset()
  capabilities.mockReset()
  raise.mockReset()
  report.mockReset()
  queryRaw.mockReset()
  config.mockResolvedValue({ autoDraftFromPaidOrders: true })
  capabilities.mockResolvedValue({ hasCatalogue: true })
  raise.mockResolvedValue(ranNothing)
  report.mockResolvedValue(undefined)
  queryRaw.mockResolvedValue([])
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the paid-order observer', () => {
  it('does nothing whatever with the setting off', async () => {
    config.mockResolvedValue({ autoDraftFromPaidOrders: false })
    await purchaseOrdersOrderPaidObserver(event)
    expect(raise).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('raises with no session behind it, so the record reads as automatic', async () => {
    await purchaseOrdersOrderPaidObserver(event)
    expect(raise).toHaveBeenCalledWith({ orderId: 'ord_1', userId: null })
  })

  it('reports the outcome, since nobody is looking at a screen', async () => {
    await purchaseOrdersOrderPaidObserver(event)
    expect(report).toHaveBeenCalledWith('SO-1001', ranNothing)
  })

  it('never throws into the payment webhook it is running inside', async () => {
    raise.mockRejectedValue(new Error('the database is having a moment'))
    await expect(purchaseOrdersOrderPaidObserver(event)).resolves.toBeUndefined()
  })

  it('does not fail because an email would not send', async () => {
    report.mockRejectedValue(new Error('no mailer'))
    await expect(purchaseOrdersOrderPaidObserver(event)).resolves.toBeUndefined()
  })
})

describe('the catch-up sweep', () => {
  it('reads nothing at all with the setting off', async () => {
    config.mockResolvedValue({ autoDraftFromPaidOrders: false })
    const result = await runPaidSweep()
    expect(result.skipped).toContain('switched off')
    expect(queryRaw).not.toHaveBeenCalled()
    expect(raise).not.toHaveBeenCalled()
  })

  it('stops before the queries on a site with no shop', async () => {
    capabilities.mockResolvedValue({ hasCatalogue: false })
    const result = await runPaidSweep()
    expect(result.skipped).toContain('no shop')
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('raises for every paid order that had nothing standing against it', async () => {
    queryRaw
      .mockResolvedValueOnce([
        { id: 'ord_1', order_number: 'SO-1001' },
        { id: 'ord_2', order_number: 'SO-1002' },
      ])
      .mockResolvedValueOnce([])
    raise.mockResolvedValue({
      ordersCreated: [
        {
          id: 'po-1',
          number: 'PO-00042',
          supplierId: 's1',
          supplierName: 'Dynamic',
          currency: 'GBP',
          total: '10.00',
          lineCount: 1,
        },
      ],
      skipped: [],
      refused: null,
    })

    const result = await runPaidSweep()
    expect(result.considered).toBe(2)
    expect(raise).toHaveBeenCalledTimes(2)
    expect(raise).toHaveBeenCalledWith({ orderId: 'ord_1', userId: null })
    expect(result.raised.map((r) => r.orderNumber)).toEqual(['SO-1001', 'SO-1002'])
  })

  it('keeps the sentence when the run turns an order away', async () => {
    queryRaw.mockResolvedValueOnce([{ id: 'ord_1', order_number: 'SO-1001' }]).mockResolvedValueOnce([])
    raise.mockResolvedValue({ ordersCreated: [], skipped: [], refused: 'SO-1001 is refunded.' })

    const result = await runPaidSweep()
    expect(result.refused).toEqual([{ orderNumber: 'SO-1001', reason: 'SO-1001 is refunded.' }])
    expect(result.raised).toEqual([])
  })

  it('reports a purchase order left live against a refunded order, and touches nothing', async () => {
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        number: 'PO-00042',
        status: 'SENT',
        order_number: 'SO-1001',
        order_status: 'REFUNDED',
        supplier_name: 'Dynamic',
      },
    ])

    const result = await runPaidSweep()
    expect(result.orphaned).toEqual([
      { number: 'PO-00042', supplierName: 'Dynamic', orderNumber: 'SO-1001', orderStatus: 'REFUNDED' },
    ])
    // Reported, never acted on. The goods may already be on their way.
    expect(raise).not.toHaveBeenCalled()
  })

  it('degrades to nothing to sweep when the shop is too old for the columns', async () => {
    queryRaw.mockRejectedValue(new Error('column "paid_at" does not exist'))
    const result = await runPaidSweep()
    expect(result.considered).toBe(0)
    expect(result.orphaned).toEqual([])
    expect(result.skipped).toBeNull()
  })
})
