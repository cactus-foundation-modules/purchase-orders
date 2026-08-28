import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { getSupplier } from '@/modules/purchase-orders/lib/db'
import { getCatalogue, readCatalogueForDiff, replaceCatalogueItems } from '@/modules/purchase-orders/lib/catalogues'
import { applyRetailDiscount, parseCatalogueCsv, type CatalogueMapping } from '@/modules/purchase-orders/lib/catalogue-import'
import { countChanges, diffCatalogue } from '@/modules/purchase-orders/lib/catalogue-matching'
import { CatalogueImportBody, toCatalogueMapping } from '@/modules/purchase-orders/lib/catalogue-body'
import { fetchPriceList, fingerprintList } from '@/modules/purchase-orders/lib/list-fetch'
import { ListFetchError } from '@/modules/purchase-orders/lib/list-url'
import type { PoCatalogueImportPreview } from '@/modules/purchase-orders/lib/types'

/**
 * Take a supplier's price list, or say what taking it would do.
 *
 * The same request either way, and the same code path: `apply` false works the
 * list out and hands back the comparison, `apply` true works out exactly the
 * same thing and then writes it. That is the only way the preview somebody read
 * is the import they got - and the body DEFAULTS to false, so a request that
 * forgets to say cannot overwrite a supplier's prices by accident.
 *
 * The list arrives one of two ways. Somebody uploads the spreadsheet, or -
 * where the list already records where it lives, which it does whenever it was
 * picked from one of the shop's catalogues - somebody presses Import and the
 * server goes and reads it. Fetching happens only on that press, never on a
 * schedule, and lib/list-url.ts refuses anything that is not a public http(s)
 * address, because this server can reach things the owner's browser cannot.
 *
 * A fetched list is read again when the import is applied, rather than being
 * handed down to the browser and posted back up. A real price list runs to
 * megabytes and the platform this sits on refuses a request body that size, so
 * the round trip is not available even where it would be tidier. What makes the
 * second read safe is the fingerprint: the preview says which version of the
 * list it was worked out from, the apply says the same thing back, and a
 * supplier who edited the sheet in between gets a fresh comparison instead of a
 * quiet swap.
 *
 * Which column is which is worked out from the headings, wherever in the first
 * fifteen rows they turn out to be - suppliers export a title, a blank line and
 * a row of merged group headings above them as a matter of course. Where that
 * lands on the wrong column, `mapping` is somebody having looked at the preview
 * and said so, and it is followed exactly. A mapping picked by hand is kept on
 * the list when the import is applied, so the correction is made once.
 */
/** How many unreadable rows go back with the preview. The screen shows twenty
 *  of them and the count is complete either way; a mis-mapped spreadsheet can
 *  produce one per row, and forty thousand sentences is a response nobody reads
 *  and everybody waits for. */
const PROBLEM_SAMPLE = 50

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCatalogues) return errorResponse('Forbidden', 403)

  const { id } = await params
  const catalogue = await getCatalogue(id)
  if (!catalogue) return errorResponse('That list is not there.', 404)

  const parsed = CatalogueImportBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const fromLink = parsed.data.fromLink
  let csv = parsed.data.csv ?? ''
  let fetchedFrom: string | null = null

  if (csv === '') {
    if (!catalogue.sourceUrl) {
      return errorResponse(
        'This list has no address on it, so there is nothing to fetch. Add where it lives, or upload the spreadsheet.',
      )
    }
    try {
      const got = await fetchPriceList(catalogue.sourceUrl)
      csv = got.text
      fetchedFrom = got.url
    } catch (error) {
      if (error instanceof ListFetchError) return errorResponse(error.message)
      throw error
    }
  }

  // Absent means "whatever this list already remembers"; present but empty means
  // "forget that and work it out again". Both are things somebody can ask for,
  // and they are not the same thing.
  const posted = toCatalogueMapping(parsed.data.mapping)
  const stored: CatalogueMapping | null =
    catalogue.headerRow != null || catalogue.columnMap
      ? { headerRow: catalogue.headerRow, columns: catalogue.columnMap ?? {} }
      : null
  const result = parseCatalogueCsv(csv, posted.mapping ?? stored)
  const fingerprint = fingerprintList(csv)

  // A retail list is the supplier's printed price with the discount still to
  // come off. Taken off here, once, before anything is compared - so the changes
  // somebody reads are changes to what they will actually pay, not to a figure
  // no purchase order will ever carry.
  const supplier = catalogue.priceBasis === 'RETAIL' ? await getSupplier(catalogue.supplierId) : null
  const discount = supplier?.discountPercent ?? null
  const discountApplied = discount != null && Number(discount) > 0 ? discount : null
  const items = discountApplied ? applyRetailDiscount(result.items, discountApplied) : result.items

  const readAs = {
    columns: result.columns,
    columnIndexes: result.columnIndexes,
    headerRow: result.headerRow,
    topRows: result.topRows,
    mapping: result.mapping,
    fingerprint,
  }

  const provenance = {
    source: (fromLink || fetchedFrom ? 'LINK' : 'FILE') as 'FILE' | 'LINK',
    // The address actually read - which is not always the one on the list, since
    // a Google Sheet page is rewritten to its CSV form before fetching.
    sourceUrl: fetchedFrom ?? (fromLink ? catalogue.sourceUrl : null),
    priceBasis: catalogue.priceBasis,
    discountApplied,
  }

  // A list that produced no rows at all is refused rather than applied. Every
  // one of a supplier's prices disappearing because somebody uploaded the wrong
  // sheet is not an outcome any confirmation dialog makes acceptable.
  if (items.length === 0) {
    return NextResponse.json({
      applied: false,
      refused:
        result.headerRow === 0
          ? 'Nothing in that file reads as a price list on its own, so the current one has been left alone. Say which row the headings are on and which column is which, and it will have another go.'
          : 'Nothing on the rows under those headings could be read as a price, so the current one has been left alone. Check the columns below are the ones you meant.',
      preview: emptyPreview(id, catalogue.name, result, provenance, readAs),
    })
  }

  const previousItems = await readCatalogueForDiff(id)
  const changes = diffCatalogue(previousItems, items)

  const preview: PoCatalogueImportPreview = {
    catalogueId: id,
    catalogueName: catalogue.name,
    ...readAs,
    ...provenance,
    itemCount: items.length,
    blankRows: result.blankRows,
    duplicateRows: result.duplicateRows,
    problems: result.problems.slice(0, PROBLEM_SAMPLE),
    problemCount: result.problems.length,
    // The whole comparison would be tens of thousands of lines on a first
    // import. The counts are complete; the list shown is the first two hundred,
    // and it says so on the screen rather than pretending it is everything.
    changes: changes.slice(0, 200),
    changeCounts: countChanges(changes),
  }

  if (!parsed.data.apply) return NextResponse.json({ applied: false, refused: null, preview })

  // The list was read again to get here. If it is not the list somebody looked
  // at, they are shown the new one rather than sold the difference.
  if (parsed.data.expectFingerprint && parsed.data.expectFingerprint !== fingerprint) {
    return NextResponse.json({
      applied: false,
      refused:
        'That list has been changed since you read it, so nothing has been imported. Here is what it says now - have a look and press the button again if you are happy.',
      preview,
    })
  }

  // A mapping is remembered only where somebody picked one, and forgotten where
  // they asked for it to be worked out again. An import nobody had to correct
  // leaves whatever is on file alone - `undefined`, not null.
  const remember = parsed.data.mapping ? (posted.explicit ? result.mapping : null) : undefined
  await replaceCatalogueItems(id, items, remember)
  await recordAudit(
    'catalogue',
    id,
    'catalogue.imported',
    {
      name: catalogue.name,
      itemCount: items.length,
      changes: preview.changeCounts,
      source: provenance.source,
      sourceUrl: provenance.sourceUrl,
      priceBasis: catalogue.priceBasis,
      discountApplied,
      headerRow: result.headerRow,
      columns: result.columns,
    },
    user.id,
  )

  return NextResponse.json({ applied: true, refused: null, preview })
}

function emptyPreview(
  catalogueId: string,
  catalogueName: string,
  result: ReturnType<typeof parseCatalogueCsv>,
  provenance: Pick<PoCatalogueImportPreview, 'source' | 'sourceUrl' | 'priceBasis' | 'discountApplied'>,
  readAs: Pick<PoCatalogueImportPreview, 'columns' | 'columnIndexes' | 'headerRow' | 'topRows' | 'mapping' | 'fingerprint'>,
): PoCatalogueImportPreview {
  return {
    catalogueId,
    catalogueName,
    ...readAs,
    ...provenance,
    itemCount: 0,
    blankRows: result.blankRows,
    duplicateRows: result.duplicateRows,
    problems: result.problems.slice(0, PROBLEM_SAMPLE),
    problemCount: result.problems.length,
    changes: [],
    changeCounts: { ADDED: 0, REMOVED: 0, RENAMED: 0, REPRICED: 0, DISCONTINUED: 0, RESTORED: 0 },
  }
}
