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
