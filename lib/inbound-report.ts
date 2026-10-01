import { escapeHtml } from '@/lib/email/blocks'
import { sendPaperworkReport } from './email'
import { takeUnreportedProblems, type PaperworkProblem, type ReportJobs } from './inbound-run'
import { portalNoticeRecipient } from './portal'
import { getPoConfigCached } from './config'

// Telling somebody when a supplier's emailed paperwork needs a person, and
// keeping quiet otherwise - the same rule as the automatic draft report
// (lib/auto-draft-report.ts): an email that arrives every half hour to say all
// is well is an email nobody reads by Wednesday.
//
// Two things are worth one: a document nobody could file (it is on the
// Paperwork list with its sentence), and a proforma whose total disagrees with
// the order beyond the price tolerance - which is how a wrong price on an order
// is caught before it is paid rather than after.

/** The table body of the email, every value escaped: a filename and a reason
 *  are whatever a supplier's system called things. */
export function paperworkReportHtml(problems: readonly PaperworkProblem[], autoSendEnabled = false): string {
  if (problems.length === 0) return ''
  const rows = problems.map(
    (p) =>
      `<tr><td>${escapeHtml(p.what)}</td><td>${escapeHtml(p.problem)}` +
      (autoSendEnabled && p.autoSendSupplier ? `<br /><strong>${escapeHtml(AUTO_SEND_ON)}</strong>` : '') +
      '</td></tr>',
  )
  return `<table cellpadding="6" cellspacing="0" border="0" width="100%">${rows.join('')}</table>`
}

/** Said beside a disagreeing total from a supplier whose drafts are sent by
 *  themselves. Reported, never acted on: the switch is the owner's (decided
 *  2026-09-30), and a wrong price that went out automatically is exactly what
 *  they need to know about before pressing it again. */
export const AUTO_SEND_ON =
  'Automatic sending is switched on for this supplier, so their drafts are going out without anybody reading them. It has been left on - switch it off under Suppliers if this keeps happening.'

/** The headline, readable on a phone without opening anything. */
export function paperworkReportSummary(problems: readonly PaperworkProblem[]): string {
  return problems.length === 1
    ? 'One piece of supplier paperwork needs a look.'
    : `${problems.length} pieces of supplier paperwork need a look.`
}

/**
 * Email whoever gets this site's purchasing notices about anything new.
 *
 * The problems are marked as reported as they are taken, so two runs never
 * send one twice - and one that fails to send is not sent again, which is the
 * right way round for a notice whose subject is already waiting on the
 * Paperwork list. Returns how many it covered.
 */
export async function reportPaperworkProblems(jobs?: ReportJobs): Promise<number> {
  const problems = await takeUnreportedProblems(jobs)
  if (problems.length === 0) return 0
  const to = await portalNoticeRecipient()
  if (!to) return problems.length
  const { autoSendEnabled } = await getPoConfigCached()
  await sendPaperworkReport(to, {
    whatHappened: paperworkReportSummary(problems),
    lines: paperworkReportHtml(problems, autoSendEnabled),
  })
  return problems.length
}
