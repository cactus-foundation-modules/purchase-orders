import { z } from 'zod'
import type { CatalogueInput } from './catalogues'
import { MAX_CATALOGUE_ROWS } from './catalogue-import'
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

/** Roughly what `MAX_CATALOGUE_ROWS` of price list weighs, with room to spare.
 *  A cap on the text as well as on the rows, because the rows are only counted
 *  after the whole thing has been parsed. */
const MAX_CSV_CHARS = MAX_CATALOGUE_ROWS * 400

export const CatalogueImportBody = z.object({
  /** The file somebody chose. Absent when the list is being fetched from the
   *  address on file instead - one of the two has to be there, which is what
   *  the refinement below insists on. */
  csv: z
    .string()
    .min(1, 'There is nothing in that file.')
    .max(MAX_CSV_CHARS, 'That file is far bigger than any price list. Split it up.')
    .optional(),
  /** Go and read the address on the list rather than taking an upload. Only
   *  ever set by somebody pressing the button: nothing fetches on a schedule. */
  fromLink: z.boolean().default(false),
  /** False shows what the import would do; true does it. The screen always asks
   *  first, and the route defaults to asking - a POST that arrives without
   *  saying which it wants must not overwrite a supplier's prices. */
  apply: z.boolean().default(false),
}).refine(
  (body) => body.fromLink || (body.csv ?? '') !== '',
  'Choose a file, or import from the link on this list.',
)
