import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { getOrder } from '@/modules/purchase-orders/lib/db'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { recordAudit } from '@/modules/purchase-orders/lib/audit'
import { sendPortalReplyToBuyer } from '@/modules/purchase-orders/lib/email'
import { PortalActionBody } from '@/modules/purchase-orders/lib/portal-body'
import { buildPortalView } from '@/modules/purchase-orders/lib/portal-response'
import { generateShipmentNumber } from '@/modules/purchase-orders/lib/numbering'
import { createShipment, despatchableLines } from '@/modules/purchase-orders/lib/shipments'
import {
  acknowledgeFromPortal, portalNoticeRecipient, recordPortalEvent, resolvePortalToken,
} from '@/modules/purchase-orders/lib/portal'
import { hashPortalIp } from '@/modules/purchase-orders/lib/portal-token'
import { allowPortalWriteIp, allowPortalWriteToken, portalClientIp } from '@/modules/purchase-orders/lib/portal-rate-limit'
import { isPortalOpen, portalEventSummary, qtyProblem, qtyThousandths } from '@/modules/purchase-orders/lib/portal-view'
import type { PoPortalEventKind } from '@/modules/purchase-orders/lib/portal-view'

// POST - the things a supplier may say back through their own link.
//
// The only write endpoint on this platform that takes instructions from outside
// the building with no account behind them, so the shape of it matters:
//
//  - Every reply is a PROPOSAL, with two exceptions that are theirs to state
//    rather than ours to guess: accepting the order stamps it, and telling us
//    what has left them files a despatch. Neither touches a line, a price, a
//    total or a stock count. A date or a shortage still lands in
//    po_portal_events for somebody here to apply.
//  - A token opens exactly one order, and the order is looked up FROM the token
//    rather than from anything the caller sends. There is no order id on the
//    wire to tamper with.
//  - Every failure is the same 404. Whether a link never existed, has been
//    revoked, has aged out, or the owner has switched the portal off is nobody
//    else's business.
export async function POST(request: NextRequest) {
  const ip = portalClientIp(request)
  // Before the token is even looked up, so a flood of made-up ones costs a map
  // lookup rather than a query each.
  if (!allowPortalWriteIp(ip)) {
    return errorResponse('That is a lot of messages at once. Give it a few minutes.', 429)
  }

  const parsed = PortalActionBody.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? 'We could not read that.')
  const body = parsed.data

  const config = await getPoConfigCached()
  if (!config.portalEnabled) return errorResponse('That link is not open any more.', 404)

  const token = await resolvePortalToken(body.token)
  if (!token) return errorResponse('That link is not open any more.', 404)
  if (!allowPortalWriteToken(token.hash)) {
    return errorResponse('That is a lot of messages at once. Give it a few minutes.', 429)
  }

  const order = await getOrder(token.orderId)
  if (!order) return errorResponse('That link is not open any more.', 404)
  if (!isPortalOpen(order.status)) {
    return errorResponse('This order is closed, so there is nothing left to tell us about it here.', 409)
  }

  const note = 'note' in body ? (body.note ?? '').trim() : ''
  let kind: PoPortalEventKind
  let payload: Record<string, unknown>

  switch (body.action) {
    case 'acknowledge': {
      // On proforma terms an order is not theirs to confirm until the money has
      // moved. Checked here as well as hidden on the panel, because a button
      // being absent from a page has never stopped a request being sent.
      if (order.proformaRequired && !order.proformaPaidAt) {
        return errorResponse(
          'We have not paid your proforma yet. Send it to us if you have not already, and confirm the order once it is settled.',
          409,
        )
      }
      kind = 'ACKNOWLEDGED'
      payload = { note, ref: (body.ref ?? '').trim(), document: false }
      // The one write to the order itself, and it is guarded in SQL: two people
      // at the supplier pressing the button at the same moment cannot both move
      // the status.
      await acknowledgeFromPortal(order.id, note || null)
      break
    }
    case 'propose-date': {
      // Line ids are checked against THIS order's own lines, exactly as a
      // shortage is: a supplier holding one link cannot re-date somebody else's
      // order. The description is snapshotted alongside so the history still
      // reads properly after an amendment rewrites the lines.
      const byId = new Map(order.lines.map((line) => [line.id, line]))
      const lines = body.lines
        .map((row) => {
          const line = byId.get(row.lineId)
          return line ? { lineId: line.id, description: line.description, date: row.date } : null
        })
        .filter((row): row is { lineId: string; description: string; date: string } => row !== null)
      if (lines.length === 0) return errorResponse('Those lines are not on this order.')
      kind = 'DATE_PROPOSED'
      payload = { lines, note }
      break
    }
    case 'shortage': {
      // What is genuinely still owed on each line, worked out here rather than
      // trusted off the form - the same figure the despatch form is held to, and
      // for the same reason. A supplier cannot be short of four when they only
      // ever had two on order, and a shortage bigger than the line is a number
      // somebody here would then have to unpick by phone.
      //
      // Refused rather than quietly cut down to size. A form that takes "10",
      // files "4" and says thank you has told the supplier something that is not
      // true, and they will not find out until the delivery is wrong.
      const byId = new Map(order.lines.map((line) => [line.id, line]))
      const outstanding = new Map(
        (await despatchableLines(order.id)).map((line) => [line.orderLineId, line]),
      )
      const lines: { lineId: string; description: string; supplierSku: string | null; qty: string }[] = []
      for (const row of body.lines) {
        const line = byId.get(row.lineId)
        if (!line) continue
        const left = outstanding.get(row.lineId)?.qtyOutstanding ?? '0'
        const problem = qtyProblem(row.qty, left, { description: line.description, unit: line.unit }, 'short')
        if (problem) return errorResponse(problem, 409)
        lines.push({
          lineId: line.id,
          description: line.description,
          supplierSku: line.supplierSku,
          qty: String(Number(row.qty)),
        })
      }
      if (lines.length === 0) return errorResponse('Those lines are not on this order.')
      kind = 'SHORTAGE'
      payload = { lines, note }
      break
    }
    case 'despatch': {
      if (!config.portalDespatchEnabled) {
        return errorResponse('We are not taking despatch notes through this page. Email them to us instead.', 409)
      }
      // What is genuinely left to send, worked out here rather than trusted off
      // the form: a supplier with two tabs open would otherwise despatch the same
      // pallet twice, and a packing slip for goods nobody ordered is worse than
      // no packing slip.
      const outstanding = new Map(
        (await despatchableLines(order.id)).map((line) => [line.orderLineId, line]),
      )
      const lines: { lineId: string; description: string; supplierSku: string | null; qty: string }[] = []
      for (const row of body.lines) {
        const line = outstanding.get(row.lineId)
        if (!line) continue
        // Refused rather than cut down to the outstanding figure. Silently
        // filing four when they told us ten reads as agreement, and the first
        // anybody hears of it is a packing slip that does not match the lorry.
        const problem = qtyProblem(
          row.qty,
          line.qtyOutstanding,
          { description: line.description, unit: line.unit },
          'sending',
        )
        if (problem) return errorResponse(problem, 409)
        if (!(qtyThousandths(row.qty) > 0)) continue
        lines.push({
          lineId: row.lineId,
          description: line.description,
          supplierSku: line.supplierSku,
          qty: Number(row.qty).toFixed(3),
        })
      }
      if (lines.length === 0) {
        return errorResponse('There is nothing left to send on those lines.', 409)
      }

      const number = await generateShipmentNumber()
      await createShipment(number, {
        orderId: order.id,
        despatchedDate: body.date,
        carrier: (body.carrier ?? '').trim() || null,
        trackingRef: (body.trackingRef ?? '').trim() || null,
        trackingUrl: (body.trackingUrl ?? '').trim() || null,
        notes: note || null,
        source: 'PORTAL',
        tokenId: token.id,
        createdByUserId: null,
        lines: lines.map((line) => ({ orderLineId: line.lineId, qty: line.qty })),
      })

      kind = 'DESPATCHED'
      payload = {
        number,
        date: body.date,
        carrier: (body.carrier ?? '').trim(),
        trackingRef: (body.trackingRef ?? '').trim(),
        trackingUrl: (body.trackingUrl ?? '').trim(),
        lines: lines.map((line) => ({
          lineId: line.lineId,
          description: line.description,
          qty: String(Number(line.qty)),
        })),
        note,
      }
      break
    }
    case 'message': {
      // Checked against THIS order's lines like every other line reference here,
      // and snapshotted with the description so the history still reads properly
      // after an amendment rewrites them. No lines at all means the whole order,
      // which is what most messages are about.
      const byId = new Map(order.lines.map((line) => [line.id, line]))
      const lines = (body.lines ?? [])
        .map((lineId) => byId.get(lineId))
        .filter((line): line is NonNullable<typeof line> => line !== undefined)
        .map((line) => ({ lineId: line.id, description: line.description }))
      kind = 'MESSAGE'
      payload = { text: body.text.trim(), lines }
      break
    }
  }

  await recordPortalEvent(token.id, order.id, kind, payload, hashPortalIp(ip))

  const summary = portalEventSummary(kind, payload)
  // Filed against the order rather than against a portal entity of its own: the
  // order is where anybody would look for it, and it is the only place the whole
  // story of this order is told in one column.
  await recordAudit('order', order.id, `order.portal-${kind.toLowerCase()}`, { note: summary, supplier: order.supplierName }, null)

  // Nobody sits watching an order screen. A proposal nobody reads is a proposal
  // nobody applies, so the buyer is told - best-effort, and the reply has landed
  // in the history whether the email sends or not.
  const to = await portalNoticeRecipient()
  if (to) await sendPortalReplyToBuyer(to, order.supplierName, order.number, summary)

  // Read back rather than patched together here, so what the supplier sees after
  // pressing the button is what the database now says.
  const view = await buildPortalView(order.id)
  return NextResponse.json({ ok: true, view })
}
