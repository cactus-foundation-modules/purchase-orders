import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { sendPortalReplyToBuyer } from '@/modules/purchase-orders/lib/email'
import { PortalUploadFields } from '@/modules/purchase-orders/lib/portal-body'
import { buildPortalView } from '@/modules/purchase-orders/lib/portal-response'
import { readPortalUpload, storePortalUpload } from '@/modules/purchase-orders/lib/portal-upload'
import { guessDocumentReference } from '@/modules/purchase-orders/lib/document-reference'
import {
  replaceProformaDocument, setAcknowledgementDocument, setProformaDocument, setProformaWarning,
} from '@/modules/purchase-orders/lib/proforma'
import { proformaReplacementWarning } from '@/modules/purchase-orders/lib/inbound-filing'
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

  // A paid proforma is never replaced, whichever door the new one comes in by:
  // a "revised" proforma after the money has gone is the shape of invoice
  // fraud, and this link cannot prove who is holding it. Refused before the
  // file is stored, so nothing is left behind.
  if (fields.kind === 'proforma' && order.proformaPaidAt) {
    return errorResponse(
      'We have already paid your proforma for this order, so we cannot take a new one through this page. Please ring us.',
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
  const typed = (fields.ref ?? '').trim()
  // Their own number, read off the document where they did not type it in.
  //
  // Most suppliers upload the file and leave the reference box alone - it is one
  // more thing to copy out of a PDF they have already sent - and the number then
  // gets typed in at this end instead, off the screen, by somebody who has to
  // open the file to find it. It is a guess, it never overwrites a number
  // already on the order, and it shows on their own page where they can correct
  // it.
  const existing = fields.kind === 'proforma' ? order.proformaRef : order.ackRef
  const ref =
    typed || existing
      ? typed
      : guessDocumentReference(fields.kind, upload.filename, upload.buffer, order.number) ?? ''

  let warning: string | null = null
  if (fields.kind === 'proforma') {
    const hasOne = Boolean(order.proformaMediaId) || Boolean(order.proformaRef) || Boolean(order.proformaAmount)
    if (!hasOne) {
      await setProformaDocument(order.id, stored.mediaId, ref || null, fields.amount ?? null)
    } else {
      // A second proforma: the same checks and the same pay gate as one from
      // email (lib/inbound-filing.ts). Their own number is read off the file
      // where they left the box empty, because the one on the order is the
      // OLD document's and must not stand beside the new file.
      const theirs = typed || guessDocumentReference('proforma', upload.filename, upload.buffer, order.number) || null
      warning = proformaReplacementWarning(
        { mediaId: order.proformaMediaId, ref: order.proformaRef, amount: order.proformaAmount },
        { ref: theirs, amount: fields.amount ?? null },
        order.currency,
      )
      if (!(await replaceProformaDocument(order.id, stored.mediaId, theirs, fields.amount ?? null, null))) {
        return errorResponse(
          'We have already paid your proforma for this order, so we cannot take a new one through this page. Please ring us.',
          409,
        )
      }
      if (warning) await setProformaWarning(order.id, warning)
    }
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

  const summary = portalEventSummary(kind, payload) + (warning ? ` ${warning}` : '')
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
