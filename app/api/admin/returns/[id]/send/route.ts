import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getSupplier } from '@/modules/purchase-orders/lib/db'
import { getReturn, recordReturnSent, setReturnStatus } from '@/modules/purchase-orders/lib/returns'
import { loadPoRetDocContext } from '@/modules/purchase-orders/lib/return-document'
import { sendReturnToSupplier, supplierRecipients } from '@/modules/purchase-orders/lib/email'
import { canSendReturn } from '@/modules/purchase-orders/lib/returning'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

// POST - email the returns note to its supplier, with the document attached.
//
// The email goes FIRST and the note is only stamped as sent once it has actually
// gone, exactly as the order does it. Stamping first would leave a return reading
// "Sent" that nobody ever received - and a pallet on a supplier's dock with no
// paperwork behind it is worse than one that has not left yet.
export async function POST(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canReceive) return errorResponse('Forbidden', 403)

  const { id } = await params
  const ret = await getReturn(id)
  if (!ret) return errorResponse('That return is not here any more.', 404)
  if (!canSendReturn(ret.status)) {
    return errorResponse(
      `A return that is ${ret.status.toLowerCase().replace(/_/g, ' ')} cannot be sent to a supplier.`,
      409,
    )
  }

  const supplier = await getSupplier(ret.supplierId)
  const recipients = supplierRecipients(supplier?.email ?? null, supplier?.emailCc ?? null)
  if (!recipients) {
    return errorResponse('This supplier has no email address on file, so there is nowhere to send it.', 409)
  }

  const ctx = await loadPoRetDocContext(id)
  if (!ctx) return errorResponse('That return is not here any more.', 404)

  try {
    await sendReturnToSupplier(ctx, recipients)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The return could not be sent.'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  await recordReturnSent(id)
  // A draft becomes sent. A note being re-sent because the supplier lost the
  // first copy keeps whatever it had got to.
  if (ret.status === 'DRAFT') await setReturnStatus(id, 'SENT', {})

  await recordAudit(
    'return',
    id,
    'return.sent',
    { to: recipients.to, cc: recipients.cc, credit: ret.creditExpected },
    user.id,
  )

  return NextResponse.json({ ok: true, to: recipients.to, cc: recipients.cc, status: ret.status === 'DRAFT' ? 'SENT' : ret.status })
}
