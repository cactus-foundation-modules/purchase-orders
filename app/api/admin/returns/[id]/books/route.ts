import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getReturn } from '@/modules/purchase-orders/lib/returns'
import { sendReturnCreditToBooks } from '@/modules/purchase-orders/lib/book-handoff'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'

type Params = { params: Promise<{ id: string }> }

/**
 * POST - send this credit to the books, or try again.
 *
 * Only from CREDITED and CLOSED: a credit that has not arrived is not an entry
 * in anybody's accounts, and a cancelled return never was one. The books' own
 * side is idempotent on the returns-note number, so pressing this twice records
 * nothing twice.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canBills) return errorResponse('Forbidden', 403)

  const { id } = await params
  const ret = await getReturn(id)
  if (!ret) return errorResponse('That return is not here any more.', 404)
  if (ret.status !== 'CREDITED' && ret.status !== 'CLOSED') {
    return errorResponse('Only a credit that has actually arrived can go to the books.', 409)
  }

  const outcome = await sendReturnCreditToBooks(id)
  await recordAudit(
    'return',
    id,
    'return.books',
    { ok: outcome.ok, message: outcome.message.slice(0, 300) },
    user.id,
  )

  return NextResponse.json({ ok: true, books: outcome })
}
