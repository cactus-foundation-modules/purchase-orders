import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { listPaperwork } from '@/modules/purchase-orders/lib/inbound-run'

// GET - supplier paperwork from email that is waiting for a person.
//
// Everything lib/inbound-run.ts could not file on its own, each with the
// sentence saying why and the sender's own orders to choose from. Read by the
// panel at the top of the Orders tab, which draws nothing when this is empty.
export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const items = await listPaperwork()
  return NextResponse.json({
    items,
    // Filing an invoice writes a bill, which is the bills permission's job;
    // a proforma or an acknowledgement is buying paperwork.
    canFile: access.canCreate,
    canFileInvoices: access.canCreate && access.canBills,
  })
}
