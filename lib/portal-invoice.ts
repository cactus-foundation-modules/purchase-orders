import type { BillLineDraft } from './billing'
import { qtyProblem, qtyThousandths } from './portal-view'
import type { PoBillableLine } from './types'

// What a supplier ticking off their own invoice turns into.
//
// CLIENT-SAFE, like lib/portal-view.ts and for the same reason: the panel runs
// these checks as they type, and the route runs them again on what arrives. A
// check only the browser does is not a check.
//
// The one thing worth being blunt about is where the MONEY comes from. It does
// not come from the supplier. Every line is priced at what the ORDER says, at
// the VAT rate the order says, in the order's own currency - because that is
// what was agreed, and a form that let a supplier type their own prices into our
// records unattended would be a form for repricing an order after the fact.
//
// What they do send is the total off their document, and that is not used as a
// figure at all: it is stored beside our arithmetic, and where the two disagree
// the bill says so. A supplier who has genuinely charged something else has said
// so on their own invoice, and somebody here reads it - which is the entire
// point of the order going to "pending close" rather than closing itself.

/** One line of the order, as the supplier ticked it. */
export type PortalInvoiceTick = { lineId: string; qty: string }

export type PortalInvoiceLines =
  | { ok: false; reason: string }
  | { ok: true; lines: BillLineDraft[] }

/** The bookkeeping defaults a line falls back to, exactly as the admin bill
 *  screen fills them in: the supplier's own first, then the site's. */
export type PortalInvoiceDefaults = {
  categoryId?: string | null
  vatTreatment?: string | null
  vatRateCode?: string | null
}

/** What is still left to invoice on one line: what was ordered, less anything
 *  given up on, less whatever has already been billed on any other invoice. */
export function leftToInvoice(line: PoBillableLine): number {
  const live = Number(line.qtyOrdered) - Number(line.qtyCancelled)
  const already = Number(line.qtyInvoiced)
  const left = live - already
  return Number.isFinite(left) ? Math.max(0, left) : 0
}

/**
 * The lines of the bill a supplier's ticks describe, or the one sentence saying
 * why there are none.
 *
 * Every refusal is something they can act on, because they are the ones who have
 * to act on it. Nothing here throws.
 */
export function portalInvoiceLines(
  billable: PoBillableLine[],
  ticks: PortalInvoiceTick[],
  defaults: PortalInvoiceDefaults = {},
): PortalInvoiceLines {
  const byId = new Map(billable.map((line) => [line.orderLineId, line]))
  const seen = new Set<string>()
  const lines: BillLineDraft[] = []

  for (const tick of ticks) {
    const source = byId.get(tick.lineId)
    // An id that is not on this order. The panel cannot produce one, so this is
    // something posted round it - and the same flat 404-ish answer everything
    // else on the portal gives, rather than a description of what went wrong.
    if (!source) return { ok: false, reason: 'One of those lines is not on this order.' }
    if (seen.has(tick.lineId)) {
      return { ok: false, reason: `${source.description} is on this invoice twice. Put it down once.` }
    }
    seen.add(tick.lineId)

    const left = leftToInvoice(source)
    const problem = qtyProblem(
      tick.qty,
      left,
      { description: source.description, unit: source.unit },
      'invoicing',
    )
    if (problem) return { ok: false, reason: problem }
    if (qtyThousandths(tick.qty) <= 0) continue

    lines.push({
      orderLineId: source.orderLineId,
      description: source.description,
      qty: tick.qty.trim(),
      // The ORDER's price and the ORDER's rate. Never theirs - see the note at
      // the top of this file.
      unitCost: source.unitCost,
      taxRatePercent: source.taxRatePercent,
      taxRateCode: source.taxRateCode ?? defaults.vatRateCode ?? null,
      vatTreatment: source.vatTreatment ?? defaults.vatTreatment ?? null,
      categoryId: source.categoryId ?? defaults.categoryId ?? null,
    })
  }

  if (lines.length === 0) {
    return { ok: false, reason: 'Tick what this invoice covers, and put a quantity against it.' }
  }
  return { ok: true, lines }
}

/** Whether there is anything left on this order for a supplier to invoice at
 *  all. Nothing left is a button that does not appear, rather than a dialog with
 *  an empty list in it. */
export function anythingToInvoice(billable: PoBillableLine[]): boolean {
  return billable.some((line) => leftToInvoice(line) > 0)
}
