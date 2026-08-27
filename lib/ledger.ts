import { scaled, fromPence } from './totals'
import { PO_VAT_RATE_CODES, PO_VAT_TREATMENTS } from './types'
import type { PoVatRateCode, PoVatTreatment } from './types'

// Turning a supplier's invoice into ledger lines.
//
// Pure, so the rules below can be read and tested without a database and without
// a set of books on the other end. Everything is worked out in integer pence,
// exactly as lib/totals.ts does it, and converted to the site's own currency
// once at the end.
//
// Three rules run this file, and each is here because getting it wrong puts a
// wrong figure on somebody's VAT return:
//
//  1. The VAT that goes to the books is the VAT PRINTED ON THE INVOICE, not the
//     VAT our own arithmetic would have preferred. A supplier who rounds line by
//     line where we round once at the line lands a penny or two out, and the
//     books must agree with the document HMRC would be shown.
//  2. A line that carries no VAT keeps whatever rate it was billed at. Reverse
//     charge is the case that matters: the supplier charges nothing, the books
//     work the notional VAT out themselves from the rate, and a line "corrected"
//     to zero percent would quietly drop it out of boxes 1 and 4.
//  3. Nothing is guessed. An unknown rate code or treatment falls back to a
//     stated default rather than being invented per line.

/** One ledger line, in the site's own currency. The shape the books receive. */
export type PoLedgerLine = {
  description: string
  /** A bookkeeping category id where anybody chose one, null where nobody did. */
  categoryId: string | null
  vatRateCode: PoVatRateCode
  vatTreatment: PoVatTreatment
  ratePercent: string
  net: string
  tax: string
  gross: string
}

/** Treatments under which the supplier charges no VAT and the books compute the
 *  notional figure themselves. A line on one of these never carries tax. */
const NO_VAT_CHARGED: PoVatTreatment[] = ['reverse_charge_services', 'domestic_reverse_charge']

function isRateCode(value: unknown): value is PoVatRateCode {
  return typeof value === 'string' && (PO_VAT_RATE_CODES as readonly string[]).includes(value)
}

function isTreatment(value: unknown): value is PoVatTreatment {
  return typeof value === 'string' && (PO_VAT_TREATMENTS as readonly string[]).includes(value)
}

/**
 * Which rate code a percentage is, when nobody said.
 *
 * The same rule the books' own sales handoff uses, and for the same reason: a
 * supplier knows what it charged, not what HMRC calls it. Anything at or above
 * the reduced band is the standard rate whatever the number happens to be that
 * year, anything between zero and there is a reduced rate, and zero is
 * zero-rated rather than exempt - both carry no VAT, but only a guess could tell
 * them apart and a wrong guess moves money between boxes 7 and nothing at all.
 */
export function rateCodeFor(percent: number): PoVatRateCode {
  if (percent <= 0) return 'zero'
  return percent >= 15 ? 'standard' : 'reduced'
}

/** A description short enough to read in a ledger table. The document itself is
 *  filed as evidence beside it and carries the full thing. */
function ledgerDescription(text: string): string {
  const trimmed = (text || '').trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed
}

type WorkingLine = {
  description: string
  categoryId: string | null
  rateCode: PoVatRateCode
  treatment: PoVatTreatment
  ratePercent: number
  net: number
  tax: number
}

/**
 * Make the lines add up to the VAT printed on the invoice.
 *
 * A penny either way is the ordinary case and lands on whichever line carries
 * the most VAT - the one where a penny is least visible and most likely to be
 * where the supplier's own rounding put it. A stated VAT of nothing is not a
 * rounding difference at all: it is a reverse-charge or zero-rated invoice
 * somebody has overtyped, so every line goes to nil rather than one line going
 * strange.
 *
 * Never leaves a line with negative VAT, and never with more VAT than net: both
 * are refused by the books' own validator, and an entry that cannot be saved is
 * worse than one that is a penny out.
 */
function applyStatedTax(lines: WorkingLine[], statedTax: number | null): void {
  if (statedTax === null) return
  const computed = lines.reduce((sum, line) => sum + line.tax, 0)
  if (computed === statedTax) return

  if (statedTax === 0) {
    for (const line of lines) line.tax = 0
    return
  }

  let delta = statedTax - computed
  const order = [...lines].sort((a, b) => b.tax - a.tax || b.net - a.net)

  // Never below nothing and never above the line's own net: both are figures no
  // VAT rate could produce, and an entry the books refuse to save loses the
  // purchase entirely, which is far worse than an entry that is a penny out.
  const spread = (over: WorkingLine[]): void => {
    for (const line of over) {
      if (delta === 0) return
      const room = delta > 0 ? Math.max(0, line.net - line.tax) : -line.tax
      const move = delta > 0 ? Math.min(delta, room) : Math.max(delta, room)
      line.tax += move
      delta -= move
    }
  }

  // A line billed at no rate at all is not where a VAT difference belongs -
  // unless there is nowhere else for it to go, which is the whole-invoice
  // zero-rated case with a VAT figure typed onto it anyway.
  spread(order.filter((line) => line.ratePercent > 0 || line.tax !== 0))
  if (delta !== 0) spread(order)
}

/** Base currency per 1 unit of the supplier's currency, as the bill stores it. */
function convert(pence: number, fx: number): number {
  if (fx === 100_000_000) return pence
  return Math.round((pence * fx) / 100_000_000)
}

/**
 * The rate code a line can honestly go to the books under.
 *
 * The money is the truth. A line that ended up carrying VAT cannot be filed as
 * zero-rated, exempt or outside the scope - the books refuse it, and rightly:
 * there would be a figure in box 4 with no rate behind it. Standard is the
 * fallback where the line was billed at no rate at all and yet has VAT on it,
 * which only happens when somebody has overtyped the invoice total.
 */
function codeForMoney(code: PoVatRateCode, ratePercent: number, tax: number): PoVatRateCode {
  if (tax === 0) return code
  if (code === 'standard' || code === 'reduced') return code
  return ratePercent > 0 ? rateCodeFor(ratePercent) : 'standard'
}

function finish(lines: WorkingLine[], fx: number): PoLedgerLine[] {
  const out: PoLedgerLine[] = []
  for (const line of lines) {
    const net = convert(line.net, fx)
    const tax = convert(line.tax, fx)
    if (net === 0 && tax === 0) continue
    out.push({
      description: ledgerDescription(line.description),
      categoryId: line.categoryId,
      vatRateCode: codeForMoney(line.rateCode, line.ratePercent, tax),
      vatTreatment: line.treatment,
      ratePercent: (line.ratePercent / 100).toFixed(2),
      net: fromPence(net),
      tax: fromPence(tax),
      gross: fromPence(net + tax),
    })
  }
  return out
}

export type BillLedgerLine = {
  description: string
  /** The line's net, to the penny, as the bill stored it. */
  lineTotal: string | number
  taxRatePercent?: string | number | null
  taxRateCode?: string | null
  vatTreatment?: string | null
  categoryId?: string | null
}

export type BillLedgerInput = {
  lines: BillLedgerLine[]
  carriageAmount?: string | number | null
  /** What the invoice says the VAT is. Null means "use ours". */
  statedTax?: string | number | null
  /** Base currency per 1 unit of the bill's currency. */
  fxRate?: string | number | null
  /** Where a line that names no category of its own is filed. */
  defaultCategoryId?: string | null
  /** What a line that names no treatment of its own is. */
  defaultVatTreatment?: string | null
  defaultVatRateCode?: string | null
  carriageDescription?: string
}

/**
 * One supplier bill as ledger lines, in the site's own currency.
 *
 * One line per line on the invoice, because a bill line already carries its own
 * category and its own VAT treatment - which is exactly what an accountant wants
 * and what a lump per VAT rate throws away. Carriage becomes a line of its own,
 * at the highest rate on the bill, which is the treatment HMRC expect when
 * delivery is ancillary to the goods.
 */
export function billLedgerLines(input: BillLedgerInput): PoLedgerLine[] {
  const fallbackTreatment = isTreatment(input.defaultVatTreatment)
    ? input.defaultVatTreatment
    : 'domestic'
  const fallbackCode = isRateCode(input.defaultVatRateCode) ? input.defaultVatRateCode : null
  const defaultCategoryId = input.defaultCategoryId?.trim() || null

  const working: WorkingLine[] = input.lines.map((line) => {
    const ratePercent = scaled(line.taxRatePercent ?? 0, 2)
    const net = scaled(line.lineTotal, 2)
    const treatment = isTreatment(line.vatTreatment) ? line.vatTreatment : fallbackTreatment
    const rateCode = isRateCode(line.taxRateCode)
      ? line.taxRateCode
      : (fallbackCode ?? rateCodeFor(ratePercent))
    return {
      description: line.description,
      categoryId: line.categoryId?.trim() || defaultCategoryId,
      rateCode,
      treatment,
      ratePercent,
      // Reverse charge: the supplier charged nothing, so the line carries
      // nothing. The books work the notional figure out from the rate.
      tax: NO_VAT_CHARGED.includes(treatment) ? 0 : Math.round((net * ratePercent) / 10_000),
      net,
    }
  })

  const carriage = scaled(input.carriageAmount ?? 0, 2)
  if (carriage !== 0) {
    const rate = working.reduce((max, line) => Math.max(max, line.ratePercent), 0)
    const treatment = fallbackTreatment
    working.push({
      description: input.carriageDescription ?? 'Carriage',
      categoryId: defaultCategoryId,
      rateCode: fallbackCode ?? rateCodeFor(rate),
      treatment,
      ratePercent: rate,
      tax: NO_VAT_CHARGED.includes(treatment) ? 0 : Math.round((carriage * rate) / 10_000),
      net: carriage,
    })
  }

  const stated =
    input.statedTax === null || input.statedTax === undefined || String(input.statedTax) === ''
      ? null
      : scaled(input.statedTax, 2)
  applyStatedTax(working, stated)

  return finish(working, scaled(input.fxRate ?? 1, 8))
}

export type ReturnLedgerLine = {
  description: string
  lineTotal: string | number
  taxRatePercent?: string | number | null
  taxRateCode?: string | null
  vatTreatment?: string | null
  categoryId?: string | null
}

export type ReturnLedgerInput = {
  lines: ReturnLedgerLine[]
  /** What the supplier actually credited, gross. */
  creditReceived: string | number
  fxRate?: string | number | null
  defaultCategoryId?: string | null
  defaultVatTreatment?: string | null
  defaultVatRateCode?: string | null
}

/**
 * One supplier credit as ledger lines, in the site's own currency.
 *
 * Every figure comes back POSITIVE. The books negate, exactly as they already do
 * for a credit note against a sale - a credit is a reduction of an expense, and
 * which side of the entry that lands on is the ledger's business, not this
 * module's.
 *
 * A supplier who credits less than was claimed is the case worth explaining. The
 * lines are scaled to what actually arrived rather than posted at what was
 * asked for, because the books have to say what happened. Pro-rata across the
 * lines, keeping each line's own VAT rate, and the pennies swept onto the
 * largest line so the entry comes to exactly the credit received. Where the
 * supplier credited particular lines rather than a share of all of them, the
 * honest fix is to correct the return's lines before marking it credited - the
 * return note is the document, and this only ever repeats it.
 */
export function returnLedgerLines(input: ReturnLedgerInput): PoLedgerLine[] {
  const fallbackTreatment = isTreatment(input.defaultVatTreatment)
    ? input.defaultVatTreatment
    : 'domestic'
  const fallbackCode = isRateCode(input.defaultVatRateCode) ? input.defaultVatRateCode : null
  const defaultCategoryId = input.defaultCategoryId?.trim() || null

  const working: WorkingLine[] = input.lines.map((line) => {
    const ratePercent = scaled(line.taxRatePercent ?? 0, 2)
    const net = scaled(line.lineTotal, 2)
    const treatment = isTreatment(line.vatTreatment) ? line.vatTreatment : fallbackTreatment
    return {
      description: line.description,
      categoryId: line.categoryId?.trim() || defaultCategoryId,
      rateCode: isRateCode(line.taxRateCode)
        ? line.taxRateCode
        : (fallbackCode ?? rateCodeFor(ratePercent)),
      treatment,
      ratePercent,
      tax: NO_VAT_CHARGED.includes(treatment) ? 0 : Math.round((net * ratePercent) / 10_000),
      net,
    }
  })

  const claimed = working.reduce((sum, line) => sum + line.net + line.tax, 0)
  const received = Math.max(0, scaled(input.creditReceived, 2))
  if (received === 0) return []

  if (claimed > 0 && received !== claimed) {
    let net = 0
    let tax = 0
    for (const line of working) {
      line.net = Math.round((line.net * received) / claimed)
      line.tax = Math.round((line.tax * received) / claimed)
      net += line.net
      tax += line.tax
    }
    // The pennies the scaling lost, onto the biggest line, so the entry comes to
    // exactly what the supplier credited rather than a penny under it.
    const drift = received - (net + tax)
    if (drift !== 0) {
      const biggest = [...working].sort((a, b) => b.net - a.net)[0]
      if (biggest) biggest.net += drift
    }
  }

  return finish(working, scaled(input.fxRate ?? 1, 8))
}

/** What a set of ledger lines comes to, for the sentence the screen shows. */
export function ledgerTotals(lines: PoLedgerLine[]): { net: string; tax: string; gross: string } {
  const net = lines.reduce((sum, line) => sum + scaled(line.net, 2), 0)
  const tax = lines.reduce((sum, line) => sum + scaled(line.tax, 2), 0)
  return { net: fromPence(net), tax: fromPence(tax), gross: fromPence(net + tax) }
}
