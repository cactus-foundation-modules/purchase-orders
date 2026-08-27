import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { ReorderRaiseBody } from '@/modules/purchase-orders/lib/reorder-body'
import { runReorder } from '@/modules/purchase-orders/lib/reorder-run'

// "Raise these now", off the Reorder tab.
//
// Naming suppliers overrides both of the nightly job's brakes - the minimum
// order value and the automatic switch - because a person has looked at the
// screen and decided. Sending no suppliers at all runs exactly what the job
// would have run, which is the dry-run-then-do-it people actually want.
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const parsed = ReorderRaiseBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const result = await runReorder({
    userId: user.id,
    supplierIds: parsed.data.supplierIds.length > 0 ? parsed.data.supplierIds : null,
  })
  return NextResponse.json(result)
}
