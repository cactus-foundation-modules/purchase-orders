import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { getCatalogue, readCatalogueForDiff, replaceCatalogueItems } from '@/modules/purchase-orders/lib/catalogues'
import { parseCatalogueCsv } from '@/modules/purchase-orders/lib/catalogue-import'
import { countChanges, diffCatalogue } from '@/modules/purchase-orders/lib/catalogue-matching'
import { CatalogueImportBody } from '@/modules/purchase-orders/lib/catalogue-body'
import type { PoCatalogueImportPreview } from '@/modules/purchase-orders/lib/types'

/**
 * Take a supplier's spreadsheet, or say what taking it would do.
 *
 * The same request either way, and the same code path: `apply` false works the
 * file out and hands back the comparison, `apply` true works out exactly the
 * same thing and then writes it. That is the only way the preview somebody read
 * is the import they got - and the body DEFAULTS to false, so a request that
 * forgets to say cannot overwrite a supplier's prices by accident.
 *
 * Nothing is fetched. The file is uploaded by a person; a route that went and
 * read a URL of its own accord could be pointed at an address inside the
 * network it is running in.
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

  const result = parseCatalogueCsv(parsed.data.csv)

  // A file that produced no rows at all is refused rather than applied. Every
  // one of a supplier's prices disappearing because somebody uploaded the wrong
  // sheet is not an outcome any confirmation dialog makes acceptable.
  if (result.items.length === 0) {
    return NextResponse.json({
      applied: false,
      refused: 'Nothing in that file could be read as a price list, so the current one has been left alone.',
      preview: emptyPreview(id, catalogue.name, result),
    })
  }

  const previousItems = await readCatalogueForDiff(id)
  const changes = diffCatalogue(previousItems, result.items)

  const preview: PoCatalogueImportPreview = {
    catalogueId: id,
    catalogueName: catalogue.name,
    columns: result.columns,
    itemCount: result.items.length,
    blankRows: result.blankRows,
    duplicateRows: result.duplicateRows,
    problems: result.problems,
    // The whole comparison would be tens of thousands of lines on a first
    // import. The counts are complete; the list shown is the first two hundred,
    // and it says so on the screen rather than pretending it is everything.
    changes: changes.slice(0, 200),
    changeCounts: countChanges(changes),
  }

  if (!parsed.data.apply) return NextResponse.json({ applied: false, refused: null, preview })

  await replaceCatalogueItems(id, result.items)
  await recordAudit(
    'catalogue',
    id,
    'catalogue.imported',
    { name: catalogue.name, itemCount: result.items.length, changes: preview.changeCounts },
    user.id,
  )

  return NextResponse.json({ applied: true, refused: null, preview })
}

function emptyPreview(
  catalogueId: string,
  catalogueName: string,
  result: ReturnType<typeof parseCatalogueCsv>,
): PoCatalogueImportPreview {
  return {
    catalogueId,
    catalogueName,
    columns: result.columns,
    itemCount: 0,
    blankRows: result.blankRows,
    duplicateRows: result.duplicateRows,
    problems: result.problems,
    changes: [],
    changeCounts: { ADDED: 0, REMOVED: 0, RENAMED: 0, REPRICED: 0, DISCONTINUED: 0, RESTORED: 0 },
  }
}
