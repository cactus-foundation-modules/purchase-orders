import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder, getSupplier, recordOrderSent, setOrderStatus } from '@/modules/purchase-orders/lib/db'
import { loadPoDocContext, supplierParty, wordingSnapshot } from '@/modules/purchase-orders/lib/document'
import { sendOrderToSupplier, supplierRecipients } from '@/modules/purchase-orders/lib/email'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { mintPortalLink } from '@/modules/purchase-orders/lib/portal'
import { canSend } from '@/modules/purchase-orders/lib/lifecycle'

type Params = { params: Promise<{ id: string }> }

const Body = z.object({ note: z.string().max(2000).optional() })

// POST - email the purchase order to its supplier, with the document attached.
//
// This is the one route that both sends and moves the order on, and the order of
// the two is the whole design: the email goes FIRST, and the order is only
// stamped as sent once it has actually gone. Stamping first and mailing after
// would leave an order reading "Sent" that nobody ever received, which is how a
// business ends up waiting six weeks for goods it never ordered.
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

  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  const gate = canSend(order.status, order.approvalRequired)
  if (!gate.ok) return errorResponse(gate.reason, 409)

  const supplier = await getSupplier(order.supplierId)
  const recipients = supplierRecipients(supplier?.email ?? null, supplier?.emailCc ?? null)
  if (!recipients) {
    return errorResponse('This supplier has no email address on file, so there is nowhere to send it.', 409)
  }

  const ctx = await loadPoDocContext(id)
  if (!ctx) return errorResponse('That purchase order is not here any more.', 404)

  // First time out, or an amendment replacing what they already hold. The
  // revision decides rather than the status, because an order can be amended
  // while it is part received and it is still an amendment.
  const kind = order.sentAt ? 'amended' : 'sent'

  // The supplier's own link, minted here so it can travel in the email. Null
  // where the owner has the supplier link switched off, in which case the
  // template's link paragraph renders as nothing at all rather than as an empty
  // invitation.
  const portalLink = await mintPortalLink(id, order.number, user.id)

  try {
    await sendOrderToSupplier(ctx, recipients, kind, parsed.data.note ?? null, portalLink)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The order could not be sent.'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  // Freezes the supplier and the wording onto the order the first time only, so
  // what they were sent stays readable however the records change afterwards.
  await recordOrderSent(id, supplierParty(supplier) as unknown as Record<string, unknown>, await wordingSnapshot(), [
    recipients.to,
    ...recipients.cc,
  ])

  // An order already past SENT keeps the status it has: an amendment to a part
  // received order does not send it back to the beginning.
  if (order.status === 'DRAFT' || order.status === 'APPROVED') {
    await setOrderStatus(id, 'SENT', {}, user.id)
  }

  await recordAudit(
    'order',
    id,
    kind === 'sent' ? 'order.sent' : 'order.amendment-sent',
    {
      to: recipients.to,
      cc: recipients.cc,
      revision: order.revision,
      note: parsed.data.note ?? null,
      portalLink: Boolean(portalLink),
    },
    user.id,
  )

  return NextResponse.json({ ok: true, kind, to: recipients.to, cc: recipients.cc })
}
