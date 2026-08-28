import { catalogueSkuKey } from './catalogue-import'
import { fromPence, lineAmounts, scaled } from './totals'
import type {
  PoCatalogueCost,
  PoCostSource,
  PoReorderPlan,
  PoReorderReview,
  PoReorderSuggestion,
  SupplierStatus,
} from './types'

// The reorder arithmetic, and nothing else.
//
// Pure by design: no database, no clock, no config reader. The nightly job and
// the button on the Reorder tab both hand this file the same facts and get the
// same answer, which is the only way somebody can press "raise these" having
// read a screen and be sure they got what they were looking at.
//
// Money is worked out in pence through lib/totals.ts, exactly as an order is.
// Quantities here are whole numbers throughout: a stock count holds whole
// things, and a reorder level for half a metre of cable is a conversation for
// the line editor rather than for a nightly job.

/** The tax rate a suggested line is drafted at.
 *
 *  The same default the order screen puts on a new line. Nobody's rates live in
 *  a stock level, the draft is going to be read by a person before it goes
 *  anywhere, and a line drafted at zero that should have been at twenty is the
 *  error that survives that reading. */
const DEFAULT_TAX_RATE_PERCENT = '20'

/** VAT codes that genuinely carry no VAT, so a supplier filed under one of them
 *  gets zero-rated lines rather than the default twenty. */
const ZERO_RATED_CODES = new Set(['zero', 'exempt', 'outside_scope'])

export type ReorderRuleRow = {
  id: string
  productId: string
  supplierId: string | null
  reorderPoint: number
  reorderQty: number
  enabled: boolean
  lastSuggestedAt: string | null
}

export type ReorderProductFacts = {
  id: string
  name: string
  sku: string | null
  /** The free-text supplier name the catalogue files this product under. */
  supplierName: string | null
  /** The supplier's own code for it, where the shop has been told one. What a
   *  price list is matched on; blank falls back to `sku`. */
  supplierSku: string | null
  costPrice: string | null
  stockCount: number | null
  trackInventory: boolean
}

export type ReorderSupplierFacts = {
  id: string
  name: string
  nameKey: string
  status: SupplierStatus
  currency: string
  minimumOrderValue: string | null
  carriagePaidOver: string | null
  carriageCharge: string | null
  defaultVatRateCode: string | null
}

/** What this supplier last charged for this product, off their last order line. */
export type ReorderLastCost = { unitCost: string; supplierSku: string | null }

export type ReorderFacts = {
  rules: ReorderRuleRow[]
  /** By product id. A rule whose product is missing here has outlived it. */
  products: Record<string, ReorderProductFacts>
  suppliers: ReorderSupplierFacts[]
  /** Still expected in on a purchase order, by product id. */
  onOrder: Record<string, number>
  /** Keyed `<productId>::<supplierId>` - what THAT supplier charged, not
   *  whoever happened to sell it last. */
  lastCosts: Record<string, ReorderLastCost>
  /** Whether the owner has switched the nightly run on. */
  automatic: boolean
  /** The suppliers' own price lists, keyed `<supplierId>::<normalised code>`.
   *  Absent on a site with price lists switched off, which is the default and
   *  which leaves every suggestion priced exactly as it was before they
   *  existed - see `unitCostFor`. */
  catalogueCosts?: Record<string, PoCatalogueCost>
}

/** Normalised supplier name, matching lib/db.ts's `supplierNameKey`. Repeated
 *  rather than imported because that file reaches for the database. */
export function reorderNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * How many to buy.
 *
 * Whole lots of the reorder quantity, as many as it takes to get back above the
 * level - which matters when a product has been sitting below its point for a
 * fortnight, or has gone negative on a site that lets stock go negative. One lot
 * would leave it under the level and the job would suggest it again tomorrow,
 * and the day after, for ever.
 *
 * Lots rather than an exact top-up because a reorder quantity is usually how the
 * supplier sells the thing: a box of twelve, a pallet of forty. Ordering seven
 * of a box of twelve is not an order anybody can place.
 */
export function reorderQuantity(available: number, reorderPoint: number, reorderQty: number): number {
  if (reorderQty <= 0) return 0
  const deficit = reorderPoint + 1 - available
  if (deficit <= 0) return 0
  return Math.ceil(deficit / reorderQty) * reorderQty
}

/** The tax rate a line for this supplier is drafted at. */
export function reorderTaxRate(supplier: ReorderSupplierFacts): string {
  return supplier.defaultVatRateCode && ZERO_RATED_CODES.has(supplier.defaultVatRateCode)
    ? '0'
    : DEFAULT_TAX_RATE_PERCENT
}

type Blocked = { reason: string }

function supplierFor(
  rule: ReorderRuleRow,
  product: ReorderProductFacts,
  byId: Map<string, ReorderSupplierFacts>,
  byNameKey: Map<string, ReorderSupplierFacts>,
): ReorderSupplierFacts | Blocked {
  // The rule's own choice wins. Falling back to the catalogue's supplier name is
  // what makes a rule worth setting on a site that has never linked the two
  // lists up - and matching on the normalised name is the same join the line
  // editor uses to offer a supplier's own products first.
  const chosen = rule.supplierId ? byId.get(rule.supplierId) : undefined
  if (rule.supplierId && !chosen) {
    return { reason: 'The supplier this was set to buy from is no longer on your list.' }
  }
  const supplier =
    chosen ?? (product.supplierName ? byNameKey.get(reorderNameKey(product.supplierName)) : undefined)

  if (!supplier) {
    return {
      reason: product.supplierName
        ? `Nobody on your supplier list is called "${product.supplierName}", so there is nowhere to send this.`
        : 'Nobody is set to supply this one. Pick a supplier on the rule.',
    }
  }
  if (supplier.status === 'ON_HOLD') {
    return { reason: `${supplier.name} is on hold, so nothing is being ordered from them.` }
  }
  if (supplier.status === 'DISABLED') {
    return { reason: `${supplier.name} is switched off on your supplier list.` }
  }
  return supplier
}

function isBlocked(value: ReorderSupplierFacts | Blocked): value is Blocked {
  return 'reason' in value
}

/**
 * What one suggested line is drafted at, and where the figure came from.
 *
 * Three sources in order of authority, and the order is the whole point:
 *
 * 1. **The supplier's own current price list.** What they are charging today,
 *    published by them. Nothing beats it.
 * 2. **What they last charged us.** Off the last order line, which is a real
 *    price somebody really paid, if not necessarily this month's.
 * 3. **The shop's `cost_price`.** Frequently whatever was typed in when the
 *    product was created and never touched again.
 *
 * Before price lists existed this was 2 then 3, and that is exactly what it
 * still is on a site with them switched off - `catalogueCosts` is absent and
 * the first branch never fires.
 *
 * A list entry with no price on it does not win: a code somebody has recorded
 * without a figure is a code with no price, not a price of nothing.
 */
export function unitCostFor(
  product: ReorderProductFacts,
  supplierId: string,
  lastCost: string | null,
  catalogueCosts?: Record<string, PoCatalogueCost>,
): {
  unitCost: string
  costSource: PoCostSource
  catalogueName: string | null
  catalogueDescription: string | null
  supplierSku: string | null
} {
  const code = product.supplierSku?.trim() || product.sku?.trim() || ''
  const listed = code && catalogueCosts ? catalogueCosts[`${supplierId}::${catalogueSkuKey(code)}`] : undefined
  // Their words for the thing come off the LIST, not off the price on it: a
  // code recorded without a figure is a code with no price, but it is still the
  // name they filed it under and still the name to order it by.
  const catalogueDescription = listed?.description?.trim() || null

  if (listed?.unitCost != null) {
    return {
      unitCost: listed.unitCost,
      costSource: 'CATALOGUE',
      catalogueName: listed.catalogueName,
      catalogueDescription,
      supplierSku: listed.supplierSku,
    }
  }
  if (lastCost != null) {
    return { unitCost: lastCost, costSource: 'PRODUCT', catalogueName: null, catalogueDescription, supplierSku: product.supplierSku }
  }
  return {
    unitCost: product.costPrice ?? '0',
    costSource: product.costPrice == null ? 'NONE' : 'PRODUCT',
    catalogueName: null,
    catalogueDescription,
    supplierSku: product.supplierSku,
  }
}

/**
 * Everything the levels say should be bought, grouped into one order per
 * supplier, and an honest answer for everything that cannot be.
 *
 * A rule that is switched off is not here at all. A rule with enough on the
 * shelf is counted as resting and not listed - a screen that lists nine hundred
 * products to say nothing is wrong with them is a screen nobody opens twice.
 */
export function planReorder(facts: ReorderFacts): PoReorderReview {
  const byId = new Map(facts.suppliers.map((s) => [s.id, s]))
  const byNameKey = new Map(facts.suppliers.map((s) => [s.nameKey, s]))

  const suggestions: PoReorderSuggestion[] = []
  let restingCount = 0

  for (const rule of facts.rules) {
    if (!rule.enabled) continue

    const product = facts.products[rule.productId]
    const onOrder = facts.onOrder[rule.productId] ?? 0

    if (!product) {
      suggestions.push(
        bare(rule, rule.productId, null, null, null, onOrder, 0, {
          reason: 'That product is no longer in your catalogue. Delete this rule, or point it at the one that replaced it.',
        }),
      )
      continue
    }

    if (!product.trackInventory) {
      suggestions.push(
        bare(rule, product.name, product.sku, null, null, onOrder, 0, {
          reason: 'Nothing is keeping a count of this product, so there is no level to have dropped below.',
        }),
      )
      continue
    }

    const inStock = product.stockCount ?? 0
    const available = inStock + onOrder
    if (available > rule.reorderPoint) {
      restingCount += 1
      continue
    }

    if (rule.reorderQty <= 0) {
      suggestions.push(
        bare(rule, product.name, product.sku, null, inStock, onOrder, 0, {
          reason: 'Say how many to buy at a time and this one starts suggesting.',
        }),
      )
      continue
    }

    const supplier = supplierFor(rule, product, byId, byNameKey)
    if (isBlocked(supplier)) {
      suggestions.push(bare(rule, product.name, product.sku, null, inStock, onOrder, 0, supplier))
      continue
    }

    const suggestedQty = reorderQuantity(available, rule.reorderPoint, rule.reorderQty)
    const last = facts.lastCosts[`${product.id}::${supplier.id}`]
    const priced = unitCostFor(product, supplier.id, last?.unitCost ?? null, facts.catalogueCosts)
    const unitCost = priced.unitCost
    const taxRatePercent = reorderTaxRate(supplier)
    const net = lineAmounts({ qty: String(suggestedQty), unitCost }, 'EXCLUSIVE').net

    suggestions.push({
      ruleId: rule.id,
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      supplierId: supplier.id,
      supplierName: supplier.name,
      reorderPoint: rule.reorderPoint,
      reorderQty: rule.reorderQty,
      inStock,
      onOrder,
      available,
      suggestedQty,
      unitCost,
      costSource: priced.costSource,
      catalogueName: priced.catalogueName,
      catalogueDescription: priced.catalogueDescription,
      taxRatePercent,
      supplierSku: priced.supplierSku ?? last?.supplierSku ?? null,
      lineValue: fromPence(net),
      lastSuggestedAt: rule.lastSuggestedAt,
      blockedReason: null,
    })
  }

  return { suggestions, plans: groupIntoPlans(suggestions, byId, facts.automatic), restingCount }
}

/** A suggestion that is only ever going to explain itself. */
function bare(
  rule: ReorderRuleRow,
  productName: string,
  sku: string | null,
  supplier: ReorderSupplierFacts | null,
  inStock: number | null,
  onOrder: number,
  suggestedQty: number,
  blocked: Blocked,
): PoReorderSuggestion {
  return {
    ruleId: rule.id,
    productId: rule.productId,
    productName,
    sku,
    supplierId: supplier?.id ?? rule.supplierId,
    supplierName: supplier?.name ?? null,
    reorderPoint: rule.reorderPoint,
    reorderQty: rule.reorderQty,
    inStock,
    onOrder,
    available: (inStock ?? 0) + onOrder,
    suggestedQty,
    unitCost: '0',
    costSource: 'NONE',
    catalogueName: null,
    catalogueDescription: null,
    taxRatePercent: '0',
    supplierSku: null,
    lineValue: '0.00',
    lastSuggestedAt: rule.lastSuggestedAt,
    blockedReason: blocked.reason,
  }
}

/**
 * One draft order per supplier, with their own terms applied.
 *
 * Minimum order value HOLDS the order rather than padding it out: a job that
 * quietly adds four hundred pounds of something nobody asked for to clear a
 * minimum is a job that gets switched off within the week. It is held, it is
 * shown, and a person can raise it anyway with one press.
 *
 * Carriage is the other way about - a threshold the order has already cleared
 * costs nothing to honour, and one it has not is a charge the supplier is going
 * to add whether or not the draft mentions it.
 */
function groupIntoPlans(
  suggestions: PoReorderSuggestion[],
  byId: Map<string, ReorderSupplierFacts>,
  automatic: boolean,
): PoReorderPlan[] {
  const grouped = new Map<string, PoReorderSuggestion[]>()
  for (const suggestion of suggestions) {
    if (suggestion.blockedReason || !suggestion.supplierId) continue
    const lines = grouped.get(suggestion.supplierId)
    if (lines) lines.push(suggestion)
    else grouped.set(suggestion.supplierId, [suggestion])
  }

  const plans: PoReorderPlan[] = []
  for (const [supplierId, lines] of grouped) {
    const supplier = byId.get(supplierId)
    if (!supplier) continue

    const goodsPence = lines.reduce((sum, line) => sum + scaled(line.lineValue, 2), 0)

    const minimumPence = supplier.minimumOrderValue == null ? null : scaled(supplier.minimumOrderValue, 2)
    const shortPence = minimumPence != null && goodsPence < minimumPence ? minimumPence - goodsPence : null

    const thresholdPence = supplier.carriagePaidOver == null ? null : scaled(supplier.carriagePaidOver, 2)
    const carriagePaid = thresholdPence != null && goodsPence >= thresholdPence
    const carriagePence = carriagePaid ? 0 : scaled(supplier.carriageCharge ?? '0', 2)

    const holdReason = !automatic
      ? 'Automatic reordering is switched off in your purchasing settings, so this is waiting for you.'
      : shortPence != null
        ? `This comes to less than ${supplier.name} will take in one order, so it is being left to grow. Raise it yourself if you would rather have it now.`
        : null

    plans.push({
      supplierId,
      supplierName: supplier.name,
      currency: supplier.currency,
      lines,
      goodsValue: fromPence(goodsPence),
      minimumOrderValue: supplier.minimumOrderValue,
      shortOfMinimum: shortPence == null ? null : fromPence(shortPence),
      carriageAmount: fromPence(carriagePence),
      carriagePaid,
      auto: holdReason === null,
      holdReason,
    })
  }

  return plans.sort((a, b) => a.supplierName.localeCompare(b.supplierName))
}
