// What a customer's order cost us, for shop's Reports > Profits - contributed
// to shop's `shop.order-costs` point. Server-only: it reads this module's own
// tables, keyed on the shop order ids the report hands over.
//
// One entry per purchase order raised off the customer order (source_ref), at
// the best figure there is for it:
//  - billed: the supplier's invoice(s) against it, once approved or posted -
//    what we actually owe, carriage and surcharge in, tax out
//  - ordered: what the purchase order asked for, until an invoice is approved
// A cancelled purchase order cost nothing and is left out. Every figure is net
// of tax and in the site's own currency, at the rate each document carries.
//
// Nothing here imports '@/modules/shop/...'. The shop's types are restated.
// A viewer without purchase-orders.access gets null - shop then says the costs
// are withheld rather than showing every order as pure profit.
import { prisma } from '@/lib/db/prisma'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { PO_STATUS_LABELS, type PoStatus } from './types'

export type OrderForCost = { id: string; orderNumber: string }
export type OrderCost = { ref: string; label?: string; path?: string; status?: string; amount: number; basis: 'billed' | 'ordered' }

export async function purchaseOrdersOrderCosts(orders: OrderForCost[]): Promise<Record<string, OrderCost[]> | null> {
  const user = await getSessionFromCookie()
  if (!user || !(await hasPermission(user, 'purchase-orders.access'))) return null
  if (orders.length === 0) return {}

  const rows = await prisma.$queryRaw<Array<{
    id: string; number: string; status: string; shop_order_id: string; supplier: string | null
    ordered_net: string; billed_net: string | null; bill_count: bigint
  }>>`
    SELECT o."id", o."number", o."status", o."source_ref"->>'orderId' AS shop_order_id, s."name" AS supplier,
           (o."total" - o."tax_amount") * o."fx_rate" AS ordered_net,
           b.billed_net, COALESCE(b.bill_count, 0)::bigint AS bill_count
    FROM "po_orders" o
    LEFT JOIN "po_suppliers" s ON s."id" = o."supplier_id"
    LEFT JOIN LATERAL (
      SELECT SUM((bl."total" - bl."tax_amount") * bl."fx_rate") AS billed_net, COUNT(*) AS bill_count
      FROM "po_bills" bl
      WHERE bl."order_id" = o."id" AND bl."status" IN ('APPROVED', 'POSTED')
    ) b ON true
    WHERE o."source_ref"->>'orderId' = ANY(${orders.map((o) => o.id)}::text[])
      AND o."status" <> 'CANCELLED'
    ORDER BY o."number"
  `

  const out: Record<string, OrderCost[]> = {}
  for (const r of rows) {
    const billed = Number(r.bill_count) > 0 && r.billed_net != null
    ;(out[r.shop_order_id] ??= []).push({
      ref: r.number,
      label: r.supplier ?? undefined,
      path: `m/purchase-orders/orders/${r.id}`,
      status: PO_STATUS_LABELS[r.status as PoStatus] ?? r.status,
      amount: Number(billed ? r.billed_net : r.ordered_net),
      basis: billed ? 'billed' : 'ordered',
    })
  }
  return out
}
