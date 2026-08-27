import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getCapabilities } from './capabilities'
import { catalogueCostsBySupplier, hasSupplierSkuColumn } from './catalogues'
import type {
  ReorderFacts,
  ReorderLastCost,
  ReorderProductFacts,
  ReorderRuleRow,
  ReorderSupplierFacts,
} from './reordering'
import type { PoReorderRule, SupplierStatus } from './types'

// Every reorder read and write, in raw SQL as the rest of this module is.
//
// The catalogue half is guarded by `hasCatalogue` every single time and returns
// nothing rather than throwing: a site with no shop still has this table, may
// still have rules in it from before the shop was removed, and must still be
// able to open the tab and delete them.

/** Statuses in which a purchase order still owes us goods.
 *
 *  DRAFT is deliberately in the list. A draft the job raised last night is a
 *  decision somebody has already taken, and leaving it out is how the job raises
 *  the same order every night until a fortnight of them are sitting there. */
const OPEN_ORDER_STATUSES = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SENT',
  'ACKNOWLEDGED',
  'PART_RECEIVED',
  'ON_HOLD',
]

function stamp(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// ---------------------------------------------------------------------------
// The rules themselves
// ---------------------------------------------------------------------------

export type ReorderRuleInput = {
  productId: string
  supplierId: string | null
  reorderPoint: number
  reorderQty: number
  enabled: boolean
}

/**
 * Every rule, with the product and supplier named where they still exist.
 *
 * The join onto the catalogue is a LEFT one through a guarded subquery rather
 * than a plain join, so a rule outliving its product still appears - with a
 * blank name and a screen that says why - instead of vanishing and leaving
 * somebody wondering where their level went.
 */
export async function listReorderRules(): Promise<PoReorderRule[]> {
  const { hasCatalogue } = await getCapabilities()

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT r."id", r."product_id", r."supplier_id", r."reorder_point", r."reorder_qty",
           r."enabled", r."last_suggested_at", r."created_at", r."updated_at",
           s."name" AS "supplier_name"
      FROM "po_reorder_rules" r
      LEFT JOIN "po_suppliers" s ON s."id" = r."supplier_id"
     ORDER BY r."created_at" DESC
  `

  const names = hasCatalogue
    ? await catalogueNames(rows.map((r) => r.product_id as string))
    : new Map<string, { name: string; sku: string | null }>()

  return rows.map((r) => {
    const product = names.get(r.product_id as string)
    return {
      id: r.id as string,
      productId: r.product_id as string,
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      supplierId: (r.supplier_id as string | null) ?? null,
      supplierName: (r.supplier_name as string | null) ?? null,
      reorderPoint: Number(r.reorder_point ?? 0),
      reorderQty: Number(r.reorder_qty ?? 0),
      enabled: Boolean(r.enabled),
      lastSuggestedAt: stamp(r.last_suggested_at),
      createdAt: stamp(r.created_at) ?? '',
      updatedAt: stamp(r.updated_at) ?? '',
    }
  })
}

export async function createReorderRule(input: ReorderRuleInput): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "po_reorder_rules" ("product_id", "supplier_id", "reorder_point", "reorder_qty", "enabled")
    VALUES (${input.productId}, ${input.supplierId}, ${input.reorderPoint}, ${input.reorderQty}, ${input.enabled})
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function updateReorderRule(id: string, input: ReorderRuleInput): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_reorder_rules" SET
      "product_id" = ${input.productId},
      "supplier_id" = ${input.supplierId},
      "reorder_point" = ${input.reorderPoint},
      "reorder_qty" = ${input.reorderQty},
      "enabled" = ${input.enabled},
      "updated_at" = now()
    WHERE "id" = ${id}
  `
}

export async function deleteReorderRule(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "po_reorder_rules" WHERE "id" = ${id}`
}

/** Thrown up as a 409 by the route: one product, one level. */
export function isDuplicateReorderProduct(error: unknown): boolean {
  return error instanceof Error && error.message.includes('po_reorder_rules_product_unique')
}

/** Stamps the rules whose suggestions have just become order lines. */
export async function markRulesSuggested(ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return
  await prisma.$executeRaw`
    UPDATE "po_reorder_rules" SET "last_suggested_at" = now()
     WHERE "id" = ANY(${ruleIds}::text[])
  `
}

// ---------------------------------------------------------------------------
// The catalogue, read at arm's length
// ---------------------------------------------------------------------------

/** A catalogue product as the rule editor offers it, counts and all. */
export type ReorderCatalogueProduct = {
  id: string
  name: string
  sku: string | null
  /** The supplier's own code, where the shop has one. Null on a shop older than
   *  v0.1.356, which has no such column - see `hasSupplierSkuColumn`. */
  supplierSku: string | null
  supplier: string | null
  costPrice: string | null
  stockCount: number | null
  lowStockThreshold: number | null
  trackInventory: boolean
}

async function catalogueNames(ids: string[]): Promise<Map<string, { name: string; sku: string | null }>> {
  const map = new Map<string, { name: string; sku: string | null }>()
  if (ids.length === 0) return map
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "name", "sku" FROM "shp_products" WHERE "id" = ANY(${ids}::text[])
    `
    for (const row of rows) {
      map.set(row.id as string, { name: row.name as string, sku: (row.sku as string | null) ?? null })
    }
  } catch {
    // hasCatalogue only proves the table was there a moment ago. A rules screen
    // that 500s because the shop was uninstalled between two queries helps
    // nobody, and the rules read perfectly well without the names.
  }
  return map
}

/**
 * Products the rule editor can pick from.
 *
 * Only the ones something is keeping a count of: a reorder level on a product
 * with no count is a level that can never be crossed, and offering it is an
 * invitation to set one and wonder for a month why nothing happens.
 */
export async function searchReorderProducts(term: string, limit = 25): Promise<ReorderCatalogueProduct[]> {
  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) return []

  const like = `%${term.trim()}%`
  const capped = Math.max(1, Math.min(100, Math.trunc(limit)))
  try {
    const withCode = await hasSupplierSkuColumn()
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "name", "sku", "supplier", "cost_price", "stock_count", "low_stock_threshold", "track_inventory",
             ${withCode ? Prisma.sql`"supplier_sku"` : Prisma.sql`NULL::text AS "supplier_sku"`}
        FROM "shp_products"
       WHERE "track_inventory" = true
         AND ("name" ILIKE ${like} OR "sku" ILIKE ${like})
       ORDER BY "name" ASC
       LIMIT ${Prisma.raw(String(capped))}
    `
    return rows.map(mapCatalogueProduct)
  } catch {
    return []
  }
}

function mapCatalogueProduct(r: Record<string, unknown>): ReorderCatalogueProduct {
  return {
    id: r.id as string,
    name: r.name as string,
    sku: (r.sku as string | null) ?? null,
    supplierSku: (r.supplier_sku as string | null) ?? null,
    supplier: (r.supplier as string | null) ?? null,
    costPrice: r.cost_price === null || r.cost_price === undefined ? null : String(r.cost_price),
    stockCount: r.stock_count === null || r.stock_count === undefined ? null : Number(r.stock_count),
    lowStockThreshold:
      r.low_stock_threshold === null || r.low_stock_threshold === undefined
        ? null
        : Number(r.low_stock_threshold),
    trackInventory: Boolean(r.track_inventory),
  }
}

// ---------------------------------------------------------------------------
// Everything the planner needs, in one go
// ---------------------------------------------------------------------------

/**
 * The facts behind a reorder run.
 *
 * Four queries and no more: the rules, the products they name, what is already
 * on its way, and what each supplier last charged for each of them. Doing this
 * per rule would be a query per product on a site with a thousand of them, run
 * nightly, for ever.
 */
export async function gatherReorderFacts(automatic: boolean): Promise<ReorderFacts> {
  const { hasCatalogue } = await getCapabilities()

  const ruleRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "product_id", "supplier_id", "reorder_point", "reorder_qty", "enabled", "last_suggested_at"
      FROM "po_reorder_rules"
     WHERE "enabled" = true
  `
  const rules: ReorderRuleRow[] = ruleRows.map((r) => ({
    id: r.id as string,
    productId: r.product_id as string,
    supplierId: (r.supplier_id as string | null) ?? null,
    reorderPoint: Number(r.reorder_point ?? 0),
    reorderQty: Number(r.reorder_qty ?? 0),
    enabled: Boolean(r.enabled),
    lastSuggestedAt: stamp(r.last_suggested_at),
  }))

  const productIds = [...new Set(rules.map((r) => r.productId))]

  const [products, suppliers, onOrder, lastCosts] = await Promise.all([
    hasCatalogue ? readProducts(productIds) : Promise.resolve({}),
    readSuppliers(),
    readOnOrder(productIds),
    readLastCosts(productIds),
  ])

  // Every supplier's lists, in one query. `catalogueCostsBySupplier` is itself
  // gated on the settings switch, so this is an empty object on the sites that
  // have not asked for price lists - and the planner falls straight back to what
  // the supplier last charged, exactly as it always has.
  const catalogueCosts = Object.fromEntries(await catalogueCostsBySupplier(suppliers.map((s) => s.id)))

  return { rules, products, suppliers, onOrder, lastCosts, automatic, catalogueCosts }
}

async function readProducts(ids: string[]): Promise<Record<string, ReorderProductFacts>> {
  if (ids.length === 0) return {}
  const withCode = await hasSupplierSkuColumn()
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "name", "sku", "supplier", "cost_price", "stock_count", "track_inventory",
             ${withCode ? Prisma.sql`"supplier_sku"` : Prisma.sql`NULL::text AS "supplier_sku"`}
        FROM "shp_products"
       WHERE "id" = ANY(${ids}::text[])
    `
    const out: Record<string, ReorderProductFacts> = {}
    for (const row of rows) {
      const mapped = mapCatalogueProduct(row)
      out[mapped.id] = {
        id: mapped.id,
        name: mapped.name,
        sku: mapped.sku,
        supplierSku: mapped.supplierSku,
        supplierName: mapped.supplier,
        costPrice: mapped.costPrice,
        stockCount: mapped.stockCount,
        trackInventory: mapped.trackInventory,
      }
    }
    return out
  } catch {
    return {}
  }
}

async function readSuppliers(): Promise<ReorderSupplierFacts[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "name", "name_key", "status", "currency", "minimum_order_value",
           "carriage_paid_over", "carriage_charge", "default_vat_rate_code"
      FROM "po_suppliers"
  `
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    nameKey: r.name_key as string,
    status: r.status as SupplierStatus,
    currency: r.currency as string,
    minimumOrderValue: r.minimum_order_value == null ? null : String(r.minimum_order_value),
    carriagePaidOver: r.carriage_paid_over == null ? null : String(r.carriage_paid_over),
    carriageCharge: r.carriage_charge == null ? null : String(r.carriage_charge),
    defaultVatRateCode: (r.default_vat_rate_code as string | null) ?? null,
  }))
}

/**
 * What is still expected in, per product.
 *
 * Ordered less cancelled less what has already been booked in, floored at zero
 * so an over-delivery on one line cannot quietly cancel out a shortage on
 * another. Only orders that still owe us something count.
 */
async function readOnOrder(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {}
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."product_id",
           SUM(GREATEST(
             l."qty" - l."qty_cancelled" - COALESCE((
               SELECT SUM(rl."qty_accepted") FROM "po_receipt_lines" rl WHERE rl."order_line_id" = l."id"
             ), 0), 0
           )) AS "on_order"
      FROM "po_order_lines" l
      JOIN "po_orders" o ON o."id" = l."order_id"
     WHERE l."product_id" = ANY(${ids}::text[])
       AND o."status" = ANY(${OPEN_ORDER_STATUSES}::text[])
     GROUP BY l."product_id"
  `
  const out: Record<string, number> = {}
  for (const row of rows) out[row.product_id as string] = Number(row.on_order ?? 0)
  return out
}

/**
 * The last price each supplier charged for each product, keyed
 * `<productId>::<supplierId>`.
 *
 * Per supplier, not per product: two suppliers stock the same chair at different
 * prices, and drafting one of them at the other's price is a bill that gets
 * queried a fortnight later. Falls back to the catalogue's own cost in the
 * planner when this comes up empty.
 *
 * Every supplier's history is kept rather than only the ones a rule names: a
 * rule with no supplier on it resolves to one by catalogue name in the planner,
 * and that supplier's own price is exactly the one worth having.
 */
async function readLastCosts(productIds: string[]): Promise<Record<string, ReorderLastCost>> {
  if (productIds.length === 0) return {}
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT DISTINCT ON (l."product_id", o."supplier_id")
           l."product_id", o."supplier_id", l."unit_cost", l."supplier_sku"
      FROM "po_order_lines" l
      JOIN "po_orders" o ON o."id" = l."order_id"
     WHERE l."product_id" = ANY(${productIds}::text[])
       AND o."status" <> 'CANCELLED'
     ORDER BY l."product_id", o."supplier_id", o."raised_date" DESC NULLS LAST, l."created_at" DESC
  `
  const out: Record<string, ReorderLastCost> = {}
  for (const row of rows) {
    out[`${row.product_id as string}::${row.supplier_id as string}`] = {
      unitCost: String(row.unit_cost ?? '0'),
      supplierSku: (row.supplier_sku as string | null) ?? null,
    }
  }
  return out
}
