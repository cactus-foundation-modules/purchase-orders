import { lineAmounts, fromPence, scaled } from './totals'
import type { PoAccess } from './permissions'
import type {
  PoBillStatus,
  PoBillVariance,
  PoBillableLine,
  PoMatchStatus,
} from './types'

// Supplier bills: the arithmetic, the match and the rules, kept away from the
// database and the screens so both use exactly the same answer.
//
// A bill is the one document in this module whose figures are NOT ours. The
// order says what we asked for, the delivery says what turned up, and the bill
// says what the supplier thinks we owe - and the whole point of the exercise is
// that those three are allowed to disagree. So, unlike a return note, quantities
// and unit costs here really do come off the form: they are being copied off a
// piece of paper somebody else wrote. What must not be typed is the ARITHMETIC,
// which is why every line total and every subtotal below comes through
// lib/totals.ts, the same file the order uses.

// ---------------------------------------------------------------------------
// The money
// ---------------------------------------------------------------------------

export type BillTotalsLine = {
  qty: string | number
  unitCost: string | number
  taxRatePercent?: string | number | null
}

export type BillTotalsInput = {
  lines: BillTotalsLine[]
  carriageAmount?: string | number | null
  carriageTaxRatePercent?: string | number | null
  /**
   * The VAT figure printed on the supplier's own invoice, where somebody has
   * overtyped ours. A supplier who rounds line by line where we round once at
   * the line lands a penny or two out on a long invoice, and the figure that
   * goes to the books has to be the one on the document HMRC would be shown -
   * not the one we would have preferred.
   */
  taxOverride?: string | number | null
}

export type BillTotals = {
  subtotal: string
  carriageAmount: string
  /** What our own arithmetic makes of the VAT, whatever was typed. */
  computedTax: string
  taxAmount: string
  total: string
  lineTotals: string[]
}

/** What a supplier's invoice comes to. Always EXCLUSIVE: an invoice states its
 *  net, its VAT and its total separately, which is rather the point of it. */
export function billTotals(input: BillTotalsInput): BillTotals {
  const amounts = input.lines.map((line) => lineAmounts(line, 'EXCLUSIVE'))
  const net = amounts.reduce((sum, a) => sum + a.net, 0)
  let tax = amounts.reduce((sum, a) => sum + a.tax, 0)

  const carriage = scaled(input.carriageAmount ?? 0, 2)
  // Carriage is taxed at its own rate, defaulting to the highest rate on the
  // bill - the treatment HMRC expect when delivery is ancillary to the goods.
  const carriageRate =
    input.carriageTaxRatePercent != null && String(input.carriageTaxRatePercent) !== ''
      ? scaled(input.carriageTaxRatePercent, 2)
      : input.lines.reduce((max, l) => Math.max(max, scaled(l.taxRatePercent ?? 0, 2)), 0)
  if (carriage !== 0 && carriageRate !== 0) {
    tax += Math.round((carriage * carriageRate) / 10_000)
  }

  const computedTax = tax
  const stated =
    input.taxOverride === null || input.taxOverride === undefined || String(input.taxOverride) === ''
      ? null
      : scaled(input.taxOverride, 2)
  const finalTax = stated ?? computedTax

  return {
    subtotal: fromPence(net),
    carriageAmount: fromPence(carriage),
    computedTax: fromPence(computedTax),
    taxAmount: fromPence(finalTax),
    total: fromPence(net + carriage + finalTax),
    lineTotals: amounts.map((a) => a.lineTotal),
  }
}

/**
 * When a bill falls due: the invoice date plus the supplier's terms.
 *
 * Off the INVOICE date rather than the day it was typed in. A supplier's invoice
 * dated the second of the month and opened on the twentieth is due thirty days
 * after the second, and paying it thirty days after the twentieth is how a
 * account goes on stop.
 */
export function dueDateFor(invoiceDate: string, termsDays: number | null | undefined): string | null {
  const days = Number(termsDays)
  if (!Number.isFinite(days) || days <= 0) return null
  const date = new Date(`${invoiceDate.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null
  date.setUTCDate(date.getUTCDate() + Math.trunc(days))
  return date.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// The three-way match
// ---------------------------------------------------------------------------
//
// Ordered, received, invoiced. The one instinct to keep straight here is the
// opposite of the one returns needed: over-INVOICING is a FLAG, never a refusal.
// A supplier who bills for twelve when ten were delivered has not broken the
// software, they have made a claim somebody now has to look at - and refusing to
// record the claim would simply mean the disagreement lives in an inbox instead
// of on the bill where it belongs.

export type MatchOrderLine = {
  id: string
  description: string
  /** Ordered. */
  qty: string
  qtyCancelled: string
  qtyReceived: string
  /** Already invoiced on OTHER bills. This bill's own lines are never in here. */
  qtyInvoicedElsewhere: string
  unitCost: string
}

export type MatchBillLine = {
  orderLineId: string | null
  description: string
  qty: string
  unitCost: string
}

export type MatchTolerances = {
  /** How far a unit cost may drift from the order before it is worth saying. */
  pricePercent: number
  /** How far past what was delivered a quantity may go before it is worth saying. */
  quantityPercent: number
}

export type BillMatch = {
  status: PoMatchStatus
  flags: PoBillVariance[]
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function money(pence: number): string {
  return fromPence(pence)
}

/** A quantity as a person would write it: 3.000 reads as 3, 2.500 as 2.5. */
function qtyWords(value: number): string {
  return String(Number(value.toFixed(3)))
}

/**
 * What this bill disagrees with, and by how much.
 *
 * A bill with no order behind it is `NOT_MATCHED` and carries no flags at all -
 * there is nothing to check it against, and calling that "matched" would be a
 * lie told by a green badge. A bill against an order with nothing to say is
 * `MATCHED`; anything else is `VARIANCE` and the flags say why.
 */
export function matchBill(
  hasOrder: boolean,
  orderLines: MatchOrderLine[],
  billLines: MatchBillLine[],
  tolerances: MatchTolerances,
): BillMatch {
  if (!hasOrder) return { status: 'NOT_MATCHED', flags: [] }

  const byId = new Map(orderLines.map((l) => [l.id, l]))
  const flags: PoBillVariance[] = []
  const priceTolerance = Math.max(0, Number(tolerances.pricePercent) || 0)
  const qtyTolerance = Math.max(0, Number(tolerances.quantityPercent) || 0)

  // How much of each order line THIS bill is claiming, across however many bill
  // lines point at it. Two lines against one order line is ordinary - a delivery
  // split over two pallets often is - and checking each in isolation would miss
  // the pair of them together going past what turned up.
  const claimed = new Map<string, { qty: number; cost: number }>()

  for (const line of billLines) {
    const qty = Number(line.qty) || 0
    const unit = Number(line.unitCost) || 0

    if (!line.orderLineId || !byId.has(line.orderLineId)) {
      // A charge on the invoice that is on no order line. Pallet fees, fuel
      // surcharges and "sundry" live here, and every one of them is worth a look.
      if (qty === 0 && unit === 0) continue
      flags.push({
        kind: 'NOT_ORDERED',
        orderLineId: null,
        description: line.description,
        amount: money(lineAmounts({ qty, unitCost: unit }, 'EXCLUSIVE').net),
        message: `“${line.description}” is on this invoice but not on the order.`,
      })
      continue
    }

    const current = claimed.get(line.orderLineId) ?? { qty: 0, cost: unit }
    claimed.set(line.orderLineId, { qty: current.qty + qty, cost: unit })

    // Price is judged per bill line rather than per order line: two lines at two
    // different costs against one order line are two separate arguments.
    const orderLine = byId.get(line.orderLineId)!
    const ordered = Number(orderLine.unitCost) || 0
    if (qty > 0) {
      const drift = ordered === 0 ? (unit === 0 ? 0 : 100) : (Math.abs(unit - ordered) / ordered) * 100
      if (drift > priceTolerance + 1e-9) {
        flags.push({
          kind: 'PRICE',
          orderLineId: line.orderLineId,
          description: line.description || orderLine.description,
          // unit(4dp) x qty(3dp) = 7dp, rounded to the penny once. Signed:
          // positive means the supplier wants more than the order said.
          amount: money(Math.round(((scaled(unit, 4) - scaled(ordered, 4)) * scaled(qty, 3)) / 100_000)),
          message:
            `${line.description || orderLine.description}: the order says ${ordered} each, ` +
            `the invoice says ${unit} each.`,
        })
      }
    }
  }

  // Quantity, once per order line, against what actually turned up.
  for (const [orderLineId, mine] of claimed) {
    const orderLine = byId.get(orderLineId)!
    if (mine.qty <= 0) continue

    const received = Number(orderLine.qtyReceived) || 0
    const elsewhere = Number(orderLine.qtyInvoicedElsewhere) || 0
    const invoiced = elsewhere + mine.qty
    const allowed = received * (1 + qtyTolerance / 100)

    if (round3(invoiced) <= round3(allowed)) continue

    const overBy = round3(invoiced - received)
    const amount = money(Math.round((scaled(mine.cost, 4) * scaled(overBy, 3)) / 100_000))

    if (received === 0) {
      flags.push({
        kind: 'NOT_RECEIVED',
        orderLineId,
        description: orderLine.description,
        amount,
        message:
          `${orderLine.description}: invoiced for ${qtyWords(invoiced)}, and nothing has been booked in yet.`,
      })
      continue
    }

    flags.push({
      kind: 'QUANTITY',
      orderLineId,
      description: orderLine.description,
      amount,
      message:
        `${orderLine.description}: invoiced for ${qtyWords(invoiced)}, ` +
        `but only ${qtyWords(received)} turned up.`,
    })
  }

  return { status: flags.length === 0 ? 'MATCHED' : 'VARIANCE', flags }
}

/** What the whole disagreement is worth, for the one line the screen leads with. */
export function varianceTotal(flags: PoBillVariance[]): string {
  return fromPence(flags.reduce((sum, flag) => sum + scaled(flag.amount, 2), 0))
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------
//
// Shorter than the order's, and every move needs `purchase-orders.bills`:
// agreeing to pay somebody is a different job from raising the order or booking
// the goods in, which is exactly why it is a permission of its own.
//
// POSTED is deliberately not one of these. It is not a decision anybody makes:
// it is what a set of books accepting the entry looks like from here, so it is
// written by the handoff and by nothing else. A status that says an entry is in
// the books when no books were ever written to would be the worst kind of lie.

export type PoBillTransition = 'query' | 'resolve' | 'approve' | 'unapprove' | 'void'

type Rule = {
  from: readonly PoBillStatus[]
  to: PoBillStatus
  label: string
}

export const BILL_TRANSITIONS: Record<PoBillTransition, Rule> = {
  query: { from: ['DRAFT', 'APPROVED'], to: 'QUERIED', label: 'Queried with the supplier' },
  resolve: { from: ['QUERIED'], to: 'DRAFT', label: 'Query settled' },
  // Approving straight from QUERIED as well as from DRAFT: most queries end with
  // the supplier explaining themselves rather than reissuing anything, and
  // making somebody click "settled" first is a click that teaches nobody
  // anything.
  approve: { from: ['DRAFT', 'QUERIED'], to: 'APPROVED', label: 'Approved to pay' },
  unapprove: { from: ['APPROVED'], to: 'DRAFT', label: 'Approval taken back' },
  // Voiding is allowed from POSTED as well, and it is the ONLY way out of it.
  // An entry is in a set of books by then, so the way back is a message saying
  // so - which voiding sends - rather than an approval quietly taken back while
  // the books go on believing the invoice stands.
  void: { from: ['DRAFT', 'QUERIED', 'APPROVED', 'POSTED'], to: 'VOID', label: 'Voided' },
}

export type BillTransitionCheck =
  | { ok: true; to: PoBillStatus; label: string }
  | { ok: false; reason: string }

function words(status: PoBillStatus): string {
  return status.toLowerCase().replace(/_/g, ' ')
}

export function checkBillTransition(
  transition: PoBillTransition,
  from: PoBillStatus,
  access: PoAccess,
): BillTransitionCheck {
  const rule = BILL_TRANSITIONS[transition]
  if (!rule) return { ok: false, reason: 'That is not something a bill can do.' }
  if (!access.canBills) return { ok: false, reason: 'You do not have permission to do that.' }
  if (!rule.from.includes(from)) {
    return { ok: false, reason: `A bill that is ${words(from)} cannot be ${rule.label.toLowerCase()}.` }
  }
  return { ok: true, to: rule.to, label: rule.label }
}

/** Which moves this user could make on a bill in this state, for the buttons. */
export function availableBillTransitions(from: PoBillStatus, access: PoAccess): PoBillTransition[] {
  return (Object.keys(BILL_TRANSITIONS) as PoBillTransition[]).filter(
    (t) => checkBillTransition(t, from, access).ok,
  )
}

/**
 * Whether a bill may still be changed.
 *
 * Up to approval, yes. After it, no: somebody has said this is what we owe, and
 * a figure that can be edited afterwards is a figure nobody has really approved.
 * Take the approval back first, which is recorded.
 */
export function isBillEditable(status: PoBillStatus): boolean {
  return status === 'DRAFT' || status === 'QUERIED'
}

/** Whether the match on this bill is still worth recomputing, or is now history.
 *  Once approved, the recorded variance is what somebody agreed to pay in spite
 *  of - a later delivery must not quietly tidy it away. */
export function isMatchLive(status: PoBillStatus): boolean {
  return isBillEditable(status)
}

/**
 * Whether this bill could be sent to a set of books.
 *
 * Approved, because nothing goes to the books until somebody has agreed to pay
 * it. And posted, because the retry has to work twice: the entry lands, the
 * supplier's PDF fails to attach behind it, and pressing the button again is how
 * that gets put right. The books' own side is idempotent, so a second go records
 * nothing twice.
 */
export function isBillPostable(status: PoBillStatus): boolean {
  return status === 'APPROVED' || status === 'POSTED'
}

// ---------------------------------------------------------------------------
// Checking a bill before it is written
// ---------------------------------------------------------------------------

export type BillLineDraft = {
  orderLineId: string | null
  description: string
  qty: string
  unitCost: string
  taxRatePercent: string
  taxRateCode: string | null
  vatTreatment: string | null
  categoryId: string | null
}

export type ValidatedBill = { ok: false; reason: string } | { ok: true; lines: BillLineDraft[] }

/**
 * Every line has to say what it is for and be against a line of THIS order,
 * where it claims to be against one at all.
 *
 * The ids come off the wire and po_bill_lines has no idea which order its
 * parent belongs to, so an id from somebody else's order would otherwise attach
 * a charge to a different purchase order entirely. An id that is not on this
 * order is dropped to null - the charge stays on the bill, and the match then
 * flags it as something nobody ordered, which is the honest answer.
 */
export function validateBillDrafts(
  billable: PoBillableLine[],
  drafts: BillLineDraft[],
): ValidatedBill {
  const byId = new Map(billable.map((l) => [l.orderLineId, l]))
  const lines: BillLineDraft[] = []

  for (const draft of drafts) {
    const description = draft.description.trim() || byId.get(draft.orderLineId ?? '')?.description || ''
    if (!description) {
      return { ok: false, reason: 'Every line on a bill needs to say what it is for.' }
    }
    if (Number(draft.qty) <= 0) {
      return { ok: false, reason: `“${description}” has no quantity on it. Take the line off, or put a figure on it.` }
    }
    lines.push({
      ...draft,
      description,
      orderLineId: draft.orderLineId && byId.has(draft.orderLineId) ? draft.orderLineId : null,
    })
  }

  if (lines.length === 0) {
    return { ok: false, reason: 'A bill needs at least one line on it.' }
  }
  return { ok: true, lines }
}

// ---------------------------------------------------------------------------
// What a bill does to the order behind it
// ---------------------------------------------------------------------------

export type InvoicedLine = {
  qty: string
  qtyCancelled: string
  qtyReceived: string
  qtyInvoiced: string
}

/** Whether every live line on an order has now been invoiced in full. */
export function fullyInvoiced(lines: InvoicedLine[]): boolean {
  const live = lines.filter((l) => Number(l.qty) - Number(l.qtyCancelled) > 0)
  if (live.length === 0) return false
  return live.every((l) => round3(Number(l.qtyInvoiced)) >= round3(Number(l.qty) - Number(l.qtyCancelled)))
}

/**
 * Whether an order can now be put to bed on its own.
 *
 * Only from RECEIVED, only when every line has been invoiced in full, and only
 * when nobody is still waiting on a credit. Closing an order with an open return
 * on it would file away the one screen showing that a supplier owes money -
 * which is exactly the thing the returns tab exists to stop happening quietly.
 */
export function shouldAutoClose(
  status: string,
  lines: InvoicedLine[],
  openReturns: number,
): boolean {
  if (status !== 'RECEIVED') return false
  if (openReturns > 0) return false
  return fullyInvoiced(lines)
}
