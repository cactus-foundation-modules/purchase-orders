import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { revokePortalToken } from '@/modules/purchase-orders/lib/portal'

type Params = { params: Promise<{ id: string; tokenId: string }> }

// DELETE - takes one supplier link back.
//
// Scoped to the order as well as to the token, so a token id lifted from one
// order's screen cannot revoke a link belonging to another.
export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id, tokenId } = await params
  const revoked = await revokePortalToken(id, tokenId)
  // Already revoked, already gone, or never this order's: all the same answer,
  // because the state the caller wanted is the state that holds.
  if (revoked) await recordAudit('order', id, 'order.portal-link-revoked', { tokenId }, user.id)
  return NextResponse.json({ ok: true, revoked })
}
