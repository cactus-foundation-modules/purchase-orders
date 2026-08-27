import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getBill } from '@/modules/purchase-orders/lib/bills'
import { isBillPostable } from '@/modules/purchase-orders/lib/billing'
import { sendBillToBooks } from '@/modules/purchase-orders/lib/book-handoff'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

/**
 * POST - send this bill to the books, or try again.
 *
 * Separate from the transition route on purpose. Filing an entry is not a state
 * a person moves a bill into: it is a thing another module does or fails to do,
 * and the button that retries it has to work on a bill that is already posted -
 * an entry that landed with its supplier PDF missing behind it is exactly the
 * case worth another go. The books' own side is idempotent, so nothing is
 * recorded twice.
 *
 * Needs the bills permission, same as approving: agreeing to pay somebody and
 * putting that in the accounts are the same decision.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canBills) return errorResponse('Forbidden', 403)

  const { id } = await params
  const bill = await getBill(id)
  if (!bill) return errorResponse('That bill is not here any more.', 404)
  if (!isBillPostable(bill.status)) {
    return errorResponse('Only a bill somebody has approved can go to the books.', 409)
  }

  const { outcome, posted } = await sendBillToBooks(id)
  await recordAudit(
    'bill',
    id,
    'bill.books',
    { ok: outcome.ok, message: outcome.message.slice(0, 300) },
    user.id,
  )

  const after = await getBill(id)
  return NextResponse.json({ ok: true, books: outcome, posted, status: after?.status ?? bill.status })
}
