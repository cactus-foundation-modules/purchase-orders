import { describe, expect, it, vi, beforeEach } from 'vitest'

const readShopOrder = vi.hoisted(() => vi.fn())
const listPosForShopOrder = vi.hoisted(() => vi.fn())
const planFromShopOrder = vi.hoisted(() => vi.fn())
const getCapabilities = vi.hoisted(() => vi.fn())

vi.mock('./capabilities', () => ({ getCapabilities }))
vi.mock('./from-order', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./from-order')>()
  return {
    ...actual,
    readShopOrder,
    listPosForShopOrder,
    planFromShopOrder,
  }
})

const { raisePurchaseOrdersFromShopOrder } = await import('./from-order-run')
const { autoDraftReport } = await import('./auto-draft-report')
const { SHOP_ORDER_KIND_REPLACEMENT } = await import('./from-order')

beforeEach(() => {
  readShopOrder.mockReset()
  listPosForShopOrder.mockReset()
  planFromShopOrder.mockReset()
  getCapabilities.mockReset()
  getCapabilities.mockResolvedValue({ hasCatalogue: true })
  listPosForShopOrder.mockResolvedValue([])
})

describe('raising from a replacement order', () => {
  it('does nothing and does not refuse, so automatic runs stay quiet', async () => {
    readShopOrder.mockResolvedValue({
      id: 'ord-r1',
      orderNumber: 'DW000182-R1',
      kind: SHOP_ORDER_KIND_REPLACEMENT,
      status: 'COMPLETED',
      customerName: 'Someone',
      customerPhone: null,
      customerOrganisation: null,
      currency: 'GBP',
      shippingAddress: null,
      deliveryInstructions: null,
      items: [],
    })

    const result = await raisePurchaseOrdersFromShopOrder({ orderId: 'ord-r1', userId: null })

    expect(result).toEqual({ ordersCreated: [], skipped: [], refused: null })
    expect(planFromShopOrder).not.toHaveBeenCalled()
    expect(autoDraftReport('DW000182-R1', result)).toBeNull()
  })
})
