import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { catalogueSkuKey } from './catalogue-import'
import { catalogueCostsBySupplier, costKey } from './catalogues'
import { getPoConfigCached, type PoConfig } from './config'
import { getOrder, getSupplier } from './db'
import { readShopOrder } from './from-order'
import { needsApproval } from './lifecycle'
import { rowStamp, sendOrderRun } from './send-run'
import { afterFailedSend, CLAIM_MINUTES, sendRefusal, type SendFacts, type SendLineFacts } from './auto-send'
import { recordRefusalAudit } from './auto-send-queue'

// The automatic queue, and the half-hourly job that empties it.
//
// The rules are lib/auto-send.ts, pure; putting a draft in the queue and taking
// it out again is lib/auto-send-queue.ts. This is the job: claiming what is due
// so that two runs at once can never email one order twice, sending or refusing
// each, and taking the refusals the owner has not been told about.
//
// Every statement here is raw SQL, and no build runs any of it:
// lib/auto-send.live.test.ts does, against a real Postgres.

/** The most drafts one run will take on. A tick is half an hour apart and each
 *  send is an email with a PDF on it; anything over this waits thirty minutes. */
const BATCH = 10

/**
 * The job's first question, and the only one on a quiet half hour: is anything
 * queued and due, refused and not yet reported, or left part way through a
 * send by a run that died? Three partial indexes answer it, so nearly every
 * tick on nearly every site ends here.
 */
export async function anythingToDo(holdMinutes: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT (
      SELECT count(*) FROM "po_orders"
       WHERE "auto_send_state" = 'QUEUED'
         AND "created_at" <= now() - make_interval(mins => ${holdMinutes}::int)
    ) + (
      SELECT count(*) FROM "po_orders"
       WHERE "auto_send_state" = 'REFUSED' AND "auto_send_reported_at" IS NULL
    ) + (
      SELECT count(*) FROM "po_orders"
       WHERE "auto_send_claimed_at" IS NOT NULL
         AND "auto_send_claimed_at" < now() - make_interval(mins => ${CLAIM_MINUTES}::int)
    ) AS "count"
  `
  return Number(rows[0]?.count ?? 0) > 0
}

/**
 * Take the queued drafts that are due, marking each one claimed in the same
 * statement.
 *
 * The claim is what makes two runs at once harmless. SKIP LOCKED means a
 * second run passes over the rows the first is claiming rather than waiting
 * for them, and the WHERE is checked again on the row itself, so a row claimed
 * a moment ago (`auto_send_claimed_at` recent) is never claimed twice. A claim
 * older than CLAIM_MINUTES is a run that died, and is taken over.
 */
export async function claimDue(holdMinutes: number, limit = BATCH): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "po_orders" o
       SET "auto_send_claimed_at" = now()
     WHERE o."id" IN (
             SELECT c."id" FROM "po_orders" c
              WHERE c."auto_send_state" = 'QUEUED'
                AND c."created_at" <= now() - make_interval(mins => ${holdMinutes}::int)
                AND (c."auto_send_claimed_at" IS NULL
                     OR c."auto_send_claimed_at" < now() - make_interval(mins => ${CLAIM_MINUTES}::int))
              ORDER BY c."created_at" ASC
              LIMIT ${Prisma.raw(String(Math.max(1, Math.trunc(limit))))}
              FOR UPDATE SKIP LOCKED
           )
       AND o."auto_send_state" = 'QUEUED'
       AND (o."auto_send_claimed_at" IS NULL
            OR o."auto_send_claimed_at" < now() - make_interval(mins => ${CLAIM_MINUTES}::int))
    RETURNING o."id"
  `
  return rows.map((r) => r.id)
}

/** The note on a send a run started and never finished. */
export const ABANDONED_SEND =
  'The automatic send stopped part way, so it may or may not have reached the supplier. Check with them before sending it again.'

/**
 * Sends a run marked as going (SENT, claim on) and never finished - the run
 * died between marking it and letting go. The email may well have gone, so it
 * is never tried again: it is REFUSED for a person, with the truth, and
 * reported. Claims on QUEUED rows that are this stale are simply taken over by
 * `claimDue`, as nothing was ever sent for them.
 */
export async function settleAbandonedSends(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "po_orders"
       SET "auto_send_state" = 'REFUSED', "auto_send_note" = ${ABANDONED_SEND},
           "auto_send_claimed_at" = NULL, "updated_at" = now()
     WHERE "auto_send_state" = 'SENT'
       AND "auto_send_claimed_at" IS NOT NULL
       AND "auto_send_claimed_at" < now() - make_interval(mins => ${CLAIM_MINUTES}::int)
    RETURNING "id"
  `
  for (const row of rows) await recordRefusalAudit(row.id, ABANDONED_SEND)
  return rows.length
}

/** Let go of a claim without deciding anything: the next run tries again. */
async function release(orderId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "po_orders" SET "auto_send_claimed_at" = NULL
     WHERE "id" = ${orderId} AND "auto_send_state" = 'QUEUED'
  `
}

/** QUEUED -> REFUSED, with the sentence. Only from QUEUED: a person who held
 *  it a moment ago keeps their note. */
async function refuse(orderId: string, note: string): Promise<void> {
  const changed = await prisma.$executeRaw`
    UPDATE "po_orders"
       SET "auto_send_state" = 'REFUSED', "auto_send_note" = ${note},
           "auto_send_claimed_at" = NULL, "updated_at" = now()
     WHERE "id" = ${orderId} AND "auto_send_state" = 'QUEUED'
  `
  if (changed > 0) await recordRefusalAudit(orderId, note)
}

/** Mail that would not go: tried again next run, or - out of tries - refused
 *  with what the mail server said. */
async function failed(orderId: string, error: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ auto_send_attempts: number }[]>`
    UPDATE "po_orders" SET "auto_send_attempts" = "auto_send_attempts" + 1
     WHERE "id" = ${orderId} AND "auto_send_state" = 'QUEUED'
    RETURNING "auto_send_attempts"
  `
  const attempts = rows[0]?.auto_send_attempts
  if (attempts === undefined) return
  const next = afterFailedSend(attempts - 1, error)
  if (next.retry) await release(orderId)
  else await refuse(orderId, next.note)
}

/** Everything `sendRefusal` needs, read fresh: the order, its supplier, the
 *  customer order behind it and the supplier's current price list. Null when
 *  the order has gone. */
export async function gatherSendFacts(orderId: string, config: PoConfig): Promise<SendFacts | null> {
  const order = await getOrder(orderId)
  if (!order) return null
  const supplier = await getSupplier(order.supplierId)

  // The customer order, re-read now rather than trusted from when it was
  // drafted - a refund in the hold is exactly what the hold is for. Raw SQL
  // behind `hasCatalogue` (lib/from-order.ts), so a site with no shop gets
  // "could not be read" rather than a throw.
  const ref = order.sourceKind === 'FROM_ORDER' ? order.sourceRef : null
  const customerOrderId = typeof ref?.orderId === 'string' ? ref.orderId : null
  const customerOrderNumber = typeof ref?.orderNumber === 'string' ? ref.orderNumber : null
  let customer: SendFacts['customer'] = null
  if (customerOrderId) {
    const shopOrder = await readShopOrder(customerOrderId)
    if (!shopOrder) {
      customer = { readable: false, orderNumber: customerOrderNumber }
    } else {
      const owed = new Map(shopOrder.items.map((item) => [item.itemId, item.quantity]))
      const shortfall = order.lines
        .filter((line) => line.sourceOrderItemId)
        .filter((line) => (owed.get(line.sourceOrderItemId!) ?? 0) < Number(line.qty) - Number(line.qtyCancelled))
        .map((line) => line.productName ?? line.description)
      customer = {
        readable: true,
        orderNumber: shopOrder.orderNumber,
        status: shopOrder.status,
        paymentStatus: shopOrder.paymentStatus ?? null,
        shortfall,
      }
    }
  }

  // Against the supplier's current list, where lists are on. The draft took
  // its price from the list or from the product's cost price; only the first is
  // the supplier's own word, and a list replaced in the hold is a price that
  // may have moved.
  const costs = config.supplierCatalogues ? await catalogueCostsBySupplier([order.supplierId]) : null
  const lines: SendLineFacts[] = order.lines.map((line) => {
    if (!costs) return { description: line.description, unitCost: line.unitCost, catalogue: 'NOT_CHECKED' }
    const listed = line.supplierSku ? costs.get(costKey(order.supplierId, catalogueSkuKey(line.supplierSku))) : undefined
    const listCost = listed?.unitCost == null ? null : Number(listed.unitCost)
    const catalogue = listCost == null || !Number.isFinite(listCost)
      ? 'MISSING'
      : listed?.discontinued
        ? 'DISCONTINUED'
        : Math.abs(listCost - Number(line.unitCost)) < 0.005 ? 'MATCH' : 'DIFFERENT'
    return { description: line.description, unitCost: line.unitCost, catalogue }
  })

  return {
    masterOn: config.autoSendEnabled,
    supplier: supplier
      ? {
          name: supplier.name,
          autoSend: supplier.autoSend,
          status: supplier.status,
          hasEmail: Boolean(supplier.email?.trim()),
        }
      : null,
    order: {
      status: order.status,
      approvalRequired: order.approvalRequired,
      // Today's threshold, not the one it was drafted under: lowered since,
      // and the job would otherwise be approving something nobody may now.
      approvalNowRequired: needsApproval(order.total, config),
      sentAt: order.sentAt,
      autoSendState: order.autoSendState,
    },
    customer,
    lines,
  }
}

export type AutoSendRunResult = { claimed: number; sent: number; refused: number; retrying: number }

/**
 * Send what is due. Each claimed draft is checked against every rule, and
 * either sent exactly as the button sends it, refused with a sentence, or -
 * where the mail server would not take it - let go for the next run to try.
 *
 * One at a time and never in parallel: each send draws a PDF and talks to the
 * mail server, and a run that fans out is a run that fights the site.
 */
export async function runAutoSend(options: { deadline: number }): Promise<AutoSendRunResult> {
  const config = await getPoConfigCached()
  const result: AutoSendRunResult = { claimed: 0, sent: 0, refused: 0, retrying: 0 }
  result.refused += await settleAbandonedSends()
  const claimed = await claimDue(config.autoSendHoldMinutes)
  result.claimed = claimed.length

  for (const orderId of claimed) {
    if (Date.now() > options.deadline) {
      await release(orderId)
      continue
    }
    try {
      // Read before the facts, so anything written to the order after this -
      // by anything at all - stops the send at the last moment.
      const stamp = await rowStamp(orderId)
      const facts = await gatherSendFacts(orderId, config)
      if (!facts) continue
      const refusal = sendRefusal(facts)
      if (refusal) {
        await refuse(orderId, refusal)
        result.refused++
        continue
      }

      const sent = await sendOrderRun({ orderId, userId: null, by: 'AUTO', autoStamp: stamp })
      switch (sent.outcome) {
        case 'sent':
          result.sent++
          break
        case 'refused':
          await refuse(orderId, sent.reason)
          result.refused++
          break
        case 'failed':
          await failed(orderId, sent.error)
          result.retrying++
          break
        case 'stale':
          // Changed under it. Nothing went; still queued unless a person took
          // it out, in which case this does nothing. Read afresh next run.
          await release(orderId)
          result.retrying++
          break
        case 'unrecorded':
          // The email went. Already refused for a person - never again.
          result.refused++
          break
      }
    } catch (error) {
      // Something other than the mailer, BEFORE anything was sent - a database
      // blip reading the facts. Counted as a failed try, so it is retried and,
      // if it keeps happening, reported. `failed` only touches a row still
      // QUEUED: one that got as far as being emailed is never retried.
      console.error('[purchase-orders] automatic send failed for', orderId, error)
      await failed(orderId, error instanceof Error ? error.message : 'Something went wrong.').catch(() => {})
      result.retrying++
    }
  }
  return result
}

/** A refusal the owner has not been told about. */
export type AutoSendProblem = { orderNumber: string; supplierName: string; note: string }

/**
 * Take the refusals nobody has been told about yet, marking them told in the
 * same statement so two runs never report one twice. Matches
 * po_orders_auto_send_unreported_idx's predicate, so it is an index read.
 */
export async function takeUnreportedRefusals(): Promise<AutoSendProblem[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    UPDATE "po_orders" o
       SET "auto_send_reported_at" = now()
      FROM "po_suppliers" s
     WHERE s."id" = o."supplier_id"
       AND o."auto_send_state" = 'REFUSED'
       AND o."auto_send_reported_at" IS NULL
    RETURNING o."number", o."auto_send_note", s."name" AS "supplier_name"
  `
  return rows.map((r) => ({
    orderNumber: r.number as string,
    supplierName: r.supplier_name as string,
    note: (r.auto_send_note as string | null) ?? '',
  }))
}
