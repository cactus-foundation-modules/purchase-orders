import { recordAudit } from './audit'
import { getCapabilities } from './capabilities'
import { getPoConfigCached, type PoConfig } from './config'
import { createOrder, type OrderInput, type OrderLineInput } from './db'
import { needsApproval } from './lifecycle'
import { generateOrderNumber } from './numbering'
import { gatherReorderFacts, markRulesSuggested } from './reorder'
import { planReorder } from './reordering'
import { orderTotals } from './totals'
import type { PoReorderPlan, PoReorderRunResult, PoShipTo } from './types'

// The one thing that actually raises a reorder. The nightly job and the button
// on the Reorder tab both come through here, so what somebody read on the screen
// is what they get when they press it.
//
// Every order it makes is a DRAFT. It never approves, never sends and never
// emails anybody: a machine that quietly posted purchase orders to suppliers
// overnight would be a machine switched off by the end of its first week.

export type ReorderRunOptions = {
  /** Null for the nightly job - nobody pressed anything. */
  userId: string | null
  /**
   * Null runs what the nightly job would run on its own: every plan that clears
   * its supplier's minimum, and only while automatic reordering is switched on.
   * A list of supplier ids is a person overriding both of those.
   */
  supplierIds: string[] | null
}

export async function runReorder(options: ReorderRunOptions): Promise<PoReorderRunResult> {
  const empty: PoReorderRunResult = {
    ordersCreated: [],
    held: [],
    suggested: 0,
    blocked: 0,
    skipped: null,
  }

  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) {
    return { ...empty, skipped: 'There is no product catalogue on this site, so there is nothing to reorder.' }
  }

  const config = await getPoConfigCached()
  const facts = await gatherReorderFacts(config.reorderAutomatic)
  const { suggestions, plans } = planReorder(facts)

  const result: PoReorderRunResult = {
    ...empty,
    suggested: suggestions.filter((s) => !s.blockedReason).length,
    blocked: suggestions.filter((s) => s.blockedReason).length,
  }

  const wanted = options.supplierIds === null ? null : new Set(options.supplierIds)

  for (const plan of plans) {
    // A named supplier is somebody having decided, so the minimum and the
    // switch both give way. An unnamed run is the job doing its rounds.
    const chosen = wanted ? wanted.has(plan.supplierId) : plan.auto
    if (!chosen) {
      if (!wanted) {
        result.held.push({
          supplierId: plan.supplierId,
          supplierName: plan.supplierName,
          reason: plan.holdReason ?? 'Left for somebody to look at.',
        })
      }
      continue
    }

    const created = await raiseOneOrder(plan, config, options.userId)
    result.ordersCreated.push(created)
  }

  await markRulesSuggested(
    result.ordersCreated.flatMap((order) =>
      (plans.find((p) => p.supplierId === order.supplierId)?.lines ?? []).map((line) => line.ruleId),
    ),
  )

  return result
}

async function raiseOneOrder(
  plan: PoReorderPlan,
  config: PoConfig,
  userId: string | null,
): Promise<PoReorderRunResult['ordersCreated'][number]> {
  const lines: OrderLineInput[] = plan.lines.map((line) => ({
    productId: line.productId,
    productName: line.productName,
    supplierSku: line.supplierSku,
    ourSku: line.sku,
    description: line.productName,
    qty: String(line.suggestedQty),
    unit: 'each',
    unitCost: line.unitCost,
    discountPercent: null,
    taxRatePercent: line.taxRatePercent,
    taxRateCode: null,
    vatTreatment: null,
    categoryId: null,
    expectedDate: null,
    qtyCancelled: '0',
    // A reorder is a shelf being topped up on whatever the standing arrangement
    // is. There is no customer waiting, so no service to name.
    serviceName: null,
    serviceCost: null,
  }))

  const input: OrderInput = {
    supplierId: plan.supplierId,
    // Always our own address, whatever the site's default is. A reorder is a
    // shelf being topped up; there is no customer to drop-ship it to.
    shipToKind: 'WAREHOUSE',
    shipTo: warehouseShipTo(config),
    currency: plan.currency,
    baseCurrency: config.baseCurrency,
    // Deliberately 1, even where the supplier bills in their own currency.
    // Nothing on this site knows today's rate, and an invented one on a draft
    // reads as a real one. Whoever opens the draft sets it.
    fxRate: '1',
    taxMode: 'EXCLUSIVE',
    discountAmount: '0',
    carriageAmount: plan.carriageAmount,
    requiredByDate: null,
    expectedDate: null,
    paymentTerms: null,
    deliveryTerms: null,
    notesSupplier: null,
    notesInternal: 'Drafted from your reorder levels. Nothing has been sent to the supplier.',
    lines,
  }

  const totals = orderTotals({
    lines: input.lines,
    taxMode: input.taxMode,
    discountAmount: input.discountAmount,
    carriageAmount: input.carriageAmount,
  })

  const number = await generateOrderNumber()
  const id = await createOrder(number, input, totals, needsApproval(totals.total, config), userId, {
    kind: 'REORDER',
    ref: { ruleIds: plan.lines.map((line) => line.ruleId) },
  })

  await recordAudit(
    'order',
    id,
    'order.created',
    { number, total: totals.total, source: 'REORDER', lines: lines.length },
    userId,
  )

  return {
    id,
    number,
    supplierId: plan.supplierId,
    supplierName: plan.supplierName,
    currency: plan.currency,
    total: totals.total,
    lineCount: lines.length,
  }
}

/** The site's own delivery address, in the shape an order line wants it. */
function warehouseShipTo(config: PoConfig): PoShipTo {
  return {
    name: config.warehouse.name,
    contact: config.warehouse.contact,
    phone: config.warehouse.phone,
    address: config.warehouse.address,
    instructions: config.warehouse.instructions,
  }
}
