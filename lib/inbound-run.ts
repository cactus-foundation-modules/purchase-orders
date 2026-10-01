import { prisma } from '@/lib/db/prisma'
import { recordAudit } from './audit'
import { anythingToInvoice, leftToInvoice, portalInvoiceLines } from './portal-invoice'
import { billTotals, dueDateFor, firstInvoiceCharges, highestTaxRate } from './billing'
import {
  DuplicateInvoiceError, createBill, listBillableLines, refreshBillMatch, setBillAttachment,
} from './bills'
import { getPoConfigCached } from './config'
import { getOrder, getSupplier } from './db'
import {
  absoluteAmount,
  decideFiling,
  KIND_NAMES,
  invoiceTotalProblem,
  paidProformaReason,
  proformaReplacementWarning,
  proformaTotalCheck,
  wholeFileProblem,
  type FileableKind,
  type FilingOrder,
  type SenderSupplier,
} from './inbound-filing'
import { settleOrder } from './order-settle'
import { extractPages } from './pdf-split'
import { acknowledgeFromPortal } from './portal'
import { storeOrderDocument } from './portal-upload'
import { mediaAttachment, replaceProformaDocument, setAcknowledgementDocument } from './proforma'
import { pdfText } from './pdf-text'
import { ourPoNumbersIn, readSupplierDocuments } from './supplier-document'
import type { PoStatus } from './types'

// The filing queue for supplier paperwork that arrives by email.
//
// lib/inbound-handler.ts puts a row here for each PDF on a supplier's email -
// page_from 0, "the file as it arrived" - and does nothing slower than that
// inline. This file does the rest, on the half-hourly job and, where the inbox's
// time budget clearly allows, straight after the handler:
//
//  1. READ a file: fetch its bytes, find the documents in it
//     (lib/supplier-document.ts), and give each one a row of its own keyed by
//     its first page. The file's row becomes READ.
//  2. FILE each document: lib/inbound-filing.ts decides where it goes, or why it
//     goes nowhere, and this does the writing - the proforma or acknowledgement
//     onto the order, an invoice as a DRAFT bill.
//
// Idempotent from end to end, because the inbox offers an email again whenever
// it is unsure the first offer finished, and may even offer it twice at once:
//
//  - every insert is ON CONFLICT (attachment_id, page_from) DO NOTHING, so a
//    second offer or a second read queues nothing new;
//  - a row is CLAIMED before it is worked on (FOR UPDATE SKIP LOCKED, with a
//    ten-minute lease), so two runs never file one document;
//  - a bill is written against the unique index on the supplier's invoice
//    number, so even a run that died after writing one and is tried again
//    cannot write it twice.
//
// Nothing here approves anything, sends anything to anybody, or moves money.

// A claim holds for ten minutes ("interval '10 minutes'" below) before another
// run may take the row over, on the assumption that whatever held it died: far
// longer than filing one document takes, and far shorter than anybody would
// wait. Written into the SQL rather than passed in, because a number bound as a
// parameter arrives as bigint and make_interval() will not take one.

/** Tries before a document stops being tried and waits for a person. A file
 *  that breaks the reader breaks it every time. */
const MAX_ATTEMPTS = 3

export type InboundOutcome = 'QUEUED' | 'READ' | 'FILED' | 'NEEDS_EYES' | 'IGNORED'

/** One row of the queue, as this file works with it. */
export type InboundRow = {
  id: string
  messageId: string
  threadId: string | null
  attachmentId: string
  sourceMediaId: string | null
  filename: string
  subject: string
  fromAddress: string
  receivedAt: string | null
  supplierIds: string[]
  pageFrom: number
  pageTo: number | null
  pageCount: number | null
  kind: string | null
  supplierRef: string | null
  ourPoNumbers: string[]
  total: string | null
  docDate: string | null
  wholeFile: boolean
  orderId: string | null
  filedAs: string | null
  filedMediaId: string | null
  billId: string | null
  flag: string | null
  flagAlert: boolean
  outcome: InboundOutcome
  reason: string | null
  attempts: number
  createdAt: string
  handledAt: string | null
}

function stamp(value: unknown): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function day(value: unknown): string | null {
  return stamp(value)?.slice(0, 10) ?? null
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function mapRow(r: Record<string, unknown>): InboundRow {
  return {
    id: r.id as string,
    messageId: r.message_id as string,
    threadId: (r.thread_id as string | null) ?? null,
    attachmentId: r.attachment_id as string,
    sourceMediaId: (r.source_media_id as string | null) ?? null,
    filename: (r.filename as string | null) ?? '',
    subject: (r.subject as string | null) ?? '',
    fromAddress: (r.from_address as string | null) ?? '',
    receivedAt: stamp(r.received_at),
    supplierIds: texts(r.supplier_ids),
    pageFrom: Number(r.page_from ?? 0),
    pageTo: r.page_to === null || r.page_to === undefined ? null : Number(r.page_to),
    pageCount: r.page_count === null || r.page_count === undefined ? null : Number(r.page_count),
    kind: (r.kind as string | null) ?? null,
    supplierRef: (r.supplier_ref as string | null) ?? null,
    ourPoNumbers: texts(r.our_po_numbers),
    total: r.total === null || r.total === undefined ? null : String(r.total),
    docDate: day(r.doc_date),
    wholeFile: Boolean(r.whole_file),
    orderId: (r.order_id as string | null) ?? null,
    filedAs: (r.filed_as as string | null) ?? null,
    filedMediaId: (r.filed_media_id as string | null) ?? null,
    billId: (r.bill_id as string | null) ?? null,
    flag: (r.flag as string | null) ?? null,
    flagAlert: Boolean(r.flag_alert),
    outcome: r.outcome as InboundOutcome,
    reason: (r.reason as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    createdAt: stamp(r.created_at) ?? '',
    handledAt: stamp(r.handled_at),
  }
}

// ---------------------------------------------------------------------------
// The two things the work needs from outside: the bytes, and somewhere to put
// a file. Passed in so the live tests can run the whole of it against a real
// database with no media library behind it.
// ---------------------------------------------------------------------------

export type InboundDeps = {
  /** The bytes of a library file, or null where they cannot be had. */
  download: (mediaId: string) => Promise<Buffer | null>
  /** Files a document under the order's folder in the media library, and says
   *  its new Media id, or null where it could not be stored. */
  store: (bytes: Buffer, filename: string, kind: FileableKind, orderNumber: string) => Promise<string | null>
  /** Tests only: runs inside the proforma's transaction, after the order is
   *  replaced and before the row is marked, to prove the two land together. */
  afterProformaReplace?: () => Promise<void>
}

export const mediaLibraryDeps: InboundDeps = {
  download: async (mediaId) => (await mediaAttachment(mediaId))?.content ?? null,
  store: async (bytes, filename, kind, orderNumber) => {
    // The same shelf the supplier's own link and the order screen file these
    // on - Purchasing / <kind> / <order number> - so a document is in one place
    // whichever door it came through. No user id: nobody here filed it.
    const stored = await storeOrderDocument({ buffer: bytes, mimeType: 'application/pdf', filename }, kind, orderNumber, null)
    return stored.ok ? stored.mediaId : null
  },
}

// ---------------------------------------------------------------------------
// Who the suppliers are, and which of our orders a document could quote
// ---------------------------------------------------------------------------

/** Every supplier's sending addresses, for the handler's inline check. One
 *  small query; the matching itself is lib/inbound-filing.ts. */
export async function senderSuppliers(): Promise<SenderSupplier[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "id", "email", "email_cc", "inbound_senders" FROM "po_suppliers"
  `
  return rows.map((r) => ({
    id: r.id as string,
    email: (r.email as string | null) ?? null,
    emailCc: (r.email_cc as string | null) ?? null,
    inboundSenders: texts(r.inbound_senders),
  }))
}

/**
 * Our order numbers a supplier's document could be quoting, every supplier's.
 *
 * Every open order, plus anything closed or cancelled in the last six months -
 * an invoice can follow an order a long way. Across ALL suppliers rather than
 * the sender's own, so that a document quoting somebody else's order is
 * recognised and refused by name instead of being missed.
 */
export async function knownOrders(): Promise<Map<string, FilingOrder>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."id", o."number", o."supplier_id", o."status", o."proforma_required", o."proforma_paid_at",
           o."total", o."currency", s."name" AS "supplier_name"
      FROM "po_orders" o
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     WHERE o."status" NOT IN ('CLOSED', 'CANCELLED')
        OR o."updated_at" > now() - interval '180 days'
  `
  const out = new Map<string, FilingOrder>()
  for (const r of rows) {
    out.set(r.number as string, {
      id: r.id as string,
      number: r.number as string,
      supplierId: r.supplier_id as string,
      supplierName: (r.supplier_name as string | null) ?? '',
      status: r.status as PoStatus,
      proformaRequired: Boolean(r.proforma_required),
      proformaPaid: Boolean(r.proforma_paid_at),
      total: String(r.total ?? '0'),
      currency: (r.currency as string | null) ?? 'GBP',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Queueing (the handler's half)
// ---------------------------------------------------------------------------

export type QueueAttachment = {
  attachmentId: string
  filename: string
  mediaId: string | null
}

export type QueueMessage = {
  messageId: string
  threadId: string
  fromAddress: string
  subject: string
  sentAt: string
}

/**
 * One row per PDF on the email, as the file arrived.
 *
 * ON CONFLICT is the whole of the duplicate protection: a second offer of the
 * same email - or two at once - inserts nothing. The one thing a second offer
 * may change is a file the inbox could not fetch the first time and now has:
 * that row goes back in the queue with its copy, in the same statement, and
 * nothing else about an existing row is ever touched.
 */
export async function queueAttachments(
  message: QueueMessage,
  supplierIds: readonly string[],
  attachments: readonly QueueAttachment[],
): Promise<void> {
  for (const attachment of attachments) {
    const missing = attachment.mediaId === null
    await prisma.$executeRaw`
      INSERT INTO "po_inbound_documents" (
        "message_id", "thread_id", "attachment_id", "source_media_id", "filename", "subject",
        "from_address", "received_at", "supplier_ids", "page_from", "outcome", "reason", "handled_at"
      ) VALUES (
        ${message.messageId}, ${message.threadId}, ${attachment.attachmentId}, ${attachment.mediaId},
        ${attachment.filename.slice(0, 500)}, ${message.subject.slice(0, 500)}, ${message.fromAddress},
        ${message.sentAt}::timestamptz, ${[...supplierIds]}::text[], 0,
        ${missing ? 'NEEDS_EYES' : 'QUEUED'},
        ${missing ? 'The file could not be fetched from the mail server, so it has not been read. Open the email to see it.' : null},
        ${missing ? new Date() : null}
      )
      ON CONFLICT ("attachment_id", "page_from") DO UPDATE
         SET "source_media_id" = EXCLUDED."source_media_id",
             "outcome" = 'QUEUED', "reason" = NULL, "handled_at" = NULL, "attempts" = 0
       WHERE "po_inbound_documents"."source_media_id" IS NULL
         AND EXCLUDED."source_media_id" IS NOT NULL
         AND "po_inbound_documents"."outcome" = 'NEEDS_EYES'
    `
  }
}

// ---------------------------------------------------------------------------
// Claiming and finishing a row
// ---------------------------------------------------------------------------

/** The next row waiting, taken so nobody else takes it. Scoped to one email
 *  when the handler is working through its own. */
async function claimNext(messageId: string | null): Promise<InboundRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "po_inbound_documents" d
       SET "claimed_at" = now(), "attempts" = d."attempts" + 1
     WHERE d."id" = (
       SELECT q."id" FROM "po_inbound_documents" q
        WHERE q."outcome" = 'QUEUED'
          AND (q."claimed_at" IS NULL OR q."claimed_at" < now() - interval '10 minutes')
          AND (${messageId}::text IS NULL OR q."message_id" = ${messageId})
        ORDER BY q."page_from" ASC, q."created_at" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING d.*
  `
  return rows[0] ? mapRow(rows[0]) : null
}

/** Let go of a person's claim on a Paperwork row, whatever happened. */
async function release(id: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "po_inbound_documents" SET "claimed_at" = NULL WHERE "id" = ${id}`
}

/**
 * Put a row back for a LATER run to try, without deciding anything.
 *
 * The claim is restamped rather than cleared, so the ten-minute lease is what
 * spaces the tries: cleared, the same run would claim it again at once, and a
 * mail server that blinked for a second would use up all three tries in the
 * same few milliseconds.
 */
async function backOff(id: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "po_inbound_documents" SET "claimed_at" = now() WHERE "id" = ${id}`
}

async function needsEyes(id: string, reason: string, from: InboundOutcome = 'QUEUED'): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_inbound_documents"
       SET "outcome" = 'NEEDS_EYES', "reason" = ${reason}, "claimed_at" = NULL, "handled_at" = now()
     WHERE "id" = ${id} AND "outcome" = ${from}
  `
}

type Filed = {
  orderId: string
  filedAs: FileableKind
  filedMediaId: string | null
  billId: string | null
  flag: string | null
  /** The flag is worth an email, not only a line on the order. */
  alert: boolean
}

async function markFiled(
  id: string,
  filed: Filed,
  userId: string | null,
  from: InboundOutcome,
  client: Pick<typeof prisma, '$executeRaw'> = prisma,
): Promise<void> {
  await client.$executeRaw`
    UPDATE "po_inbound_documents"
       SET "outcome" = 'FILED', "reason" = NULL, "order_id" = ${filed.orderId}, "filed_as" = ${filed.filedAs},
           "filed_media_id" = ${filed.filedMediaId}, "bill_id" = ${filed.billId}, "flag" = ${filed.flag},
           "flag_alert" = ${filed.alert},
           "handled_by_user_id" = ${userId}, "claimed_at" = NULL, "handled_at" = now()
     WHERE "id" = ${id} AND "outcome" = ${from}
  `
}

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

/** Bytes fetched once per run, however many documents one file holds. A
 *  failed fetch is never remembered: the next document asks again. */
type ByteCache = Map<string, Buffer>

async function bytesFor(mediaId: string, deps: InboundDeps, cache: ByteCache): Promise<Buffer | null> {
  const held = cache.get(mediaId)
  if (held) return held
  try {
    const bytes = await deps.download(mediaId)
    if (bytes) cache.set(mediaId, bytes)
    return bytes
  } catch (error) {
    console.error('[purchase-orders] could not fetch an emailed file', mediaId, error)
    return null
  }
}

/** The words in the document itself, for a file read as one whole document -
 *  as distinct from its filename and the subject line, which the reader also
 *  uses. Empty for a scan or a picture. Never throws: somebody else's PDF. */
function wholeFileText(bytes: Buffer): string {
  try {
    return pdfText(bytes) ?? ''
  } catch {
    return ''
  }
}

async function readFile(row: InboundRow, deps: InboundDeps, cache: ByteCache): Promise<void> {
  if (!row.sourceMediaId) {
    await needsEyes(row.id, 'The file could not be fetched from the mail server, so it has not been read. Open the email to see it.')
    return
  }
  const bytes = await bytesFor(row.sourceMediaId, deps, cache)
  if (!bytes) {
    if (row.attempts < MAX_ATTEMPTS) return backOff(row.id)
    await needsEyes(row.id, 'The file could not be read back from the media library, so it has not been read.')
    return
  }

  const known = await knownOrders()
  const documents = readSupplierDocuments(row.filename, bytes, new Set(known.keys()), {
    subject: row.subject,
    now: row.receivedAt ? new Date(row.receivedAt) : new Date(),
  })
  const pageCount = Math.max(...documents.map((doc) => doc.pages[1]))

  for (const doc of documents) {
    // A file read as one whole document may have been read from nothing but
    // its name and the subject line. Not enough to file on: it goes straight to
    // the Paperwork list, where a person can still file it by hand.
    let problem: string | null = null
    if (doc.wholeFile) {
      const text = wholeFileText(bytes)
      problem = wholeFileProblem({
        kind: doc.kind,
        totalRead: doc.total !== null,
        refFromText: !!doc.supplierRef && text.includes(doc.supplierRef),
        poFromText: ourPoNumbersIn(text, new Set(known.keys())).length > 0,
      })
    }
    // Keyed by the first page, so a second read of the same file lands on the
    // same keys and inserts nothing.
    await prisma.$executeRaw`
      INSERT INTO "po_inbound_documents" (
        "message_id", "thread_id", "attachment_id", "source_media_id", "filename", "subject",
        "from_address", "received_at", "supplier_ids", "page_from", "page_to", "page_count",
        "kind", "supplier_ref", "our_po_numbers", "total", "doc_date", "whole_file",
        "outcome", "reason", "handled_at"
      ) VALUES (
        ${row.messageId}, ${row.threadId}, ${row.attachmentId}, ${row.sourceMediaId}, ${row.filename},
        ${row.subject}, ${row.fromAddress}, ${row.receivedAt}::timestamptz, ${row.supplierIds}::text[],
        ${Math.max(1, doc.pages[0])}, ${doc.pages[1]}, ${pageCount},
        ${doc.kind}, ${doc.supplierRef}, ${doc.ourPoNumbers}::text[], ${doc.total}::numeric,
        ${doc.date}::date, ${doc.wholeFile},
        ${problem ? 'NEEDS_EYES' : 'QUEUED'}, ${problem}, ${problem ? new Date() : null}
      )
      ON CONFLICT ("attachment_id", "page_from") DO NOTHING
    `
  }

  await prisma.$executeRaw`
    UPDATE "po_inbound_documents"
       SET "outcome" = 'READ', "page_count" = ${pageCount}, "claimed_at" = NULL, "handled_at" = now()
     WHERE "id" = ${row.id} AND "outcome" = 'QUEUED'
  `
}

// ---------------------------------------------------------------------------
// Filing one document
// ---------------------------------------------------------------------------

/** The pages this document is, as a file of their own where the splitter will
 *  cut them safely, or the whole file with a sentence saying where in it to
 *  look. Never guessed: a split that cannot be checked is not used. */
export function documentPiece(
  row: Pick<InboundRow, 'filename' | 'pageFrom' | 'pageTo' | 'pageCount' | 'wholeFile' | 'supplierRef'>,
  bytes: Buffer,
  kind: FileableKind,
): { bytes: Buffer; filename: string; note: string | null } {
  const from = row.pageFrom
  const to = row.pageTo ?? from
  const count = row.pageCount ?? to
  // The file row itself (page 0), a file read as one document, or a document
  // that is already every page of its file: nothing to cut.
  if (from < 1 || row.wholeFile || (from === 1 && to >= count)) {
    return { bytes, filename: row.filename || 'document.pdf', note: null }
  }
  const stem = (row.filename || 'document.pdf').replace(/\.pdf$/i, '')
  const pages = to > from ? `${from}-${to}` : `${from}`
  const split = extractPages(bytes, [from, to], row.supplierRef)
  if (split) return { bytes: Buffer.from(split), filename: `${stem} (page ${pages}).pdf`, note: null }
  return {
    bytes,
    filename: row.filename || 'document.pdf',
    note: `Their ${KIND_NAMES[kind]} is page ${pages} of ${count} in the attached file.`,
  }
}

type FileResult =
  /** `marked`: the row is already FILED, in the same transaction as the write
   *  it records - the caller must not mark it again. */
  | { ok: true; filed: Filed; orderNumber: string; marked?: boolean }
  | { ok: false; reason: string; retry?: boolean }

function fromEmailNote(row: InboundRow, what: string): string {
  const when = row.receivedAt ? new Date(row.receivedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null
  const who = row.fromAddress || 'the supplier'
  return `${what}, from an email from ${who}${when ? ` on ${when}` : ''}${row.subject ? ` ("${row.subject}")` : ''}.`
}

/**
 * Put one document on one order as one kind of paperwork.
 *
 * The same code whether the rules chose the order or a person did on the
 * Paperwork list: the rules decide WHERE, this only does the filing. `userId`
 * is the person, null for the machine.
 */
async function fileOn(
  row: InboundRow,
  kind: FileableKind,
  orderId: string,
  ref: string | null,
  userId: string | null,
  deps: InboundDeps,
  cache: ByteCache,
  from: InboundOutcome,
): Promise<FileResult> {
  const order = await getOrder(orderId)
  if (!order) return { ok: false, reason: 'That purchase order is not here any more.' }
  if (!row.sourceMediaId) {
    return { ok: false, reason: 'There is no copy of the file here to file. Open the email to see it.' }
  }
  const bytes = await bytesFor(row.sourceMediaId, deps, cache)
  if (!bytes) return { ok: false, reason: 'The file could not be read back from the media library.', retry: true }

  const piece = documentPiece(row, bytes, kind)
  const audit = {
    message: row.messageId,
    thread: row.threadId,
    from: row.fromAddress,
    subject: row.subject,
    filename: row.filename,
    pages: row.pageFrom > 0 ? [row.pageFrom, row.pageTo ?? row.pageFrom] : undefined,
    ref: ref ?? undefined,
    total: row.total ?? undefined,
    by: userId ? 'USER' : 'AUTO',
  }

  if (kind === 'proforma') {
    // Paid already: refused before anything is stored, so nothing is left in
    // the library for nobody. (The write below refuses again, for a payment
    // that lands in between.)
    if (order.proformaPaidAt) return { ok: false, reason: paidProformaReason(order.number) }

    // What the order held before this document, taken ONCE and kept on the
    // row. Every attempt compares with that: a retry after a failure part way
    // through would otherwise compare the document with itself, find nothing
    // to warn about, and lose the one warning that matters.
    const prior = await capturePriorProforma(row.id, order)

    const mediaId = await deps.store(piece.bytes, piece.filename, kind, order.number)
    if (!mediaId) return { ok: false, reason: 'The file could not be saved to the media library. Try again later.', retry: true }

    const config = await getPoConfigCached()
    const amount = absoluteAmount(row.total)
    // A replacement replaces the one on the order - but never quietly, and
    // never with the old reference and amount left beside the new file. The
    // earlier file stays in the library, vouched for by its own row here, and
    // its id is in the audit.
    const revised = proformaReplacementWarning(prior, { ref, amount }, order.currency)
    const check = proformaTotalCheck(row.total, order, config.priceVarianceTolerancePercent)
    const flag = [revised, check?.sentence].filter(Boolean).join(' ') || null
    const filed: Filed = {
      orderId: order.id,
      filedAs: kind,
      filedMediaId: mediaId,
      billId: null,
      flag,
      alert: Boolean(revised) || Boolean(check?.differs),
    }

    // The replacement and the row's record of it - flag and all, which is what
    // the pay gate reads - in one transaction: never a new proforma on the
    // order with its warning lost to a failure in between.
    const written = await prisma.$transaction(async (tx) => {
      if (!(await replaceProformaDocument(order.id, mediaId, ref, amount, row.receivedAt, tx))) return false
      await deps.afterProformaReplace?.()
      await markFiled(row.id, filed, userId, from, tx)
      return true
    })
    if (!written) return { ok: false, reason: paidProformaReason(order.number) }

    await recordAudit(
      'order',
      order.id,
      'order.proforma_from_email',
      {
        ...audit,
        note: fromEmailNote(row, `Their proforma${ref ? ` ${ref}` : ''} filed`) + (flag ? ` ${flag}` : ''),
        replaced: prior.mediaId ?? undefined,
        revised: revised ? true : undefined,
        differs: check?.differs || undefined,
      },
      userId,
    )
    return { ok: true, orderNumber: order.number, filed, marked: true }
  }

  if (kind === 'acknowledgement') {
    const mediaId = await deps.store(piece.bytes, piece.filename, kind, order.number)
    if (!mediaId) return { ok: false, reason: 'The file could not be saved to the media library. Try again later.', retry: true }

    await setAcknowledgementDocument(order.id, mediaId, ref)
    // Their sales order IS their acceptance, exactly as on their own link -
    // including on a proforma order whose proforma is not yet paid: they have
    // accepted it, so it is acknowledged. The unpaid proforma stays on the
    // badge (lib/proforma-stage.ts).
    await acknowledgeFromPortal(order.id, null)
    await recordAudit(
      'order',
      order.id,
      'order.acknowledged_from_email',
      { ...audit, note: fromEmailNote(row, `Their acknowledgement${ref ? ` ${ref}` : ''} filed`) },
      userId,
    )
    return {
      ok: true,
      orderNumber: order.number,
      filed: { orderId: order.id, filedAs: kind, filedMediaId: mediaId, billId: null, flag: null, alert: false },
    }
  }

  // An invoice: a DRAFT bill for everything still left to invoice, priced at
  // the ORDER's prices - lib/portal-invoice.ts, the same rule the supplier's own
  // link follows. Their total is kept beside our arithmetic, never in place of it.
  //
  // Two DIFFERENT invoices for one order (a part delivery invoiced twice): in
  // one run, which is the usual case - one batch file, one email - they are
  // filed in turn, the first takes everything left and the second finds
  // nothing left and waits on the Paperwork list. Should two runs file them at
  // the same instant, each bills everything left; their stated totals then
  // disagree with our arithmetic and both bills show the variance. Either way a
  // person sorts out the split, which is what a part-invoiced order needs.
  const invoiceNumber = (ref ?? '').trim()
  if (!invoiceNumber) return { ok: false, reason: 'No invoice number could be read off it, and a bill cannot be filed without one.' }

  // Already a bill under their number: a second copy of the same invoice, or a
  // run that died after writing it. Looked at first, because by then the order
  // has nothing left to invoice and would say so instead. The unique index
  // below is still what decides when two runs race.
  const existing = await billByInvoiceNumber(order.supplierId, invoiceNumber)
  if (existing) return alreadyBilled(existing, order, invoiceNumber, piece, userId, deps)

  const [config, supplier, billable] = await Promise.all([
    getPoConfigCached(),
    getSupplier(order.supplierId),
    listBillableLines(order.id),
  ])
  if (!anythingToInvoice(billable)) {
    return { ok: false, reason: `Everything on ${order.number} has already been invoiced, so this has not been filed as a bill.` }
  }
  const ticks = billable
    .filter((line) => leftToInvoice(line) > 0)
    .map((line) => ({ lineId: line.orderLineId, qty: String(Number(leftToInvoice(line).toFixed(3))) }))
  const drafted = portalInvoiceLines(billable, ticks, {
    categoryId: supplier?.defaultCategoryId || config.defaultCategoryId || null,
    vatTreatment: supplier?.defaultVatTreatment ?? null,
    vatRateCode: supplier?.defaultVatRateCode ?? null,
  })
  if (!drafted.ok) return { ok: false, reason: drafted.reason }

  const invoiceDate = row.docDate ?? row.receivedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
  const statedTotal = absoluteAmount(row.total)
  // The order's carriage and surcharge ride on its first invoice, exactly as
  // on the bill screen - without them every invoice on an order that has
  // either would disagree with our arithmetic, and a bill filed by hand would
  // come in short by both and the VAT on them.
  const charges = firstInvoiceCharges(order, billable)
  const totals = billTotals({
    lines: drafted.lines,
    carriageAmount: charges.carriageAmount,
    carriageTaxRatePercent: highestTaxRate(drafted.lines),
    surchargeAmount: charges.surchargeAmount,
  })

  // "Everything left" is only the right bill when their invoice says so. A
  // part invoice, or a separate one for an extra charge, would otherwise be a
  // bill for the wrong money. A person choosing on the Paperwork list is the
  // way round it, and gets the variance on the bill to see.
  if (!userId) {
    const problem = invoiceTotalProblem(row.total, totals.total, order, config.priceVarianceTolerancePercent)
    if (problem) return { ok: false, reason: problem }
  }

  // The bill before the file, so a second arrival of the same invoice stops at
  // the unique index having stored nothing.
  let billId: string
  try {
    billId = await createBill(
      {
        supplierId: order.supplierId,
        orderId: order.id,
        supplierInvoiceNumber: invoiceNumber,
        invoiceDate,
        dueDate: dueDateFor(invoiceDate, supplier?.paymentTermsDays ?? null),
        currency: order.currency,
        fxRate: order.fxRate,
        subtotal: totals.subtotal,
        carriageAmount: totals.carriageAmount,
        surchargeAmount: totals.surchargeAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        statedTotal,
        lines: drafted.lines.map((line, index) => ({ ...line, lineTotal: totals.lineTotals[index] ?? '0' })),
      },
      userId,
      'INBOX',
    )
  } catch (error) {
    if (!(error instanceof DuplicateInvoiceError)) throw error
    const raced = await billByInvoiceNumber(order.supplierId, invoiceNumber)
    if (raced) return alreadyBilled(raced, order, invoiceNumber, piece, userId, deps)
    throw error
  }

  const mediaId = await deps.store(piece.bytes, piece.filename, kind, order.number)
  const flag = mediaId ? null : 'The file could not be saved to the media library, so the bill has nothing attached. It is on the email.'
  if (mediaId) await setBillAttachment(billId, mediaId, piece.note)
  const match = await refreshBillMatch(billId)

  await recordAudit('bill', billId, 'bill.inbox-created', {
    ...audit,
    invoice: invoiceNumber,
    order: order.number,
    total: totals.total,
    stated: statedTotal ?? undefined,
    match: match?.status,
    variances: match?.flags.length ?? 0,
  }, userId)
  await recordAudit(
    'order',
    order.id,
    'order.invoice_from_email',
    { ...audit, invoice: invoiceNumber, note: fromEmailNote(row, `Their invoice ${invoiceNumber} entered as a draft bill`) },
    userId,
  )

  // Everything delivered and invoiced puts the order in front of somebody
  // rather than closing it, exactly as the supplier's own link does: this bill
  // is a draft nobody has read.
  await settleOrder(order.id, userId)

  return {
    ok: true,
    orderNumber: order.number,
    filed: { orderId: order.id, filedAs: kind, filedMediaId: mediaId, billId, flag, alert: flag !== null },
  }
}

type ExistingBill = { id: string; orderId: string | null; orderNumber: string | null; mediaId: string | null }

/**
 * Their invoice is already a bill. Anywhere but this order, that is a person's
 * question. On this very order, it is already filed - no second bill - but
 * possibly by a run that died between writing the bill and finishing with it:
 * so the file goes on if the bill has none, and the order is settled, both of
 * which are harmless to do twice.
 */
async function alreadyBilled(
  existing: ExistingBill,
  order: { id: string; number: string },
  invoiceNumber: string,
  piece: { bytes: Buffer; filename: string; note: string | null },
  userId: string | null,
  deps: InboundDeps,
): Promise<FileResult> {
  if (existing.orderId === order.id) {
    let mediaId = existing.mediaId
    if (!mediaId) {
      mediaId = await deps.store(piece.bytes, piece.filename, 'invoice', order.number)
      if (mediaId) await setBillAttachment(existing.id, mediaId, piece.note)
    }
    await settleOrder(order.id, userId)
    const flag = mediaId ? null : 'The file could not be saved to the media library, so the bill has nothing attached. It is on the email.'
    return {
      ok: true,
      orderNumber: order.number,
      filed: { orderId: order.id, filedAs: 'invoice', filedMediaId: mediaId, billId: existing.id, flag, alert: flag !== null },
    }
  }
  return {
    ok: false,
    reason: `They have already billed you under invoice ${invoiceNumber}${existing.orderNumber ? `, on ${existing.orderNumber}` : ''}, so this has not been filed again.`,
  }
}

/**
 * What the order's proforma was before this row's document replaces it - taken
 * on the first attempt and read back on every one after. A person's typed-in
 * reference or amount counts as much as a file.
 */
async function capturePriorProforma(
  rowId: string,
  order: { proformaMediaId: string | null; proformaRef: string | null; proformaAmount: string | null },
): Promise<{ mediaId: string | null; ref: string | null; amount: string | null }> {
  await prisma.$executeRaw`
    UPDATE "po_inbound_documents"
       SET "prior_captured_at" = now(),
           "prior_proforma_media_id" = ${order.proformaMediaId},
           "prior_proforma_ref" = ${order.proformaRef},
           "prior_proforma_amount" = ${order.proformaAmount}::numeric
     WHERE "id" = ${rowId} AND "prior_captured_at" IS NULL
  `
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "prior_proforma_media_id", "prior_proforma_ref", "prior_proforma_amount"
      FROM "po_inbound_documents" WHERE "id" = ${rowId}
  `
  const r = rows[0] ?? {}
  return {
    mediaId: (r.prior_proforma_media_id as string | null) ?? null,
    ref: (r.prior_proforma_ref as string | null) ?? null,
    amount: r.prior_proforma_amount === null || r.prior_proforma_amount === undefined ? null : String(r.prior_proforma_amount),
  }
}

async function billByInvoiceNumber(
  supplierId: string,
  number: string,
): Promise<ExistingBill | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT b."id", b."order_id", b."attachment_media_id", o."number" AS "order_number"
      FROM "po_bills" b
      LEFT JOIN "po_orders" o ON o."id" = b."order_id"
     WHERE b."supplier_id" = ${supplierId} AND lower(b."supplier_invoice_number") = lower(${number})
     LIMIT 1
  `
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id as string,
    orderId: (r.order_id as string | null) ?? null,
    orderNumber: (r.order_number as string | null) ?? null,
    mediaId: (r.attachment_media_id as string | null) ?? null,
  }
}

async function fileDocument(row: InboundRow, deps: InboundDeps, cache: ByteCache): Promise<void> {
  const decision = decideFiling(
    { kind: row.kind ?? 'unknown', supplierRef: row.supplierRef, ourPoNumbers: row.ourPoNumbers, total: row.total },
    row.supplierIds,
    await knownOrders(),
  )
  if (!decision.ok) return needsEyes(row.id, decision.reason)

  const result = await fileOn(row, decision.kind, decision.order.id, row.supplierRef, null, deps, cache, 'QUEUED')
  if (result.ok) return result.marked ? undefined : markFiled(row.id, result.filed, null, 'QUEUED')
  if (result.retry && row.attempts < MAX_ATTEMPTS) return backOff(row.id)
  await needsEyes(row.id, result.reason)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type InboundRunResult = { read: number; filed: number; needsEyes: number; waiting: boolean }

/**
 * Work through the queue until it is empty or the time is up.
 *
 * `deadline` is checked BEFORE each row, never during one: a document half
 * filed is worse than one not started. `messageId` limits the run to one
 * email's files, which is what the handler uses.
 */
export async function runInboundQueue(options: {
  deadline: number
  messageId?: string | null
  signal?: AbortSignal
  deps?: InboundDeps
}): Promise<InboundRunResult> {
  const deps = options.deps ?? mediaLibraryDeps
  const cache: ByteCache = new Map()
  const result: InboundRunResult = { read: 0, filed: 0, needsEyes: 0, waiting: false }

  for (;;) {
    if (Date.now() >= options.deadline || options.signal?.aborted) {
      result.waiting = true
      return result
    }
    const row = await claimNext(options.messageId ?? null)
    if (!row) return result

    try {
      if (row.attempts > MAX_ATTEMPTS) {
        await needsEyes(row.id, `This could not be ${row.pageFrom === 0 ? 'read' : 'filed'} after ${MAX_ATTEMPTS} tries.`)
        result.needsEyes++
        continue
      }
      if (row.pageFrom === 0) {
        await readFile(row, deps, cache)
        result.read++
      } else {
        await fileDocument(row, deps, cache)
      }
    } catch (error) {
      // Somebody else's PDF, or a write that failed: the row goes back for the
      // next run, and MAX_ATTEMPTS stops it being tried for ever.
      console.error('[purchase-orders] could not deal with an emailed document', row.id, error)
      await backOff(row.id).catch(() => {})
    }
    const after = await rowOutcome(row.id)
    if (after === 'FILED') result.filed++
    if (after === 'NEEDS_EYES') result.needsEyes++
  }
}

async function rowOutcome(id: string): Promise<InboundOutcome | null> {
  const rows = await prisma.$queryRaw<{ outcome: string }[]>`
    SELECT "outcome" FROM "po_inbound_documents" WHERE "id" = ${id}
  `
  return (rows[0]?.outcome as InboundOutcome | undefined) ?? null
}

/** The cron's first question, off the partial index: is anything waiting? */
export async function anythingQueued(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "po_inbound_documents" WHERE "outcome" = 'QUEUED') AS "waiting"
  `
  return Boolean(rows[0]?.waiting)
}

// ---------------------------------------------------------------------------
// Reading the queue back
// ---------------------------------------------------------------------------

/** Every row one email produced, for the note and links the inbox is given. */
export async function rowsForMessage(
  messageId: string,
): Promise<Array<InboundRow & { orderNumber: string | null; trackingNote: string | null }>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.*, o."number" AS "order_number"
      FROM "po_inbound_documents" d
      LEFT JOIN "po_orders" o ON o."id" = d."order_id"
     WHERE d."message_id" = ${messageId}
     ORDER BY d."attachment_id" ASC, d."page_from" ASC
  `
  return rows.map((r) => ({
    ...mapRow(r),
    orderNumber: (r.order_number as string | null) ?? null,
    // A tracking row's line for the conversation (lib/inbound-tracking.ts).
    trackingNote: ((r.tracking as { note?: unknown } | null)?.note as string | null | undefined) ?? null,
  }))
}

/** A document filed on an order from an email, as the order screen lists it. */
export type PoInboundFiled = {
  id: string
  filedAs: FileableKind
  supplierRef: string | null
  receivedAt: string | null
  fromAddress: string
  threadId: string | null
  filedMediaId: string | null
  billId: string | null
  flag: string | null
  /** The flag is a warning, not a remark - the proforma card shows it loudly. */
  flagAlert: boolean
  handledAt: string | null
  byPerson: boolean
}

export async function inboundForOrder(orderId: string): Promise<PoInboundFiled[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "po_inbound_documents"
     WHERE "order_id" = ${orderId} AND "outcome" = 'FILED'
       -- Tracking is shown as the despatch it became, not as a document.
       AND "kind" IS DISTINCT FROM 'tracking'
     ORDER BY "handled_at" DESC NULLS LAST
  `
  return rows.map((r) => {
    const row = mapRow(r)
    return {
      id: row.id,
      filedAs: row.filedAs as FileableKind,
      supplierRef: row.supplierRef,
      receivedAt: row.receivedAt,
      fromAddress: row.fromAddress,
      threadId: row.threadId,
      filedMediaId: row.filedMediaId,
      billId: row.billId,
      flag: row.flag,
      flagAlert: row.flagAlert,
      handledAt: row.handledAt,
      byPerson: Boolean(r.handled_by_user_id),
    }
  })
}

/** One of the sender's orders, offered on the Paperwork list to file on. */
export type PaperworkChoice = { id: string; number: string; status: PoStatus; supplierName: string }

/** One document waiting for a person - or, kind 'tracking', delivery tracking
 *  matched to an order by its postcode alone, waiting for "yes, that one". */
export type PaperworkItem = InboundRow & {
  supplierNames: string[]
  choices: PaperworkChoice[]
  /** The order a tracking row proposes, by number. */
  orderNumber: string | null
  tracking: PaperworkTracking | null
}

/** What a tracking row shows a person deciding on it. */
export type PaperworkTracking = {
  carrier: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  deliveryDate: string | null
  deliverySlot: [string, string] | null
  postcodes: string[]
}

function paperworkTracking(value: unknown): PaperworkTracking | null {
  if (!value || typeof value !== 'object') return null
  const detail = value as {
    candidate?: { carrier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null } | null
    deliveryDate?: string | null
    deliverySlot?: [string, string] | null
    postcodes?: string[]
  }
  return {
    carrier: detail.candidate?.carrier ?? null,
    trackingNumber: detail.candidate?.trackingNumber ?? null,
    trackingUrl: detail.candidate?.trackingUrl ?? null,
    deliveryDate: detail.deliveryDate ?? null,
    deliverySlot: detail.deliverySlot ?? null,
    postcodes: Array.isArray(detail.postcodes) ? detail.postcodes.map(String) : [],
  }
}

/**
 * Everything waiting for a person, newest first, each with the orders it could
 * be filed on: the sending supplier's, open or recently closed. Scoped to the
 * supplier on purpose - the list is for "which of THEIR orders is this", not a
 * way to file one supplier's invoice on another's order.
 */
export async function listPaperwork(limit = 100): Promise<PaperworkItem[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.*, o."number" AS "order_number"
      FROM "po_inbound_documents" d
      LEFT JOIN "po_orders" o ON o."id" = d."order_id"
     WHERE d."outcome" = 'NEEDS_EYES'
     ORDER BY d."created_at" DESC
     LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit)))}
  `
  const items = rows.map((r) => ({
    ...mapRow(r),
    orderNumber: (r.order_number as string | null) ?? null,
    tracking: r.kind === 'tracking' ? paperworkTracking(r.tracking) : null,
  }))
  const supplierIds = [...new Set(items.flatMap((item) => item.supplierIds))]
  if (supplierIds.length === 0) return items.map((item) => ({ ...item, supplierNames: [], choices: [] }))

  const [suppliers, orders] = await Promise.all([
    prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT "id", "name" FROM "po_suppliers" WHERE "id" = ANY(${supplierIds}::text[])
    `,
    prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT o."id", o."number", o."status", o."supplier_id", s."name" AS "supplier_name"
        FROM "po_orders" o
        JOIN "po_suppliers" s ON s."id" = o."supplier_id"
       WHERE o."supplier_id" = ANY(${supplierIds}::text[])
         AND o."status" <> 'DRAFT'
         AND (o."status" NOT IN ('CLOSED', 'CANCELLED') OR o."updated_at" > now() - interval '180 days')
       ORDER BY o."created_at" DESC
       LIMIT 500
    `,
  ])
  const names = new Map(suppliers.map((s) => [s.id, s.name]))
  return items.map((item) => ({
    ...item,
    supplierNames: item.supplierIds.map((id) => names.get(id)).filter((name): name is string => !!name),
    choices: orders
      .filter((o) => item.supplierIds.includes(o.supplier_id as string))
      .map((o) => ({
        id: o.id as string,
        number: o.number as string,
        status: o.status as PoStatus,
        supplierName: (o.supplier_name as string | null) ?? '',
      })),
  }))
}

export async function paperworkCount(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS "count" FROM "po_inbound_documents" WHERE "outcome" = 'NEEDS_EYES'
  `
  return Number(rows[0]?.count ?? 0)
}

// ---------------------------------------------------------------------------
// A person's choices on the Paperwork list
// ---------------------------------------------------------------------------

/**
 * A person says which order a waiting document belongs on, and what it is.
 *
 * The same rules and the same filing as the machine: a person choosing by hand
 * cannot file a proforma on a cancelled order either. The claim first, so two
 * people pressing at once file it once.
 */
export async function fileManually(
  id: string,
  choice: { orderId: string; kind: FileableKind; ref: string | null },
  userId: string,
  deps: InboundDeps = mediaLibraryDeps,
): Promise<{ ok: true; orderNumber: string } | { ok: false; reason: string }> {
  const claimed = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "po_inbound_documents"
       SET "claimed_at" = now()
     WHERE "id" = ${id} AND "outcome" = 'NEEDS_EYES'
       AND ("claimed_at" IS NULL OR "claimed_at" < now() - interval '10 minutes')
    RETURNING *
  `
  if (!claimed[0]) return { ok: false, reason: 'Somebody has already dealt with that one.' }
  const row = mapRow(claimed[0])

  try {
    if (row.kind === 'tracking') return { ok: false, reason: 'That is delivery tracking, not paperwork.' }
    const order = await getOrder(choice.orderId)
    if (!order) return { ok: false, reason: 'That purchase order is not here any more.' }
    const ref = (choice.ref ?? '').trim() || row.supplierRef
    const decision = decideFiling(
      { kind: choice.kind, supplierRef: ref, ourPoNumbers: [order.number], total: row.total },
      row.supplierIds,
      new Map([[order.number, {
        id: order.id,
        number: order.number,
        supplierId: order.supplierId,
        supplierName: order.supplierName,
        status: order.status,
        proformaRequired: order.proformaRequired,
        proformaPaid: Boolean(order.proformaPaidAt),
        total: order.total,
        currency: order.currency,
      }]]),
      choice.kind,
    )
    if (!decision.ok) return { ok: false, reason: decision.reason }

    const result = await fileOn(row, decision.kind, order.id, ref, userId, deps, new Map(), 'NEEDS_EYES')
    if (!result.ok) return { ok: false, reason: result.reason }
    if (!result.marked) await markFiled(row.id, result.filed, userId, 'NEEDS_EYES')
    return { ok: true, orderNumber: result.orderNumber }
  } finally {
    await release(row.id).catch(() => {})
  }
}

/** "Not ours", or "ignore": off the list, with who said so. Nothing else about
 *  the document changes, and the email and its file are untouched. */
export async function dismissPaperwork(id: string, how: 'not-ours' | 'ignore', userId: string): Promise<boolean> {
  const reason = how === 'not-ours' ? 'Marked as not ours.' : 'Ignored.'
  const count = await prisma.$executeRaw`
    UPDATE "po_inbound_documents"
       SET "outcome" = 'IGNORED', "reason" = ${reason}, "handled_by_user_id" = ${userId},
           "claimed_at" = NULL, "handled_at" = now()
     WHERE "id" = ${id} AND "outcome" = 'NEEDS_EYES'
       AND ("claimed_at" IS NULL OR "claimed_at" < now() - interval '10 minutes')
  `
  return count > 0
}

// ---------------------------------------------------------------------------
// Warnings on a proforma that arrived by email
// ---------------------------------------------------------------------------

/**
 * Every warning still standing on this order's proforma: each proforma filed
 * from email with a flag worth an email (revised, a second one, not the
 * order's total) since somebody last said they had checked, while the
 * proforma is unpaid.
 *
 * Read off EVERY such row, not the newest: a fraudster's second copy of their
 * own "revised" proforma matches what is on the order by then and carries no
 * warning of its own, and it must not be the thing that makes the first
 * warning disappear. Only a person saying they have checked the bank details
 * answers them (clearProformaWarnings), and that is in the audit with their
 * name.
 */
export type ProformaWarnings = {
  warnings: string[]
  /** When the newest of them was raised. The screen sends back the newest it
   *  showed, and the pay gate refuses a tick given before a newer one. */
  newestAt: string | null
}

export async function liveProformaWarnings(orderId: string): Promise<ProformaWarnings> {
  // Two sources: proformas filed from email (one row each), and a replacement
  // sent through the supplier's own link (on the order itself).
  const rows = await prisma.$queryRaw<{ flag: string; at: Date }[]>`
    SELECT d."flag" AS "flag", d."handled_at" AS "at"
      FROM "po_inbound_documents" d
      JOIN "po_orders" o ON o."id" = d."order_id"
     WHERE d."order_id" = ${orderId}
       AND d."outcome" = 'FILED'
       AND d."filed_as" = 'proforma'
       AND d."flag_alert"
       AND d."flag" IS NOT NULL
       AND o."proforma_paid_at" IS NULL
       AND (o."proforma_warning_cleared_at" IS NULL OR d."handled_at" > o."proforma_warning_cleared_at")
    UNION ALL
    SELECT o."proforma_warning" AS "flag", o."proforma_warning_at" AS "at"
      FROM "po_orders" o
     WHERE o."id" = ${orderId}
       AND o."proforma_warning" IS NOT NULL
       AND o."proforma_paid_at" IS NULL
       AND (o."proforma_warning_cleared_at" IS NULL OR o."proforma_warning_at" > o."proforma_warning_cleared_at")
     ORDER BY "at" ASC
  `
  const newest = rows.reduce<Date | null>((max, r) => (r.at && (!max || r.at > max) ? r.at : max), null)
  return { warnings: [...new Set(rows.map((r) => r.flag))], newestAt: newest ? newest.toISOString() : null }
}

/**
 * Somebody has checked the bank details with the supplier. Answers every
 * warning raised up to `seenUpTo` - the newest one they were shown - and says
 * who, when, and to what. One raised after that stays live.
 */
export async function clearProformaWarnings(
  orderId: string,
  warnings: readonly string[],
  seenUpTo: string,
  userId: string,
): Promise<void> {
  // A millisecond past what they saw: the screen's timestamps are in
  // milliseconds and Postgres keeps microseconds.
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "proforma_warning_cleared_at" = ${seenUpTo}::timestamptz + interval '1 millisecond', "updated_at" = now()
     WHERE "id" = ${orderId}
  `
  await recordAudit(
    'order',
    orderId,
    'order.proforma_warning_checked',
    { note: `Said they had checked the bank details with the supplier, answering: ${warnings.join(' ')}`, warnings },
    userId,
  )
}

// ---------------------------------------------------------------------------
// The problem report
// ---------------------------------------------------------------------------

/** One thing worth an email: a document nobody could file, a proforma that
 *  disagrees with its order or revises one already on it, or a bill filed with
 *  nothing attached. */
export type PaperworkProblem = {
  what: string
  problem: string
  /** A flag on a filed document - a total that disagrees with its order - for
   *  a supplier whose automatic sending is switched on. The report says so:
   *  that switch is the owner's, and nothing here turns it off. */
  autoSendSupplier?: boolean
}

/**
 * Take the problems nobody has been told about yet, marking them told in the
 * same statement so two runs never report one twice.
 *
 * A filed document's flag is a problem only where `flag_alert` says so - a
 * total that could not be read carries a flag too (it is said on the order),
 * but it is not evidence of anything and is not worth an email. The WHERE
 * clause matches po_inbound_documents_unreported_idx's predicate exactly, so
 * this is an index read rather than a pass over the whole table.
 */
/** Which job's rows to report: the paperwork filing's, the delivery
 *  tracking's (postcode proposals and announcements given up on - rows of kind
 *  'tracking' and 'announce'), or both. A job that is switched off keeps its
 *  rows unreported until it is switched on again. */
export type ReportJobs = { documents: boolean; tracking: boolean }

export async function takeUnreportedProblems(
  jobs: ReportJobs = { documents: true, tracking: true },
): Promise<PaperworkProblem[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "po_inbound_documents" d
       SET "reported_at" = now()
      FROM "po_inbound_documents" x
      LEFT JOIN "po_orders" o ON o."id" = x."order_id"
      LEFT JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     WHERE d."id" = x."id"
       AND d."reported_at" IS NULL
       AND (d."outcome" = 'NEEDS_EYES' OR d."flag_alert")
       AND (
         (${jobs.tracking} AND d."kind" IN ('tracking', 'announce'))
         OR (${jobs.documents} AND d."kind" IS DISTINCT FROM 'tracking' AND d."kind" IS DISTINCT FROM 'announce')
       )
    RETURNING d."outcome", d."reason", d."flag", d."filename", d."from_address", d."page_from", d."page_to",
              o."number" AS "order_number", COALESCE(s."auto_send", false) AS "auto_send"
  `
  return rows.map((r) => {
    const pages = Number(r.page_from ?? 0) > 0
      ? ` (page ${r.page_from}${r.page_to && r.page_to !== r.page_from ? `-${r.page_to}` : ''})`
      : ''
    const what = r.order_number
      ? `${r.order_number as string}: ${(r.filename as string) || 'a file'}${pages}`
      : `${(r.filename as string) || 'A file'}${pages} from ${(r.from_address as string) || 'a supplier'}`
    return {
      what,
      problem: ((r.outcome === 'NEEDS_EYES' ? r.reason : r.flag) as string | null) ?? '',
      autoSendSupplier: r.outcome !== 'NEEDS_EYES' && Boolean(r.auto_send),
    }
  })
}
