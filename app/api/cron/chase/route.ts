// GET/POST /api/m/purchase-orders/cron/chase
//
// Daily: asks suppliers where the late orders have got to, on the schedule in
// the purchasing settings. Same CRON_SECRET bearer as every other module's cron
// - core's dispatcher sends it.
//
// Inert on a site that has not asked for it: nothing goes anywhere until
// "chase suppliers about orders that are late" is switched on. The Reports tab
// still works out who is late either way, and the button there still sends.
//
// It changes nothing. A chase is a question - the order keeps its status, its
// dates and its lines, and all that is written is a line in its history saying
// somebody asked.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { runChase } from '@/modules/purchase-orders/lib/chase-run'

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const result = await runChase({ userId: null, orderIds: null })
  return NextResponse.json({ ok: true, ...result })
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
