import { prisma } from '@/lib/db/prisma'
import type { PoBillStatus, PoCustomerOrder, PoMatchStatus, PoUnsettledBill } from './types'

// The two extra facts the Orders and Bills tabs draw beside each row, read in
// one query per tab rather than one per row.
//
// Both are raw SQL and both degrade to "nothing to say". The customer's order is
// in the shop's table, which does not exist on a site without a shop, and
// nothing here imports from '@/modules/shop/...' for the same reason
// lib/from-order.ts does not: that path is absent at build time on an install
// without one. A missing table throws, the catch turns it into an empty map, and
// the list simply has no customer column.

/**
 * The customer order each of these purchase orders was raised for, keyed by the
 * purchase order's id. A purchase order raised by hand or by a reorder has no
 * entry.
 */
export async function customerOrdersFor(orderIds: string[]): Promise<Map<string, PoCustomerOrder>> {
  const out = new Map<string, PoCustomerOrder>()
  const ids = [...new Set(orderIds.filter(Boolean))]
  if (ids.length === 0) return out

  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT p."id" AS "po_id", s."id", s."order_number", s."status"
        FROM "po_orders" p
        JOIN "shp_orders" s ON s."id" = p."source_ref"->>'orderId'
       WHERE p."id" = ANY(${ids}::text[])
         AND p."source_kind" = 'FROM_ORDER'
    `
    for (const r of rows) {
      out.set(r.po_id as string, {
        id: r.id as string,
        number: r.order_number as string,
        status: r.status as string,
      })
    }
  } catch {
    // No shop, or one too old to have these columns.
  }
  return out
}

/**
 * Every invoice on these orders that nobody here has agreed to pay yet,
 * grouped by order. The same two statuses `unsettledBillCount` counts, which is
 * what the close route refuses on.
 */
export async function unsettledBillsFor(orderIds: string[]): Promise<Map<string, PoUnsettledBill[]>> {
  const out = new Map<string, PoUnsettledBill[]>()
  const ids = [...new Set(orderIds.filter(Boolean))]
  if (ids.length === 0) return out

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT b."id", b."order_id", b."status", b."supplier_invoice_number", b."total", b."currency",
           b."match_status", b."variance"
      FROM "po_bills" b
     WHERE b."order_id" = ANY(${ids}::text[])
       AND b."status" = ANY(${['DRAFT', 'QUERIED']}::text[])
     ORDER BY b."invoice_date" ASC, b."created_at" ASC
  `
  for (const r of rows) {
    const orderId = r.order_id as string
    const list = out.get(orderId) ?? []
    list.push({
      id: r.id as string,
      status: r.status as PoBillStatus,
      supplierInvoiceNumber: r.supplier_invoice_number as string,
      total: r.total === null || r.total === undefined ? '0' : String(r.total),
      currency: (r.currency as string | null) ?? 'GBP',
      matchStatus: r.match_status as PoMatchStatus,
      varianceCount: Array.isArray(r.variance) ? r.variance.length : 0,
    })
    out.set(orderId, list)
  }
  return out
}
