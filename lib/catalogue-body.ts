import { z } from 'zod'
import type { CatalogueInput } from './catalogues'
import { CATALOGUE_FIELDS, type CatalogueColumnMap, type CatalogueField, type CatalogueMapping } from './catalogue-import'
import { PO_PRICE_BASES } from './types'

// The catalogue form and the import payload, validated once and shared by every
// route that takes them.

/** A web address, or nothing.
 *
 *  Only http and https. This one IS fetched, when somebody presses Import
 *  against the link rather than uploading a file, so a `javascript:` or `file:`
 *  address is refused here as well as at the fetch - see lib/list-url.ts, which
 *  checks it again on the way out and will not go to a private address. */
const SourceUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => value === '' || /^https?:\/\/\S+$/i.test(value), 'That does not look like a web address.')

const IsoDay = z
  .string()
  .trim()
  .refine((value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value), 'Dates go in as YYYY-MM-DD.')

export const CatalogueBody = z.object({
  supplierId: z.string().trim().min(1, 'Pick a supplier').max(100),
  name: z.string().trim().min(1, 'Give the list a name').max(120),
  sourceUrl: SourceUrl.nullable().default(null),
  // The shop catalogue this was picked from, and its name at the time. Both or
  // neither: an id with no snapshot is a link that reads as nothing the moment
  // shop renames the row.
  shopCatalogueId: z.string().trim().max(100).nullable().default(null),
  shopCatalogueName: z.string().trim().max(200).nullable().default(null),
  currency: z.string().trim().length(3, 'Currencies are three letters').default('GBP'),
  // Existing lists have no basis on them and were all read as trade net, so the
  // default has to be NET or a saved edit would reprice somebody's whole range.
  priceBasis: z.enum(PO_PRICE_BASES).default('NET'),
  effectiveFrom: IsoDay.nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
})

export type CatalogueBodyInput = z.infer<typeof CatalogueBody>

function orNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

export function toCatalogueInput(body: CatalogueBodyInput): CatalogueInput {
  const shopCatalogueId = orNull(body.shopCatalogueId)
  return {
    supplierId: body.supplierId.trim(),
    name: body.name.trim(),
    sourceUrl: orNull(body.sourceUrl),
    shopCatalogueId,
    // No id, no snapshot. A name on its own would show as a link to something
    // that was never linked.
    shopCatalogueName: shopCatalogueId ? orNull(body.shopCatalogueName) : null,
    currency: body.currency.trim().toUpperCase(),
    priceBasis: body.priceBasis,
    effectiveFrom: orNull(body.effectiveFrom),
    notes: orNull(body.notes),
  }
}

/**
 * What a browser can actually post.
 *
 * Not a judgement about how big a price list may be - it is how big a request
 * the thing this runs on will accept, which is a shade over four megabytes and
 * not negotiable. Said here, in words somebody can act on, rather than left to
 * arrive as a gateway error with a number in it. A list bigger than this is
 * imported from its address instead, where the server does the reading and the
 * file never goes near the browser at all.
 */
const MAX_CSV_CHARS = 4_000_000

/** One column somebody has pointed at, by position. -1 says the file has no
 *  such column, which is a thing worth being able to say: it is how "no, that
 *  is not the discount group" gets across. */
const ColumnIndex = z.number().int().min(-1).max(4_000)

export const CatalogueImportBody = z.object({
  /** The file somebody chose. Absent when the list is being fetched from the
   *  address on file instead - one of the two has to be there, which is what
   *  the refinement below insists on. */
  csv: z
    .string()
    .min(1, 'There is nothing in that file.')
    .max(
      MAX_CSV_CHARS,
      'That file is too big to send from your browser. Put it somewhere with a web address - a shared Google Sheet does nicely - put that address on this list, and press Import instead.',
    )
    .optional(),
  /** Go and read the address on the list rather than taking an upload. Only
   *  ever set by somebody pressing the button: nothing fetches on a schedule. */
  fromLink: z.boolean().default(false),
  /** False shows what the import would do; true does it. The screen always asks
   *  first, and the route defaults to asking - a POST that arrives without
   *  saying which it wants must not overwrite a supplier's prices. */
  apply: z.boolean().default(false),
  /**
   * Which row the headings are on and which column is which, where somebody has
   * looked at the preview and said so.
   *
   * Absent means "whatever this list already remembers, or work it out". Present
   * but entirely empty means "forget what it remembers and work it out again",
   * which is how somebody undoes a mapping they no longer want.
   */
  mapping: z
    .object({
      headerRow: z.number().int().min(1).max(200).nullable().default(null),
      columns: z.record(z.string(), ColumnIndex).default({}),
    })
    .nullable()
    .default(null),
  /**
   * The version of the list the preview was worked out from.
   *
   * A list fetched from its address is read again when the import is applied,
   * because twelve megabytes of spreadsheet cannot make the round trip through
   * a browser. This is what makes that second read safe: a supplier who edited
   * the sheet in between gets a fresh comparison rather than a quiet swap.
   */
  expectFingerprint: z.string().trim().max(200).nullable().default(null),
}).refine(
  (body) => body.fromLink || (body.csv ?? '') !== '',
  'Choose a file, or import from the link on this list.',
)

export type CatalogueImportBodyInput = z.infer<typeof CatalogueImportBody>

/** The posted mapping, in the shape the parser takes.
 *
 *  Column names are not carried up from the browser - the header row the server
 *  is about to read is where they come from - so what arrives is positions, and
 *  positions for fields this module has heard of. Anything else is dropped
 *  rather than argued with. */
export function toCatalogueMapping(
  posted: CatalogueImportBodyInput['mapping'],
): { mapping: CatalogueMapping | null; explicit: boolean } {
  if (!posted) return { mapping: null, explicit: false }
  const columns: CatalogueColumnMap = {}
  for (const field of CATALOGUE_FIELDS) {
    const index = posted.columns[field]
    if (typeof index === 'number' && index >= 0) columns[field as CatalogueField] = { index }
  }
  const explicit = posted.headerRow != null || Object.keys(columns).length > 0
  return { mapping: { headerRow: posted.headerRow, columns }, explicit }
}
