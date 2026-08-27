import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getCapabilities } from '@/modules/purchase-orders/lib/capabilities'
import { createSupplier, listShopSuppliers, listSuppliers } from '@/modules/purchase-orders/lib/db'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import {
  isDuplicateSupplierName,
  SupplierBody,
  toSupplierInput,
} from '@/modules/purchase-orders/lib/supplier-body'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const [suppliers, capabilities] = await Promise.all([listSuppliers(), getCapabilities()])
  // Only fetched where there is a catalogue to link to; the helper returns an
  // empty list rather than throwing on a site with no shop.
  const shopSuppliers = capabilities.hasCatalogue ? await listShopSuppliers() : []
  return NextResponse.json({ suppliers, shopSuppliers, capabilities })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canCreate) return errorResponse('Forbidden', 403)

  const parsed = SupplierBody.safeParse(await request.json())
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')

  try {
    const id = await createSupplier(toSupplierInput(parsed.data))
    await recordAudit('supplier', id, 'supplier.created', { name: parsed.data.name }, user.id)
    return NextResponse.json({ id })
  } catch (error) {
    if (isDuplicateSupplierName(error)) {
      return errorResponse('There is already a supplier with that name.', 409)
    }
    throw error
  }
}
