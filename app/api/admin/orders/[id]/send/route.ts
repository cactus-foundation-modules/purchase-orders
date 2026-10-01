import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { sendOrderRun } from '@/modules/purchase-orders/lib/send-run'
import { personName } from '@/modules/purchase-orders/lib/auto-send-queue'

type Params = { params: Promise<{ id: string }> }

const Body = z.object({
  note: z.string().max(2000).optional(),
  // When the order was last sent as the sender's screen showed it, null for
  // never. Optional: left out, it is not checked.
  seenSentAt: z.string().max(64).nullable().optional(),
})

// POST - email the purchase order to its supplier, with the document attached.
//
// The sending itself is lib/send-run.ts, shared with the automatic job so the
// button and the job can never send two different ways. This is the session,
// the permission and the body, and the answer.
//
// Unlike most of what this module sends, a failure here is a failure. Somebody
// pressed a button and is owed a real error in the words the mailer gave.
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const result = await sendOrderRun({
    orderId: id,
    userId: user.id,
    by: 'USER',
    note: parsed.data.note ?? null,
    personName: personName(user),
    seenSentAt: parsed.data.seenSentAt,
  })
  switch (result.outcome) {
    case 'refused':
      return errorResponse(result.reason, result.status)
    case 'failed':
      return NextResponse.json({ error: result.error }, { status: 502 })
    case 'sent':
      return NextResponse.json({ ok: true, kind: result.kind, to: result.to, cc: result.cc })
    // The job's own outcomes; a person's send never produces them.
    case 'stale':
    case 'unrecorded':
      return errorResponse('The order could not be sent.', 500)
  }
}
