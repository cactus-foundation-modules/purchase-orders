import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { getSupplier, searchCatalogue } from '@/modules/purchase-orders/lib/db'
import { applyCatalogueCosts, catalogueCostsForSupplier } from '@/modules/purchase-orders/lib/catalogues'

// The product picker behind the line editor. On a site with no catalogue this
// answers with an empty list and hasCatalogue false, which is what the line
// editor uses to say "type the line yourself" rather than showing a search box
// that can only ever find nothing.
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { hasCatalogue } = await getCapabilities()
  if (!hasCatalogue) return NextResponse.json({ products: [], hasCatalogue: false })

  const params = request.nextUrl.searchParams
  const term = params.get('q') ?? ''
  const supplierId = params.get('supplierId')

  // Narrowing to one supplier's products is a convenience, not a rule: plenty
  // of things get bought from whoever has them in.
  let supplierNameKey: string | null = null
  if (supplierId && params.get('onlyThisSupplier') === 'true') {
    const supplier = await getSupplier(supplierId)
    supplierNameKey = supplier?.nameKey ?? null
  }

  const products = await searchCatalogue(term, supplierNameKey)

  // The supplier's own price beats the shop's cost where their list names the
  // code. `catalogueCostsForSupplier` is itself gated on the settings switch, so
  // this is an empty map - and every product comes back untouched - on a site
  // that has not asked for price lists. No supplier chosen yet means no list to
  // price from: a price is a price FROM somebody.
  const costs = supplierId ? await catalogueCostsForSupplier(supplierId) : new Map()

  return NextResponse.json({ products: applyCatalogueCosts(products, costs), hasCatalogue: true })
}
