import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { FILEABLE_KINDS } from '@/modules/purchase-orders/lib/inbound-filing'
import { dismissPaperwork, fileManually } from '@/modules/purchase-orders/lib/inbound-run'
import { applyTrackingProposal } from '@/modules/purchase-orders/lib/inbound-tracking'

type Params = { params: Promise<{ id: string }> }

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('file'),
    orderId: z.string().min(1, 'Pick the purchase order it belongs on.').max(100),
    kind: z.enum(FILEABLE_KINDS),
    ref: z.string().max(120).optional(),
  }),
  z.object({ action: z.literal('apply-tracking') }),
  z.object({ action: z.literal('not-ours') }),
  z.object({ action: z.literal('ignore') }),
])

// POST - a person's decision on one waiting document: file it on this order
// as this kind of paperwork, it is not ours, or leave it be. For delivery
// tracking matched by postcode alone, "yes, that one" records it as the
// order's despatch, exactly as a certain match would have.
//
// Filing runs exactly the code the half-hourly job runs, rules included, so a
// choice made here cannot put a proforma on a cancelled order any more than the
// machine can. It refuses with the same sentences.
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')
  const body = parsed.data

  if (body.action === 'file') {
    if (body.kind === 'invoice' && !access.canBills) {
      return errorResponse('Filing an invoice enters a bill, which needs the bills permission.', 403)
    }
    const result = await fileManually(id, { orderId: body.orderId, kind: body.kind, ref: body.ref ?? null }, user.id)
    if (!result.ok) return errorResponse(result.reason, 409)
    return NextResponse.json({ ok: true, orderNumber: result.orderNumber })
  }

  if (body.action === 'apply-tracking') {
    const result = await applyTrackingProposal(id, user.id)
    if (!result.ok) return errorResponse(result.reason, 409)
    return NextResponse.json({ ok: true, orderNumber: result.orderNumber })
  }

  const done = await dismissPaperwork(id, body.action, user.id)
  if (!done) return errorResponse('Somebody has already dealt with that one.', 409)
  return NextResponse.json({ ok: true })
}
