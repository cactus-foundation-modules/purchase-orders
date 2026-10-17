import { prisma } from '@/lib/db/prisma'

// What a despatch means for the customer's order when the order line was a KIT.
//
// A kit is bought as its parts (lib/from-order.ts, expandKitItems): one purchase
// order line per part, each sharing the customer's line as its
// `source_order_item_id`, each in units of the PART. A parcel holding the seat
// is therefore not news that "6 of the chair" went out - and the shop observer
// reads `qty` as units of its own order line. So before a despatch is announced,
// every line that belongs to a kit is replaced by one line in the customer's
// units: how many WHOLE kits the parts shipped so far now add up to, less how
// many they added up to before this parcel. The seat alone gives nothing; the
// parcel that completes the set gives the kit.
//
// Counted across every purchase order raised off that customer order, because
// the parts can come from different suppliers - each tells its own story, and the
// kit has gone only when the scarcest part has.
//
// Reads shop's `shp_product_components` and `shp_order_items` by raw SQL, like
// the rest of this module's reading of the shop. A shop without kits (or a site
// with no shop) throws on the first read, which is answered with "no kits": the
// lines go out exactly as they were.

export type DespatchLine = { sourceOrderItemId: string; qty: number }

/** One part's shipments, in the part's own units, and how many go into one kit. */
export type KitPartShipped = { perKit: number; shippedBefore: number; shippedNow: number }

/**
 * Whole kits newly complete because of this parcel.
 *
 * `shippedBefore` is everything of that part sent in parcels before this one,
 * `shippedNow` what this one holds. The kit is limited by its scarcest part, so
 * it is the minimum over the parts of how many kits' worth each has shipped.
 */
export function kitUnitsDespatched(parts: readonly KitPartShipped[]): number {
  if (parts.length === 0) return 0
  const wholeKits = (count: (p: KitPartShipped) => number) =>
    Math.min(...parts.map((p) => (p.perKit > 0 ? Math.floor(count(p) / p.perKit) : 0)))
  const before = wholeKits((p) => p.shippedBefore)
  const after = wholeKits((p) => p.shippedBefore + p.shippedNow)
  return Math.max(after - before, 0)
}

type PartRow = { item_id: string; per_kit: unknown; shipped_before: unknown; shipped_now: unknown }

/**
 * `lines` with each kit's part lines replaced by one line in the customer's own
 * units. Anything that is not part of a kit passes through unchanged, and so
 * does everything when there are no kits to be found.
 */
export async function kitAwareDespatchLines(
  despatchId: string,
  customerOrderId: string,
  lines: readonly DespatchLine[],
): Promise<DespatchLine[]> {
  const itemIds = [...new Set(lines.map((l) => l.sourceOrderItemId))]
  if (itemIds.length === 0) return [...lines]

  let rows: PartRow[]
  try {
    rows = await prisma.$queryRaw<PartRow[]>`
      SELECT l."source_order_item_id" AS "item_id",
             pc."quantity" AS "per_kit",
             COALESCE(SUM(sl."qty") FILTER (
               WHERE s."id" <> ${despatchId}
                 AND s."created_at" < (SELECT "created_at" FROM "po_shipments" WHERE "id" = ${despatchId})
             ), 0) AS "shipped_before",
             COALESCE(SUM(sl."qty") FILTER (WHERE s."id" = ${despatchId}), 0) AS "shipped_now"
        FROM "po_order_lines" l
        JOIN "po_orders" o ON o."id" = l."order_id"
                          AND o."source_kind" = 'FROM_ORDER'
                          AND o."source_ref"->>'orderId' = ${customerOrderId}
                          AND o."status" <> 'CANCELLED'
        JOIN "shp_order_items" oi ON oi."id" = l."source_order_item_id"
        JOIN "shp_product_components" pc ON pc."product_id" = oi."product_id"
                                        AND pc."component_product_id" = l."product_id"
        LEFT JOIN "po_shipment_lines" sl ON sl."order_line_id" = l."id"
        LEFT JOIN "po_shipments" s ON s."id" = sl."shipment_id"
       WHERE l."source_order_item_id" = ANY(${itemIds}::text[])
       GROUP BY l."id", l."source_order_item_id", pc."quantity"
    `
  } catch {
    return [...lines]
  }
  if (rows.length === 0) return [...lines]

  const partsByItem = new Map<string, KitPartShipped[]>()
  for (const r of rows) {
    const list = partsByItem.get(r.item_id) ?? []
    list.push({ perKit: Number(r.per_kit), shippedBefore: Number(r.shipped_before), shippedNow: Number(r.shipped_now) })
    partsByItem.set(r.item_id, list)
  }

  const out: DespatchLine[] = lines.filter((l) => !partsByItem.has(l.sourceOrderItemId))
  for (const [itemId, parts] of partsByItem) {
    const qty = kitUnitsDespatched(parts)
    if (qty > 0) out.push({ sourceOrderItemId: itemId, qty })
  }
  return out
}
