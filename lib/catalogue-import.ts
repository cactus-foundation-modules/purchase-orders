import { parseCsv } from './csv'
import { scaled } from './totals'
import type { PoCatalogueItem } from './types'

// Turning a supplier's spreadsheet into rows of a price list, and nothing else.
//
// Pure: no database, no clock, no config. The screen that shows somebody what
// their file is about to become and the route that writes it hand this file the
// same text and get the same answer, which is the only way a preview is worth
// looking at. Same split lib/reorder.ts and lib/reordering.ts already use.
//
// Nothing here fetches anything. A list arrives as text - a file somebody chose
// to upload, or one lib/list-fetch.ts went and read from the address on file
// because somebody pressed Import. Which of the two it was makes no difference
// to a single line below.

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
    // Retail names, last of all. A list carrying a trade price AND an RRP is
    // read at trade, as it always was; a list carrying only the RRP is a retail
    // list, which is exactly what `priceBasis` and the supplier's discount are
    // for. Better to read it and say so on the preview than to import nothing.
    'listprice', 'retailprice', 'rrp', 'srp', 'msrp',
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
  /** Which column index filled each field, or -1 where nothing did. The screen
   *  needs these to show what it picked, in the same dropdowns somebody uses to
   *  pick something else. */
  columnIndexes: Record<CatalogueField, number>
  /** The row the headings were read off, as the spreadsheet numbers it. Zero
   *  where no such row could be found. */
  headerRow: number
  /** Enough of the top of the file to point at the right row and the right
   *  columns by eye. Cells cut short: one of them is routinely a paragraph. */
  topRows: string[][]
  /** What this read amounts to, in the form the list can remember. Handed back
   *  so a mapping somebody picked by hand can be kept and used again next time
   *  without them picking it twice. */
  mapping: ResolvedMapping
  items: CatalogueImportItem[]
  problems: CatalogueImportProblem[]
  /** Rows that were entirely blank. Counted, not complained about: every
   *  exported spreadsheet has a few. */
  blankRows: number
  /** Rows repeating a code already taken, where the repeat said the same thing.
   *  A repeat that said something DIFFERENT is a problem, not a count. */
  duplicateRows: number
}

/** One column somebody has pointed at, held by position AND by name.
 *
 *  Both, because either on its own goes wrong the first time a supplier edits
 *  their spreadsheet. A name alone cannot tell two columns headed "Code" apart.
 *  A position alone silently reads the column next door the moment anybody
 *  inserts one, which on a price list means importing descriptions as prices. */
export type CatalogueColumnChoice = { index: number; header?: string | null }

export type CatalogueColumnMap = Partial<Record<CatalogueField, CatalogueColumnChoice>>

/**
 * Which row the headings are on, and which column is which.
 *
 * Every part optional, and the whole thing optional, because the ordinary case
 * is still a file that explains itself. This is what arrives when it does not:
 * somebody has looked at the preview, seen it read the wrong column, and said
 * so. Where `columns` has anything in it at all it is the WHOLE truth - a field
 * missing from it is a field the file does not have - so that "no, there is no
 * discount group" is something that can actually be said.
 */
export type CatalogueMapping = { headerRow?: number | null; columns?: CatalogueColumnMap | null }

/** A mapping with nothing left to work out. What was actually used. */
export type ResolvedMapping = { headerRow: number; columns: Partial<Record<CatalogueField, { index: number; header: string }>> }

const EMPTY_COLUMNS = (): Record<CatalogueField, string | null> =>
  Object.fromEntries(CATALOGUE_FIELDS.map((f) => [f, null])) as Record<CatalogueField, string | null>

const NO_COLUMNS = (): Record<CatalogueField, number> =>
  Object.fromEntries(CATALOGUE_FIELDS.map((f) => [f, -1])) as Record<CatalogueField, number>

/**
 * How far down a file to look for the headings, and how much of it to hand back.
 *
 * A supplier's export puts a title, a blank line and a row of merged group
 * headings above the real header more often than not - the headings on row four
 * is ordinary, not exotic. Fifteen rows is well past all of that, and it is the
 * same fifteen rows the screen shows, so the row somebody can pick is always a
 * row this file would have considered.
 */
export const HEADER_SEARCH_ROWS = 15

const PREVIEW_COLUMNS = 250
const PREVIEW_CELL_CHARS = 40

/** Lowercase, letters and digits only - `squashHeader` - but tolerant of the
 *  header being null or undefined, which is what a stored mapping can hold. */
function squashed(value: string | null | undefined): string {
  return value == null ? '' : squashHeader(value)
}

/** Where a heading sits, but only where it sits in exactly one place. Two
 *  columns headed the same thing cannot be told apart by name, so they are told
 *  apart by position instead. */
function findUniqueHeader(header: string[], name: string | null | undefined): number {
  const want = squashed(name)
  if (want === '') return -1
  let found = -1
  for (let i = 0; i < header.length; i += 1) {
    if (squashHeader(header[i] ?? '') !== want) continue
    if (found !== -1) return -1
    found = i
  }
  return found
}

/**
 * Which column feeds which field, going by the names in the header row.
 *
 * First alias wins, and a column already claimed by one field is not offered to
 * the next - otherwise a list with only a "Code" column would fill both the code
 * and the discount group. The count of fields matched comes back too, because
 * that is what decides which row of a file is the header row at all.
 */
function matchAliases(header: string[]): { indexes: Record<CatalogueField, number>; score: number } {
  const squash = header.map(squashHeader)
  const claimed = new Set<number>()
  const indexes = NO_COLUMNS()
  let score = 0
  for (const field of CATALOGUE_FIELDS) {
    let found = -1
    for (const alias of HEADER_ALIASES[field]) {
      const at = squash.findIndex((h, i) => h === alias && !claimed.has(i))
      if (at !== -1) {
        found = at
        break
      }
    }
    indexes[field] = found
    if (found !== -1) {
      claimed.add(found)
      score += 1
    }
  }
  return { indexes, score }
}

/**
 * The row the headings are on, worked out rather than assumed to be the first.
 *
 * The row that names the most fields wins, and it has to name the supplier's
 * code or it is not a header row at all. Ties go to the earliest, so a file that
 * genuinely starts with its headings is never overruled by something further
 * down. Returns -1 where nothing in the first fifteen rows qualifies, which is
 * the case that asks somebody to say which row it is.
 */
function findHeaderRow(rows: string[][]): number {
  let best = -1
  let bestScore = 0
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS)
  for (let i = 0; i < limit; i += 1) {
    const { indexes, score } = matchAliases(rows[i]!)
    if (indexes.supplierSku === -1) continue
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

/** The header row to read, honouring what somebody asked for.
 *
 *  A row number somebody picked is followed, unless the headings have plainly
 *  moved since - a sheet that gains a title row pushes everything down one and
 *  changes not a single heading - in which case the code column's own name is
 *  what gets followed instead. */
function resolveHeaderRow(rows: string[][], mapping: CatalogueMapping | null | undefined): number {
  const asked = mapping?.headerRow
  if (asked != null && asked >= 1) {
    const at = asked - 1
    const anchor = mapping?.columns?.supplierSku?.header
    const stillThere = rows[at] != null && findUniqueHeader(rows[at]!, anchor) !== -1
    if (anchor && !stillThere) {
      const limit = Math.min(rows.length, HEADER_SEARCH_ROWS)
      for (let i = 0; i < limit; i += 1) {
        if (findUniqueHeader(rows[i]!, anchor) !== -1) return i
      }
    }
    if (at >= 0 && at < rows.length) return at
  }
  return findHeaderRow(rows)
}

/** Which column feeds which field, honouring what somebody asked for. */
function resolveColumns(header: string[], mapping: CatalogueMapping | null | undefined): Record<CatalogueField, number> {
  const picked = mapping?.columns
  if (!picked || Object.keys(picked).length === 0) return matchAliases(header).indexes

  const indexes = NO_COLUMNS()
  for (const field of CATALOGUE_FIELDS) {
    const choice = picked[field]
    if (!choice || choice.index < 0) continue
    // The heading beats the position. A supplier who inserts one column shifts
    // every index along by one and renames nothing.
    const byName = findUniqueHeader(header, choice.header)
    indexes[field] = byName !== -1 ? byName : choice.index
  }
  return indexes
}

function cut(value: string): string {
  const text = value.trim()
  return text.length > PREVIEW_CELL_CHARS ? `${text.slice(0, PREVIEW_CELL_CHARS)}…` : text
}

/**
 * One uploaded spreadsheet, worked out into a price list.
 *
 * Nothing is dropped in silence. A row without a code, a price that is not a
 * number, a code that appears twice saying two different things - each of them
 * comes back in `problems` with the spreadsheet's own row number, and the rest
 * of the file still imports.
 *
 * The headings are looked for rather than assumed to be on the first line:
 * suppliers export a title, a blank row and a row of merged group headings above
 * them as a matter of course. Where that still lands on the wrong row, or picks
 * the wrong one of two columns that could both be the code, `mapping` is
 * somebody saying so by hand - and it is followed exactly. Either way the top of
 * the file comes back with the answer, so the screen can show what was read and
 * offer something else.
 */
export function parseCatalogueCsv(text: string, mapping?: CatalogueMapping | null): CatalogueImportResult {
  const rows = parseCsv(text)
  const columns = EMPTY_COLUMNS()
  const problems: CatalogueImportProblem[] = []
  const items: CatalogueImportItem[] = []
  let blankRows = 0
  let duplicateRows = 0

  const topRows = rows.slice(0, HEADER_SEARCH_ROWS).map((row) => row.slice(0, PREVIEW_COLUMNS).map(cut))

  const headerAt = resolveHeaderRow(rows, mapping)
  if (headerAt === -1) {
    return {
      columns,
      columnIndexes: NO_COLUMNS(),
      headerRow: 0,
      topRows,
      mapping: { headerRow: 0, columns: {} },
      items,
      problems: [
        {
          row: 1,
          message:
            rows.length === 0
              ? 'There is nothing in that file.'
              : 'Nothing in the first fifteen rows reads as a heading with the supplier’s product code under it. Say which row the headings are on and which column is which, and it will read the rest.',
        },
      ],
      blankRows,
      duplicateRows,
    }
  }

  const header = rows[headerAt]!
  const indexes = resolveColumns(header, mapping)
  for (const field of CATALOGUE_FIELDS) {
    const at = indexes[field]
    if (at === -1) continue
    columns[field] = header[at]?.trim() || `Column ${at + 1}`
  }

  const resolved: ResolvedMapping = {
    headerRow: headerAt + 1,
    columns: Object.fromEntries(
      CATALOGUE_FIELDS.filter((f) => indexes[f] !== -1).map((f) => [
        f,
        { index: indexes[f], header: (header[indexes[f]] ?? '').trim() },
      ]),
    ),
  }

  if (indexes.supplierSku === -1) {
    return {
      columns,
      columnIndexes: indexes,
      headerRow: headerAt + 1,
      topRows,
      mapping: resolved,
      items,
      problems: [
        {
          row: headerAt + 1,
          message:
            'Nothing on that row is the supplier’s product code. Pick the column it is in - or name it "Supplier SKU", "Product code" or "Code" and try again.',
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

  for (let i = headerAt + 1; i < rows.length; i += 1) {
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

  return { columns, columnIndexes: indexes, headerRow: headerAt + 1, topRows, mapping: resolved, items, problems, blankRows, duplicateRows }
}

/**
 * A retail price list, turned into what you actually pay.
 *
 * Trade suppliers publish one list and sell off it at a different number: the
 * printed figure is retail and your price is that less whatever percentage you
 * have negotiated. Importing such a list untouched drafts every purchase order
 * at the price the customer pays, which is a mistake nobody notices until the
 * invoice arrives.
 *
 * Done in integer ten-thousandths, the same as lib/totals.ts does a line
 * discount and for the same reason: 25% off 41.67 in floating point is not
 * 31.2525. A row with no price stays without one - there is nothing to take a
 * quarter off - and a percentage of nothing, or of zero, hands the list back
 * exactly as it came so the caller never has to check first.
 */
export function applyRetailDiscount(
  items: CatalogueImportItem[],
  discountPercent: string | number | null | undefined,
): CatalogueImportItem[] {
  const percent = scaled(discountPercent ?? 0, 2)
  if (percent <= 0) return items
  return items.map((item) => {
    if (item.unitCost == null) return item
    const list = scaled(item.unitCost, 4)
    const net = list - Math.round((list * percent) / 10_000)
    return { ...item, unitCost: (net / 10_000).toFixed(4) }
  })
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
