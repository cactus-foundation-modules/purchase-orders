import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { sendPortalReplyToBuyer } from '@/modules/purchase-orders/lib/email'
import { PortalUploadFields } from '@/modules/purchase-orders/lib/portal-body'
import { buildPortalView } from '@/modules/purchase-orders/lib/portal-response'
import { readPortalUpload, storePortalUpload } from '@/modules/purchase-orders/lib/portal-upload'
import { setAcknowledgementDocument, setProformaDocument } from '@/modules/purchase-orders/lib/proforma'
import {
  acknowledgeFromPortal, portalNoticeRecipient, recordPortalEvent, resolvePortalToken,
} from '@/modules/purchase-orders/lib/portal'
import { hashPortalIp } from '@/modules/purchase-orders/lib/portal-token'
import { allowPortalWriteIp, allowPortalWriteToken, portalClientIp } from '@/modules/purchase-orders/lib/portal-rate-limit'
import { isPortalOpen, portalEventSummary } from '@/modules/purchase-orders/lib/portal-view'

// POST - the two documents a supplier sends us, arriving as a file.
//
// Multipart rather than JSON because a PDF cannot ride on JSON, and its own
// route rather than a branch of the action endpoint because the two have nothing
// in common past the token: one parses a body, the other reads bytes off a form
// and puts them in the media library.
//
// Two kinds and no third:
//
//  - proforma        their invoice, on an order to a supplier we pay up front.
//  - acknowledgement their confirmation of the order, which ALSO accepts it -
//                    that is the button they pressed, and making them press a
//                    second one afterwards is how an order sits unconfirmed with
//                    its own acknowledgement attached.
//
// Everything the other portal endpoint promises holds here: the order is looked
// up from the token, nothing on the wire names it, and every failure that could
// confirm a link exists is the same 404.
export async function POST(request: NextRequest) {
  const ip = portalClientIp(request)
  if (!allowPortalWriteIp(ip)) {
    return errorResponse('That is a lot of files at once. Give it a few minutes.', 429)
  }

  const form = await request.formData().catch(() => null)
  if (!form) return errorResponse('We could not read that.')

  const parsed = PortalUploadFields.safeParse({
    token: form.get('token') ?? '',
    kind: form.get('kind') ?? '',
    ref: form.get('ref')?.toString().trim() || undefined,
    amount: form.get('amount')?.toString().trim() || undefined,
    note: form.get('note')?.toString().trim() || undefined,
  })
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'We could not read that.')
  const fields = parsed.data

  const config = await getPoConfigCached()
  if (!config.portalEnabled) return errorResponse('That link is not open any more.', 404)
  if (!config.portalUploadsEnabled) {
    return errorResponse('We are not taking files through this page. Email it to us instead.', 409)
  }

  const token = await resolvePortalToken(fields.token)
  if (!token) return errorResponse('That link is not open any more.', 404)
  if (!allowPortalWriteToken(token.hash)) {
    return errorResponse('That is a lot of files at once. Give it a few minutes.', 429)
  }

  const order = await getOrder(token.orderId)
  if (!order) return errorResponse('That link is not open any more.', 404)
  if (!isPortalOpen(order.status)) {
    return errorResponse('This order is closed, so there is nothing left to send us for it.', 409)
  }
  if (fields.kind === 'acknowledgement' && order.proformaRequired && !order.proformaPaidAt) {
    return errorResponse(
      'We have not paid your proforma yet. Send it to us if you have not already, and confirm the order once it is settled.',
      409,
    )
  }

  // The file is read and sniffed BEFORE anything is written, so a refusal leaves
  // the order exactly as it was.
  const upload = await readPortalUpload(form.get('file'))
  if (!upload.ok) return errorResponse(upload.reason, upload.status)

  const stored = await storePortalUpload(upload, fields.kind, order.number)
  if (!stored.ok) return errorResponse(stored.reason, stored.status)

  const note = (fields.note ?? '').trim()
  const ref = (fields.ref ?? '').trim()

  if (fields.kind === 'proforma') {
    await setProformaDocument(order.id, stored.mediaId, ref || null, fields.amount ?? null)
  } else {
    await setAcknowledgementDocument(order.id, stored.mediaId, ref || null)
    // Same guarded write the plain acknowledge action makes. Attaching the
    // acknowledgement IS accepting the order.
    await acknowledgeFromPortal(order.id, note || null)
  }

  const kind = fields.kind === 'proforma' ? 'PROFORMA' : 'ACKNOWLEDGED'
  const payload: Record<string, unknown> =
    fields.kind === 'proforma'
      ? { ref, amount: fields.amount ?? '', filename: upload.filename, note }
      : { ref, document: true, filename: upload.filename, note }

  await recordPortalEvent(token.id, order.id, kind, payload, hashPortalIp(ip))

  const summary = portalEventSummary(kind, payload)
  await recordAudit(
    'order',
    order.id,
    `order.portal-${kind.toLowerCase()}`,
    { note: summary, supplier: order.supplierName, filename: upload.filename },
    null,
  )

  const to = await portalNoticeRecipient()
  if (to) await sendPortalReplyToBuyer(to, order.supplierName, order.number, summary)

  const view = await buildPortalView(order.id)
  return NextResponse.json({ ok: true, view })
}
