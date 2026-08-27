import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { runChase } from '@/modules/purchase-orders/lib/chase-run'

// POST - chase these suppliers now, rather than waiting for the morning.
//
// Always a named list, never "everything": a person pressing a button is
// overriding both brakes the nightly job respects - chasing does not have to be
// switched on, and an order does not have to have waited out its repeat
// interval - and an override should say what it is overriding. The screen sends
// the ids it was showing, so what somebody read is what gets chased.
//
// The one thing no override can supply is an email address. A supplier with
// none comes back in `failed`, in words.
const Body = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(200),
})

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const result = await runChase({ userId: user.id, orderIds: parsed.data.orderIds })
  return NextResponse.json({ ok: true, ...result })
}
