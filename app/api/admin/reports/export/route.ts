import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { errorResponse } from '@/lib/utils'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { csvFilename, toCsv } from '@/modules/purchase-orders/lib/csv'
import { buildExport } from '@/modules/purchase-orders/lib/export'
import { defaultSpendRange } from '@/modules/purchase-orders/lib/reporting'
import { reportToday } from '@/modules/purchase-orders/lib/reports'
import { PO_EXPORT_KINDS, type PoExportKind } from '@/modules/purchase-orders/lib/types'

// GET - one of the four purchasing spreadsheets, over a window of days.
//
// Gated on plain access rather than on anything narrower: everything in these
// files is already on a screen the same person can open, and an export that
// needed a permission the screen did not would only teach people to copy the
// table by hand.
export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  const access = await getPoAccess(user)
  if (!access.canAccess) return errorResponse('Forbidden', 403)

  const params = request.nextUrl.searchParams
  const kind = (params.get('kind') ?? 'orders') as PoExportKind
  if (!PO_EXPORT_KINDS.includes(kind)) {
    return errorResponse(`There is no "${kind}" export. Try one of: ${PO_EXPORT_KINDS.join(', ')}.`)
  }

  const today = reportToday()
  const fallback = defaultSpendRange(today)
  const from = (params.get('from') ?? '').slice(0, 10) || fallback.from
  const to = (params.get('to') ?? '').slice(0, 10) || fallback.to

  const file = await buildExport(kind, from, to)
  const csv = toCsv(file.columns, file.rows)

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${csvFilename(kind, today)}"`,
      // Said in a header rather than swallowed: a file that quietly stops at
      // twenty thousand rows looks complete, and the one thing worse than a
      // partial export is one nobody knows is partial.
      ...(file.truncated ? { 'X-Cactus-Export-Truncated': 'true' } : {}),
    },
  })
}
