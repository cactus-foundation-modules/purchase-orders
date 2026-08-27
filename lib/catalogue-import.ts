import { parseCsv } from './csv'
import type { PoCatalogueItem } from './types'

// Turning a supplier's spreadsheet into rows of a price list, and nothing else.
//
// Pure: no database, no clock, no config. The screen that shows somebody what
// their file is about to become and the route that writes it hand this file the
// same text and get the same answer, which is the only way a preview is worth
// looking at. Same split lib/reorder.ts and lib/reordering.ts already use.
//
// Nothing here fetches anything. A supplier's list arrives as a file somebody
// chose to upload; a module that goes and reads a URL of its own accord is a
// module that can be pointed at an address inside somebody's network.

/** The most rows one import will take.
 *
 *  Well above any real price list - Deskwell's whole catalogue is twenty
 *  thousand rows and that is one shop's worth of one supplier - and low enough
 *  that a file pasted in by mistake is refused rather than held in memory. */
export const MAX_CATALOGUE_ROWS = 50_000

/** The fields a price list can carry. Everything except the code is optional:
 *  plenty of lists are two columns, and a code with a price is already useful. */
export const CATALOGUE_FIELDS = [
  'supplierSku',
  'description',
  'unitCost',
  'packSize',
  'minimumOrderQty',
  'leadTimeDays',
  'discountGroup',
  'discontinued',
] as const
export type CatalogueField = (typeof CATALOGUE_FIELDS)[number]

/**
 * What each column may be called.
 *
 * Suppliers do not agree on a single one of these names, and asking somebody to
 * rename eight headers before every import is asking them to stop importing.
 * Matched on the squashed form of the header - lowercase with everything that
 * is not a letter or a digit removed - so "Unit Cost (£)", "unit_cost" and
 * "UNIT COST" are all one thing.
 *
 * Order matters within a field: the first alias found in the header row wins,
 * so the most specific names are listed first. A list carrying both "Trade
 * price" and "RRP" must not be imported at retail.
 */
const HEADER_ALIASES: Record<CatalogueField, string[]> = {
  supplierSku: [
    'suppliersku', 'suppliercode', 'suppliersproductcode', 'productcode', 'itemcode',
    'partnumber', 'partno', 'cataloguecode', 'catalogcode', 'code', 'sku', 'ref',
  ],
  description: ['description', 'productname', 'itemname', 'productdescription', 'product', 'item', 'name', 'title'],
  unitCost: [
    'tradeprice', 'netprice', 'costprice', 'unitcost', 'buyprice', 'nettprice',
    'cost', 'unitprice', 'price',
  ],
  packSize: ['packsize', 'packquantity', 'qtyperpack', 'casesize', 'packqty', 'pack'],
  minimumOrderQty: ['minimumorderquantity', 'minimumorderqty', 'minorderqty', 'minimumqty', 'minqty', 'moq'],
  leadTimeDays: ['leadtimedays', 'leadtimeindays', 'leadtime', 'leaddays'],
  discountGroup: ['discountgroup', 'discountcode', 'pricegroup', 'productgroup', 'band'],
  discontinued: ['discontinued', 'obsolete', 'deleted', 'nolongeravailable'],
}

/** Lowercase, letters and digits only. Used on headers, not on data. */
export function squashHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The form every code is matched on.
 *
 * Uppercased and stripped of spaces, hyphens, dots and slashes. Supplier lists
 * print the same code as "DS-1234", "ds1234" and "DS 1234" across three tabs of
 * one workbook, and a match that fails on punctuation is a match that fails.
 * The code itself is stored beside the key exactly as the supplier wrote it -
 * that is what goes on the purchase order.
 */
export function catalogueSkuKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Normalised catalogue name, matching the `name_key` column. */
export function catalogueNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * A price off a spreadsheet.
 *
 * Currency symbols, thousands separators and stray spaces are removed; a figure
 * in brackets is negative, as accountants write it. Anything left that is not a
 * number comes back undefined and the row is reported rather than imported at
 * zero - a price list silently full of zeroes is how a purchase order goes out
 * at nothing.
 */
export function parseListMoney(raw: string): string | null | undefined {
  const text = raw.trim()
  if (text === '') return null

  const negative = /^\(.*\)$/.test(text)
  const cleaned = text
    .replace(/^\(|\)$/g, '')
    .replace(/[£$€,\s]/g, '')
    .replace(/^\+/, '')
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return undefined

  const value = Number(cleaned) * (negative ? -1 : 1)
  if (!Number.isFinite(value)) return undefined
  // Four decimal places, which is what NUMERIC(12,4) holds and what every other
  // cost in this module is carried at.
  return (Math.round(value * 10_000) / 10_000).toFixed(4)
}

/** A quantity off a spreadsheet, to three places - the column's own precision. */
function parseListQty(raw: string): string | null | undefined {
  const money = parseListMoney(raw)
  if (money === undefined || money === null) return money
  return Number(money).toFixed(3)
}

function parseListInt(raw: string): number | null | undefined {
  const text = raw.trim()
  if (text === '') return null
  const value = Number(text.replace(/[,\s]/g, '').replace(/days?$/i, ''))
  if (!Number.isFinite(value)) return undefined
  return Math.trunc(value)
}

const TRUE_WORDS = new Set(['y', 'yes', 'true', '1', 'discontinued', 'obsolete', 'deleted', 'x'])
const FALSE_WORDS = new Set(['', 'n', 'no', 'false', '0', 'current', 'available', 'active', '-'])

/** A yes/no column, however the supplier said it. Anything unrecognised is
 *  taken as "still sold": marking a live product discontinued on a typo would
 *  stop it being ordered, which is the more expensive way to be wrong. */
export function parseListFlag(raw: string): boolean {
  const text = raw.trim().toLowerCase()
  if (TRUE_WORDS.has(text)) return true
  if (FALSE_WORDS.has(text)) return false
  return false
}

/** One row of the list, ready to be written. */
export type CatalogueImportItem = Omit<PoCatalogueItem, 'id' | 'catalogueId'>

/** A row that could not be taken, and why. Row numbers are as the spreadsheet
 *  shows them - the header is row 1 - so somebody can go and look at it. */
export type CatalogueImportProblem = { row: number; message: string }

export type CatalogueImportResult = {
  /** Which header filled each field, or null where the file had none. */
  columns: Record<CatalogueField, string | null>
  items: CatalogueImportItem[]
  problems: CatalogueImportProblem[]
  /** Rows that were entirely blank. Counted, not complained about: every
   *  exported spreadsheet has a few. */
  blankRows: number
  /** Rows repeating a code already taken, where the repeat said the same thing.
   *  A repeat that said something DIFFERENT is a problem, not a count. */
  duplicateRows: number
}

const EMPTY_COLUMNS = (): Record<CatalogueField, string | null> =>
  Object.fromEntries(CATALOGUE_FIELDS.map((f) => [f, null])) as Record<CatalogueField, string | null>

/**
 * One uploaded spreadsheet, worked out into a price list.
 *
 * Nothing is dropped in silence. A row without a code, a price that is not a
 * number, a code that appears twice saying two different things - each of them
 * comes back in `problems` with the spreadsheet's own row number, and the rest
 * of the file still imports. A file whose header carries no recognisable code
 * column is refused outright, because every row of it would be a problem.
 */
export function parseCatalogueCsv(text: string): CatalogueImportResult {
  const rows = parseCsv(text)
  const columns = EMPTY_COLUMNS()
  const problems: CatalogueImportProblem[] = []
  const items: CatalogueImportItem[] = []
  let blankRows = 0
  let duplicateRows = 0

  const header = rows[0]
  if (!header || header.every((cell) => cell.trim() === '')) {
    return {
      columns,
      items,
      problems: [{ row: 1, message: 'That file has no header row, so there is no way to tell which column is which.' }],
      blankRows,
      duplicateRows,
    }
  }

  // Which column index feeds which field. First alias wins, and a column
  // already claimed by one field is not offered to the next - otherwise a list
  // with only a "Code" column would fill both the code and the discount group.
  const squashed = header.map(squashHeader)
  const claimed = new Set<number>()
  const indexes = {} as Record<CatalogueField, number>
  for (const field of CATALOGUE_FIELDS) {
    let found = -1
    for (const alias of HEADER_ALIASES[field]) {
      const at = squashed.findIndex((h, i) => h === alias && !claimed.has(i))
      if (at !== -1) {
        found = at
        break
      }
    }
    indexes[field] = found
    if (found !== -1) {
      claimed.add(found)
      columns[field] = header[found]!.trim()
    }
  }

  if (indexes.supplierSku === -1) {
    return {
      columns,
      items,
      problems: [
        {
          row: 1,
          message:
            'Nothing in that header looks like the supplier’s product code. Name the column "Supplier SKU", "Product code" or "Code" and try again.',
        },
      ],
      blankRows,
      duplicateRows,
    }
  }

  const cell = (row: string[], field: CatalogueField): string => {
    const at = indexes[field]
    return at === -1 ? '' : (row[at] ?? '')
  }

  const seen = new Map<string, CatalogueImportItem>()

  for (let i = 1; i < rows.length; i += 1) {
    const rowNumber = i + 1
    const row = rows[i]!

    if (row.every((value) => value.trim() === '')) {
      blankRows += 1
      continue
    }

    if (items.length >= MAX_CATALOGUE_ROWS) {
      problems.push({
        row: rowNumber,
        message: `A price list stops at ${MAX_CATALOGUE_ROWS.toLocaleString('en-GB')} rows. Everything from here down was left out.`,
      })
      break
    }

    const supplierSku = cell(row, 'supplierSku').trim()
    if (supplierSku === '') {
      problems.push({ row: rowNumber, message: 'No supplier code on this row, so there is nothing to price.' })
      continue
    }

    const key = catalogueSkuKey(supplierSku)
    if (key === '') {
      problems.push({ row: rowNumber, message: `"${supplierSku}" has no letters or digits in it, so it cannot be a code.` })
      continue
    }

    const unitCost = parseListMoney(cell(row, 'unitCost'))
    if (unitCost === undefined) {
      problems.push({ row: rowNumber, message: `${supplierSku}: "${cell(row, 'unitCost').trim()}" is not a price.` })
      continue
    }

    const packSize = parseListQty(cell(row, 'packSize'))
    const minimumOrderQty = parseListQty(cell(row, 'minimumOrderQty'))
    const leadTimeDays = parseListInt(cell(row, 'leadTimeDays'))

    const item: CatalogueImportItem = {
      supplierSku,
      supplierSkuKey: key,
      description: cell(row, 'description').trim(),
      unitCost,
      // A pack size or a lead time that will not parse is not worth losing the
      // row over - the code and the price are what an order needs - so these
      // fall back to blank rather than to a problem.
      packSize: packSize === undefined ? null : packSize,
      minimumOrderQty: minimumOrderQty === undefined ? null : minimumOrderQty,
      leadTimeDays: leadTimeDays === undefined ? null : leadTimeDays,
      discountGroup: cell(row, 'discountGroup').trim() || null,
      discontinued: parseListFlag(cell(row, 'discontinued')),
    }

    const already = seen.get(key)
    if (already) {
      if (sameItem(already, item)) duplicateRows += 1
      else {
        problems.push({
          row: rowNumber,
          message: `${supplierSku} is in this list twice saying two different things. The first one was kept.`,
        })
      }
      continue
    }

    seen.set(key, item)
    items.push(item)
  }

  return { columns, items, problems, blankRows, duplicateRows }
}

function sameItem(a: CatalogueImportItem, b: CatalogueImportItem): boolean {
  return (
    a.description === b.description &&
    a.unitCost === b.unitCost &&
    a.packSize === b.packSize &&
    a.minimumOrderQty === b.minimumOrderQty &&
    a.leadTimeDays === b.leadTimeDays &&
    a.discountGroup === b.discountGroup &&
    a.discontinued === b.discontinued
  )
}
