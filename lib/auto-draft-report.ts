import { escapeHtml } from '@/lib/email/blocks'
import { formatMoney } from './money'
import { sendAutoDraftReport } from './email'
import { portalNoticeRecipient } from './portal'
import type { FromOrderRunResult } from './from-order-run'

// Telling somebody what an automatic draft did, and - the part that matters -
// deciding when to keep quiet.
//
// The button's caller reads the outcome off the screen. A run started by the
// money landing has no screen and nobody waiting on it, so anything it could not
// buy would otherwise be discovered by a customer asking where their chair is.
//
// The rule: an email goes ONLY when something is wrong. A daily "raised three
// drafts, all fine" is an email nobody reads by week two, and the drafts are
// already sitting on the Orders tab where somebody has to go anyway to send
// them. Split pure from sending, as the rest of this module does, so what counts
// as "wrong" is pinned by a test rather than by reading the mailer.

/** What an automatic run is worth telling somebody about, or null for "nothing
 *  went wrong, say nothing". */
export type AutoDraftReport = {
  orderNumber: string
  /** The drafts that were raised, if any. Named because the email is about what
   *  went wrong, and "two of the three suppliers are sorted" is the context that
   *  makes the third one actionable. */
  raised: Array<{ number: string; supplierName: string; total: string; currency: string }>
  /** The reason nothing at all was raised, where there is one. */
  refused: string | null
  /** One sentence per line that could not be bought. */
  skipped: Array<{ productName: string; reason: string }>
}

/**
 * Whether this run is worth an email, and what it would say.
 *
 * Null on the ordinary happy case: every line matched a supplier and the drafts
 * are on the Orders tab.
 *
 * NOT null when the run was refused. That includes the refusals that are
 * perfectly correct - an order already raised, a cancelled order - because a
 * caller nobody is watching must not distinguish "this was fine" from "this did
 * nothing" on its own; the sentence explains which, and a person decides.
 */
export function autoDraftReport(orderNumber: string, result: FromOrderRunResult): AutoDraftReport | null {
  if (!result.refused && result.skipped.length === 0) return null
  return {
    orderNumber,
    raised: result.ordersCreated.map((po) => ({
      number: po.number,
      supplierName: po.supplierName,
      total: po.total,
      currency: po.currency,
    })),
    refused: result.refused,
    skipped: result.skipped.map((line) => ({ productName: line.productName, reason: line.reason })),
  }
}

/**
 * The report as the table body of an email, every value escaped as it goes.
 *
 * A product name is whatever a supplier's spreadsheet called it and a reason
 * names it back, so neither is ever trusted as markup. Declared as a rawTag on
 * the template for that reason: this is markup this code built.
 */
export function autoDraftReportHtml(report: AutoDraftReport): string {
  const rows: string[] = []

  for (const po of report.raised) {
    rows.push(
      '<tr>' +
        `<td>${escapeHtml(po.supplierName)}</td>` +
        `<td>Drafted as <strong>${escapeHtml(po.number)}</strong>, ${escapeHtml(formatMoney(po.total, po.currency))}</td>` +
        '</tr>',
    )
  }
  for (const line of report.skipped) {
    rows.push(
      '<tr>' +
        `<td>${escapeHtml(line.productName)}</td>` +
        `<td>${escapeHtml(line.reason)}</td>` +
        '</tr>',
    )
  }

  if (rows.length === 0) return ''
  return `<table cellpadding="6" cellspacing="0" border="0" width="100%">${rows.join('')}</table>`
}

/** The headline: what happened to this order, in one sentence somebody can read
 *  on a phone without opening anything. */
export function autoDraftReportSummary(report: AutoDraftReport): string {
  if (report.refused) return report.refused
  const count = report.skipped.length
  const drafts = report.raised.length
  const lines = `${count} ${count === 1 ? 'thing on it could not be' : 'things on it could not be'} ordered`
  if (drafts === 0) return `${lines}, and nothing was drafted.`
  return `${lines}. The rest was drafted as ${drafts === 1 ? 'one purchase order' : `${drafts} purchase orders`}.`
}

/**
 * Tell whoever gets this site's purchasing notices, if there is anything to
 * tell them.
 *
 * Best-effort and never throws: this runs at the tail of a payment webhook and
 * inside a cron sweep, and neither of them is a thing to fail over an email. The
 * drafts, and the absence of them, are on the order either way.
 */
export async function reportAutoDraft(orderNumber: string, result: FromOrderRunResult): Promise<void> {
  const report = autoDraftReport(orderNumber, result)
  if (!report) return
  try {
    const to = await portalNoticeRecipient()
    if (!to) return
    await sendAutoDraftReport(to, {
      orderNumber: report.orderNumber,
      whatHappened: autoDraftReportSummary(report),
      lines: autoDraftReportHtml(report),
    })
  } catch (error) {
    console.error('[purchase-orders] could not report the automatic draft for', orderNumber, error)
  }
}
