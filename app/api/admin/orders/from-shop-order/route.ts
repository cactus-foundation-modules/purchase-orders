import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { raisePurchaseOrdersFromShopOrder } from '@/modules/purchase-orders/lib/from-order-run'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'

const FromShopOrderBody = z.object({
  orderId: z.string().trim().min(1, 'Which order?').max(100),
})

// "Order this from the suppliers", off the panel on a customer order.
//
// Drafts only, one per supplier, drop-shipped to the customer. Nothing is
// emailed to anybody: the drafts land in Purchasing and a person sends them.
//
// A second press is refused rather than obeyed - see the idempotency guard in
// lib/from-order-run.ts. The refusal comes back as a 200 with a `refused`
// sentence rather than as an error status: nothing went wrong, the answer is
// simply "these already exist", and the panel says so beside the orders it is
// already listing.
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const parsed = FromShopOrderBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const result = await raisePurchaseOrdersFromShopOrder({ orderId: parsed.data.orderId, userId: user.id })
  return NextResponse.json(result)
}
