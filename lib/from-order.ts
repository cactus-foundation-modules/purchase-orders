import { prisma } from '@/lib/db/prisma'
import { getCapabilities } from './capabilities'
import { catalogueSkuKey } from './catalogue-import'
import { catalogueCostsBySupplier, costKey } from './catalogues'
import { reorderNameKey, reorderTaxRate, type ReorderSupplierFacts } from './reordering'
import { fromPence, scaled } from './totals'
import type { PoCatalogueCost, PoCostSource, PoShipTo, PoStatus } from './types'

// Everything needed to turn one customer order into purchase orders, and
// nothing that writes.
//
// The customer order is read by RAW SQL and nothing here imports from
// '@/modules/shop/...'. That path does not exist at build time on an install
// without a shop, and a static import would break that build. Every read is
// guarded by `hasCatalogue` and every one of them degrades to "no shop" rather
// than throwing: this module is standalone and stays that way.
//
// The arithmetic and the mapping are pure functions taking facts, so the tests
// pin them without a database - the same split lib/reorder.ts and
// lib/reordering.ts already use.

/** Purchase order statuses that count as a live attempt at this customer order.
 *
 *  Everything except CANCELLED. A cancelled PO is a decision to buy this
 *  differently, so it must not stand in the way of raising the order again;
 *  anything else still owes the customer their goods. */
const LIVE_STATUSES: PoStatus[] = [
  'DRAFT',
  'AWAITING_APPROVAL',
  'APPROVED',
  'SENT',
  'ACKNOWLEDGED',
  'PART_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'ON_HOLD',
]

// ---------------------------------------------------------------------------
// The facts, read at arm's length
// ---------------------------------------------------------------------------

/** One line of the customer's order, joined to the product it names.
 *
 *  A variation child IS a product row - shop's `svr_variants.child_product_id`
 *  points at `shp_products.id` - and an order item points at the child, so the
 *  code, the supplier and the cost all resolve on one join with no special case
 *  for variants. */
export type ShopOrderItemFacts = {
  itemId: string
  productId: string | null
  productName: string
  quantity: number
  /** What the customer paid, per unit. Recorded for the screen and NEVER used
   *  as a purchase cost - see `costPrice`. */
  unitPrice: string
  sku: string | null
  supplierSku: string | null
  /** The free-text supplier name the catalogue files this product under. */
  supplierName: string | null
  costPrice: string | null
  lineMeta: Record<string, unknown> | null
}

export type ShopOrderFacts = {
  id: string
  orderNumber: string
  status: string
  customerName: string
  customerPhone: string | null
  currency: string
  shippingAddress: Record<string, unknown> | null
  items: ShopOrderItemFacts[]
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function numOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function bag(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * One customer order and its lines, or null when there is no shop, no such
 * order, or the shop was uninstalled between the capability probe and the read.
 */
export async function readShopOrder(orderId: string): Promise<ShopOrderFacts | null> {
  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) return null

  try {
    const orders = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "order_number", "status", "customer_name", "customer_phone", "currency", "shipping_address"
        FROM "shp_orders"
       WHERE "id" = ${orderId}
       LIMIT 1
    `
    const order = orders[0]
    if (!order) return null

    // `supplier_sku` arrived in shop v0.1.356 - the same release that added the
    // `shop.order-detail-panels` point this module's panel hangs off. A shop old
    // enough to lack the column is a shop with no point to render us on, so the
    // two cannot come apart; the catch below is the belt to that braces.
    //
    // LEFT JOIN, not a plain one: a product deleted since the order was placed
    // leaves the item with a null product_id, and that line has to be REPORTED
    // rather than quietly left out of the purchase order.
    const items = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT oi."id", oi."product_id", oi."product_name", oi."quantity", oi."unit_price", oi."line_meta",
             p."sku", p."supplier_sku", p."supplier", p."cost_price"
        FROM "shp_order_items" oi
        LEFT JOIN "shp_products" p ON p."id" = oi."product_id"
       WHERE oi."order_id" = ${orderId}
       ORDER BY oi."product_name" ASC
    `

    return {
      id: order.id as string,
      orderNumber: order.order_number as string,
      status: order.status as string,
      customerName: (order.customer_name as string | null) ?? '',
      customerPhone: textOrNull(order.customer_phone),
      currency: (order.currency as string | null) ?? 'GBP',
      shippingAddress: bag(order.shipping_address),
      items: items.map((r) => ({
        itemId: r.id as string,
        productId: (r.product_id as string | null) ?? null,
        productName: (r.product_name as string | null) ?? '',
        quantity: Number(r.quantity ?? 0),
        unitPrice: numOrNull(r.unit_price) ?? '0',
        sku: textOrNull(r.sku),
        supplierSku: textOrNull(r.supplier_sku),
        supplierName: textOrNull(r.supplier),
        costPrice: numOrNull(r.cost_price),
        lineMeta: bag(r.line_meta),
      })),
    }
  } catch {
    return null
  }
}

/** The supplier list, in the shape the planner and the reorder arithmetic both
 *  want. Same columns as the reorder run reads, so one supplier cannot be
 *  zero-rated on a reorder and standard-rated here. */
export async function readSuppliersForOrder(): Promise<ReorderSupplierFacts[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "name", "name_key", "status", "currency", "minimum_order_value",
           "carriage_paid_over", "carriage_charge", "default_vat_rate_code"
      FROM "po_suppliers"
  `
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    nameKey: r.name_key as string,
    status: r.status as ReorderSupplierFacts['status'],
    currency: r.currency as string,
    minimumOrderValue: numOrNull(r.minimum_order_value),
    carriagePaidOver: numOrNull(r.carriage_paid_over),
    carriageCharge: numOrNull(r.carriage_charge),
    defaultVatRateCode: textOrNull(r.default_vat_rate_code),
  }))
}

/** A purchase order already raised off this customer order. */
export type PoRaisedFromShopOrder = {
  id: string
  number: string
  status: PoStatus
  supplierId: string
  supplierName: string
  currency: string
  total: string
  createdAt: string
}

/**
 * Every purchase order ever raised off this customer order, cancelled ones
 * included - the panel lists them all, and only the live ones block a re-raise.
 */
export async function listPosForShopOrder(orderId: string): Promise<PoRaisedFromShopOrder[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."id", o."number", o."status", o."supplier_id", o."currency", o."total", o."created_at",
           s."name" AS "supplier_name"
      FROM "po_orders" o
      LEFT JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     WHERE o."source_kind" = 'FROM_ORDER'
       AND o."source_ref"->>'orderId' = ${orderId}
     ORDER BY o."created_at" ASC
  `
  return rows.map((r) => ({
    id: r.id as string,
    number: r.number as string,
    status: r.status as PoStatus,
    supplierId: r.supplier_id as string,
    supplierName: (r.supplier_name as string | null) ?? 'A supplier no longer on your list',
    currency: r.currency as string,
    total: numOrNull(r.total) ?? '0',
    createdAt: (r.created_at as Date).toISOString(),
  }))
}

/** The ones that stand in the way of raising this order again. */
export function livePos(raised: PoRaisedFromShopOrder[]): PoRaisedFromShopOrder[] {
  return raised.filter((po) => LIVE_STATUSES.includes(po.status))
}

// ---------------------------------------------------------------------------
// The delivery service, read off the line the shop actually stored
// ---------------------------------------------------------------------------

/** The label a delivery charge is filed under on a shop line. Matched without
 *  regard to case; anything else on the line is somebody else's charge and is
 *  not carriage we are buying back. */
const DELIVERY_LABEL = 'delivery'

/** "3 September 2026". Pinned to en-GB rather than left to the runtime: this
 *  wording is written into a purchase order and read by a supplier. */
function formatServiceDate(value: string): string | null {
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/**
 * The service this line has to be sent on, in words a supplier can act on.
 *
 * Built from the resolver's own snapshot in `line_meta.data.ashDelivery`, which
 * is the immutable record of what was bought. It is emphatically NOT built from
 * `line_meta.batch.uniformHeading` or from `fields[].value`: shop re-resolves
 * both of those against current configuration when the payment lands, so a
 * purchase order quoting either could name a service the customer never bought.
 *
 * Duck-typed rather than imported. Advanced shipping is an optional module and
 * this one names no other module's code, so anything publishing a service name
 * under that key is read and anything else is simply absent.
 */
export function serviceNameFor(lineMeta: Record<string, unknown> | null): string | null {
  const data = bag(lineMeta?.data)
  const state = bag(data?.ashDelivery)
  const tierText = textOrNull(state?.tierText)
  if (!tierText) return null

  const targetDate = textOrNull(state?.targetDate)
  const when = targetDate ? formatServiceDate(targetDate) : null
  const text = when ? `${tierText}, expected ${when}` : tierText
  // The column is TEXT, but the order form caps a typed service at 200 and a
  // sentence longer than that has stopped being an instruction anyway.
  return text.length > 200 ? `${text.slice(0, 197)}...` : text
}

/**
 * What that service costs us, per unit, to four decimal places.
 *
 * `line_meta.charges` is per unit and unclamped by design - the true cost of the
 * service for one of them, which is exactly the figure to buy it back at. Null
 * on every order placed before shop began persisting charges, and on orders
 * converted from a quote, which build their line meta from scratch. That is a
 * degradation and not an error: the service NAME is the part the supplier acts
 * on, and it survives.
 */
export function serviceCostFor(lineMeta: Record<string, unknown> | null): string | null {
  const charges = lineMeta?.charges
  if (!Array.isArray(charges)) return null
  for (const raw of charges) {
    const charge = bag(raw)
    if (!charge) continue
    if (String(charge.label ?? '').trim().toLowerCase() !== DELIVERY_LABEL) continue
    // `base` is the figure before any attribution where a resolver ever
    // publishes one; `amount` is what every resolver publishes today.
    const value = Number(charge.base ?? charge.amount)
    if (!Number.isFinite(value) || value === 0) return null
    // Four decimal places or fewer: the column is NUMERIC(12,4) and the order
    // form's own money regex refuses a fifth.
    return (Math.round(value * 10_000) / 10_000).toFixed(4)
  }
  return null
}

// ---------------------------------------------------------------------------
// The drop-ship address
// ---------------------------------------------------------------------------

/**
 * The customer's delivery address, in the shape a purchase order wants it.
 *
 * `county` becomes `region` - the two shapes disagree on that one name only, and
 * mapping it by hand is the only way it does not silently vanish off the address
 * printed for the supplier.
 *
 * Copied verbatim and never tidied. People type a street into the town box and a
 * flat number into the street box; a purchase order that "corrects" the address
 * the parcel is actually going to is a parcel that goes somewhere else.
 */
export function shipToFromShopOrder(order: ShopOrderFacts): PoShipTo {
  const address = order.shippingAddress ?? {}
  const first = textOrNull(address.firstName) ?? ''
  const last = textOrNull(address.lastName) ?? ''
  const name = `${first} ${last}`.trim() || order.customerName

  return {
    name,
    contact: name,
    phone: textOrNull(address.phone) ?? order.customerPhone ?? '',
    address: {
      line1: textOrNull(address.line1) ?? '',
      line2: textOrNull(address.line2) ?? '',
      city: textOrNull(address.city) ?? '',
      region: textOrNull(address.county) ?? '',
      postcode: textOrNull(address.postcode) ?? '',
      country: textOrNull(address.country) ?? '',
    },
    instructions: '',
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type FromOrderLine = {
  itemId: string
  productId: string | null
  productName: string
  qty: number
  ourSku: string | null
  supplierSku: string | null
  /** What the line will be bought at. See `planFromOrder` for why it is never
   *  the price the customer paid. */
  unitCost: string
  /** Where that figure came from - the supplier's own price list where one
   *  names this code, and the shop's `cost_price` otherwise. */
  costSource: PoCostSource
  /** The price list that priced it, so the panel can say so. Null unless
   *  `costSource` is CATALOGUE. */
  catalogueName: string | null
  /** Set when the supplier's list carries this code and has marked it as no
   *  longer sold. The line is still drafted - it is a draft, and a person is
   *  going to read it - but it says so. */
  discontinued: boolean
  serviceName: string | null
  serviceCost: string | null
}

export type FromOrderGroup = {
  supplierId: string
  supplierName: string
  currency: string
  taxRatePercent: string
  lines: FromOrderLine[]
  /** The lines' service costs, times their quantities, to the penny. This is
   *  what reaches the order as its carriage. */
  carriageAmount: string
}

/** A line that cannot be bought, and the sentence that says why. */
export type FromOrderSkipped = {
  itemId: string
  productName: string
  reason: string
}

export type FromOrderPlan = {
  groups: FromOrderGroup[]
  skipped: FromOrderSkipped[]
  shipTo: PoShipTo
}

/**
 * One customer order, worked out into one draft purchase order per supplier.
 *
 * Pure: it takes the facts and returns the plan, so the screen that shows
 * somebody what is about to happen and the run that does it cannot disagree.
 *
 * **The cost is never the order line's `unit_price`.** On this platform the
 * delivery charge is added straight into the price of the goods at checkout, so
 * `unit_price` is the goods AND the carriage fused into one figure. Paying a
 * supplier that would pay them our customer's delivery charge as though it were
 * part of the product, and then pay the carriage again underneath. The two are
 * identical on a free delivery service, which is why this is worth saying twice.
 *
 * What it IS: the supplier's own current price list where one names this code
 * and price lists are switched on, and the shop's `cost_price` in every other
 * case - which is what this did in full before lists existed, and what it still
 * does on every site that has not switched them on. `catalogueCosts` defaults
 * to empty, so a caller that knows nothing about lists gets the old behaviour
 * exactly. Each line says which of the two it used in `costSource`.
 *
 * Nothing is ever dropped in silence: a line with no supplier, no product or no
 * matching supplier record comes back in `skipped` with a sentence a person can
 * act on.
 */
export function planFromOrder(
  order: ShopOrderFacts,
  suppliers: ReorderSupplierFacts[],
  catalogueCosts: Map<string, PoCatalogueCost> = new Map(),
): FromOrderPlan {
  const byNameKey = new Map(suppliers.map((s) => [s.nameKey, s]))
  const groups = new Map<string, FromOrderGroup>()
  const skipped: FromOrderSkipped[] = []

  for (const item of order.items) {
    const skip = (reason: string) => skipped.push({ itemId: item.itemId, productName: item.productName, reason })

    if (!item.productId) {
      skip('This product is no longer in the catalogue, so there is nothing to say who supplies it. Add the line by hand.')
      continue
    }
    if (item.quantity <= 0) {
      skip('There is nothing to order on this line.')
      continue
    }
    if (!item.supplierName) {
      skip('Nothing on this product says who supplies it. Put a supplier on it in the catalogue.')
      continue
    }

    const supplier = byNameKey.get(reorderNameKey(item.supplierName))
    if (!supplier) {
      skip(`Nobody on your supplier list is called "${item.supplierName}", so there is nowhere to send this.`)
      continue
    }
    if (supplier.status === 'ON_HOLD') {
      skip(`${supplier.name} is on hold, so nothing is being ordered from them.`)
      continue
    }
    if (supplier.status === 'DISABLED') {
      skip(`${supplier.name} is switched off on your supplier list.`)
      continue
    }

    const group = groups.get(supplier.id) ?? {
      supplierId: supplier.id,
      supplierName: supplier.name,
      currency: supplier.currency,
      taxRatePercent: reorderTaxRate(supplier),
      lines: [],
      carriageAmount: '0.00',
    }
    // Blank falls back to our own code, which is what a supplier who has never
    // given us one of theirs will be reading it as anyway.
    const supplierSku = item.supplierSku ?? item.sku
    const listed = supplierSku ? catalogueCosts.get(costKey(supplier.id, catalogueSkuKey(supplierSku))) : undefined
    const listCost = listed?.unitCost ?? null

    group.lines.push({
      itemId: item.itemId,
      productId: item.productId,
      productName: item.productName,
      qty: item.quantity,
      ourSku: item.sku,
      supplierSku,
      unitCost: listCost ?? item.costPrice ?? '0',
      costSource: listCost != null ? 'CATALOGUE' : item.costPrice != null ? 'PRODUCT' : 'NONE',
      catalogueName: listCost != null ? (listed?.catalogueName ?? null) : null,
      discontinued: listed?.discontinued ?? false,
      serviceName: serviceNameFor(item.lineMeta),
      serviceCost: serviceCostFor(item.lineMeta),
    })
    groups.set(supplier.id, group)
  }

  for (const group of groups.values()) {
    group.carriageAmount = carriageFor(group.lines)
  }

  return {
    groups: [...groups.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName)),
    skipped,
    shipTo: shipToFromShopOrder(order),
  }
}

/**
 * The delivery money on a set of lines, as one carriage figure.
 *
 * Per-unit cost times quantity, summed in ten-thousandths and rounded to the
 * penny once at the end - the same discipline lib/totals.ts uses, and for the
 * same reason. This is how the delivery reaches the books: it is carriage, which
 * is where this module has always carried it, and it is deliberately not part of
 * any line total.
 */
export function carriageFor(lines: Array<{ qty: number; serviceCost: string | null }>): string {
  const tenThousandths = lines.reduce(
    (sum, line) => sum + scaled(line.serviceCost ?? 0, 4) * (Number.isFinite(line.qty) ? line.qty : 0),
    0,
  )
  return fromPence(Math.round(tenThousandths / 100))
}

/**
 * The suppliers this customer order will actually be split between.
 *
 * Worked out from the items rather than from the whole supplier list, so the
 * price-list lookup asks about the two suppliers on this order and not the two
 * hundred on the site. Pure, and it deliberately repeats the planner's matching
 * rule rather than sharing a helper with it - the rule is three lines, and a
 * lookup that quietly disagreed with the grouping would price nothing.
 */
export function supplierIdsForOrder(order: ShopOrderFacts, suppliers: ReorderSupplierFacts[]): string[] {
  const byNameKey = new Map(suppliers.map((s) => [s.nameKey, s]))
  const ids = new Set<string>()
  for (const item of order.items) {
    if (!item.supplierName) continue
    const supplier = byNameKey.get(reorderNameKey(item.supplierName))
    if (supplier) ids.add(supplier.id)
  }
  return [...ids]
}

/**
 * The plan for one customer order, with the suppliers and their price lists
 * read for you.
 *
 * The one entry point both callers use - the panel that previews it and the run
 * that writes it - so the screen and the button cannot be looking at two
 * different sets of prices. `planFromOrder` itself stays pure and stays
 * testable; this is the three lines of reading in front of it.
 */
export async function planFromShopOrder(order: ShopOrderFacts): Promise<FromOrderPlan> {
  const suppliers = await readSuppliersForOrder()
  const costs = await catalogueCostsBySupplier(supplierIdsForOrder(order, suppliers))
  return planFromOrder(order, suppliers, costs)
}
