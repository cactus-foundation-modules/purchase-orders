// Rendering money on a purchase order.
//
// This module is standalone: it may be installed on a site with no shop at all,
// so it cannot borrow the shop's own formatter and must not import one from a
// directory that does not exist at build time on such a site.
//
// A purchase order carries a CURRENCY CODE rather than a symbol - a supplier in
// Poland invoices in PLN whatever the site's own currency is - so the symbol is
// looked up here. An unknown code prints as the code itself followed by the
// figure ("SEK 1,240.00"), which is what an accounts department would write and
// is never wrong, where guessing at a symbol easily is.
//
// The locale is pinned to en-GB rather than left to the runtime's default. It
// has to be: this runs on the server for the RSC pass and again in the browser
// for the editor canvas, and a server that thinks it is in Germany would render
// "1.600,00" into HTML React then re-renders as "1,600.00".

import { fromPence, scaled } from '@/modules/purchase-orders/lib/totals'

const SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  AUD: '$',
  CAD: '$',
  NZD: '$',
  JPY: '¥',
  CNY: '¥',
  CHF: 'CHF ',
  SEK: 'kr ',
  NOK: 'kr ',
  DKK: 'kr ',
  PLN: 'zł ',
}

/** The symbol for a currency code, or the code and a space when there is none. */
export function currencySymbol(code: string | null | undefined): string {
  const key = (code ?? '').trim().toUpperCase()
  if (!key) return '£'
  return SYMBOLS[key] ?? `${key} `
}

/** "£1,600.00". Nullish or non-numeric formats as zero rather than as nothing:
 *  a blank where a figure belongs on an order is worse than an honest 0.00. */
export function formatMoney(amount: string | number | null | undefined, code?: string | null): string {
  const n = Number(amount)
  const value = Number.isFinite(n) ? n : 0
  return `${currencySymbol(code)}${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** A quantity, with its trailing zeroes taken off. The column is numeric(12,3),
 *  so "4" arrives as "4.000" and reads as a measurement rather than a count. */
export function formatQty(value: string | number | null | undefined): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-GB', { maximumFractionDigits: 3 })
}

/**
 * The delivery service on a line, and what it costs, as one sentence.
 *
 * The cost is per unit and is NOT in the line total - it is summed into the
 * order's carriage - so the wording says so rather than leaving a supplier to
 * add it on themselves. Where the line is for more than one, both figures are
 * given: the unit rate is what a price list is checked against, the extended
 * one is the slice of the carriage this line accounts for.
 *
 * Shared by the printed document and the email so the two cannot word the same
 * line differently.
 */
export function serviceLineText(
  serviceName: string | null,
  serviceCost: string | null,
  qty: string | number | null | undefined,
  code?: string | null,
): string | null {
  const name = serviceName?.trim() || (serviceCost ? 'Delivery' : '')
  if (!name) return null
  const unit = Number(serviceCost)
  if (!Number.isFinite(unit) || unit <= 0) return name
  const count = Number(qty)
  const each = formatMoney(unit, code)
  if (!Number.isFinite(count) || count <= 1) return `${name} - ${each} in carriage`
  // Extended the same way carriageFor sums it - ten-thousandths, rounded to the
  // penny once - so the figure on the line and the carriage at the foot are
  // arrived at by the same arithmetic and cannot drift a penny apart.
  const extended = fromPence(Math.round((scaled(serviceCost, 4) * count) / 100))
  return `${name} - ${each} each, ${formatMoney(extended, code)} in carriage`
}
