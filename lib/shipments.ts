import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { PoDespatchableLine, PoShipment, PoShipmentLine, PoShipmentSummary, PoShipmentSource } from './types'

// Despatches: what the SUPPLIER says they have sent.
//
// Raw SQL like the rest of the module. The important thing about this table is
// what it does NOT do: a despatch moves no stock, closes no line, changes no
// status and touches no money. Goods-in (po_receipts) is still the only thing
// that says something arrived, and it always will be - a supplier telling us a
// pallet left them on Tuesday is a useful thing to know and is not the same fact
// as it being on our dock.
//
// What a despatch IS for: tracking a part-shipped order drop by drop, and giving
// each drop a packing slip to go in the box.

function dec(value: unknown): string {
  if (value === null || value === undefined) return '0'
  return String(value)
}

function day(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function stamp(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function mapSummary(r: Record<string, unknown>): PoShipmentSummary {
  return {
    id: r.id as string,
    number: r.number as string,
    orderId: r.order_id as string,
    orderNumber: (r.order_number as string | null) ?? '',
    supplierName: (r.supplier_name as string | null) ?? '',
    despatchedDate: day(r.despatched_date) ?? '',
    carrier: (r.carrier as string | null) ?? null,
    trackingRef: (r.tracking_ref as string | null) ?? null,
    trackingUrl: (r.tracking_url as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    source: ((r.source as string | null) ?? 'PORTAL') as PoShipmentSource,
    createdAt: stamp(r.created_at) ?? '',
  }
}

function mapLine(r: Record<string, unknown>): PoShipmentLine {
  return {
    id: r.id as string,
    orderLineId: r.order_line_id as string,
    qty: dec(r.qty),
    description: (r.description as string | null) ?? '',
    supplierSku: (r.supplier_sku as string | null) ?? null,
    ourSku: (r.our_sku as string | null) ?? null,
    productId: (r.product_id as string | null) ?? null,
    unit: (r.unit as string | null) ?? 'each',
  }
}

const SUMMARY_SELECT = Prisma.sql`
  d."id", d."number", d."order_id", d."despatched_date", d."carrier", d."tracking_ref",
  d."tracking_url", d."notes", d."source", d."created_at",
  o."number" AS "order_number", s."name" AS "supplier_name"
`

const SUMMARY_FROM = Prisma.sql`
  FROM "po_shipments" d
  JOIN "po_orders" o ON o."id" = d."order_id"
  JOIN "po_suppliers" s ON s."id" = o."supplier_id"
`

/** Every despatch filed against one order, newest first. */
export async function listShipmentsForOrder(orderId: string): Promise<PoShipment[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM}
     WHERE d."order_id" = ${orderId}
     ORDER BY d."despatched_date" DESC, d."created_at" DESC
  `
  if (rows.length === 0) return []

  // One round trip for every line of every despatch on the order, rather than
  // one per despatch: an order shipped in five drops is five queries otherwise,
  // on a screen that is drawn every time somebody opens the order.
  const ids = rows.map((r) => r.id as string)
  const lineRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT sl.*, l."description", l."supplier_sku", l."our_sku", l."product_id", l."unit", l."position"
      FROM "po_shipment_lines" sl
      JOIN "po_order_lines" l ON l."id" = sl."order_line_id"
     WHERE sl."shipment_id" = ANY(${ids}::text[])
     ORDER BY l."position" ASC
  `
  const byShipment = new Map<string, PoShipmentLine[]>()
  for (const row of lineRows) {
    const key = row.shipment_id as string
    const list = byShipment.get(key) ?? []
    list.push(mapLine(row))
    byShipment.set(key, list)
  }
  return rows.map((r) => ({ ...mapSummary(r), lines: byShipment.get(r.id as string) ?? [] }))
}

export async function getShipment(id: string): Promise<PoShipment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_SELECT} ${SUMMARY_FROM} WHERE d."id" = ${id} LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  const lineRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT sl.*, l."description", l."supplier_sku", l."our_sku", l."product_id", l."unit"
      FROM "po_shipment_lines" sl
      JOIN "po_order_lines" l ON l."id" = sl."order_line_id"
     WHERE sl."shipment_id" = ${id}
     ORDER BY l."position" ASC, l."created_at" ASC
  `
  return { ...mapSummary(r), lines: lineRows.map(mapLine) }
}

/** How much of each line the supplier says they have already sent, keyed by
 *  order line id. One round trip, for the portal's own page. */
export async function despatchedTotalsByLine(orderId: string): Promise<Record<string, string>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT sl."order_line_id", SUM(sl."qty") AS "qty"
      FROM "po_shipment_lines" sl
      JOIN "po_shipments" d ON d."id" = sl."shipment_id"
     WHERE d."order_id" = ${orderId}
     GROUP BY sl."order_line_id"
  `
  const out: Record<string, string> = {}
  for (const row of rows) out[row.order_line_id as string] = dec(row.qty)
  return out
}

/** One despatch, found by its number rather than its id - which is what the
 *  packing slip's own page has in the URL. */
export async function getShipmentIdByNumber(number: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "po_shipments" WHERE "number" = ${number} LIMIT 1
  `
  return rows[0]?.id ?? null
}

/**
 * What is left to send on each line.
 *
 * Ordered, less cancelled, less everything already despatched. Deliberately NOT
 * less what has been received: the two counts answer different questions, and a
 * supplier who despatched a pallet we have since booked in has still despatched
 * it. A line with nothing left is dropped rather than offered at zero.
 */
export async function despatchableLines(orderId: string): Promise<PoDespatchableLine[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."id", l."description", l."supplier_sku", l."unit", l."qty", l."qty_cancelled",
           COALESCE((
             SELECT SUM(sl."qty") FROM "po_shipment_lines" sl WHERE sl."order_line_id" = l."id"
           ), 0) AS "qty_despatched"
      FROM "po_order_lines" l
     WHERE l."order_id" = ${orderId}
     ORDER BY l."position" ASC, l."created_at" ASC
  `
  return rows
    .map((r) => {
      const ordered = Number(r.qty) - Number(r.qty_cancelled ?? 0)
      const despatched = Number(r.qty_despatched ?? 0)
      return {
        orderLineId: r.id as string,
        description: (r.description as string | null) ?? '',
        supplierSku: (r.supplier_sku as string | null) ?? null,
        unit: (r.unit as string | null) ?? 'each',
        qtyOrdered: ordered.toFixed(3),
        qtyDespatched: despatched.toFixed(3),
        qtyOutstanding: Math.max(0, ordered - despatched).toFixed(3),
      }
    })
    .filter((line) => Number(line.qtyOutstanding) > 0)
}

export type ShipmentLineInput = { orderLineId: string; qty: string }

export type ShipmentInput = {
  orderId: string
  despatchedDate: string
  carrier: string | null
  trackingRef: string | null
  trackingUrl: string | null
  notes: string | null
  source: PoShipmentSource
  tokenId: string | null
  createdByUserId: string | null
  lines: ShipmentLineInput[]
}

export async function createShipment(number: string, input: ShipmentInput): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "po_shipments" (
        "number", "order_id", "despatched_date", "carrier", "tracking_ref", "tracking_url",
        "notes", "source", "token_id", "created_by_user_id"
      ) VALUES (
        ${number}, ${input.orderId}, ${input.despatchedDate}::date, ${input.carrier},
        ${input.trackingRef}, ${input.trackingUrl}, ${input.notes}, ${input.source},
        ${input.tokenId}, ${input.createdByUserId}
      )
      RETURNING "id"
    `
    const shipmentId = rows[0]!.id
    for (const line of input.lines) {
      await tx.$executeRaw`
        INSERT INTO "po_shipment_lines" ("shipment_id", "order_line_id", "qty")
        VALUES (${shipmentId}, ${line.orderLineId}, ${line.qty}::numeric)
      `
    }
    return shipmentId
  })
}

export async function deleteShipment(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "po_shipments" WHERE "id" = ${id}`
}

/** The order a despatch belongs to, for the packing slip's own door. */
export async function shipmentOrderId(id: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ order_id: string }[]>`
    SELECT "order_id" FROM "po_shipments" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0]?.order_id ?? null
}
