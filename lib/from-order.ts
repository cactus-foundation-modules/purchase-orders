import { prisma } from '@/lib/db/prisma'
import { getCapabilities } from './capabilities'
import { catalogueNameKey, catalogueSkuKey } from './catalogue-import'
import { catalogueCostsBySupplier, costKey } from './catalogues'
import { reorderNameKey, reorderTaxRate, type ReorderSupplierFacts } from './reordering'
import { fromPence, lineAmounts, scaled } from './totals'
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
  'PENDING_CLOSE',
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
  /** The supplier's own clearance code, snapshotted on the order line at
   *  checkout ONLY when it was actually bought at the sale price - shop's
   *  `shp_order_items.sale_sku` (migration 061). Null on an ordinary line, and
   *  null on a sale-eligible product bought at full price. Read off the ORDER
   *  ITEM rather than the live product for the same reason `unitPrice` and
   *  `costPrice` never are: the product may have had its sale turned off, or
   *  its clearance code changed, since this was bought - the supplier still
   *  wants the code this customer's stock was actually raised under. See
   *  `planFromOrder`, which prefers this over `supplierSku` whenever it is set. */
  saleSku: string | null
  /** The free-text supplier name the catalogue files this product under. */
  supplierName: string | null
  costPrice: string | null
  lineMeta: Record<string, unknown> | null
}

/** Shop's `shp_orders.kind`. Absent on older installs, read as `SALE`. */
export const SHOP_ORDER_KIND_SALE = 'SALE'
export const SHOP_ORDER_KIND_REPLACEMENT = 'REPLACEMENT'

export type ShopOrderFacts = {
  id: string
  orderNumber: string
  /** `SALE` or `REPLACEMENT` once shop's replacement orders exist. */
  kind: string
  status: string
  customerName: string
  customerPhone: string | null
  /** The organisation the checkout collected as a CONTACT detail, on its own
   *  field, away from the address. Read and carried because the screen shows
   *  it, and deliberately NOT used to head the delivery label - see
   *  `shipToFromShopOrder`. */
  customerOrganisation: string | null
  currency: string
  shippingAddress: Record<string, unknown> | null
  /** What the customer told the shop about getting the goods to that door - a
   *  gate code, a side entrance, somewhere safe to leave it. Collected at
   *  checkout on the shops that ask for it, and the reason this module reads it
   *  at all: on a drop-ship the driver works for the SUPPLIER, so an instruction
   *  that never reaches the purchase order never reaches the lorry.
   *
   *  Null where the shop does not ask, where the shopper had nothing to say, or
   *  where the shop predates the column - see `readShopOrder`. */
  deliveryInstructions: string | null
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
    // `delivery_instructions` is read through the row's own JSON rather than
    // named as a column, and that is deliberate. It arrives with shop's
    // migration 046, and the two modules are pinned independently - a site can
    // perfectly well be running this version of Purchase Orders against a shop
    // that has not had that migration yet. Named as a column it would throw,
    // and the catch
    // at the bottom of this function turns a throw into "there is no such
    // order", which would take the whole panel down over a field nobody had
    // filled in. `to_jsonb(o) ->> 'missing_key'` is NULL, so an older shop
    // answers "nothing said" and everything else carries on.
    const orders = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT o."id", o."order_number", o."status", o."customer_name", o."customer_phone", o."customer_organisation",
             o."currency", o."shipping_address",
             to_jsonb(o) ->> 'delivery_instructions' AS "delivery_instructions",
             COALESCE(to_jsonb(o) ->> 'kind', ${SHOP_ORDER_KIND_SALE}) AS "kind"
        FROM "shp_orders" o
       WHERE o."id" = ${orderId}
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
    // What is still owed, not what was first ordered: units refunded before a
    // purchase order was raised - a cancelled chair on an order of three - are
    // not goods anybody should be buying in. The quantity-at-zero skip further
    // down then drops a line refunded outright.
    // `sale_sku` is read off the ORDER ITEM, through its own JSON rather than
    // named as a column, for the same reason `delivery_instructions` above is:
    // it arrives on `shp_order_items` in shop migration 061, independently
    // pinned from this module, and `to_jsonb(oi) ->> 'missing_key'` answers
    // NULL on a shop that predates it rather than throwing - "nothing on
    // record", which is the honest answer for an order old enough to have none.
    const items = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT oi."id", oi."product_id", oi."product_name",
             GREATEST(oi."quantity" - COALESCE(oi."refunded_qty", 0), 0) AS "quantity",
             oi."unit_price", oi."line_meta",
             to_jsonb(oi) ->> 'sale_sku' AS "sale_sku",
             p."sku", p."supplier_sku", p."supplier", p."cost_price"
        FROM "shp_order_items" oi
        LEFT JOIN "shp_products" p ON p."id" = oi."product_id"
       WHERE oi."order_id" = ${orderId}
       ORDER BY oi."product_name" ASC
    `

    return {
      id: order.id as string,
      orderNumber: order.order_number as string,
      kind: (order.kind as string | null) ?? SHOP_ORDER_KIND_SALE,
      status: order.status as string,
      customerName: (order.customer_name as string | null) ?? '',
      customerPhone: textOrNull(order.customer_phone),
      customerOrganisation: textOrNull(order.customer_organisation),
      currency: (order.currency as string | null) ?? 'GBP',
      shippingAddress: bag(order.shipping_address),
      deliveryInstructions: textOrNull(order.delivery_instructions),
      items: items.map((r) => ({
        itemId: r.id as string,
        productId: (r.product_id as string | null) ?? null,
        productName: (r.product_name as string | null) ?? '',
        quantity: Number(r.quantity ?? 0),
        unitPrice: numOrNull(r.unit_price) ?? '0',
        sku: textOrNull(r.sku),
        supplierSku: textOrNull(r.supplier_sku),
        saleSku: textOrNull(r.sale_sku),
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
           "carriage_paid_over", "carriage_charge", "default_vat_rate_code", "surcharge_threshold"
      FROM "po_suppliers"
  `
  const rates = rows.length === 0 ? [] : await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "supplier_id", "category_key", "rate_per_unit"
      FROM "po_supplier_surcharge_rates"
     WHERE "supplier_id" = ANY(${rows.map((r) => r.id as string)}::text[])
  `
  const ratesBySupplier = new Map<string, Array<{ categoryKey: string; ratePerUnit: string }>>()
  for (const r of rates) {
    const supplierId = r.supplier_id as string
    const list = ratesBySupplier.get(supplierId) ?? []
    list.push({ categoryKey: r.category_key as string, ratePerUnit: String(r.rate_per_unit) })
    ratesBySupplier.set(supplierId, list)
  }

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
    surchargeThreshold: numOrNull(r.surcharge_threshold),
    surchargeRates: ratesBySupplier.get(r.id as string) ?? [],
  }))
}

/** A purchase order already raised off this customer order. */
export type PoRaisedFromShopOrder = {
  id: string
  number: string
  status: PoStatus
  /** Where the proforma dance has got to, for the badge. An order on these
   *  terms sits at SENT throughout, and "Sent" on the customer order's panel
   *  hides the fact that nobody has paid the supplier yet. */
  proformaRequired: boolean
  proformaReceived: boolean
  proformaPaid: boolean
  supplierId: string
  supplierName: string
  currency: string
  total: string
  createdAt: string
  /** Raised by the money landing rather than by somebody pressing Raise.
   *  Read off a null `created_by_user_id`, which within `source_kind =
   *  'FROM_ORDER'` can only mean the hook or the sweep - the button always has
   *  a session behind it. Worth saying on the screen: a draft that appeared by
   *  itself is one nobody has read yet. */
  raisedAutomatically: boolean
}

/**
 * Every purchase order ever raised off this customer order, cancelled ones
 * included - the panel lists them all, and only the live ones block a re-raise.
 */
export async function listPosForShopOrder(orderId: string): Promise<PoRaisedFromShopOrder[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."id", o."number", o."status", o."supplier_id", o."currency", o."total", o."created_at",
           o."created_by_user_id", s."name" AS "supplier_name",
           o."proforma_required", o."proforma_media_id", o."proforma_received_at", o."proforma_paid_at"
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
    proformaRequired: Boolean(r.proforma_required),
    proformaReceived: Boolean(r.proforma_media_id) || Boolean(r.proforma_received_at),
    proformaPaid: Boolean(r.proforma_paid_at),
    supplierId: r.supplier_id as string,
    supplierName: (r.supplier_name as string | null) ?? 'A supplier no longer on your list',
    currency: r.currency as string,
    total: numOrNull(r.total) ?? '0',
    createdAt: (r.created_at as Date).toISOString(),
    raisedAutomatically: r.created_by_user_id == null,
  }))
}

/** Customer-order statuses where buying the goods in has stopped making sense.
 *
 *  Checked on the run as well as on the panel. The panel hides the button, but
 *  the button is not the only way to reach the route, and an order refunded
 *  while somebody had the screen open would otherwise still buy the goods. */
export const CLOSED_SHOP_ORDER_STATUSES = new Set(['CANCELLED', 'REFUNDED'])

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
  const text = when ? `${tierText}, expected by ${when}` : tierText
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
 * The COMPANY heads the label wherever the customer put one IN THE DELIVERY
 * ADDRESS, with the person underneath as the contact - which is the way a
 * delivery to a business has to be addressed, and the way a post room finds who
 * it belongs to. The order's own `customerOrganisation` is NOT read here: the
 * checkout collects that as a contact detail, on a field of its own away from
 * the address, and someone who names their employer there has not asked for the
 * parcel to go to it. With no company on the address the person heads the label.
 *
 * Copied verbatim and never tidied. People type a street into the town box and a
 * flat number into the street box; a purchase order that "corrects" the address
 * the parcel is actually going to is a parcel that goes somewhere else.
 *
 * The customer's own delivery instructions ride along in `instructions`, which
 * is what puts them on the paperwork the supplier's driver reads - the whole
 * reason the shop collects them on a drop-ship. Blank where the shop does not
 * ask for them or the shopper had nothing to say, which is the same blank a
 * purchase order raised by hand starts with; somebody can still type into the
 * box on the order screen either way, and what they type wins from then on,
 * because this only ever fills the field in as the order is drafted.
 */
export function shipToFromShopOrder(order: ShopOrderFacts): PoShipTo {
  const address = order.shippingAddress ?? {}
  const first = textOrNull(address.firstName) ?? ''
  const last = textOrNull(address.lastName) ?? ''
  const person = `${first} ${last}`.trim() || order.customerName
  const company = textOrNull(address.company)?.trim() || ''

  return {
    name: company || person,
    contact: person,
    phone: textOrNull(address.phone) ?? order.customerPhone ?? '',
    address: {
      line1: textOrNull(address.line1) ?? '',
      line2: textOrNull(address.line2) ?? '',
      city: textOrNull(address.city) ?? '',
      region: textOrNull(address.county) ?? '',
      postcode: textOrNull(address.postcode) ?? '',
      country: textOrNull(address.country) ?? '',
    },
    // Trimmed, and nothing more: the wording is the customer's, and a purchase
    // order that improves on what somebody wrote about their own front door is
    // a purchase order that gets it wrong.
    instructions: order.deliveryInstructions?.trim() ?? '',
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
  /** The code the purchase order asks for. The supplier's CLEARANCE code where
   *  this was bought on sale (see `ShopOrderItemFacts.saleSku`), their ordinary
   *  one otherwise, and our own where neither is on record. */
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
  /** What the SUPPLIER calls this thing on their own list. Null where their
   *  list does not carry the code, or carries it with no description. */
  catalogueDescription: string | null
  /** Set when the supplier's list carries this code and has marked it as no
   *  longer sold. The line is still drafted - it is a draft, and a person is
   *  going to read it - but it says so. */
  discontinued: boolean
  serviceName: string | null
  serviceCost: string | null
  /** True when `supplierSku` above is the supplier's CLEARANCE code - i.e.
   *  this unit was genuinely bought on sale, not just that the supplier
   *  happens to have one on record. Only sale-coded units ever count toward
   *  a sale surcharge - see `surchargeFor`. */
  onSale: boolean
  /** What the matched catalogue row calls this line's kind - a sale surcharge
   *  rate is keyed against this. Null where nothing priced the line off a
   *  list, or the list carries no category for it. */
  category: string | null
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
  /** This supplier's sale surcharge, worked out over the group's own sale-coded
   *  lines and capped at the shortfall to their threshold - see `surchargeFor`.
   *  `'0.00'` on every supplier with no threshold set, same as carriage on a
   *  supplier with no service cost. */
  surchargeAmount: string
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
  const byId = new Map(suppliers.map((s) => [s.id, s]))
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

    // Bought under the supplier's clearance code takes priority over their
    // ordinary one - it is what the customer's stock was actually raised
    // under, and it is the only code a sale price list prices. Falling back to
    // the ordinary code (or, blank, our own) is what every line that was not
    // on sale still does exactly as before.
    const supplierSku = item.saleSku ?? item.supplierSku ?? item.sku
    const listed = supplierSku ? catalogueCosts.get(costKey(supplier.id, catalogueSkuKey(supplierSku))) : undefined
    const listCost = listed?.unitCost ?? null

    // A sale code with no price behind it is not a line to guess at: the
    // ordinary cost price prices the ordinary code, and putting it on a
    // purchase order under the CLEARANCE code would ask the supplier for
    // clearance stock at their standard price - not a mistake this module
    // makes quietly. Upload the sale list, or the human drafting this order
    // sorts it by hand.
    if (item.saleSku && listCost == null) {
      skip(`This was sold under ${supplier.name}'s sale code "${item.saleSku}", but nothing in their price lists prices it. Upload the sale price list, or add the line by hand.`)
      continue
    }

    const group = groups.get(supplier.id) ?? {
      supplierId: supplier.id,
      supplierName: supplier.name,
      currency: supplier.currency,
      taxRatePercent: reorderTaxRate(supplier),
      lines: [],
      carriageAmount: '0.00',
      surchargeAmount: '0.00',
    }

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
      // Off the list itself rather than off the price on it: a supplier whose
      // list names the code but leaves the price blank still has a name for the
      // thing, and it is still the name they will be reading it under.
      catalogueDescription: listed?.description?.trim() || null,
      discontinued: listed?.discontinued ?? false,
      serviceName: serviceNameFor(item.lineMeta),
      serviceCost: serviceCostFor(item.lineMeta),
      onSale: item.saleSku != null,
      category: listed?.category ?? null,
    })
    groups.set(supplier.id, group)
  }

  for (const group of groups.values()) {
    group.carriageAmount = carriageFor(group.lines)
    const supplier = byId.get(group.supplierId)!
    group.surchargeAmount = surchargeFor(
      group.lines,
      netTotalFor(group.lines),
      supplier.surchargeThreshold,
      supplier.surchargeRates,
    )
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
 * A group's net goods total, to the penny - what a sale surcharge's threshold
 * is actually checked against.
 *
 * Deliberately NOT `carriageFor`'s discipline (sum in ten-thousandths across
 * every line, round once at the end): `orderTotals` rounds each LINE to the
 * penny first, then sums the already-rounded pence, and the two can disagree
 * by a penny on some inputs. A surcharge decided against a different net than
 * the one the order is actually saved with is a decision made against a
 * number nobody can see anywhere - so this reuses `lineAmounts`, the exact
 * function `orderTotals` itself calls per line, rather than a second
 * arithmetic path that could quietly drift from it.
 */
export function netTotalFor(lines: Array<{ qty: number; unitCost: string }>): string {
  const pence = lines.reduce(
    (sum, line) => sum + lineAmounts({ qty: String(line.qty), unitCost: line.unitCost }, 'EXCLUSIVE').net,
    0,
  )
  return fromPence(pence)
}

/**
 * A supplier's sale surcharge for one group of lines.
 *
 * Only lines bought on sale count, and only where their category has a rate -
 * an ordinary line at full price never adds a penny, however many of them sit
 * on the same order. Below the threshold, every sale-coded unit's rate is
 * summed by category; above or AT it, there is nothing to charge - "under",
 * never "at or under". The figure charged is capped at the shortfall: a
 * supplier that would rather take five pounds than push the order to their
 * own threshold and beyond is not one this module second-guesses.
 *
 * `thresholdNet == null` or an empty rate list both read as "this supplier has
 * no surcharge", which is what every supplier starts as and what most stay.
 */
export function surchargeFor(
  lines: Array<{ qty: number; onSale: boolean; category: string | null }>,
  netTotal: string,
  thresholdNet: string | null,
  rates: Array<{ categoryKey: string; ratePerUnit: string }>,
): string {
  if (thresholdNet == null || rates.length === 0) return '0.00'
  const thresholdPence = scaled(thresholdNet, 2)
  const netPence = scaled(netTotal, 2)
  if (netPence >= thresholdPence) return '0.00'

  const rateByKey = new Map(rates.map((r) => [r.categoryKey, scaled(r.ratePerUnit, 4)]))
  let rawTenThousandths = 0
  for (const line of lines) {
    if (!line.onSale || !line.category) continue
    const rate = rateByKey.get(catalogueNameKey(line.category))
    if (rate == null) continue
    rawTenThousandths += rate * (Number.isFinite(line.qty) ? line.qty : 0)
  }
  const rawPence = Math.round(rawTenThousandths / 100)
  const shortfallPence = thresholdPence - netPence
  return fromPence(Math.max(0, Math.min(rawPence, shortfallPence)))
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
