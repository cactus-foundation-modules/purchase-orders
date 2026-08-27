// This module's own CSV writer.
//
// Twelve lines rather than an import, and deliberately so: shop has one of these
// and Purchase Orders may be installed on a site that has no shop, where
// '@/modules/shop/lib/csv' does not exist at build time at all. The same reason
// lib/money.ts does not borrow the shop's formatter.
//
// Writing only. Nothing here reads a CSV back in - purchasing has no import, and
// a parser with no caller is dead code wearing a justification.

/**
 * One cell, quoted where it has to be, and guarded against the spreadsheet.
 *
 * A cell beginning `=`, `+`, `-` or `@` is executed as a formula by Excel and
 * Sheets, which is how a supplier called "=cmd|..." becomes somebody else's
 * problem. Prefixed with an apostrophe so it reads as text - except for plain
 * numbers, which keep their minus sign and stay numbers.
 */
export function toCsvField(value: string): string {
  let field = value
  if (/^[=+\-@\t\r]/.test(field) && !/^-?\d+(\.\d+)?$/.test(field)) field = `'${field}`
  if (/[",\n\r]/.test(field)) return `"${field.replace(/"/g, '""')}"`
  return field
}

export function toCsvRow(values: string[]): string {
  return values.map(toCsvField).join(',')
}

/** A header row and its rows, CRLF-separated as the format wants. */
export function toCsv(columns: readonly string[], rows: string[][]): string {
  return [toCsvRow([...columns]), ...rows.map(toCsvRow)].join('\r\n')
}

/** A date-stamped filename, so three downloads in a week do not all land as
 *  `export (2).csv` in the same folder. */
export function csvFilename(kind: string, today: string): string {
  return `purchasing-${kind}-${today.slice(0, 10)}.csv`
}
