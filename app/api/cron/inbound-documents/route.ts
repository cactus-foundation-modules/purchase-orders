// GET/POST /api/m/purchase-orders/cron/inbound-documents
//
// Half-hourly: reads the supplier PDFs the inbox handler queued
// (lib/inbound-handler.ts) and files each document in them on its purchase
// order, or leaves it on the Paperwork list with a sentence saying why. Same
// CRON_SECRET bearer as every other module's cron - core's dispatcher sends it.
//
// Inert twice over on a site that has not asked for it: nothing is queued
// unless "file supplier paperwork from email" is switched on, and nothing here
// runs unless it still is. The first real question is one EXISTS off a partial
// index, so a quiet half hour costs one indexed read.
//
// Then the problem report: an email ONLY where something needs a person - a
// document nobody could file, a proforma that disagrees with its order. Never
// one to say all went well.
//
// And, with delivery tracking on, the despatches whose announcement did not
// get through last time (a busy customer order, a blip): told again. Also one
// indexed read when nothing is waiting.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { anythingQueued, runInboundQueue } from '@/modules/purchase-orders/lib/inbound-run'
import { reportPaperworkProblems } from '@/modules/purchase-orders/lib/inbound-report'
import { announcePendingDespatches } from '@/modules/purchase-orders/lib/inbound-tracking'

/** Stop starting new work this far in. Module routes run for a minute at most,
 *  and one document is never abandoned half filed. */
const RUN_BUDGET_MS = 40_000

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const config = await getPoConfigCached()
  if (!config.inboundFilingEnabled && !config.inboundTrackingEnabled) {
    return NextResponse.json({ ok: true, skipped: 'switched off' })
  }

  const started = Date.now()
  const result = config.inboundFilingEnabled && (await anythingQueued())
    ? await runInboundQueue({ deadline: started + RUN_BUDGET_MS })
    : { read: 0, filed: 0, needsEyes: 0, waiting: false }

  // Not fatal to the run: the documents are filed either way, and a problem
  // nobody was emailed about is still on the Paperwork list.
  // Either job's problems, each only while its job is on: a site reading
  // tracking and not filing paperwork still hears about postcode proposals
  // and despatches that could not be passed on.
  let reported = 0
  try {
    reported = await reportPaperworkProblems({
      documents: config.inboundFilingEnabled,
      tracking: config.inboundTrackingEnabled,
    })
  } catch (error) {
    console.error('[purchase-orders] could not send the paperwork report', error)
  }

  let announced = 0
  if (config.inboundTrackingEnabled) {
    try {
      announced = await announcePendingDespatches({ deadline: started + RUN_BUDGET_MS })
    } catch (error) {
      console.error('[purchase-orders] could not announce pending despatches', error)
    }
  }

  return NextResponse.json({ ok: true, ...result, reported, announced })
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
