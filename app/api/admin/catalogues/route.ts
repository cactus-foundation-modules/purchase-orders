import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { listSuppliers } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import {
  createCatalogue,
  isDuplicateCatalogueName,
  listCatalogues,
  listShopCatalogues,
} from '@/modules/purchase-orders/lib/catalogues'
import { CatalogueBody, toCatalogueInput } from '@/modules/purchase-orders/lib/catalogue-body'

// The Catalogues tab in one round trip: the lists, the suppliers they belong
// to, and - for whichever supplier is being looked at - the catalogues shop
// already has on file for them, so a list can be picked rather than typed.
//
// `supplierCatalogues` rides along rather than being read separately, because
// the tab has to be able to say "this is switched off" without a second call.
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const supplierId = request.nextUrl.searchParams.get('supplierId')

  const [catalogues, suppliers, capabilities, config] = await Promise.all([
    listCatalogues(),
    listSuppliers(),
    getCapabilities(),
    getPoConfigCached(),
  ])

  // Shop records its catalogues against ITS supplier row, which this module
  // links to by id and by name snapshot. No link, nothing to offer - and the
  // form still takes a pasted address.
  const linked = supplierId ? (suppliers.find((s) => s.id === supplierId)?.shopSupplierId ?? null) : null
  const shopCatalogues = await listShopCatalogues(linked)

  return NextResponse.json({
    catalogues,
    suppliers,
    shopCatalogues,
    capabilities,
    enabled: config.supplierCatalogues,
    canEdit: access.canCatalogues,
  })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCatalogues) return errorResponse('Forbidden', 403)

  const parsed = CatalogueBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  try {
    const id = await createCatalogue(toCatalogueInput(parsed.data), user.id)
    await recordAudit('catalogue', id, 'catalogue.created', { name: parsed.data.name }, user.id)
    return NextResponse.json({ id })
  } catch (error) {
    if (isDuplicateCatalogueName(error)) {
      return errorResponse('That supplier already has a list of that name. Edit the one that is there.', 409)
    }
    throw error
  }
}
