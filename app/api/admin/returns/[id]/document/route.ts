import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { getSiteUrl } from '@/lib/config/env'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getReturn } from '@/modules/purchase-orders/lib/returns'
import { poReturnDocumentPath } from '@/modules/purchase-orders/lib/print-token'

type Params = { params: Promise<{ id: string }> }

// GET - opens the return's own document page.
//
// A redirect rather than a link the admin screen builds for itself: the token is
// short-lived and has to be minted at the moment somebody presses the button.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const ret = await getReturn(id)
  if (!ret) return errorResponse('That return is not here any more.', 404)

  return NextResponse.redirect(`${getSiteUrl()}${poReturnDocumentPath(ret.number)}`)
}
