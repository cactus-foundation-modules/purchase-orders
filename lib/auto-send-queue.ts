import { prisma } from '@/lib/db/prisma'
import { recordAudit } from './audit'
import { CLAIM_MINUTES, heldNote, queueDecision, RECORD_SIZE } from './auto-send'
import type { PoConfig } from './config'

// In and out of the automatic queue. Kept apart from the job itself
// (lib/auto-send-run.ts) because the paid-order run and every route that saves
// an order call these, and none of them should drag the document renderer and
// the mailer in behind a one-line UPDATE.

/**
 * Where a freshly raised AUTOMATIC draft goes - queued, refused, or nowhere
 * (left an ordinary draft) - per `queueDecision`. Called by the paid-order run
 * straight after it writes the draft; a draft raised by a person never comes
 * here.
 *
 * The supplier's switch is read here rather than off the plan, so a switch
 * flipped a moment ago is the one that counts - and the job reads it again at
 * send time regardless.
 */
export async function queueAutoDraft(
  orderId: string,
  options: { skippedLines: number; customerOrderNumber: string; config: Pick<PoConfig, 'autoSendEnabled'> },
): Promise<void> {
  if (!options.config.autoSendEnabled) return
  const rows = await prisma.$queryRaw<{ auto_send: boolean }[]>`
    SELECT s."auto_send" FROM "po_orders" o JOIN "po_suppliers" s ON s."id" = o."supplier_id" WHERE o."id" = ${orderId}
  `
  const decision = queueDecision({
    masterOn: options.config.autoSendEnabled,
    supplierOn: Boolean(rows[0]?.auto_send),
    skippedLines: options.skippedLines,
    customerOrderNumber: options.customerOrderNumber,
  })
  if (!decision) return
  await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "auto_send_state" = ${decision.state}, "auto_send_note" = ${decision.note}
     WHERE "id" = ${orderId} AND "auto_send_state" IS NULL
  `
  if (decision.state === 'REFUSED') await recordRefusalAudit(orderId, decision.note)
}

/** Whether a person may go ahead with what they were doing to an order. */
export type QueueGate = 'ok' | 'busy'

/**
 * Take a draft out of the automatic queue for good, BEFORE a person writes to
 * it or sends it - the gate both of those pass through, so the job and a
 * person can never act on one draft at once.
 *
 * `readState` is the `auto_send_state` the caller read the order with, and
 * the caller's whole decision (free edit or amendment, first send or resend)
 * rests on that read. So:
 *  - read QUEUED: one UPDATE takes it to HELD with `note`, provided the job
 *    holds no live claim on it. If that UPDATE finds nothing to take - claimed,
 *    or moved on since the read (sent a moment ago by the job) - it is 'busy',
 *    because what the caller read is no longer true.
 *  - read SENT (the job's own send): 'busy' while the job's claim is still on
 *    it, i.e. while it is part way through emailing and recording it.
 *  - anything else - never queued, held, refused - nothing can put it back in
 *    the queue, so 'ok' without touching the database at all.
 */
export async function takeOutOfQueue(orderId: string, readState: string | null, note: string): Promise<QueueGate> {
  if (readState === 'QUEUED') {
    const taken = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "po_orders"
         SET "auto_send_state" = 'HELD', "auto_send_note" = ${note}, "auto_send_claimed_at" = NULL
       WHERE "id" = ${orderId}
         AND "auto_send_state" = 'QUEUED'
         AND ("auto_send_claimed_at" IS NULL
              OR "auto_send_claimed_at" < now() - make_interval(mins => ${CLAIM_MINUTES}::int))
      RETURNING "id"
    `
    return taken.length > 0 ? 'ok' : 'busy'
  }
  if (readState === 'SENT') {
    const rows = await prisma.$queryRaw<{ busy: boolean }[]>`
      SELECT ("auto_send_claimed_at" IS NOT NULL AND "auto_send_state" = 'SENT') AS "busy"
        FROM "po_orders" WHERE "id" = ${orderId}
    `
    return rows[0]?.busy ? 'busy' : 'ok'
  }
  return 'ok'
}

/**
 * A person is about to change this order: out of the automatic queue, for
 * good, first. Called by every route that saves a change to an order, AHEAD
 * of the write, with the order as it read it; the route answers 409 with
 * BEING_SENT_AUTOMATICALLY on 'busy' - saving a change to lines the job is
 * emailing that minute would send one version and leave the other on screen.
 */
export async function holdAutoSend(
  order: { id: string; autoSendState: string | null },
  personName: string | null,
): Promise<QueueGate> {
  return takeOutOfQueue(order.id, order.autoSendState, heldNote(personName))
}

/** The name a held draft is held by, off a session user. */
export function personName(user: { displayName?: string | null; username?: string | null }): string | null {
  return user.displayName?.trim() || user.username?.trim() || null
}

export async function recordRefusalAudit(orderId: string, note: string): Promise<void> {
  await recordAudit('order', orderId, 'order.auto-send-refused', { by: 'AUTO', note }, null)
}

/** How a supplier's automatic drafts have fared, for the line beside the
 *  switch: of the last `drafts` (at most RECORD_SIZE), `changed` were changed
 *  by a person before they were sent. */
export type AutoDraftRecord = { drafts: number; changed: number }

/**
 * The edit record for every supplier with an automatic draft, keyed by
 * supplier id. For information only: nothing switches itself off on it.
 *
 * Read off the history, which is the one place that knows: an automatic draft
 * is an `order.created` written with `raisedBy: 'AUTO'`, and it was changed if
 * an `order.updated` was written before the first time it was sent - by email
 * (`order.sent`) or marked as sent by hand (`order.send`) - or at all, for one
 * not sent yet. A draft deleted since is not counted: there is no order left
 * to say which supplier it was for.
 */
export async function autoDraftRecords(): Promise<Map<string, AutoDraftRecord>> {
  const rows = await prisma.$queryRaw<{ supplier_id: string; drafts: bigint; changed: bigint }[]>`
    WITH "auto" AS (
      SELECT o."id", o."supplier_id",
             row_number() OVER (PARTITION BY o."supplier_id" ORDER BY a."created_at" DESC) AS "rn"
        FROM "po_audit_log" a
        JOIN "po_orders" o ON o."id" = a."entity_id"
       WHERE a."entity_type" = 'order'
         AND a."action" = 'order.created'
         AND a."detail"->>'raisedBy' = 'AUTO'
    )
    SELECT x."supplier_id",
           count(*) AS "drafts",
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM "po_audit_log" u
              WHERE u."entity_type" = 'order'
                AND u."entity_id" = x."id"
                AND u."action" = 'order.updated'
                AND u."created_at" < COALESCE((
                      SELECT min(s."created_at") FROM "po_audit_log" s
                       WHERE s."entity_type" = 'order'
                         AND s."entity_id" = x."id"
                         AND s."action" IN ('order.sent', 'order.send')
                    ), 'infinity'::timestamptz)
           )) AS "changed"
      FROM "auto" x
     WHERE x."rn" <= ${RECORD_SIZE}
     GROUP BY x."supplier_id"
  `
  return new Map(rows.map((r) => [r.supplier_id, { drafts: Number(r.drafts), changed: Number(r.changed) }]))
}
