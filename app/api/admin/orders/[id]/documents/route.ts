import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { readBillUpload } from '@/modules/purchase-orders/lib/bill-attachment'
import { storeOrderDocument, PO_FILE_KINDS } from '@/modules/purchase-orders/lib/portal-upload'
import { guessDocumentReference } from '@/modules/purchase-orders/lib/document-reference'
import {
  orderDocuments,
  setAcknowledgementDocument,
  setAcknowledgementReference,
  setPaymentProofDocument,
  setProformaAmount,
  setProformaDocument,
  setProformaReference,
} from '@/modules/purchase-orders/lib/proforma'

// The supplier's paperwork, filed from THIS end.
//
// Their own link is the tidy way in and plenty of suppliers will never touch it:
// they email the proforma, they attach the acknowledgement to a reply, or they
// post it. Before this route existed, all of that arrived at a screen with
// nowhere to put it - so the file lived in somebody's inbox and the order said
// "not here yet" for ever.
//
// Three kinds, and the third goes the other way:
//
//  - proforma        their invoice, on an order we pay up front.
//  - acknowledgement their confirmation, as a document.
//  - payment-proof   what WE send THEM to show the money left. Not something a
//                    supplier can ever upload, which is why the portal's own
//                    endpoint takes only the first two.
//
// Where the reference is left blank the file is read for it
// (lib/document-reference.ts). It is a guess, it is never allowed to overwrite
// something already typed, and it lands on a screen where it can be corrected.

type Params = { params: Promise<{ id: string }> }

const KIND = z.enum(PO_FILE_KINDS)

const UploadFields = z.object({
  kind: KIND,
  ref: z.string().max(120).optional(),
})

/** The three fields somebody can type in without a file to go with them. An
 *  empty string is "clear it" rather than "leave it alone" - the whole reason
 *  these do not go through the upload's own COALESCE write. */
const ReferenceBody = z.object({
  proformaRef: z.string().max(120).optional(),
  ackRef: z.string().max(120).optional(),
  proformaAmount: z
    .string()
    .regex(/^$|^\d{1,10}(\.\d{1,2})?$/, 'That amount does not look right.')
    .optional(),
})

// POST - a document arrives, as a file off the screen.
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)

  const { id } = await params
  const form = await request.formData().catch(() => null)
  if (!form) return errorResponse('We could not read that.')

  const parsed = UploadFields.safeParse({
    kind: form.get('kind') ?? '',
    ref: form.get('ref')?.toString().trim() || undefined,
  })
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'We could not read that.')
  const { kind } = parsed.data

  // Filing their paperwork is clerical. Attaching the proof of a payment is part
  // of paying, so it wants the same hands as the button that records one.
  const allowed = kind === 'payment-proof' ? access.canApprove || access.canBills : access.canCreate
  if (!allowed) return errorResponse('Forbidden', 403)

  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)
  if (kind === 'payment-proof' && !order.proformaRequired) {
    return errorResponse('This order is on the supplier’s account, so there is no proforma to prove a payment against.', 409)
  }

  // Read and sniffed BEFORE anything is written, so a refusal leaves the order
  // exactly as it was.
  const upload = await readBillUpload(form)
  if (!upload.ok) return errorResponse(upload.reason, upload.status)

  const stored = await storeOrderDocument(upload, kind, order.number, user.id)
  if (!stored.ok) return errorResponse(stored.reason, stored.status)

  const typed = (parsed.data.ref ?? '').trim()
  // Only ever where the box was left empty, and never against a reference the
  // order already carries: a guess does not get to overrule a person.
  const existing = kind === 'proforma' ? order.proformaRef : order.ackRef
  const guessed =
    kind === 'payment-proof' || typed || existing
      ? null
      : guessDocumentReference(kind, upload.filename, upload.buffer, order.number)
  const ref = typed || guessed

  if (kind === 'proforma') {
    // The amount is left alone: what a proforma is for is typed in on the card
    // (PATCH, below) rather than guessed at out of a file, and an upload must
    // never quietly rewrite a figure somebody put there.
    await setProformaDocument(id, stored.mediaId, ref, null)
  } else if (kind === 'acknowledgement') {
    await setAcknowledgementDocument(id, stored.mediaId, ref)
  } else {
    await setPaymentProofDocument(id, stored.mediaId)
  }

  const what =
    kind === 'proforma' ? 'proforma' : kind === 'acknowledgement' ? 'acknowledgement' : 'proof of payment'
  await recordAudit(
    'order',
    id,
    `order.${kind}-filed`,
    {
      note: `Filed their ${what}${ref ? `, reference ${ref}` : ''}`,
      filename: upload.filename,
      // Said in the log, because a number nobody typed is worth being able to
      // tell apart from one somebody did.
      readOffTheFile: Boolean(guessed),
    },
    user.id,
  )

  const after = await getOrder(id)
  return NextResponse.json({
    ok: true,
    order: after,
    documents: await orderDocuments(after),
    // The screen says so out loud rather than quietly filling a box: a number
    // that appeared on its own is a number worth a glance.
    readOffTheFile: guessed,
  })
}

// PATCH - the numbers, typed in or corrected, with no file involved.
//
// A supplier who rings the number through, a scan with no text in it, or a guess
// that read the wrong line: all of them end here.
export async function PATCH(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = ReferenceBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  const changed: string[] = []
  if (parsed.data.proformaRef !== undefined) {
    const ref = parsed.data.proformaRef.trim() || null
    await setProformaReference(id, ref)
    changed.push(ref ? `their proforma number to ${ref}` : 'their proforma number cleared')
  }
  if (parsed.data.ackRef !== undefined) {
    const ref = parsed.data.ackRef.trim() || null
    await setAcknowledgementReference(id, ref)
    changed.push(ref ? `their sales order number to ${ref}` : 'their sales order number cleared')
  }
  if (parsed.data.proformaAmount !== undefined) {
    const amount = parsed.data.proformaAmount.trim() || null
    await setProformaAmount(id, amount)
    changed.push(amount ? `the proforma amount to ${amount}` : 'the proforma amount cleared')
  }
  if (!changed.length) return errorResponse('There was nothing to change.')

  await recordAudit('order', id, 'order.supplier-references', { note: `Set ${changed.join(', ')}` }, user.id)

  const after = await getOrder(id)
  return NextResponse.json({ ok: true, order: after, documents: await orderDocuments(after) })
}
