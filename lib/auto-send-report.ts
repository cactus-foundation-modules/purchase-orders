import { escapeHtml } from '@/lib/email/blocks'
import { sendAutoSendReport } from './email'
import { takeUnreportedRefusals, type AutoSendProblem } from './auto-send-run'
import { portalNoticeRecipient } from './portal'

// Telling somebody when the job that sends automatic drafts would not send one,
// and keeping quiet otherwise - the same rule as the automatic draft report
// (lib/auto-draft-report.ts) and the paperwork report (lib/inbound-report.ts):
// a half-hourly email to say all went out is an email nobody reads.
//
// Each refusal is reported once. They are marked as told in the statement that
// takes them, so two runs never send one twice - and one that fails to send is
// not sent again, which is the right way round for a draft already sitting on
// the Orders tab with its sentence.

/** The table body of the email, every value escaped: a note can quote a line
 *  description, which is whatever a supplier's price list called it. */
export function autoSendReportHtml(problems: readonly AutoSendProblem[]): string {
  if (problems.length === 0) return ''
  const rows = problems.map(
    (p) =>
      `<tr><td><strong>${escapeHtml(p.orderNumber)}</strong><br />${escapeHtml(p.supplierName)}</td>` +
      `<td>${escapeHtml(p.note)}</td></tr>`,
  )
  return `<table cellpadding="6" cellspacing="0" border="0" width="100%">${rows.join('')}</table>`
}

/** The headline, readable on a phone without opening anything. */
export function autoSendReportSummary(problems: readonly AutoSendProblem[]): string {
  return problems.length === 1
    ? 'One draft was not sent automatically.'
    : `${problems.length} drafts were not sent automatically.`
}

/** Email whoever gets this site's purchasing notices about any refusal they
 *  have not heard about. Returns how many it covered. */
export async function reportAutoSendRefusals(): Promise<number> {
  const problems = await takeUnreportedRefusals()
  if (problems.length === 0) return 0
  const to = await portalNoticeRecipient()
  if (!to) return problems.length
  await sendAutoSendReport(to, {
    whatHappened: autoSendReportSummary(problems),
    lines: autoSendReportHtml(problems),
  })
  return problems.length
}
