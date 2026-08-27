import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getBill, setBillAttachment } from '@/modules/purchase-orders/lib/bills'
import { readBillUpload, storeBillAttachment } from '@/modules/purchase-orders/lib/bill-attachment'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

/**
 * POST - attach the supplier's own invoice to a bill.
 *
 * The bytes come through the server rather than going straight to storage: the
 * media Worker's direct upload path types a file from its object key and accepts
 * only raster images and 3D models, so a PDF sent that way is refused outright.
 *
 * A replacement leaves the previous file in the media library rather than
 * deleting it. Deleting somebody's file out from under them because a screen in
 * this module stopped pointing at it is not a decision this module gets to make;
 * it simply stops being counted as in use, and the library offers it up for a
 * tidy in the ordinary way.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canBills) return errorResponse('Forbidden', 403)

  const { id } = await params
  const bill = await getBill(id)
  if (!bill) return errorResponse('That bill is not here any more.', 404)
  if (bill.status === 'VOID') {
    return errorResponse('This bill has been voided, so there is nothing left to file against it.', 409)
  }

  const form = await request.formData().catch(() => null)
  const upload = await readBillUpload(form)
  if (!upload.ok) return errorResponse(upload.reason, upload.status)

  const stored = await storeBillAttachment(upload, bill.invoiceDate, user.id)
  if (!stored.ok) return errorResponse(stored.reason, stored.status)

  await setBillAttachment(id, stored.mediaId)
  await recordAudit(
    'bill',
    id,
    'bill.attachment-added',
    { filename: upload.filename, replaced: Boolean(bill.attachment) },
    user.id,
  )

  const after = await getBill(id)
  return NextResponse.json({ ok: true, attachment: after?.attachment ?? null })
}

// DELETE - unfile the invoice from this bill. The file itself stays in the media
// library, where whoever owns the library decides what happens to it.
export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canBills) return errorResponse('Forbidden', 403)

  const { id } = await params
  const bill = await getBill(id)
  if (!bill) return errorResponse('That bill is not here any more.', 404)

  await setBillAttachment(id, null)
  await recordAudit('bill', id, 'bill.attachment-removed', {}, user.id)
  return NextResponse.json({ ok: true })
}
