import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { getSupplier } from '@/modules/purchase-orders/lib/db'
import { catalogueCostsForSupplier, listShopProductsForSupplier } from '@/modules/purchase-orders/lib/catalogues'
import { reconcileCatalogue } from '@/modules/purchase-orders/lib/catalogue-matching'

/**
 * What the shop is selling against what this supplier says they sell.
 *
 * Worked out on read rather than stored, for the reason the reorder suggestions
 * are: a list imported an hour ago changes the answer, and a screen showing last
 * week's verdict is how somebody orders a code that stopped existing on Friday.
 *
 * Read-only in every sense. It changes nothing in the shop and nothing here; it
 * hands back a list of sentences for a person to act on.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const supplierId = request.nextUrl.searchParams.get('supplierId')
  if (!supplierId) return errorResponse('Which supplier?')

  const supplier = await getSupplier(supplierId)
  if (!supplier) return errorResponse('That supplier is not on your list.', 404)

  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) {
    return NextResponse.json({
      hasCatalogue: false,
      reconciliation: null,
    })
  }

  const config = await getPoConfigCached()
  const [products, costs] = await Promise.all([
    listShopProductsForSupplier(supplier.nameKey),
    catalogueCostsForSupplier(supplierId),
  ])

  return NextResponse.json({
    hasCatalogue: true,
    // The bill match's own tolerance, deliberately reused: a site that has said
    // it does not care about a 2% difference on an invoice does not want four
    // hundred findings about the same 2% on a price list.
    reconciliation: reconcileCatalogue(
      supplier.id,
      supplier.name,
      products,
      costs,
      config.priceVarianceTolerancePercent,
    ),
  })
}
