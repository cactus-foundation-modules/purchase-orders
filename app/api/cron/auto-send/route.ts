// GET/POST /api/m/purchase-orders/cron/auto-send
//
// Half-hourly: sends the automatic drafts whose hold has run out, to suppliers
// the owner has switched on, exactly as the Send button would - or leaves each
// as a draft with a sentence saying why (lib/auto-send.ts). Same CRON_SECRET
// bearer as every other module's cron - core's dispatcher sends it.
//
// Runs whether or not the site-wide switch is on, and that is deliberate: a
// draft queued before somebody switched it off must be REFUSED, with a
// sentence, rather than left reading "sends automatically at 14:30" for ever.
// On a site that never switched it on nothing is ever queued, and the first
// question - one count off two partial indexes - is the whole run.
//
// Then the report: an email ONLY for a draft it would not send, each one once.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { anythingToDo, runAutoSend } from '@/modules/purchase-orders/lib/auto-send-run'
import { reportAutoSendRefusals } from '@/modules/purchase-orders/lib/auto-send-report'

/** Stop starting new sends this far in. Module routes run for a minute at
 *  most, and one email is never abandoned half sent. */
const RUN_BUDGET_MS = 40_000

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const config = await getPoConfigCached()
  if (!(await anythingToDo(config.autoSendHoldMinutes))) {
    return NextResponse.json({ ok: true, skipped: 'nothing due' })
  }

  const result = await runAutoSend({ deadline: Date.now() + RUN_BUDGET_MS })

  // Not fatal to the run: the drafts are refused either way, each with its
  // sentence on the order.
  let reported = 0
  try {
    reported = await reportAutoSendRefusals()
  } catch (error) {
    console.error('[purchase-orders] could not send the automatic send report', error)
  }

  return NextResponse.json({ ok: true, ...result, reported })
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
