import { getInventoryAdjuster } from '@/lib/inventory/adjusters'
import type { InventoryAdjustment, InventoryAdjustmentOutcome } from '@/lib/inventory/adjusters'
import { getPoConfigCached } from './config'
import { claimStockApplication, recordStockResult, releaseStockApplication } from './receipts'
import { claimReturnStock, recordReturnStockResult, releaseReturnStock } from './returns'
import type { PoReceipt, PoReturn, PoStockLineResult, PoStockResult } from './types'

// The stock seam. Everything this module knows about stock is in this file, and
// what it knows is deliberately almost nothing: core says whether anything on
// the site keeps counts, and if something does, this hands it a list of moves.
//
// Nothing here imports from the shop. On an install with no shop those files do
// not exist at build time, and a static import would break the build of a site
// that was only ever going to raise purchase orders and file the paperwork.

export type StockApplyOutcome =
  | { applied: false; reason: string }
  | { applied: true; result: PoStockResult }

/** Why the site would not move stock right now, or null when it would.
 *
 *  One switch covers both directions. A site where booking a delivery in adds to
 *  a count but sending goods back never takes them off would drift upwards for
 *  ever, which is a worse answer than not keeping the count at all. */
export async function stockBlockedReason(): Promise<string | null> {
  const config = await getPoConfigCached()
  if (!config.stockOnReceipt) {
    return 'Changing stock counts from purchasing is switched off in your purchasing settings.'
  }
  if (!getInventoryAdjuster()) {
    return 'Nothing on this site keeps stock counts, so there is nothing to change.'
  }
  return null
}

/** Whether this delivery has anything a stock system could act on at all. */
export function hasStockableLines(receipt: PoReceipt): boolean {
  return receipt.lines.some((l) => l.productId && Number(l.qtyAccepted) > 0)
}

/**
 * Put a delivery's accepted quantities onto the shelf, exactly once.
 *
 * The `stock_applied` flag is claimed FIRST, in a conditional UPDATE, and only
 * then is anything moved: two people pressing the button at the same moment
 * would both pass a check done in JavaScript and the shelf would gain the
 * delivery twice. If the move then fails outright the claim is handed back, so
 * the button works again once whatever went wrong is fixed.
 */
export async function applyReceiptStock(
  receipt: PoReceipt,
  userId: string,
): Promise<StockApplyOutcome> {
  const blocked = await stockBlockedReason()
  if (blocked) return { applied: false, reason: blocked }

  const registered = getInventoryAdjuster()
  if (!registered) return { applied: false, reason: 'Nothing on this site keeps stock counts.' }

  if (!hasStockableLines(receipt)) {
    return {
      applied: false,
      reason: 'Nothing on this delivery is linked to a catalogue product, so there is no count to change.',
    }
  }

  if (!(await claimStockApplication(receipt.id))) {
    return { applied: false, reason: 'This delivery has already been added to stock.' }
  }

  const { adjustments, refused } = planAdjustments(receipt, userId, 1)

  let result: PoStockResult
  try {
    const outcomes = await registered.adjuster.adjust(adjustments)
    result = {
      adjuster: registered.adjuster.label,
      at: new Date().toISOString(),
      byUserId: userId,
      lines: [...refused, ...matchOutcomes(receipt, adjustments, outcomes)],
    }
  } catch (error) {
    // The adjuster is contracted not to throw for an ordinary refusal, so this
    // is the database being on fire. Hand the claim back: the goods are on the
    // shelf either way, and somebody has to be able to try again.
    const message = error instanceof Error ? error.message : 'The stock system would not answer.'
    await releaseStockApplication(receipt.id, {
      adjuster: registered.adjuster.label,
      at: new Date().toISOString(),
      byUserId: userId,
      error: message,
    })
    return { applied: false, reason: `Stock was not changed: ${message}` }
  }

  await recordStockResult(receipt.id, result)
  return { applied: true, result }
}

/**
 * Take a delivery's accepted quantities back off the shelf.
 *
 * Called when a delivery that had been added to stock is deleted. Booking goods
 * in and then deleting the paperwork without putting the count back is how a
 * stock figure quietly stops meaning anything.
 */
export async function reverseReceiptStock(
  receipt: PoReceipt,
  userId: string,
): Promise<PoStockResult | null> {
  if (!receipt.stockApplied) return null
  const registered = getInventoryAdjuster()
  if (!registered) return null

  const { adjustments } = planAdjustments(receipt, userId, -1)
  if (adjustments.length === 0) return null

  try {
    const outcomes = await registered.adjuster.adjust(adjustments)
    return {
      adjuster: registered.adjuster.label,
      at: new Date().toISOString(),
      byUserId: userId,
      lines: matchOutcomes(receipt, adjustments, outcomes),
    }
  } catch (error) {
    // Best effort, and said out loud. The delivery is being deleted either way -
    // refusing the delete because the reversal failed would leave the paperwork
    // and the shelf disagreeing in both directions at once.
    console.error('[purchase-orders] could not reverse a delivery off stock', { receipt: receipt.number, error })
    return { error: error instanceof Error ? error.message : 'The stock system would not answer.' }
  }
}

/** One adjustment per stockable line, and a refusal for every line that cannot
 *  become one. A count is a whole number of things; half a metre of cable is a
 *  perfectly good delivery and simply not something a count can hold. */
function planAdjustments(
  receipt: PoReceipt,
  userId: string,
  direction: 1 | -1,
): { adjustments: InventoryAdjustment[]; refused: PoStockLineResult[] } {
  const adjustments: InventoryAdjustment[] = []
  const refused: PoStockLineResult[] = []

  for (const line of receipt.lines) {
    const qty = Number(line.qtyAccepted)
    if (!line.productId || !(qty > 0)) continue
    if (!Number.isInteger(qty)) {
      refused.push({
        orderLineId: line.orderLineId,
        productId: line.productId,
        description: line.description,
        ok: false,
        before: null,
        after: null,
        message: `${qty} is not a whole number, and a stock count only holds whole ones. Adjust this product by hand.`,
      })
      continue
    }
    adjustments.push({
      productId: line.productId,
      delta: qty * direction,
      reason: direction > 0 ? 'purchase-order.receipt' : 'purchase-order.receipt-deleted',
      ref: receipt.number,
      userId,
      note: direction > 0 ? `Booked in on ${receipt.orderNumber}` : `Delivery ${receipt.number} deleted`,
    })
  }
  return { adjustments, refused }
}

/** Puts each outcome back beside the line it came from, for the screen.
 *  The adjuster answers in the order it was asked, which is the order the
 *  stockable lines were planned in. */
function matchOutcomes(
  receipt: PoReceipt,
  adjustments: InventoryAdjustment[],
  outcomes: InventoryAdjustmentOutcome[],
): PoStockLineResult[] {
  const stockable = receipt.lines.filter(
    (l) => l.productId && Number(l.qtyAccepted) > 0 && Number.isInteger(Number(l.qtyAccepted)),
  )
  return adjustments.map((adjustment, index) => {
    const outcome = outcomes[index]
    const line = stockable[index]
    return {
      orderLineId: line?.orderLineId ?? '',
      productId: adjustment.productId,
      description: line?.description ?? '',
      ok: outcome?.ok ?? false,
      before: outcome?.before ?? null,
      after: outcome?.after ?? null,
      message: outcome?.message,
    }
  })
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------
//
// The mirror image of a delivery, with one extra rule: goods can only come OFF a
// count they were put ON. A return raised against a delivery nobody booked onto
// the shelf, or against an order line that never came in on a recorded delivery
// at all, has nothing to deduct - and deducting anyway would invent a shortage
// out of paperwork.

/** Whether this return has anything a stock system could act on. */
export function hasStockableReturnLines(ret: PoReturn): boolean {
  return ret.lines.some((l) => l.productId && l.stockedIn && Number(l.qty) > 0)
}

/**
 * Takes a return's quantities back off the shelf, exactly once.
 *
 * `stock_applied` is claimed FIRST, in a conditional UPDATE, and only then is
 * anything moved - the same shape `applyReceiptStock` uses, because the same two
 * clicks are available here and a count deducted twice is a phantom shortage
 * somebody will spend an afternoon chasing.
 */
export async function applyReturnStock(ret: PoReturn, userId: string): Promise<StockApplyOutcome> {
  const blocked = await stockBlockedReason()
  if (blocked) return { applied: false, reason: blocked }

  const registered = getInventoryAdjuster()
  if (!registered) return { applied: false, reason: 'Nothing on this site keeps stock counts.' }

  if (!hasStockableReturnLines(ret)) {
    return {
      applied: false,
      reason:
        'Nothing on this return came in on a delivery that was added to stock, so there is no count to take it off.',
    }
  }

  if (!(await claimReturnStock(ret.id))) {
    return { applied: false, reason: 'This return has already come off stock.' }
  }

  const { adjustments, refused } = planReturnAdjustments(ret, userId, -1)

  let result: PoStockResult
  try {
    const outcomes = await registered.adjuster.adjust(adjustments)
    result = {
      adjuster: registered.adjuster.label,
      at: new Date().toISOString(),
      byUserId: userId,
      lines: [...refused, ...matchReturnOutcomes(ret, adjustments, outcomes)],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The stock system would not answer.'
    await releaseReturnStock(ret.id, {
      adjuster: registered.adjuster.label,
      at: new Date().toISOString(),
      byUserId: userId,
      error: message,
    })
    return { applied: false, reason: `Stock was not changed: ${message}` }
  }

  await recordReturnStockResult(ret.id, result)
  return { applied: true, result }
}

/**
 * Puts back whatever a return took off, when the return itself is deleted.
 *
 * Best effort and said out loud, exactly as deleting a delivery is: the return is
 * being unfiled on somebody's say-so, and refusing that because a stock system
 * was busy would leave the paperwork and the shelf disagreeing in both
 * directions at once.
 */
export async function reverseReturnStock(ret: PoReturn, userId: string): Promise<PoStockResult | null> {
  if (!ret.stockApplied) return null
  const registered = getInventoryAdjuster()
  if (!registered) return null

  const { adjustments } = planReturnAdjustments(ret, userId, 1)
  if (adjustments.length === 0) return null

  try {
    const outcomes = await registered.adjuster.adjust(adjustments)
    return {
      adjuster: registered.adjuster.label,
      at: new Date().toISOString(),
      byUserId: userId,
      lines: matchReturnOutcomes(ret, adjustments, outcomes),
    }
  } catch (error) {
    console.error('[purchase-orders] could not put a deleted return back on stock', { return: ret.number, error })
    return { error: error instanceof Error ? error.message : 'The stock system would not answer.' }
  }
}

/** The stockable lines of a return, in the order the adjuster will be asked
 *  about them. A line with no product, that never went onto a count, or that is
 *  not a whole number of things cannot become an adjustment. */
function stockableReturnLines(ret: PoReturn) {
  return ret.lines.filter(
    (l) => l.productId && l.stockedIn && Number(l.qty) > 0 && Number.isInteger(Number(l.qty)),
  )
}

function planReturnAdjustments(
  ret: PoReturn,
  userId: string,
  direction: 1 | -1,
): { adjustments: InventoryAdjustment[]; refused: PoStockLineResult[] } {
  const adjustments: InventoryAdjustment[] = []
  const refused: PoStockLineResult[] = []

  for (const line of ret.lines) {
    const qty = Number(line.qty)
    if (!line.productId || !(qty > 0)) continue
    if (!line.stockedIn) {
      refused.push({
        orderLineId: line.orderLineId,
        productId: line.productId,
        description: line.description,
        ok: false,
        before: null,
        after: null,
        message: 'These never went onto a stock count, so there is nothing to take them off.',
      })
      continue
    }
    if (!Number.isInteger(qty)) {
      refused.push({
        orderLineId: line.orderLineId,
        productId: line.productId,
        description: line.description,
        ok: false,
        before: null,
        after: null,
        message: `${qty} is not a whole number, and a stock count only holds whole ones. Adjust this product by hand.`,
      })
      continue
    }
    adjustments.push({
      productId: line.productId,
      delta: qty * direction,
      reason: direction < 0 ? 'purchase-order.return' : 'purchase-order.return-deleted',
      ref: ret.number,
      userId,
      note: direction < 0 ? `Returned to supplier on ${ret.number}` : `Return ${ret.number} deleted`,
    })
  }
  return { adjustments, refused }
}

/** Puts each outcome back beside the line it came from. The adjuster answers in
 *  the order it was asked, which is the order the stockable lines were planned
 *  in. */
function matchReturnOutcomes(
  ret: PoReturn,
  adjustments: InventoryAdjustment[],
  outcomes: InventoryAdjustmentOutcome[],
): PoStockLineResult[] {
  const stockable = stockableReturnLines(ret)
  return adjustments.map((adjustment, index) => {
    const outcome = outcomes[index]
    const line = stockable[index]
    return {
      orderLineId: line?.orderLineId ?? '',
      productId: adjustment.productId,
      description: line?.description ?? '',
      ok: outcome?.ok ?? false,
      before: outcome?.before ?? null,
      after: outcome?.after ?? null,
      message: outcome?.message,
    }
  })
}
