import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { listSuppliers } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import {
  createReorderRule,
  gatherReorderFacts,
  isDuplicateReorderProduct,
  listReorderRules,
  searchReorderProducts,
} from '@/modules/purchase-orders/lib/reorder'
import { planReorder } from '@/modules/purchase-orders/lib/reordering'
import { ReorderRuleBody, toReorderRuleInput } from '@/modules/purchase-orders/lib/reorder-body'

// The Reorder tab in one round trip: the levels, what they say should be bought
// today, and the suppliers and products the editor needs to offer.
//
// The suggestions are worked out on READ rather than stored. A delivery booked
// in an hour ago changes the answer, and a screen showing last night's verdict
// is how somebody orders twelve of something that turned up on Tuesday - the
// same reasoning the bill match is recomputed under.
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const capabilities = await getCapabilities()
  const config = await getPoConfigCached()

  const [rules, suppliers, products] = await Promise.all([
    listReorderRules(),
    listSuppliers(),
    searchReorderProducts(request.nextUrl.searchParams.get('q') ?? ''),
  ])

  // Nothing to plan without a catalogue: no counts, so no level was ever
  // crossed. The rules still come back, so they can be tidied up.
  const review = capabilities.hasCatalogue
    ? planReorder(await gatherReorderFacts(config.reorderAutomatic))
    : { suggestions: [], plans: [], restingCount: 0 }

  return NextResponse.json({
    rules,
    suppliers,
    products,
    capabilities,
    automatic: config.reorderAutomatic,
    ...review,
  })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const parsed = ReorderRuleBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  try {
    const id = await createReorderRule(toReorderRuleInput(parsed.data))
    await recordAudit('settings', 'reorder', 'reorder.rule-created', { productId: parsed.data.productId }, user.id)
    return NextResponse.json({ id })
  } catch (error) {
    if (isDuplicateReorderProduct(error)) {
      return errorResponse('That product already has a reorder level. Edit the one that is there.', 409)
    }
    throw error
  }
}
