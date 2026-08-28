// GET/POST /api/m/purchase-orders/cron/reorder
//
// Daily: works out what has dropped below its reorder level and drafts one
// purchase order per supplier. Same CRON_SECRET bearer as every other module's
// cron - core's dispatcher sends it.
//
// Inert on a site that has not asked for it, twice over: nothing happens without
// reorder levels, and nothing happens until "raise orders automatically" is
// switched on in the purchasing settings. Everything it would have raised is
// still worked out and still shown on the Reorder tab either way.
//
// Drafts only. It never approves, sends or emails - the whole point is that a
// person opens the tab in the morning and finds the paperwork already typed.
//
// It also runs the paid-order catch-up sweep, which is a different job with the
// same shape and the same hour: anything a payment webhook should have drafted
// and did not, plus any purchase order left standing against a customer order
// that has since been refunded. Folded in here rather than given a cron entry of
// its own - one more scheduled slot for a job measured in milliseconds is not
// worth it, and both are "here is your paperwork this morning".
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { runReorder } from '@/modules/purchase-orders/lib/reorder-run'
import { runPaidSweep } from '@/modules/purchase-orders/lib/paid-sweep'

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const result = await runReorder({ userId: null, supplierIds: null })

  // Deliberately after the reorder and deliberately not fatal to it: two
  // unrelated jobs sharing an hour must not share a failure. Each is inert on a
  // site that has not switched it on.
  let paidOrders
  try {
    paidOrders = await runPaidSweep()
  } catch (error) {
    console.error('[purchase-orders] the paid-order sweep failed', error)
    paidOrders = { failed: (error as Error).message }
  }

  return NextResponse.json({ ok: true, ...result, paidOrders })
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
