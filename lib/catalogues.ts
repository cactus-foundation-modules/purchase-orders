import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getCapabilities } from './capabilities'
import { getPoConfigCached } from './config'
import { catalogueNameKey, catalogueSkuKey, type CatalogueImportItem } from './catalogue-import'
import type { ShopProductForSupplier } from './catalogue-matching'
import type { CatalogueProduct, PoCatalogueCost, PoCatalogueItem, PoSupplierCatalogue } from './types'

// Every read and write behind supplier price lists, in raw SQL as the rest of
// this module is.
//
// The shop half is guarded by `hasCatalogue` every single time and returns
// nothing rather than throwing, exactly as lib/reorder.ts does: a site with no
// shop still has these tables, may still have lists in them from before the
// shop was removed, and must still be able to open the tab and tidy them up.
// Nothing here imports from '@/modules/shop/...'.

function stamp(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function day(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function num(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function mapCatalogue(r: Record<string, unknown>): PoSupplierCatalogue {
  return {
    id: r.id as string,
    supplierId: r.supplier_id as string,
    supplierName: (r.supplier_name as string | null) ?? 'A supplier no longer on your list',
    name: r.name as string,
    nameKey: r.name_key as string,
    sourceUrl: text(r.source_url),
    shopCatalogueId: text(r.shop_catalogue_id),
    shopCatalogueName: text(r.shop_catalogue_name),
    currency: (r.currency as string | null) ?? 'GBP',
    effectiveFrom: day(r.effective_from),
    lastImportedAt: stamp(r.last_imported_at),
    itemCount: Number(r.item_count ?? 0),
    notes: text(r.notes),
    createdAt: stamp(r.created_at) ?? '',
    updatedAt: stamp(r.updated_at) ?? '',
  }
}

function mapItem(r: Record<string, unknown>): PoCatalogueItem {
  return {
    id: r.id as string,
    catalogueId: r.catalogue_id as string,
    supplierSku: r.supplier_sku as string,
    supplierSkuKey: r.supplier_sku_key as string,
    description: (r.description as string | null) ?? '',
    unitCost: num(r.unit_cost),
    packSize: num(r.pack_size),
    minimumOrderQty: num(r.minimum_order_qty),
    leadTimeDays: r.lead_time_days == null ? null : Number(r.lead_time_days),
    discountGroup: text(r.discount_group),
    discontinued: Boolean(r.discontinued),
  }
}

// ---------------------------------------------------------------------------
// The lists themselves
// ---------------------------------------------------------------------------

export async function listCatalogues(supplierId?: string | null): Promise<PoSupplierCatalogue[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT c.*, s."name" AS "supplier_name"
      FROM "po_supplier_catalogues" c
      LEFT JOIN "po_suppliers" s ON s."id" = c."supplier_id"
     ${supplierId ? Prisma.sql`WHERE c."supplier_id" = ${supplierId}` : Prisma.empty}
     ORDER BY s."name" ASC, c."name" ASC
  `
  return rows.map(mapCatalogue)
}

export async function getCatalogue(id: string): Promise<PoSupplierCatalogue | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT c.*, s."name" AS "supplier_name"
      FROM "po_supplier_catalogues" c
      LEFT JOIN "po_suppliers" s ON s."id" = c."supplier_id"
     WHERE c."id" = ${id}
     LIMIT 1
  `
  return rows[0] ? mapCatalogue(rows[0]) : null
}

export type CatalogueInput = {
  supplierId: string
  name: string
  sourceUrl: string | null
  shopCatalogueId: string | null
  shopCatalogueName: string | null
  currency: string
  effectiveFrom: string | null
  notes: string | null
}

export async function createCatalogue(input: CatalogueInput, userId?: string | null): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "po_supplier_catalogues"
      ("supplier_id", "name", "name_key", "source_url", "shop_catalogue_id", "shop_catalogue_name",
       "currency", "effective_from", "notes", "created_by_user_id")
    VALUES
      (${input.supplierId}, ${input.name}, ${catalogueNameKey(input.name)}, ${input.sourceUrl},
       ${input.shopCatalogueId}, ${input.shopCatalogueName}, ${input.currency},
       ${input.effectiveFrom}::date, ${input.notes}, ${userId ?? null})
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function updateCatalogue(id: string, input: CatalogueInput): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_supplier_catalogues" SET
      "supplier_id"         = ${input.supplierId},
      "name"                = ${input.name},
      "name_key"            = ${catalogueNameKey(input.name)},
      "source_url"          = ${input.sourceUrl},
      "shop_catalogue_id"   = ${input.shopCatalogueId},
      "shop_catalogue_name" = ${input.shopCatalogueName},
      "currency"            = ${input.currency},
      "effective_from"      = ${input.effectiveFrom}::date,
      "notes"               = ${input.notes},
      "updated_at"          = now()
    WHERE "id" = ${id}
  `
}

/** Deleting a list takes its rows with it - the cascade in 004. Nothing else
 *  points at either table, and an order already drafted off a list keeps the
 *  price it was drafted at: the figure was copied onto the line, not looked up. */
export async function deleteCatalogue(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "po_supplier_catalogues" WHERE "id" = ${id}`
}

/** Thrown up as a 409 by the route: one name per supplier. */
export function isDuplicateCatalogueName(error: unknown): boolean {
  return error instanceof Error && error.message.includes('po_supplier_catalogues_supplier_name_unique')
}

// ---------------------------------------------------------------------------
// The rows of a list
// ---------------------------------------------------------------------------

/** How many rows go into one INSERT. Postgres takes tens of thousands of
 *  parameters, but a single statement carrying fifty thousand rows is a
 *  statement nothing can report progress on and nothing can recover from. */
const INSERT_CHUNK = 500

export async function listCatalogueItems(catalogueId: string, term = '', limit = 200): Promise<PoCatalogueItem[]> {
  const like = `%${term.trim()}%`
  const capped = Math.max(1, Math.min(1000, Math.trunc(limit)))
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "po_catalogue_items"
     WHERE "catalogue_id" = ${catalogueId}
       ${term.trim() === '' ? Prisma.empty : Prisma.sql`AND ("supplier_sku" ILIKE ${like} OR "description" ILIKE ${like})`}
     ORDER BY "supplier_sku" ASC
     LIMIT ${Prisma.raw(String(capped))}
  `
  return rows.map(mapItem)
}

/** Every row of a list, in the shape `diffCatalogue` compares. The whole list
 *  and not a page of it: a comparison over half the codes would report the other
 *  half as removed. */
export async function readCatalogueForDiff(
  catalogueId: string,
): Promise<Array<Pick<PoCatalogueItem, 'supplierSku' | 'supplierSkuKey' | 'description' | 'unitCost' | 'discontinued'>>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "supplier_sku", "supplier_sku_key", "description", "unit_cost", "discontinued"
      FROM "po_catalogue_items"
     WHERE "catalogue_id" = ${catalogueId}
  `
  return rows.map((r) => ({
    supplierSku: r.supplier_sku as string,
    supplierSkuKey: r.supplier_sku_key as string,
    description: (r.description as string | null) ?? '',
    unitCost: num(r.unit_cost),
    discontinued: Boolean(r.discontinued),
  }))
}

/**
 * Swap a list's rows for the ones that just arrived.
 *
 * Delete then insert, all of it in one transaction, and deliberately not a
 * merge. A price list is a statement about the whole range on the day it was
 * published: merging keeps last year's codes alive forever, which is the exact
 * failure these tables exist to prevent. The transaction is what stops a failed
 * import leaving a supplier with no prices at all.
 *
 * `last_imported_at` and `item_count` are stamped in the same transaction as the
 * rows, so the figure on the screen cannot disagree with what is in the table.
 */
export async function replaceCatalogueItems(catalogueId: string, items: CatalogueImportItem[]): Promise<void> {
  const statements: Prisma.PrismaPromise<unknown>[] = [
    prisma.$executeRaw`DELETE FROM "po_catalogue_items" WHERE "catalogue_id" = ${catalogueId}`,
  ]

  for (let at = 0; at < items.length; at += INSERT_CHUNK) {
    const chunk = items.slice(at, at + INSERT_CHUNK)
    const values = chunk.map(
      (item) => Prisma.sql`(
        ${catalogueId}, ${item.supplierSku}, ${item.supplierSkuKey}, ${item.description},
        ${item.unitCost}::numeric, ${item.packSize}::numeric, ${item.minimumOrderQty}::numeric,
        ${item.leadTimeDays}, ${item.discountGroup}, ${item.discontinued}
      )`,
    )
    statements.push(prisma.$executeRaw`
      INSERT INTO "po_catalogue_items"
        ("catalogue_id", "supplier_sku", "supplier_sku_key", "description",
         "unit_cost", "pack_size", "minimum_order_qty", "lead_time_days", "discount_group", "discontinued")
      VALUES ${Prisma.join(values)}
    `)
  }

  statements.push(prisma.$executeRaw`
    UPDATE "po_supplier_catalogues"
       SET "last_imported_at" = now(), "item_count" = ${items.length}, "updated_at" = now()
     WHERE "id" = ${catalogueId}
  `)

  await prisma.$transaction(statements)
}

// ---------------------------------------------------------------------------
// What a list is FOR: pricing a line
// ---------------------------------------------------------------------------

/**
 * Everything one supplier is currently selling, keyed by normalised code.
 *
 * The one choke point for price lists affecting anything. With
 * `supplierCatalogues` switched off this returns an empty map and every caller
 * falls back to the shop's own `cost_price` exactly as it did before - which is
 * why nothing anywhere else asks whether the feature is on.
 *
 * A code in two of a supplier's lists resolves to the one imported most
 * recently. That is the list somebody has just been handed, and a price from
 * last spring beating one from this morning is not an answer anybody wants.
 */
export async function catalogueCostsForSupplier(supplierId: string): Promise<Map<string, PoCatalogueCost>> {
  const all = await catalogueCostsBySupplier([supplierId])
  const out = new Map<string, PoCatalogueCost>()
  for (const [key, cost] of all) {
    const [owner, code] = splitCostKey(key)
    if (owner === supplierId) out.set(code, cost)
  }
  return out
}

/** The key a multi-supplier lookup is held under. Two suppliers stocking the
 *  same manufacturer's code at two prices is the ordinary case, not the odd
 *  one, so a bare code is never enough to price a line with. */
export function costKey(supplierId: string, supplierSkuKey: string): string {
  return `${supplierId}::${supplierSkuKey}`
}

function splitCostKey(key: string): [string, string] {
  const at = key.indexOf('::')
  return [key.slice(0, at), key.slice(at + 2)]
}

/**
 * The same lookup across several suppliers at once, keyed by `costKey`.
 *
 * One query for a whole customer order, however many suppliers it fans out to -
 * the same discipline `gatherReorderFacts` follows, and for the same reason: a
 * query per supplier per order is a query per supplier per order forever.
 */
export async function catalogueCostsBySupplier(supplierIds: string[]): Promise<Map<string, PoCatalogueCost>> {
  const out = new Map<string, PoCatalogueCost>()
  if (supplierIds.length === 0) return out

  const { supplierCatalogues } = await getPoConfigCached()
  if (!supplierCatalogues) return out

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT DISTINCT ON (c."supplier_id", i."supplier_sku_key")
           c."supplier_id", i."supplier_sku_key", i."supplier_sku", i."description", i."unit_cost",
           i."discontinued", i."lead_time_days", i."minimum_order_qty",
           c."id" AS "catalogue_id", c."name" AS "catalogue_name"
      FROM "po_catalogue_items" i
      JOIN "po_supplier_catalogues" c ON c."id" = i."catalogue_id"
     WHERE c."supplier_id" = ANY(${supplierIds}::text[])
     ORDER BY c."supplier_id", i."supplier_sku_key", c."last_imported_at" DESC NULLS LAST, c."created_at" DESC
  `

  for (const r of rows) {
    out.set(costKey(r.supplier_id as string, r.supplier_sku_key as string), {
      catalogueId: r.catalogue_id as string,
      catalogueName: r.catalogue_name as string,
      supplierSku: r.supplier_sku as string,
      description: (r.description as string | null) ?? '',
      unitCost: num(r.unit_cost),
      discontinued: Boolean(r.discontinued),
      leadTimeDays: r.lead_time_days == null ? null : Number(r.lead_time_days),
      minimumOrderQty: num(r.minimum_order_qty),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Cross-module reads, every one of them guarded
// ---------------------------------------------------------------------------

/** One of shop's own catalogue bookmarks, offered when a list is being set up.
 *
 *  The direction is deliberate: purchasing picks FROM shop's list rather than
 *  shop pointing at purchasing. Shop stays the one place a supplier's
 *  catalogues are recorded, no shop code changes, and nothing in shop ends up
 *  knowing this module exists. */
export type ShopCatalogueRow = { id: string; supplierId: string; name: string; sheetUrl: string | null }

export async function listShopCatalogues(shopSupplierId: string | null): Promise<ShopCatalogueRow[]> {
  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue || !shopSupplierId) return []
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "supplier_id", "name", "sheet_url"
        FROM "shp_supplier_catalogues"
       WHERE "supplier_id" = ${shopSupplierId}
       ORDER BY "position" ASC, "name" ASC
    `
    return rows.map((r) => ({
      id: r.id as string,
      supplierId: r.supplier_id as string,
      name: r.name as string,
      sheetUrl: text(r.sheet_url),
    }))
  } catch {
    // hasCatalogue only proves shp_products is there. A shop old enough to
    // predate its own catalogue table degrades to "nothing to pick from", and
    // the form still takes a pasted address.
    return []
  }
}

/** Whether shop's product table has the supplier's own code on it yet.
 *
 *  `supplier_sku` arrived in shop v0.1.356. On anything older the column is
 *  simply absent, and selecting it would throw - so it is probed once rather
 *  than assumed, and the comparison falls back to our own SKU, which is what a
 *  supplier who has never sent us a code reads it as anyway. */
let supplierSkuColumn: { value: boolean; at: number } | null = null
const COLUMN_TTL_MS = 30_000

export async function hasSupplierSkuColumn(): Promise<boolean> {
  if (supplierSkuColumn && Date.now() - supplierSkuColumn.at < COLUMN_TTL_MS) return supplierSkuColumn.value
  try {
    const rows = await prisma.$queryRaw<{ present: bigint }[]>`
      SELECT count(*) AS "present"
        FROM information_schema.columns
       WHERE "table_schema" = 'public'
         AND "table_name" = 'shp_products'
         AND "column_name" = 'supplier_sku'
    `
    const value = Number(rows[0]?.present ?? 0) > 0
    supplierSkuColumn = { value, at: Date.now() }
    return value
  } catch {
    return false
  }
}

/**
 * Every product the shop files under this supplier's name, for the comparison.
 *
 * Matched on the normalised supplier name, the same join `searchCatalogue` and
 * the from-order planner use - shop links products to a supplier by name, not
 * by id. Variation children are included and deliberately so: a child row IS a
 * product row, it carries its own code and its own cost, and it is what an
 * order line actually points at.
 */
export async function listShopProductsForSupplier(supplierNameKeyValue: string): Promise<ShopProductForSupplier[]> {
  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) return []

  const withCode = await hasSupplierSkuColumn()
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "name", "sku", "cost_price",
             ${withCode ? Prisma.sql`"supplier_sku"` : Prisma.sql`NULL::text AS "supplier_sku"`}
        FROM "shp_products"
       WHERE lower(regexp_replace(btrim(COALESCE("supplier", '')), '\\s+', ' ', 'g')) = ${supplierNameKeyValue}
       ORDER BY "name" ASC
    `
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      sku: text(r.sku),
      supplierSku: text(r.supplier_sku),
      costPrice: num(r.cost_price),
    }))
  } catch {
    return []
  }
}

/**
 * The supplier's current price over the shop's own cost, where they have one.
 *
 * The overlay is applied at the edge - the route, once, with the supplier
 * known - rather than inside the product search, so there is exactly one place
 * to look when a line comes out at a price somebody did not expect. An empty
 * map (which is what a site with the feature switched off always gets) leaves
 * every product exactly as the shop described it.
 */
export function applyCatalogueCosts(
  products: CatalogueProduct[],
  costs: Map<string, PoCatalogueCost>,
): CatalogueProduct[] {
  if (costs.size === 0) return products
  return products.map((product) => {
    const code = product.supplierSku?.trim() || product.sku?.trim() || ''
    if (code === '') return product
    const cost = costs.get(catalogueSkuKey(code))
    if (!cost || cost.unitCost == null) return product
    return {
      ...product,
      supplierSku: product.supplierSku ?? cost.supplierSku,
      costPrice: cost.unitCost,
      costSource: 'CATALOGUE',
      catalogueName: cost.catalogueName,
      discontinued: cost.discontinued,
    }
  })
}
