import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { buildReports } from '@/modules/purchase-orders/lib/reports'

// GET - the whole Reports tab in one round trip.
//
// Everything is worked out on READ rather than stored, the same way the reorder
// suggestions and the bill match are. A delivery booked in ten minutes ago has
// already changed what the site is committed to, and a report showing last
// night's answer is one nobody trusts by the end of the week.
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const params = request.nextUrl.searchParams
  const reports = await buildReports({ from: params.get('from'), to: params.get('to') })

  return NextResponse.json({ ...reports, canChase: access.canCreate })
}
