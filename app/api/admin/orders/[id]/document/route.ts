import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { getSiteUrl } from '@/lib/config/env'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { poDocumentPath } from '@/modules/purchase-orders/lib/print-token'

type Params = { params: Promise<{ id: string }> }

// GET - opens the order's own document page.
//
// A redirect rather than a link the admin screen builds for itself, for one
// reason: the token is short-lived and has to be minted at the moment somebody
// presses the button. Handing the screen a token when the order loads would give
// it one that had already aged out by the time anybody clicked, and putting a
// long-lived one in a JSON payload would defeat the point of it being short.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  return NextResponse.redirect(`${getSiteUrl()}${poDocumentPath(order.number)}`)
}
