import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder, getSupplier } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { proformaPaidRecipients, sendProformaPaid } from '@/modules/purchase-orders/lib/email'
import { formatMoney } from '@/modules/purchase-orders/lib/money'
import { mintPortalLink } from '@/modules/purchase-orders/lib/portal'
import {
  clearProformaPayment, markProformaPaid, markProofSent, mediaAttachment, setProformaRequired,
} from '@/modules/purchase-orders/lib/proforma'

type Params = { params: Promise<{ id: string }> }

const PayBody = z.object({
  paymentRef: z.string().max(120).optional(),
  /** Whether the proof of payment filed against the order travels with the
   *  email. Off unless asked for: not every payment has one, and a supplier who
   *  did not ask for one does not need it. */
  sendProof: z.boolean().optional(),
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
  const wantsProof = parsed.data.sendProof === true
  const claimed = await markProformaPaid(id, ref, user.id)
  if (!claimed && !wantsProof) {
    // Somebody else got there first. The state the caller wanted is the state
    // that holds, so this is not an error - but it is worth saying rather than
    // silently re-dating their payment.
    return NextResponse.json({ ok: true, alreadyPaid: true })
  }

  // The proof, where one is filed and somebody has asked for it to go. Fetched
  // before the email rather than inside it, so a proof that cannot be read
  // becomes a message the screen can make - the email still goes, saying the
  // money has moved, which is the half that matters most.
  const proof = wantsProof ? await mediaAttachment(order.proformaPaymentProofMediaId) : null

  // And the supplier is told, every time. On these terms they are waiting on
  // this and nothing else - their own link will not let them confirm the order
  // until the money has moved - so this is not an option on a checkbox. It is
  // best-effort: the payment has already been recorded, and taking it back
  // because a mail server was busy would be the worse of the two wrongs.
  const supplier = await getSupplier(order.supplierId)
  // Their accounts department where the supplier says so, and the ordering desk
  // otherwise. This is the only email in the module that asks.
  const recipients = proformaPaidRecipients(supplier)
  let emailed = false
  if (recipients) {
    // A fresh link travels with it, so "you can confirm the order now" is
    // something they can act on from the same email. Null where the site has the
    // supplier link switched off, and the paragraph then renders as nothing.
    const portalLink = await mintPortalLink(id, order.number, user.id)
    emailed = await sendProformaPaid(
      order.supplierName,
      order.number,
      recipients,
      {
        paymentRef: ref,
        amount: formatMoney(order.proformaAmount ?? order.total, order.currency),
        proformaRef: order.proformaRef,
      },
      portalLink,
      proof,
    )
  }
  // Stamped only where it actually travelled. A proof recorded as sent that
  // never left is the one lie this screen must not tell.
  if (emailed && proof) await markProofSent(id)

  await recordAudit(
    'order',
    id,
    claimed ? 'order.proforma-paid' : 'order.proforma-proof-resent',
    {
      note:
        (claimed ? (ref ? `Proforma paid, reference ${ref}` : 'Proforma paid') : 'Proof of payment sent again') +
        (emailed && proof ? ', with the proof of payment attached' : ''),
      supplier: order.supplierName,
      emailed,
      proofAttached: Boolean(emailed && proof),
      to: recipients?.to ?? null,
    },
    user.id,
  )
  const after = await getOrder(id)
  return NextResponse.json({
    ok: true,
    order: after,
    alreadyPaid: !claimed,
    emailed,
    // Said apart from `emailed`: an email that went without the attachment
    // somebody asked for is not the thing they pressed the button for.
    proofSent: Boolean(emailed && proof),
    proofProblem:
      wantsProof && !proof
        ? 'The email went, but the proof of payment could not be read, so it did not travel with it. Upload it again.'
        : null,
    // Said plainly rather than left for somebody to notice: a supplier who was
    // not told is a supplier still waiting.
    emailProblem: emailed
      ? null
      : recipients
        ? 'The payment is recorded, but the email telling them could not be sent. Check Settings, Emails.'
        : 'The payment is recorded, but this supplier has no email address on file, so nobody has told them.',
    // Which desk it went to, so the screen can say "their accounts department"
    // rather than leaving somebody to guess whether the switch did anything.
    emailedTo: recipients?.to ?? null,
  })
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
