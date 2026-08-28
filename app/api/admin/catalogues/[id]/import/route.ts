import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { getSupplier } from '@/modules/purchase-orders/lib/db'
import { getCatalogue, readCatalogueForDiff, replaceCatalogueItems } from '@/modules/purchase-orders/lib/catalogues'
import { applyRetailDiscount, parseCatalogueCsv } from '@/modules/purchase-orders/lib/catalogue-import'
import { countChanges, diffCatalogue } from '@/modules/purchase-orders/lib/catalogue-matching'
import { CatalogueImportBody } from '@/modules/purchase-orders/lib/catalogue-body'
import { fetchPriceList } from '@/modules/purchase-orders/lib/list-fetch'
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
 * A fetch hands the text back to the screen with the preview, and the screen
 * posts that same text again to apply it. The alternative - fetching a second
 * time - would be a supplier free to change the list between the comparison
 * somebody read and the prices they ended up with.
 */
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

  const result = parseCatalogueCsv(csv)

  // A retail list is the supplier's printed price with the discount still to
  // come off. Taken off here, once, before anything is compared - so the changes
  // somebody reads are changes to what they will actually pay, not to a figure
  // no purchase order will ever carry.
  const supplier = catalogue.priceBasis === 'RETAIL' ? await getSupplier(catalogue.supplierId) : null
  const discount = supplier?.discountPercent ?? null
  const discountApplied = discount != null && Number(discount) > 0 ? discount : null
  const items = discountApplied ? applyRetailDiscount(result.items, discountApplied) : result.items

  const provenance = {
    source: (fromLink || fetchedFrom ? 'LINK' : 'FILE') as 'FILE' | 'LINK',
    // The address actually read where this request did the reading; otherwise
    // the one on the list, which is where the text the screen is posting back
    // came from a moment ago.
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
      refused: 'Nothing in that file could be read as a price list, so the current one has been left alone.',
      preview: emptyPreview(id, catalogue.name, result, provenance),
    })
  }

  const previousItems = await readCatalogueForDiff(id)
  const changes = diffCatalogue(previousItems, items)

  const preview: PoCatalogueImportPreview = {
    catalogueId: id,
    catalogueName: catalogue.name,
    columns: result.columns,
    ...provenance,
    itemCount: items.length,
    blankRows: result.blankRows,
    duplicateRows: result.duplicateRows,
    problems: result.problems,
    // The whole comparison would be tens of thousands of lines on a first
    // import. The counts are complete; the list shown is the first two hundred,
    // and it says so on the screen rather than pretending it is everything.
    changes: changes.slice(0, 200),
    changeCounts: countChanges(changes),
  }

  if (!parsed.data.apply) {
    // The text goes back only when the server was the one that went and got it,
    // so the screen can post the very same list to apply it. An upload already
    // has its own copy and does not need it read back.
    return NextResponse.json({ applied: false, refused: null, preview, csv: fetchedFrom ? csv : null })
  }

  await replaceCatalogueItems(id, items)
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
): PoCatalogueImportPreview {
  return {
    catalogueId,
    catalogueName,
    columns: result.columns,
    ...provenance,
    itemCount: 0,
    blankRows: result.blankRows,
    duplicateRows: result.duplicateRows,
    problems: result.problems,
    changes: [],
    changeCounts: { ADDED: 0, REMOVED: 0, RENAMED: 0, REPRICED: 0, DISCONTINUED: 0, RESTORED: 0 },
  }
}
