import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { LINE_PROGRESS_SQL, receiptStatus } from './progress'
import { statusAfterReceipts } from './receiving'
import type {
  CatalogueProduct,
  PoRevisionSummary,
  PoOrder,
  PoOrderLine,
  PoOrderSummary,
  PoShipTo,
  PoStatus,
  PoSupplier,
  ShipToKind,
  SourceKind,
  SupplierStatus,
} from './types'
import type { PoAddress } from './config'
import { getCapabilities } from './capabilities'

// Everything here is raw SQL. This module owns po_ tables and reads nothing
// else's through Prisma's client, because the shop and bookkeeping models are
// simply not in the generated client on an install without those modules.

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** Postgres numerics arrive as Prisma.Decimal; a float round-trip loses pennies. */
function dec(value: unknown): string {
  if (value === null || value === undefined) return '0'
  return String(value)
}

function decOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
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

const EMPTY_ADDRESS: PoAddress = { line1: '', line2: '', city: '', region: '', postcode: '', country: '' }

function address(value: unknown): PoAddress {
  const raw = (value ?? {}) as Partial<PoAddress>
  return {
    line1: raw.line1 ?? '',
    line2: raw.line2 ?? '',
    city: raw.city ?? '',
    region: raw.region ?? '',
    postcode: raw.postcode ?? '',
    country: raw.country ?? '',
  }
}

function shipTo(value: unknown): PoShipTo {
  const raw = (value ?? {}) as Partial<PoShipTo>
  return {
    name: raw.name ?? '',
    contact: raw.contact ?? '',
    phone: raw.phone ?? '',
    address: address(raw.address),
    instructions: raw.instructions ?? '',
  }
}

function mapSupplier(r: Record<string, unknown>): PoSupplier {
  return {
    id: r.id as string,
    name: r.name as string,
    nameKey: r.name_key as string,
    shopSupplierId: (r.shop_supplier_id as string | null) ?? null,
    shopSupplierName: (r.shop_supplier_name as string | null) ?? null,
    accountNumber: (r.account_number as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    emailCc: (r.email_cc as string | null) ?? null,
    address: address(r.address),
    currency: r.currency as string,
    paymentTerms: (r.payment_terms as string | null) ?? null,
    paymentTermsDays: (r.payment_terms_days as number | null) ?? null,
    leadTimeDays: (r.lead_time_days as number | null) ?? null,
    minimumOrderValue: decOrNull(r.minimum_order_value),
    carriagePaidOver: decOrNull(r.carriage_paid_over),
    carriageCharge: decOrNull(r.carriage_charge),
    defaultCategoryId: (r.default_category_id as string | null) ?? null,
    defaultVatTreatment: (r.default_vat_treatment as string | null) ?? null,
    defaultVatRateCode: (r.default_vat_rate_code as string | null) ?? null,
    taxRegistrationNumber: (r.tax_registration_number as string | null) ?? null,
    deliveryInstructions: (r.delivery_instructions as string | null) ?? null,
    status: r.status as SupplierStatus,
    notes: (r.notes as string | null) ?? null,
    orderCount: Number(r.order_count ?? 0),
    shopLinkLive: Boolean(r.shop_link_live ?? false),
  }
}

function mapLine(r: Record<string, unknown>): PoOrderLine {
  return {
    id: r.id as string,
    position: Number(r.position ?? 0),
    productId: (r.product_id as string | null) ?? null,
    productName: (r.product_name as string | null) ?? null,
    supplierSku: (r.supplier_sku as string | null) ?? null,
    ourSku: (r.our_sku as string | null) ?? null,
    description: r.description as string,
    qty: dec(r.qty),
    unit: r.unit as string,
    unitCost: dec(r.unit_cost),
    discountPercent: decOrNull(r.discount_percent),
    taxRatePercent: dec(r.tax_rate_percent),
    taxRateCode: (r.tax_rate_code as string | null) ?? null,
    vatTreatment: (r.vat_treatment as string | null) ?? null,
    categoryId: (r.category_id as string | null) ?? null,
    lineTotal: dec(r.line_total),
    expectedDate: day(r.expected_date),
    qtyCancelled: dec(r.qty_cancelled),
    qtyReceived: dec(r.qty_received),
    qtyInvoiced: dec(r.qty_invoiced),
    qtyReturned: dec(r.qty_returned),
  }
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

/**
 * The normalised form of a supplier name.
 *
 * This is what makes the name unique, and it is also what matches shop's
 * free-text `shp_products.supplier` column when a catalogue is there to match
 * against. Case, surrounding space and repeated inner spaces are all noise -
 * "Northern Clay Co." and "northern clay  co." are one supplier, and letting
 * both exist is how two people end up raising half the orders each.
 */
export function supplierNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function listSuppliers(includeDisabled = true): Promise<PoSupplier[]> {
  const { hasCatalogue } = await getCapabilities()

  // The live-link probe only runs where shop's table actually exists. Written as
  // two whole queries rather than one with a conditional join, because the
  // second one does not parse at all on a site with no shp_suppliers table.
  const shopLink = hasCatalogue
    ? Prisma.sql`EXISTS (SELECT 1 FROM "shp_suppliers" ss WHERE ss."id" = s."shop_supplier_id")`
    : Prisma.sql`false`

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT s.*,
           (SELECT count(*) FROM "po_orders" o WHERE o."supplier_id" = s."id") AS "order_count",
           ${shopLink} AS "shop_link_live"
      FROM "po_suppliers" s
     ${includeDisabled ? Prisma.empty : Prisma.sql`WHERE s."status" = 'ENABLED'`}
     ORDER BY s."name" ASC
  `
  return rows.map(mapSupplier)
}

export async function getSupplier(id: string): Promise<PoSupplier | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT s.*,
           (SELECT count(*) FROM "po_orders" o WHERE o."supplier_id" = s."id") AS "order_count",
           false AS "shop_link_live"
      FROM "po_suppliers" s
     WHERE s."id" = ${id}
     LIMIT 1
  `
  return rows[0] ? mapSupplier(rows[0]) : null
}

export type SupplierInput = {
  name: string
  shopSupplierId: string | null
  shopSupplierName: string | null
  accountNumber: string | null
  contactName: string | null
  phone: string | null
  email: string | null
  emailCc: string | null
  address: PoAddress
  currency: string
  paymentTerms: string | null
  paymentTermsDays: number | null
  leadTimeDays: number | null
  minimumOrderValue: string | null
  carriagePaidOver: string | null
  carriageCharge: string | null
  defaultCategoryId: string | null
  defaultVatTreatment: string | null
  defaultVatRateCode: string | null
  taxRegistrationNumber: string | null
  deliveryInstructions: string | null
  status: SupplierStatus
  notes: string | null
}

export async function createSupplier(input: SupplierInput): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "po_suppliers" (
      "name", "name_key", "shop_supplier_id", "shop_supplier_name", "account_number",
      "contact_name", "phone", "email", "email_cc", "address", "currency",
      "payment_terms", "payment_terms_days", "lead_time_days", "minimum_order_value",
      "carriage_paid_over", "carriage_charge", "default_category_id",
      "default_vat_treatment", "default_vat_rate_code", "tax_registration_number",
      "delivery_instructions", "status", "notes"
    ) VALUES (
      ${input.name}, ${supplierNameKey(input.name)}, ${input.shopSupplierId}, ${input.shopSupplierName},
      ${input.accountNumber}, ${input.contactName}, ${input.phone}, ${input.email}, ${input.emailCc},
      ${JSON.stringify(input.address)}::jsonb, ${input.currency},
      ${input.paymentTerms}, ${input.paymentTermsDays}, ${input.leadTimeDays},
      ${input.minimumOrderValue}::numeric, ${input.carriagePaidOver}::numeric, ${input.carriageCharge}::numeric,
      ${input.defaultCategoryId}, ${input.defaultVatTreatment}, ${input.defaultVatRateCode},
      ${input.taxRegistrationNumber}, ${input.deliveryInstructions}, ${input.status}, ${input.notes}
    )
    RETURNING "id"
  `
  return rows[0]!.id
}

export async function updateSupplier(id: string, input: SupplierInput): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_suppliers" SET
      "name" = ${input.name},
      "name_key" = ${supplierNameKey(input.name)},
      "shop_supplier_id" = ${input.shopSupplierId},
      "shop_supplier_name" = ${input.shopSupplierName},
      "account_number" = ${input.accountNumber},
      "contact_name" = ${input.contactName},
      "phone" = ${input.phone},
      "email" = ${input.email},
      "email_cc" = ${input.emailCc},
      "address" = ${JSON.stringify(input.address)}::jsonb,
      "currency" = ${input.currency},
      "payment_terms" = ${input.paymentTerms},
      "payment_terms_days" = ${input.paymentTermsDays},
      "lead_time_days" = ${input.leadTimeDays},
      "minimum_order_value" = ${input.minimumOrderValue}::numeric,
      "carriage_paid_over" = ${input.carriagePaidOver}::numeric,
      "carriage_charge" = ${input.carriageCharge}::numeric,
      "default_category_id" = ${input.defaultCategoryId},
      "default_vat_treatment" = ${input.defaultVatTreatment},
      "default_vat_rate_code" = ${input.defaultVatRateCode},
      "tax_registration_number" = ${input.taxRegistrationNumber},
      "delivery_instructions" = ${input.deliveryInstructions},
      "status" = ${input.status},
      "notes" = ${input.notes},
      "updated_at" = now()
    WHERE "id" = ${id}
  `
}

/** Refuses while orders are filed against the supplier - the FK is ON DELETE RESTRICT anyway. */
export async function deleteSupplier(id: string): Promise<{ ok: boolean; reason?: string }> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS "count" FROM "po_orders" WHERE "supplier_id" = ${id}
  `
  if (Number(rows[0]?.count ?? 0) > 0) {
    return {
      ok: false,
      reason: 'There are purchase orders filed against this supplier. Set them to Disabled instead, which keeps the history and drops the name out of the list you pick from.',
    }
  }
  await prisma.$executeRaw`DELETE FROM "po_suppliers" WHERE "id" = ${id}`
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Cross-module reads, every one of them guarded
// ---------------------------------------------------------------------------

export type ShopSupplierRow = { id: string; name: string; email: string | null; accountNumber: string | null }

/** Shop's own supplier list, for the "link to shop supplier" picker. Empty without a catalogue. */
export async function listShopSuppliers(): Promise<ShopSupplierRow[]> {
  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) return []
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "name", "email", "account_number"
        FROM "shp_suppliers"
       ORDER BY "name" ASC
    `
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      email: (r.email as string | null) ?? null,
      accountNumber: (r.account_number as string | null) ?? null,
    }))
  } catch {
    // hasCatalogue only proves shp_products is there. A shop old enough to
    // predate its own supplier table degrades to "no shop suppliers to link to"
    // rather than turning the supplier screen into an error page.
    return []
  }
}

/**
 * Catalogue products for the line editor.
 *
 * `supplierNameKey` narrows to what one supplier sells, matched on the
 * normalised name - shop files products against a supplier by name, not by id.
 * Free-text lines are always available regardless; not everything a business
 * buys is in its own sales catalogue.
 */
export async function searchCatalogue(
  term: string,
  supplierNameKeyValue: string | null,
  limit = 25,
): Promise<CatalogueProduct[]> {
  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) return []

  const like = `%${term.trim()}%`
  const capped = Math.max(1, Math.min(100, Math.trunc(limit)))
  try {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "name", "sku", "supplier", "cost_price"
        FROM "shp_products"
       WHERE ("name" ILIKE ${like} OR "sku" ILIKE ${like})
         ${supplierNameKeyValue
           ? Prisma.sql`AND lower(regexp_replace(btrim(COALESCE("supplier", '')), '\\s+', ' ', 'g')) = ${supplierNameKeyValue}`
           : Prisma.empty}
       ORDER BY "name" ASC
       LIMIT ${Prisma.raw(String(capped))}
    `
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      sku: (r.sku as string | null) ?? null,
      supplier: (r.supplier as string | null) ?? null,
      costPrice: decOrNull(r.cost_price),
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderFilters = {
  status?: PoStatus | 'ALL' | 'OPEN'
  supplierId?: string
  search?: string
  limit?: number
  offset?: number
}

/** Everything that has not finished: the default view of a purchasing screen. */
const OPEN_STATUSES: PoStatus[] = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SENT',
  'ACKNOWLEDGED',
  'PART_RECEIVED',
  'ON_HOLD',
]

export async function listOrders(
  filters: OrderFilters = {},
): Promise<{ orders: PoOrderSummary[]; total: number }> {
  const where: Prisma.Sql[] = []

  if (filters.status === 'OPEN' || !filters.status) {
    where.push(Prisma.sql`o."status" = ANY(${OPEN_STATUSES}::text[])`)
  } else if (filters.status !== 'ALL') {
    where.push(Prisma.sql`o."status" = ${filters.status}`)
  }
  if (filters.supplierId) where.push(Prisma.sql`o."supplier_id" = ${filters.supplierId}`)
  if (filters.search?.trim()) {
    const like = `%${filters.search.trim()}%`
    where.push(Prisma.sql`(o."number" ILIKE ${like} OR s."name" ILIKE ${like} OR o."notes_internal" ILIKE ${like})`)
  }

  const whereSql = where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty
  const limit = Math.max(1, Math.min(200, Math.trunc(filters.limit ?? 50)))
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0))

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."id", o."number", o."revision", o."status", o."supplier_id", s."name" AS "supplier_name",
           o."currency", o."total", o."raised_date", o."required_by_date", o."expected_date",
           o."created_at",
           (SELECT count(*) FROM "po_order_lines" l WHERE l."order_id" = o."id") AS "line_count"
      FROM "po_orders" o
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     ${whereSql}
     ORDER BY o."created_at" DESC
     LIMIT ${Prisma.raw(String(limit))} OFFSET ${Prisma.raw(String(offset))}
  `
  const countRows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS "count"
      FROM "po_orders" o
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     ${whereSql}
  `

  return {
    orders: rows.map((r) => ({
      id: r.id as string,
      number: r.number as string,
      revision: Number(r.revision ?? 1),
      status: r.status as PoStatus,
      supplierId: r.supplier_id as string,
      supplierName: r.supplier_name as string,
      currency: r.currency as string,
      total: dec(r.total),
      raisedDate: day(r.raised_date),
      requiredByDate: day(r.required_by_date),
      expectedDate: day(r.expected_date),
      lineCount: Number(r.line_count ?? 0),
      createdAt: stamp(r.created_at) ?? '',
    })),
    total: Number(countRows[0]?.count ?? 0),
  }
}

export async function getOrder(id: string): Promise<PoOrder | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o.*, s."name" AS "supplier_name"
      FROM "po_orders" o
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     WHERE o."id" = ${id}
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null

  const lineRows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l.*, ${LINE_PROGRESS_SQL}
      FROM "po_order_lines" l
     WHERE l."order_id" = ${id}
     ORDER BY l."position" ASC, l."created_at" ASC
  `

  return {
    id: r.id as string,
    number: r.number as string,
    revision: Number(r.revision ?? 1),
    status: r.status as PoStatus,
    supplierId: r.supplier_id as string,
    supplierName: r.supplier_name as string,
    supplierSnapshot: (r.supplier_snapshot as Record<string, unknown> | null) ?? {},
    shipToKind: r.ship_to_kind as ShipToKind,
    shipTo: shipTo(r.ship_to),
    sourceKind: r.source_kind as SourceKind,
    sourceRef: (r.source_ref as Record<string, unknown> | null) ?? null,
    currency: r.currency as string,
    baseCurrency: r.base_currency as string,
    fxRate: dec(r.fx_rate),
    taxMode: r.tax_mode as 'EXCLUSIVE' | 'INCLUSIVE',
    subtotal: dec(r.subtotal),
    discountAmount: dec(r.discount_amount),
    carriageAmount: dec(r.carriage_amount),
    taxAmount: dec(r.tax_amount),
    total: dec(r.total),
    raisedDate: day(r.raised_date),
    requiredByDate: day(r.required_by_date),
    expectedDate: day(r.expected_date),
    paymentTerms: (r.payment_terms as string | null) ?? null,
    deliveryTerms: (r.delivery_terms as string | null) ?? null,
    notesSupplier: (r.notes_supplier as string | null) ?? null,
    notesInternal: (r.notes_internal as string | null) ?? null,
    approvalRequired: Boolean(r.approval_required),
    approvedByUserId: (r.approved_by_user_id as string | null) ?? null,
    approvedAt: stamp(r.approved_at),
    approvalNote: (r.approval_note as string | null) ?? null,
    sentAt: stamp(r.sent_at),
    acknowledgedAt: stamp(r.acknowledged_at),
    acknowledgedNote: (r.acknowledged_note as string | null) ?? null,
    cancelledAt: stamp(r.cancelled_at),
    cancelReason: (r.cancel_reason as string | null) ?? null,
    closedAt: stamp(r.closed_at),
    closeReason: (r.close_reason as string | null) ?? null,
    lineCount: lineRows.length,
    createdAt: stamp(r.created_at) ?? '',
    updatedAt: stamp(r.updated_at) ?? '',
    lines: lineRows.map(mapLine),
  }
}

export type OrderLineInput = {
  productId: string | null
  productName: string | null
  supplierSku: string | null
  ourSku: string | null
  description: string
  qty: string
  unit: string
  unitCost: string
  discountPercent: string | null
  taxRatePercent: string
  taxRateCode: string | null
  vatTreatment: string | null
  categoryId: string | null
  expectedDate: string | null
  qtyCancelled: string
}

export type OrderInput = {
  supplierId: string
  shipToKind: ShipToKind
  shipTo: PoShipTo
  currency: string
  baseCurrency: string
  fxRate: string
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE'
  discountAmount: string
  carriageAmount: string
  requiredByDate: string | null
  expectedDate: string | null
  paymentTerms: string | null
  deliveryTerms: string | null
  notesSupplier: string | null
  notesInternal: string | null
  lines: OrderLineInput[]
}

export type OrderTotalsPatch = {
  subtotal: string
  taxAmount: string
  total: string
  lineTotals: string[]
}

/** Where an order came from, for the orders that nobody typed.
 *
 *  Optional, and MANUAL when it is left off: every order raised by a person on
 *  the order screen is a manual one, and that is most of them. */
export type OrderSource = { kind: SourceKind; ref: Record<string, unknown> | null }

const MANUAL_SOURCE: OrderSource = { kind: 'MANUAL', ref: null }

// `userId` is nullable because the nightly reorder job has no user behind it.
// The column has always allowed it; nothing had ever needed it until something
// other than a person started raising orders.
export async function createOrder(
  number: string,
  input: OrderInput,
  totals: OrderTotalsPatch,
  approvalRequired: boolean,
  userId: string | null,
  source: OrderSource = MANUAL_SOURCE,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "po_orders" (
        "number", "status", "supplier_id", "ship_to_kind", "ship_to", "currency", "base_currency",
        "fx_rate", "tax_mode", "subtotal", "discount_amount", "carriage_amount", "tax_amount", "total",
        "raised_date", "required_by_date", "expected_date", "payment_terms", "delivery_terms",
        "notes_supplier", "notes_internal", "approval_required",
        "source_kind", "source_ref",
        "created_by_user_id", "updated_by_user_id"
      ) VALUES (
        ${number}, 'DRAFT', ${input.supplierId}, ${input.shipToKind}, ${JSON.stringify(input.shipTo)}::jsonb,
        ${input.currency}, ${input.baseCurrency}, ${input.fxRate}::numeric, ${input.taxMode},
        ${totals.subtotal}::numeric, ${input.discountAmount}::numeric, ${input.carriageAmount}::numeric,
        ${totals.taxAmount}::numeric, ${totals.total}::numeric,
        CURRENT_DATE, ${input.requiredByDate}::date, ${input.expectedDate}::date,
        ${input.paymentTerms}, ${input.deliveryTerms}, ${input.notesSupplier}, ${input.notesInternal},
        ${approvalRequired},
        ${source.kind}, ${source.ref === null ? null : JSON.stringify(source.ref)}::jsonb,
        ${userId}, ${userId}
      )
      RETURNING "id"
    `
    const orderId = rows[0]!.id
    await insertLines(tx, orderId, input.lines, totals.lineTotals)
    return orderId
  })
}

export async function updateOrder(
  id: string,
  input: OrderInput,
  totals: OrderTotalsPatch,
  approvalRequired: boolean,
  userId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "po_orders" SET
        "supplier_id" = ${input.supplierId},
        "ship_to_kind" = ${input.shipToKind},
        "ship_to" = ${JSON.stringify(input.shipTo)}::jsonb,
        "currency" = ${input.currency},
        "base_currency" = ${input.baseCurrency},
        "fx_rate" = ${input.fxRate}::numeric,
        "tax_mode" = ${input.taxMode},
        "subtotal" = ${totals.subtotal}::numeric,
        "discount_amount" = ${input.discountAmount}::numeric,
        "carriage_amount" = ${input.carriageAmount}::numeric,
        "tax_amount" = ${totals.taxAmount}::numeric,
        "total" = ${totals.total}::numeric,
        "required_by_date" = ${input.requiredByDate}::date,
        "expected_date" = ${input.expectedDate}::date,
        "payment_terms" = ${input.paymentTerms},
        "delivery_terms" = ${input.deliveryTerms},
        "notes_supplier" = ${input.notesSupplier},
        "notes_internal" = ${input.notesInternal},
        "approval_required" = ${approvalRequired},
        "updated_by_user_id" = ${userId},
        "updated_at" = now()
      WHERE "id" = ${id}
    `
    // Lines are replaced wholesale. Safe only while the order is still freely
    // editable: the route refuses past SENT, and a receipt's ON DELETE RESTRICT
    // on order_line_id is the belt to that braces.
    await tx.$executeRaw`DELETE FROM "po_order_lines" WHERE "order_id" = ${id}`
    await insertLines(tx, id, input.lines, totals.lineTotals)
  })
}

// The client a $transaction callback is handed. Taken off prisma's own type
// rather than Prisma.TransactionClient: the extended client this project builds
// is not assignable to the plain one.
type Tx = Pick<typeof prisma, '$executeRaw' | '$queryRaw'>

async function insertLines(
  tx: Tx,
  orderId: string,
  lines: OrderLineInput[],
  lineTotals: string[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await tx.$executeRaw`
      INSERT INTO "po_order_lines" (
        "order_id", "position", "product_id", "product_name", "supplier_sku", "our_sku",
        "description", "qty", "unit", "unit_cost", "discount_percent", "tax_rate_percent",
        "tax_rate_code", "vat_treatment", "category_id", "line_total", "expected_date", "qty_cancelled"
      ) VALUES (
        ${orderId}, ${index}, ${line.productId}, ${line.productName}, ${line.supplierSku}, ${line.ourSku},
        ${line.description}, ${line.qty}::numeric, ${line.unit}, ${line.unitCost}::numeric,
        ${line.discountPercent}::numeric, ${line.taxRatePercent}::numeric,
        ${line.taxRateCode}, ${line.vatTreatment}, ${line.categoryId},
        ${lineTotals[index] ?? '0'}::numeric, ${line.expectedDate}::date, ${line.qtyCancelled}::numeric
      )
    `
  }
}

export type StatusPatch = {
  approvedByUserId?: string | null
  approvedAt?: boolean
  approvalNote?: string | null
  sentAt?: boolean
  acknowledgedNote?: string | null
  cancelReason?: string | null
  closeReason?: string | null
}

/** The single write behind every lifecycle transition. Callers log the audit line. */
export async function setOrderStatus(
  id: string,
  to: PoStatus,
  patch: StatusPatch,
  userId: string,
): Promise<void> {
  const sets: Prisma.Sql[] = [
    Prisma.sql`"status" = ${to}`,
    Prisma.sql`"updated_by_user_id" = ${userId}`,
    Prisma.sql`"updated_at" = now()`,
  ]

  if (to === 'APPROVED') {
    sets.push(Prisma.sql`"approved_by_user_id" = ${userId}`, Prisma.sql`"approved_at" = now()`)
  }
  if (patch.approvalNote !== undefined) sets.push(Prisma.sql`"approval_note" = ${patch.approvalNote}`)
  if (to === 'SENT') sets.push(Prisma.sql`"sent_at" = COALESCE("sent_at", now())`)
  if (to === 'ACKNOWLEDGED') {
    sets.push(
      Prisma.sql`"acknowledged_at" = now()`,
      Prisma.sql`"acknowledged_note" = ${patch.acknowledgedNote ?? null}`,
    )
  }
  if (to === 'CANCELLED') {
    sets.push(Prisma.sql`"cancelled_at" = now()`, Prisma.sql`"cancel_reason" = ${patch.cancelReason ?? null}`)
  }
  if (to === 'CLOSED') {
    sets.push(Prisma.sql`"closed_at" = now()`, Prisma.sql`"close_reason" = ${patch.closeReason ?? null}`)
  }
  // Reopening has to clear the closure, or a reopened order still reads as
  // closed on every report that looks at closed_at rather than at status.
  if (to === 'RECEIVED') sets.push(Prisma.sql`"closed_at" = NULL`, Prisma.sql`"close_reason" = NULL`)

  await prisma.$executeRaw`
    UPDATE "po_orders" SET ${Prisma.join(sets, ', ')} WHERE "id" = ${id}
  `
}

export async function deleteOrder(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "po_orders" WHERE "id" = ${id}`
}

// ---------------------------------------------------------------------------
// The document: snapshots, revisions and who did what
// ---------------------------------------------------------------------------
//
// Everything below exists because a purchase order that has gone out is not a
// draft any more. What the supplier holds must stay readable exactly as they
// received it, whatever anybody renames, re-words or re-prices afterwards.

/** The wording an order was printed with, frozen at first send. Empty until then. */
export async function getOrderWording(id: string): Promise<Record<string, string>> {
  const rows = await prisma.$queryRaw<{ wording: unknown }[]>`
    SELECT "wording" FROM "po_orders" WHERE "id" = ${id} LIMIT 1
  `
  const raw = rows[0]?.wording
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** The supplier as the order froze them, or null where it never has. Read in
 *  preference to the live row: a supplier renamed or deleted after the order
 *  went out must not rewrite paperwork they are already holding. */
export async function getOrderSupplierSnapshot(id: string): Promise<Record<string, unknown> | null> {
  const rows = await prisma.$queryRaw<{ supplier_snapshot: unknown }[]>`
    SELECT "supplier_snapshot" FROM "po_orders" WHERE "id" = ${id} LIMIT 1
  `
  const raw = rows[0]?.supplier_snapshot
  if (!raw || typeof raw !== 'object' || Object.keys(raw as object).length === 0) return null
  return raw as Record<string, unknown>
}

/**
 * Freezes the supplier and the wording onto the order, and records who it went
 * to.
 *
 * Only ever writes the snapshots that are still empty (`= '{}'::jsonb`), so a
 * second send - an amendment, a re-send after a bounce - leaves the original
 * exactly as it was. `sent_to` appends, because who has been told is a list and
 * not a fact that gets replaced.
 */
export async function recordOrderSent(
  id: string,
  supplierSnapshot: Record<string, unknown>,
  wording: Record<string, string>,
  recipients: string[],
): Promise<void> {
  const entry = JSON.stringify([{ at: new Date().toISOString(), to: recipients }])
  await prisma.$executeRaw`
    UPDATE "po_orders" SET
      "supplier_snapshot" = CASE WHEN "supplier_snapshot" = '{}'::jsonb
        THEN ${JSON.stringify(supplierSnapshot)}::jsonb ELSE "supplier_snapshot" END,
      "wording" = CASE WHEN "wording" = '{}'::jsonb
        THEN ${JSON.stringify(wording)}::jsonb ELSE "wording" END,
      "sent_to" = COALESCE("sent_to", '[]'::jsonb) || ${entry}::jsonb,
      "updated_at" = now()
    WHERE "id" = ${id}
  `
}

/**
 * Files the order as it stands as revision N and moves the live order on to
 * N + 1.
 *
 * One statement each, inside one transaction, and the INSERT goes first: the
 * unique index on (order_id, revision) is what stops two people amending the
 * same order at the same moment and both writing revision 2.
 */
export async function bumpOrderRevision(
  id: string,
  snapshot: unknown,
  reason: string | null,
  userId: string,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ revision: number }[]>`
      SELECT "revision" FROM "po_orders" WHERE "id" = ${id} FOR UPDATE
    `
    const current = Number(rows[0]?.revision ?? 1)
    await tx.$executeRaw`
      INSERT INTO "po_revisions" ("order_id", "revision", "snapshot", "reason", "created_by_user_id")
      VALUES (${id}, ${current}, ${JSON.stringify(snapshot)}::jsonb, ${reason}, ${userId})
    `
    await tx.$executeRaw`
      UPDATE "po_orders" SET "revision" = ${current + 1}, "updated_at" = now() WHERE "id" = ${id}
    `
    return current + 1
  })
}

/** What this order looked like at each earlier revision. Newest first. */
export async function listOrderRevisions(id: string): Promise<PoRevisionSummary[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT r."id", r."revision", r."reason", r."created_by_user_id", r."created_at",
           COALESCE(u."displayName", u."username") AS "created_by_name"
      FROM "po_revisions" r
      LEFT JOIN "User" u ON u."id" = r."created_by_user_id"
     WHERE r."order_id" = ${id}
     ORDER BY r."revision" DESC
  `
  return rows.map((r) => ({
    id: r.id as string,
    revision: Number(r.revision ?? 0),
    reason: (r.reason as string | null) ?? null,
    createdByUserId: (r.created_by_user_id as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: stamp(r.created_at) ?? '',
  }))
}

/** Display names for a handful of user ids, in one round trip. A missing user -
 *  somebody who has since left - simply has no name, which prints as nothing
 *  rather than as an id nobody recognises. */
export async function userNames(ids: (string | null | undefined)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return {}
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", COALESCE("displayName", "username") AS "name"
      FROM "User" WHERE "id" = ANY(${wanted}::text[])
  `
  const out: Record<string, string> = {}
  for (const row of rows) out[row.id as string] = (row.name as string | null) ?? ''
  return out
}

/** Who raised the order, and who approved it - as ids, for `userNames`. */
export async function getOrderPeople(id: string): Promise<{ createdByUserId: string | null; approvedByUserId: string | null }> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "created_by_user_id", "approved_by_user_id" FROM "po_orders" WHERE "id" = ${id} LIMIT 1
  `
  return {
    createdByUserId: (rows[0]?.created_by_user_id as string | null) ?? null,
    approvedByUserId: (rows[0]?.approved_by_user_id as string | null) ?? null,
  }
}

/** One order, found by its number rather than its id - which is what the public
 *  document page has in the URL. */
export async function getOrderIdByNumber(number: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "po_orders" WHERE "number" = ${number} LIMIT 1
  `
  return rows[0]?.id ?? null
}

/**
 * The shop's own trading identity, where a shop is installed.
 *
 * Read by raw SQL out of shp_settings' JSON column, never by importing the shop
 * module: those files do not exist at build time on an install without it. Used
 * only as a FALLBACK for this module's own organisation settings, so nobody has
 * to type their VAT number into two screens and keep the two in step by hand.
 */
export async function shopTradingIdentity(): Promise<Record<string, string> | null> {
  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) return null
  try {
    const rows = await prisma.$queryRaw<{ config: unknown }[]>`
      SELECT "config" FROM "shp_settings" WHERE "id" = 'singleton' LIMIT 1
    `
    const raw = rows[0]?.config
    if (!raw || typeof raw !== 'object') return null
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    // A shop old enough to predate its own settings table degrades to "no
    // fallback identity", not to an error page on somebody's document.
    return null
  }
}

/**
 * Brings an order's status back in line with what has actually turned up.
 *
 * The one status change in this module that no human asks for. Every other one
 * goes through the transition route, which is guarded by lib/lifecycle.ts and
 * writes its own audit line; this one is arithmetic - a line's worth of goods
 * arrived, so the order is now part received - and it is written here beside
 * `setOrderStatus` rather than anywhere clever, so there is still exactly one
 * file that writes `po_orders.status`.
 *
 * Returns the new status when it moved, or null when it did not, which is what
 * the caller logs.
 */
export async function syncOrderReceiptStatus(
  orderId: string,
  userId: string,
): Promise<PoStatus | null> {
  const order = await getOrder(orderId)
  if (!order) return null

  const computed = receiptStatus(
    order.lines.map((line) => ({
      qty: line.qty,
      qtyCancelled: line.qtyCancelled,
      qtyReceived: line.qtyReceived,
    })),
  )
  const next = statusAfterReceipts(order.status, computed, Boolean(order.acknowledgedAt))
  if (!next) return null

  await setOrderStatus(orderId, next, {}, userId)
  return next
}

/**
 * Cancels the balance of one order line.
 *
 * Its own operation rather than part of an edit, because by the time anybody
 * wants it the order is usually part received - and `updateOrder` replaces every
 * line wholesale, which a line with a delivery against it will not allow (and
 * should not). Nothing is deleted: the quantity ordered stays as it was, the
 * cancelled quantity rises to meet it, and the line stops being outstanding.
 *
 * `qtyCancelled` is clamped so it can never exceed what was ordered, nor fall
 * below what has already arrived - a line cannot be cancelled out from under a
 * delivery that is sitting in the yard.
 */
export async function cancelOrderLineBalance(
  orderId: string,
  lineId: string,
  userId: string,
): Promise<{ ok: boolean; reason?: string; qtyCancelled?: string }> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT l."id", l."qty", l."qty_cancelled", ${LINE_PROGRESS_SQL}
      FROM "po_order_lines" l
     WHERE l."id" = ${lineId} AND l."order_id" = ${orderId}
     LIMIT 1
  `
  const row = rows[0]
  if (!row) return { ok: false, reason: 'That line is not on this order any more.' }

  const qty = Number(row.qty)
  const received = Number(row.qty_received ?? 0)
  const alreadyCancelled = Number(row.qty_cancelled ?? 0)
  const target = Math.max(0, qty - received)

  if (target <= alreadyCancelled) {
    return { ok: false, reason: 'There is nothing outstanding on that line to cancel.' }
  }

  const cancelled = target.toFixed(3)
  await prisma.$executeRaw`
    UPDATE "po_order_lines"
       SET "qty_cancelled" = ${cancelled}::numeric, "updated_at" = now()
     WHERE "id" = ${lineId} AND "order_id" = ${orderId}
  `
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "updated_by_user_id" = ${userId}, "updated_at" = now() WHERE "id" = ${orderId}
  `
  return { ok: true, qtyCancelled: cancelled }
}
