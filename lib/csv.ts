// This module's own CSV writer.
//
// Twelve lines rather than an import, and deliberately so: shop has one of these
// and Purchase Orders may be installed on a site that has no shop, where
// '@/modules/shop/lib/csv' does not exist at build time at all. The same reason
// lib/money.ts does not borrow the shop's formatter.
//
// Writing was all this file did until supplier price lists arrived. A reader
// lives here now as well, and only because there is something importing a
// spreadsheet - `parseCsv` has exactly one caller, lib/catalogue-import.ts.

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

/**
 * A CSV back into rows of cells.
 *
 * Written out rather than pulled in from a library for the reason at the top of
 * this file, and deliberately small: quoted fields, doubled quotes inside them,
 * commas and newlines inside quotes, and CRLF or LF line endings. That is the
 * whole of what a supplier's exported price list ever contains.
 *
 * Two things it does NOT do, both on purpose. It does not guess a delimiter -
 * a semicolon-separated export is a different file and saying so beats
 * importing four hundred rows of nonsense. And it does not strip the leading
 * apostrophe `toCsvField` adds: a code genuinely beginning with one is rare,
 * and quietly editing what a supplier calls something is worse than a code that
 * has to be looked at.
 *
 * A trailing newline produces no extra row. A blank line in the middle produces
 * one empty cell, which the import counts as a blank row and skips.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  // Strip a UTF-8 byte order mark: Excel writes one, and it otherwise becomes
  // part of the first header and nothing matches it.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"' && field === '') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  // Whatever is left after the last line ending, unless the file ended on one.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}
