import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import {
  deleteCatalogue,
  getCatalogue,
  isDuplicateCatalogueName,
  listCatalogueItems,
  updateCatalogue,
} from '@/modules/purchase-orders/lib/catalogues'
import { CatalogueBody, toCatalogueInput } from '@/modules/purchase-orders/lib/catalogue-body'

type Ctx = { params: Promise<{ id: string }> }

/** One list and a page of its rows. Never the whole list: a supplier's range
 *  runs to tens of thousands of codes and nobody reads them in a browser. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const catalogue = await getCatalogue(id)
  if (!catalogue) return errorResponse('That list is not there.', 404)

  const items = await listCatalogueItems(id, request.nextUrl.searchParams.get('q') ?? '')
  return NextResponse.json({ catalogue, items })
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCatalogues) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = CatalogueBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  try {
    await updateCatalogue(id, toCatalogueInput(parsed.data))
    await recordAudit('catalogue', id, 'catalogue.updated', { name: parsed.data.name }, user.id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isDuplicateCatalogueName(error)) {
      return errorResponse('That supplier already has a list of that name. Edit the one that is there.', 409)
    }
    throw error
  }
}

/** Deleting a list takes its prices with it. Orders already drafted off it are
 *  untouched - the price was copied onto the line, not looked up - so this is a
 *  plain delete rather than a refusal with a count. */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCatalogues) return errorResponse('Forbidden', 403)

  const { id } = await params
  const catalogue = await getCatalogue(id)
  await deleteCatalogue(id)
  await recordAudit('catalogue', id, 'catalogue.deleted', { name: catalogue?.name ?? null }, user.id)
  return NextResponse.json({ ok: true })
}
