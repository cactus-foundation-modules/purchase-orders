import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import {
  deleteReorderRule,
  isDuplicateReorderProduct,
  updateReorderRule,
} from '@/modules/purchase-orders/lib/reorder'
import { ReorderRuleBody, toReorderRuleInput } from '@/modules/purchase-orders/lib/reorder-body'

type Ctx = { params: Promise<{ id: string }> }

export async function PUT(request: NextRequest, { params }: Ctx) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const parsed = ReorderRuleBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  try {
    await updateReorderRule(id, toReorderRuleInput(parsed.data))
    await recordAudit('settings', 'reorder', 'reorder.rule-updated', { ruleId: id }, user.id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isDuplicateReorderProduct(error)) {
      return errorResponse('That product already has a reorder level. Edit the one that is there.', 409)
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  await deleteReorderRule(id)
  await recordAudit('settings', 'reorder', 'reorder.rule-deleted', { ruleId: id }, user.id)
  return NextResponse.json({ ok: true })
}
