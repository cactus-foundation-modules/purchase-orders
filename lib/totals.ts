// Order arithmetic, in one place, done in integer minor units.
//
// Money is never added up in floating point here. Every figure arrives as a
// decimal string, is scaled to whole pence (or to whole ten-thousandths for a
// unit cost, which is held to four places because supplier costs routinely go
// below the penny), added as integers, and rendered back as a fixed-2 string.
// The order screen, the document and the bill match all read the same numbers
// because they all come through this file.

/** Decimal string -> integer at `places` decimal places, rounded half away from zero. */
export function scaled(value: string | number | null | undefined, places: number): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0)
  if (!Number.isFinite(n)) return 0
  const factor = 10 ** places
  return Math.round(n * factor)
}

/** Integer pence -> "12.34". */
export function fromPence(pence: number): string {
  return (pence / 100).toFixed(2)
}

export type TotalsLineInput = {
  qty: string | number
  unitCost: string | number
  discountPercent?: string | number | null
  taxRatePercent?: string | number | null
}

export type LineAmounts = {
  /** Net of the line discount, to the penny. */
  lineTotal: string
  net: number
  tax: number
}

/**
 * One line's net and tax, in pence.
 *
 * Quantities carry three decimal places and unit costs four, so the raw product
 * is worked out at seven and rounded to the penny ONCE, at the line. Rounding
 * per unit first is how an order for 250 of something at £1.005 comes out a
 * pound light against the supplier's own invoice.
 */
export function lineAmounts(line: TotalsLineInput, taxMode: 'EXCLUSIVE' | 'INCLUSIVE'): LineAmounts {
  const qty = scaled(line.qty, 3)
  const unit = scaled(line.unitCost, 4)
  const discount = scaled(line.discountPercent ?? 0, 2)
  const rate = scaled(line.taxRatePercent ?? 0, 2)

  // qty(3dp) * unit(4dp) = 7dp. Take off the discount, then round to pence.
  const gross7 = qty * unit
  const afterDiscount7 = discount === 0 ? gross7 : gross7 - Math.round((gross7 * discount) / 10_000)
  const rounded = Math.round(afterDiscount7 / 100_000)

  if (taxMode === 'INCLUSIVE') {
    // The figure typed in already has tax in it: pull the tax back out rather
    // than adding more on top.
    const net = Math.round((rounded * 10_000) / (10_000 + rate))
    return { lineTotal: fromPence(net), net, tax: rounded - net }
  }

  const tax = Math.round((rounded * rate) / 10_000)
  return { lineTotal: fromPence(rounded), net: rounded, tax }
}

export type OrderTotalsInput = {
  lines: TotalsLineInput[]
  taxMode: 'EXCLUSIVE' | 'INCLUSIVE'
  discountAmount?: string | number | null
  carriageAmount?: string | number | null
  carriageTaxRatePercent?: string | number | null
}

export type OrderTotals = {
  subtotal: string
  discountAmount: string
  carriageAmount: string
  taxAmount: string
  total: string
  lineTotals: string[]
}

/**
 * The whole order.
 *
 * An order-level discount is taken off the net subtotal and its tax is reduced
 * in the same proportion, which is what a supplier's own settlement discount
 * does to a VAT total. Carriage is taxed at its own rate, defaulting to the
 * highest rate on the order - the treatment HMRC expect when delivery is
 * ancillary to what is being delivered.
 */
export function orderTotals(input: OrderTotalsInput): OrderTotals {
  const amounts = input.lines.map((l) => lineAmounts(l, input.taxMode))
  const net = amounts.reduce((sum, a) => sum + a.net, 0)
  let tax = amounts.reduce((sum, a) => sum + a.tax, 0)

  const discount = Math.max(0, scaled(input.discountAmount ?? 0, 2))
  const cappedDiscount = Math.min(discount, net)
  if (cappedDiscount > 0 && net > 0) {
    tax -= Math.round((tax * cappedDiscount) / net)
  }

  const carriage = scaled(input.carriageAmount ?? 0, 2)
  const carriageRate =
    input.carriageTaxRatePercent != null
      ? scaled(input.carriageTaxRatePercent, 2)
      : input.lines.reduce((max, l) => Math.max(max, scaled(l.taxRatePercent ?? 0, 2)), 0)
  if (carriage !== 0 && carriageRate !== 0) {
    tax += Math.round((carriage * carriageRate) / 10_000)
  }

  const total = net - cappedDiscount + carriage + tax

  return {
    subtotal: fromPence(net),
    discountAmount: fromPence(cappedDiscount),
    carriageAmount: fromPence(carriage),
    taxAmount: fromPence(tax),
    total: fromPence(total),
    lineTotals: amounts.map((a) => a.lineTotal),
  }
}
