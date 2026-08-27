import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { listOrdersAwaitingDelivery, listReceipts } from '@/modules/purchase-orders/lib/receipts'
import { stockBlockedReason } from '@/modules/purchase-orders/lib/inventory'

// Everything the Receiving tab draws, in one request: what is still expected,
// what has already turned up, and whether stock is in play at all. Three round
// trips for one screen is three chances to render it half-populated.
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const search = request.nextUrl.searchParams.get('search') ?? ''
  const [awaiting, receipts, stockBlocked] = await Promise.all([
    listOrdersAwaitingDelivery(search),
    listReceipts(50, search),
    stockBlockedReason(),
  ])

  return NextResponse.json({ awaiting, receipts, stockBlocked })
}
