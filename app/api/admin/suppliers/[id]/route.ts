import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { deleteSupplier, getSupplier, updateSupplier } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import {
  isDuplicateSupplierName,
  SupplierBody,
  toSupplierInput,
} from '@/modules/purchase-orders/lib/supplier-body'

type Params = { params: Promise<{ id: string }> }

export async function PUT(request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const existing = await getSupplier(id)
  if (!existing) return errorResponse('That supplier is not here any more.', 404)

  const parsed = SupplierBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  try {
    await updateSupplier(id, toSupplierInput(parsed.data))
  } catch (error) {
    if (isDuplicateSupplierName(error)) {
      return errorResponse('There is already a supplier with that name.', 409)
    }
    throw error
  }

  await recordAudit(
    'supplier',
    id,
    'supplier.updated',
    { name: parsed.data.name, previousName: existing.name },
    user.id,
  )
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const { id } = await params
  const existing = await getSupplier(id)
  if (!existing) return errorResponse('That supplier is not here any more.', 404)

  const result = await deleteSupplier(id)
  if (!result.ok) return errorResponse(result.reason ?? 'That supplier cannot be deleted.', 409)

  await recordAudit('supplier', id, 'supplier.deleted', { name: existing.name }, user.id)
  return NextResponse.json({ ok: true })
}
