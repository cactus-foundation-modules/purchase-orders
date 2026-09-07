import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { readBillUpload } from '@/modules/purchase-orders/lib/bill-attachment'
import { guessInvoiceDetails } from '@/modules/purchase-orders/lib/document-reference'

/**
 * POST - read a supplier's invoice and say what is on it. Stores NOTHING.
 *
 * The bill screen calls this the moment somebody picks a file, so the invoice
 * number, the invoice date and the total are already in their boxes before they
 * have looked away from the PDF. The file itself is filed later, against the
 * bill, by the attachment route - which is why this one writes no bytes
 * anywhere: a scan that happened before anybody pressed Save must not leave a
 * file in the media library for a bill that was never entered.
 *
 * Every field can come back null and routinely does. A photographed invoice has
 * no text in it at all, and the boxes are then exactly as empty as they were
 * before - which is the behaviour this replaced, so there is nothing to be sorry
 * about.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canBills) return errorResponse('Forbidden', 403)

  const form = await request.formData().catch(() => null)
  const upload = await readBillUpload(form)
  if (!upload.ok) return errorResponse(upload.reason, upload.status)

  // Our own order number, so a supplier quoting it back at us under "Your order"
  // does not come home as their invoice number.
  const ours = form?.get('orderNumber')?.toString().trim() || null

  return NextResponse.json({ ok: true, guess: guessInvoiceDetails(upload.filename, upload.buffer, ours) })
}
