import { getPoConfigCached } from './config'
import { inboxNote, isPdfAttachment, matchSender, type FileableKind, type SenderSupplier } from './inbound-filing'
import { queueAttachments, rowsForMessage, runInboundQueue, senderSuppliers } from './inbound-run'
import { handleTrackingMessage } from './inbound-tracking'

// What this module does when an email arrives: nothing, unless the owner has
// switched on filing supplier paperwork (and then only for a PDF on an email
// from one of their suppliers) or reading delivery tracking (and then only
// for an email that carries some - lib/inbound-tracking.ts).
//
// Registered against the unified inbox's `unified-inbox.message-received`
// point. The event carries plain strings and no inbox types, which is the whole
// reason this file can exist: purchase-orders is standalone, `requiresModules`
// is `[]`, and nothing here imports '@/modules/unified-inbox/...' - that path
// does not exist at build time on an install with no inbox. An inbox older
// than the point never gathers this and it simply never runs.
//
// The inbox gives each handler five seconds, and a PDF is not read in five
// seconds on a bad day. So the inline work is the sender check - a loop over
// the supplier list, which is the whole of it for nearly every email - and one
// queue insert per PDF. Reading and filing happen on the half-hourly job
// (app/api/cron/inbound-documents), or straight away here when the files are
// small enough that doing so clearly fits: that is what lets the conversation
// say "Filed on PO-01234 as the proforma" the moment the email lands.

/** The inbox's payload, restated locally. Structural, so it stays compatible
 *  without a dependency: the inbox may send more than this and nothing here
 *  minds. */
export type InboundMessageEvent = {
  messageId: string
  threadId: string
  fromAddress: string
  toAddresses: string[]
  /** Who was in Cc. An email a supplier sends To a colleague of their own with
   *  us in Cc is not internal mail, and only the Cc line says so. */
  ccAddresses?: string[]
  subject: string
  bodyText: string
  sentAt: string
  attachments: Array<{
    attachmentId: string
    filename: string
    mimeType: string
    sizeBytes: number
    mediaId: string | null
  }>
}

/** What the inbox accepts back. Restated for the same reason. */
export type InboundMessageOutcome = {
  links?: Array<{ moduleName: string; recordType: string; recordId: string; label: string }>
  note?: string
}

/** Filing inline is attempted only while this much of the inbox's five seconds
 *  has gone - no document STARTS past it, and one document takes well under
 *  the three seconds left - and only for files this small in all. A handler
 *  that overruns five seconds has nothing it returns recorded at all, so the
 *  margin is the point. Past either limit, the job does it within half an
 *  hour and nothing is lost but the link on the email. */
const INLINE_BUDGET_MS = 1800
const INLINE_MAX_BYTES = 2 * 1024 * 1024

/**
 * Queue a supplier's PDFs, file them now if that clearly fits, read the email
 * for delivery tracking, and tell the conversation what became of it all.
 *
 * Two jobs for one email, each behind its own switch: supplier paperwork
 * (inboundFilingEnabled) and delivery tracking (inboundTrackingEnabled,
 * lib/inbound-tracking.ts). One handler rather than two, so the supplier list
 * is read once and the conversation gets one line about both.
 *
 * Idempotent on the message: every queue insert is ON CONFLICT DO NOTHING, a
 * despatch is one per parcel per order, and what is said back is read off the
 * rows this email has produced - so the inbox's second offer of an email says
 * the same thing and files nothing.
 */
export async function handleInboundMessage(
  event: InboundMessageEvent,
  context: { signal: AbortSignal },
): Promise<InboundMessageOutcome | void> {
  const started = Date.now()
  // The cheapest possible first question, and the answer on every site that
  // never switches either on.
  const config = await getPoConfigCached()
  if (!config.inboundFilingEnabled && !config.inboundTrackingEnabled) return
  if (!event.fromAddress) return

  // `?? []` in case an older inbox, without the Cc line in its payload, is the
  // one doing the offering.
  const recipients = [...event.toAddresses, ...(event.ccAddresses ?? [])]
  let suppliers: SenderSupplier[] | null = null
  const loadSuppliers = async () => (suppliers ??= await senderSuppliers())

  // Paperwork, the inline half: queue each PDF from a supplier.
  const pdfs = config.inboundFilingEnabled ? event.attachments.filter(isPdfAttachment) : []
  let queued = false
  if (pdfs.length > 0) {
    const supplierIds = matchSender(event.fromAddress, await loadSuppliers(), recipients)
    if (supplierIds.length > 0 && !context.signal.aborted) {
      await queueAttachments(
        {
          messageId: event.messageId,
          threadId: event.threadId,
          fromAddress: event.fromAddress,
          subject: event.subject,
          sentAt: event.sentAt,
        },
        supplierIds,
        pdfs.map((pdf) => ({ attachmentId: pdf.attachmentId, filename: pdf.filename, mediaId: pdf.mediaId })),
      )
      queued = true
    }
  }

  // Tracking: read the text, and only when there is tracking in it go any
  // further. A few short queries at most, so it goes before the slow part.
  let tracked = false
  if (config.inboundTrackingEnabled && !context.signal.aborted) {
    try {
      const outcome = await handleTrackingMessage(
        {
          messageId: event.messageId,
          threadId: event.threadId,
          fromAddress: event.fromAddress,
          recipients,
          subject: event.subject,
          bodyText: event.bodyText,
          sentAt: event.sentAt,
        },
        loadSuppliers,
      )
      tracked = outcome.match !== null
    } catch (error) {
      // Nothing half-done is left behind: the despatch is one transaction, and
      // the inbox's catch-up offer tries the email again.
      console.error('[purchase-orders] could not read an email for tracking', event.messageId, error)
    }
  }

  // Paperwork, the slow half: file straight away when the files are small
  // enough that doing so clearly fits.
  if (queued) {
    const small = pdfs.reduce((sum, pdf) => sum + Math.max(0, pdf.sizeBytes), 0) <= INLINE_MAX_BYTES
    if (small && !context.signal.aborted) {
      try {
        await runInboundQueue({ deadline: started + INLINE_BUDGET_MS, messageId: event.messageId, signal: context.signal })
      } catch (error) {
        // Queued either way: the job picks up whatever this did not finish.
        console.error('[purchase-orders] could not file an emailed document straight away', event.messageId, error)
      }
    }
  }
  if (context.signal.aborted || (!queued && !tracked)) return

  return outcomeFor(event.messageId)
}

/** The links and the one line for an email, off what its rows say now. */
export async function outcomeFor(messageId: string): Promise<InboundMessageOutcome | void> {
  const all = await rowsForMessage(messageId)
  const rows = all.filter((row) => row.kind !== 'tracking')
  const tracking = all.filter((row) => row.kind === 'tracking')
  const filed = rows.filter((row) => row.outcome === 'FILED' && row.orderId && row.orderNumber)
  const waiting = rows.filter((row) => row.outcome === 'QUEUED').length
  const needsEyes = rows.filter((row) => row.outcome === 'NEEDS_EYES').length

  const links: NonNullable<InboundMessageOutcome['links']> = []
  const linkTo = (orderId: string, orderNumber: string) => {
    if (links.some((link) => link.recordId === orderId)) return
    links.push({ moduleName: 'purchase-orders', recordType: 'purchase-order', recordId: orderId, label: `Purchase order ${orderNumber}` })
  }
  for (const row of filed) linkTo(row.orderId!, row.orderNumber!)
  // A tracking row links its order only once the tracking is ON it: a
  // proposal is a question, and a link would read as the answer.
  for (const row of tracking) if (row.outcome === 'FILED' && row.orderId && row.orderNumber) linkTo(row.orderId, row.orderNumber)

  const parts = [
    inboxNote(
      filed.map((row) => ({ orderNumber: row.orderNumber!, kind: row.filedAs as FileableKind })),
      waiting,
      needsEyes,
    ),
    ...tracking
      .filter((row) => row.outcome === 'FILED' || row.outcome === 'NEEDS_EYES')
      .map((row) => row.trackingNote),
  ].filter((part): part is string => typeof part === 'string' && part !== '')
  const joined = parts.join('; ')
  const note = joined.length > 200 ? `${joined.slice(0, 197)}...` : joined
  if (links.length === 0 && !note) return
  return { ...(links.length > 0 ? { links: links.slice(0, 10) } : {}), ...(note ? { note } : {}) }
}

/** What the manifest entry names: the handler, and the one kind of file it
 *  needs in hand - on the export, because core's parsed manifest drops fields
 *  its schema does not know. */
export const purchaseOrdersInboundHandler = {
  attachmentTypes: ['application/pdf'],
  handle: handleInboundMessage,
}
