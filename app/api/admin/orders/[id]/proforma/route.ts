import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import {
  clearProformaPayment, markProformaPaid, setProformaRequired,
} from '@/modules/purchase-orders/lib/proforma'

type Params = { params: Promise<{ id: string }> }

const PayBody = z.object({
  paymentRef: z.string().max(120).optional(),
})

const RequiredBody = z.object({
  required: z.boolean(),
})

// POST - we have paid the supplier's proforma.
//
// This is the button the whole proforma flow turns on: until it is pressed the
// supplier's own page will not let them confirm the order, because on these
// terms the order is not theirs to confirm. So it is deliberately a decision
// somebody makes rather than something inferred from a bank feed nobody has
// connected - and it is `canApprove` rather than `canCreate`, because it is a
// statement that money has left the building.
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canApprove && !access.canBills) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = PayBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)
  if (!order.proformaRequired) {
    return errorResponse('This order is not on proforma terms, so there is no proforma to pay.', 409)
  }

  const ref = (parsed.data.paymentRef ?? '').trim() || null
  const claimed = await markProformaPaid(id, ref, user.id)
  if (!claimed) {
    // Somebody else got there first. The state the caller wanted is the state
    // that holds, so this is not an error - but it is worth saying rather than
    // silently re-dating their payment.
    return NextResponse.json({ ok: true, alreadyPaid: true })
  }

  await recordAudit(
    'order',
    id,
    'order.proforma-paid',
    { note: ref ? `Proforma paid, reference ${ref}` : 'Proforma paid', supplier: order.supplierName },
    user.id,
  )
  const after = await getOrder(id)
  return NextResponse.json({ ok: true, order: after })
}

// DELETE - taking that back, for the day somebody presses it on the wrong order.
// The proforma itself stays where it is; only the payment is undone.
export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canApprove && !access.canBills) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  await clearProformaPayment(id)
  await recordAudit('order', id, 'order.proforma-unpaid', { note: 'Proforma payment taken back' }, user.id)
  const after = await getOrder(id)
  return NextResponse.json({ ok: true, order: after })
}

// PATCH - whether THIS order waits for a proforma at all.
//
// The supplier's account terms decide it when the order is raised, and that is
// right nearly every time. This is the exception: a one-off from a supplier we
// have an account with who wants the money up front, or an order to a proforma
// supplier that they have agreed to put on the account just this once.
export async function PATCH(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = RequiredBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  await setProformaRequired(id, parsed.data.required)
  await recordAudit(
    'order',
    id,
    'order.proforma-terms',
    { note: parsed.data.required ? 'Set to proforma terms' : 'Taken off proforma terms' },
    user.id,
  )
  const after = await getOrder(id)
  return NextResponse.json({ ok: true, order: after })
}
