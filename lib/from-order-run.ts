import { recordAudit } from './audit'
import { getCapabilities } from './capabilities'
import { getPoConfigCached } from './config'
import { createOrder, type OrderInput, type OrderLineInput } from './db'
import {
  CLOSED_SHOP_ORDER_STATUSES,
  listPosForShopOrder,
  livePos,
  planFromShopOrder,
  readShopOrder,
  type FromOrderGroup,
  type FromOrderPlan,
  type FromOrderSkipped,
  type ShopOrderFacts,
} from './from-order'
import { needsApproval } from './lifecycle'
import { generateOrderNumber } from './numbering'
import { orderTotals } from './totals'
import type { PoShipTo } from './types'

// The one thing that raises purchase orders off a customer order.
//
// Every order it makes is a DRAFT, drop-shipped to the customer, and nothing is
// emailed to anybody: somebody presses send having read it, exactly as the
// reorder job behaves. A button that posted orders straight to three suppliers
// is a button pressed once by mistake and regretted for a fortnight.

export type FromOrderRaised = {
  id: string
  number: string
  supplierId: string
  supplierName: string
  currency: string
  total: string
  lineCount: number
}

/** Who caused this. Recorded because "somebody chose to buy this" and "the
 *  money landing bought this" look identical on the Orders tab and are not the
 *  same thing at all when one of them turns out to have been a mistake. */
export type FromOrderRaisedBy = 'USER' | 'AUTO'

export type FromOrderRunResult = {
  ordersCreated: FromOrderRaised[]
  /** Lines that could not be bought, each with a sentence saying why. */
  skipped: FromOrderSkipped[]
  /** Set when nothing was raised at all, and why. */
  refused: string | null
}

export type FromOrderRunOptions = {
  /** The customer order's `shp_orders.id`. */
  orderId: string
  /** Null where nothing was pressed by anybody - the paid-order hook and the
   *  catch-up sweep both run with no session, exactly as the reorder job does.
   *  It is what the audit entry reads as, and it must read as the truth. */
  userId: string | null
}

export async function raisePurchaseOrdersFromShopOrder(
  options: FromOrderRunOptions,
): Promise<FromOrderRunResult> {
  const empty: FromOrderRunResult = { ordersCreated: [], skipped: [], refused: null }

  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) {
    return { ...empty, refused: 'There is no shop on this site, so there is no customer order to buy for.' }
  }

  const order = await readShopOrder(options.orderId)
  if (!order) return { ...empty, refused: 'That order could not be read.' }

  // Cancelled or refunded. The panel hides its button on those, but the panel is
  // not the only way to this route and an order can be refunded while somebody
  // has the screen open. Buying the goods in for an order nobody is paying for
  // is the one mistake here that costs real money.
  if (CLOSED_SHOP_ORDER_STATUSES.has(order.status)) {
    return { ...empty, refused: `${order.orderNumber} is ${order.status.toLowerCase()}, so nothing is being ordered for it.` }
  }

  // Idempotency. Pressing the button twice must not order everything twice, and
  // the second press has to SAY so rather than quietly doing nothing. Cancelled
  // orders are ignored on purpose: cancelling one is a decision to buy this
  // differently, and it must not lock the order out of ever being raised again.
  const already = livePos(await listPosForShopOrder(order.id))
  if (already.length > 0) {
    const numbers = already.map((po) => po.number).join(', ')
    return {
      ...empty,
      refused: `${numbers} ${already.length === 1 ? 'has' : 'have'} already been raised for ${order.orderNumber}. Cancel ${already.length === 1 ? 'it' : 'them'} first if you want to start again.`,
    }
  }

  const plan = await planFromShopOrder(order)
  if (plan.groups.length === 0) {
    return {
      ...empty,
      skipped: plan.skipped,
      refused: 'Nothing on this order could be matched to a supplier on your list.',
    }
  }

  const config = await getPoConfigCached()
  const ordersCreated: FromOrderRaised[] = []
  for (const group of plan.groups) {
    ordersCreated.push(await raiseOneOrder(order, group, plan.shipTo, config.baseCurrency, config, options.userId))
  }


  return { ordersCreated, skipped: plan.skipped, refused: null }
}

async function raiseOneOrder(
  order: ShopOrderFacts,
  group: FromOrderGroup,
  shipTo: PoShipTo,
  baseCurrency: string,
  config: { approvalRequired: boolean; approvalThreshold: number },
  userId: string | null,
): Promise<FromOrderRaised> {
  const lines: OrderLineInput[] = group.lines.map((line) => ({
    productId: line.productId,
    productName: line.productName,
    supplierSku: line.supplierSku,
    ourSku: line.ourSku,
    description: line.productName,
    qty: String(line.qty),
    unit: 'each',
    unitCost: line.unitCost,
    discountPercent: null,
    taxRatePercent: group.taxRatePercent,
    taxRateCode: null,
    vatTreatment: null,
    categoryId: null,
    expectedDate: null,
    qtyCancelled: '0',
    serviceName: line.serviceName,
    serviceCost: line.serviceCost,
    sourceOrderItemId: line.itemId,
  }))

  const input: OrderInput = {
    supplierId: group.supplierId,
    // Drop-ship. The goods never come here: they go to the person who bought
    // them, at the address they gave at the checkout.
    shipToKind: 'CUSTOMER',
    shipTo,
    currency: group.currency,
    baseCurrency,
    // Deliberately 1, exactly as a reorder is. Nothing on this site knows
    // today's rate, and an invented one on a draft reads as a real one.
    fxRate: '1',
    taxMode: 'EXCLUSIVE',
    discountAmount: '0',
    // The delivery money, and the only place it lands. Each line names its
    // service; the cost of those services is summed here, because carriage is
    // where this module has always carried delivery and a line total that
    // included it would disagree with every supplier invoice ever matched.
    carriageAmount: group.carriageAmount,
    requiredByDate: null,
    expectedDate: null,
    paymentTerms: null,
    deliveryTerms: null,
    notesSupplier: null,
    notesInternal: userId
      ? `Drafted from customer order ${order.orderNumber}, to be delivered straight to the customer. Nothing has been sent to the supplier.`
      : `Drafted automatically when customer order ${order.orderNumber} was paid for, to be delivered straight to the customer. Nobody has read it and nothing has been sent to the supplier.`,
    lines,
  }

  const totals = orderTotals({
    lines: input.lines,
    taxMode: input.taxMode,
    discountAmount: input.discountAmount,
    carriageAmount: input.carriageAmount,
  })

  const number = await generateOrderNumber()
  const id = await createOrder(number, input, totals, needsApproval(totals.total, config), userId, {
    kind: 'FROM_ORDER',
    ref: { orderId: order.id, orderNumber: order.orderNumber },
  })

  await recordAudit(
    'order',
    id,
    'order.created',
    {
      number,
      total: totals.total,
      source: 'FROM_ORDER',
      // Derived rather than passed: a run with no session is a run nobody
      // started, and the two can then never disagree.
      raisedBy: (userId ? 'USER' : 'AUTO') satisfies FromOrderRaisedBy,
      shopOrder: order.orderNumber,
      lines: lines.length,
    },
    userId,
  )

  return {
    id,
    number,
    supplierId: group.supplierId,
    supplierName: group.supplierName,
    currency: group.currency,
    total: totals.total,
    lineCount: lines.length,
  }
}
