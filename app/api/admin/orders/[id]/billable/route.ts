import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { getOrder, getSupplier } from '@/modules/purchase-orders/lib/db'
import { listBillableLines, listBookCategories } from '@/modules/purchase-orders/lib/bills'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import type { PoBillableOrder } from '@/modules/purchase-orders/lib/types'

type Params = { params: Promise<{ id: string }> }

// GET - one order as the bill screen needs it: every line with what was ordered,
// what turned up, and what has already been invoiced on other bills, plus the
// supplier's terms so the due date fills itself in.
export async function GET(_request: NextRequest, { params }: Params) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const { id } = await params
  const order = await getOrder(id)
  if (!order) return errorResponse('That purchase order is not here any more.', 404)

  const [lines, categories, supplier, config] = await Promise.all([
    listBillableLines(id),
    listBookCategories(),
    getSupplier(order.supplierId),
    getPoConfigCached(),
  ])

  // Typed rather than assembled loose, so a field the bill screen relies on
  // cannot quietly stop being sent.
  const billable: PoBillableOrder = {
    id: order.id,
    number: order.number,
    supplierId: order.supplierId,
    supplierName: order.supplierName,
    currency: order.currency,
    fxRate: order.fxRate,
    paymentTerms: order.paymentTerms,
    lines,
  }

  return NextResponse.json({
    order: billable,
    categories,
    paymentTermsDays: supplier?.paymentTermsDays ?? null,
    // The supplier's own default first, then the site's. A line that ends up
    // with neither is simply uncategorised, which is a fine thing for a bill to
    // be until somebody says otherwise.
    defaultCategoryId: supplier?.defaultCategoryId || config.defaultCategoryId || null,
    defaultVatTreatment: supplier?.defaultVatTreatment ?? null,
    defaultVatRateCode: supplier?.defaultVatRateCode ?? null,
  })
}
