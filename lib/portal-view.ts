import type { PoOrder, PoStatus } from './types'
import { PO_STATUS_LABELS } from './types'

// What a SUPPLIER is allowed to see and say, and the pure functions that build
// it.
//
// The projection is built field by field on purpose. Handing the PoOrder row
// itself to the portal would hand over notes_internal ("check they have not
// stitched us up on carriage again"), who approved it and at what level, and
// every audit line - none of which is theirs, and all of which would arrive the
// day somebody added a field to the row rather than the day anybody decided to
// share it. An allow-list cannot leak a field nobody has listed.
//
// CLIENT-SAFE. The panel on the portal page imports this, so nothing here may
// reach the database, next/headers or any server-only module.

export const PO_PORTAL_EVENT_KINDS = ['ACKNOWLEDGED', 'DATE_PROPOSED', 'SHORTAGE', 'MESSAGE'] as const
export type PoPortalEventKind = (typeof PO_PORTAL_EVENT_KINDS)[number]

export const PO_PORTAL_EVENT_LABELS: Record<PoPortalEventKind, string> = {
  ACKNOWLEDGED: 'Accepted the order',
  DATE_PROPOSED: 'Offered a different date',
  SHORTAGE: 'Said something is short',
  MESSAGE: 'Left a message',
}

/** One line of the order as the supplier sees it in the panel. No money: the
 *  document above the panel already prints their own prices, and the panel only
 *  needs enough to point at a line. */
export type PoPortalLine = {
  id: string
  description: string
  supplierSku: string | null
  qty: string
  unit: string
  expectedDate: string | null
  /** A conscious addition to an otherwise tight allow-list: the supplier cannot
   *  send a line on the right service without being told which one. What that
   *  service costs stays behind - it is on the document as carriage, and a
   *  per-line figure beside it is nothing they need. */
  serviceName: string | null
}

/** Something the supplier has already told us, as it reads back to them. */
export type PoPortalEvent = {
  id: string
  kind: PoPortalEventKind
  createdAt: string
  /** One line of plain English, built from the payload. */
  summary: string
}

export type PoPortalView = {
  orderNumber: string
  revision: number
  statusLabel: string
  /** Whether the order is still one the supplier can say anything about. A
   *  cancelled or finished order is readable and nothing more. */
  open: boolean
  acknowledged: boolean
  acknowledgedAt: string | null
  requiredByDate: string | null
  expectedDate: string | null
  lines: PoPortalLine[]
  events: PoPortalEvent[]
}

/** One link, as the order screen lists it. Never the hash: no screen anywhere
 *  has any business showing that, and a type that cannot carry it is one fewer
 *  way for it to end up in a browser. */
export type PoPortalTokenSummary = {
  id: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  useCount: number
  createdByName: string | null
  /** Worked out on the server, so the list and the door agree on what "live"
   *  means. */
  live: boolean
}

/** One thing the supplier said, as the order screen lists it. The date is named
 *  rather than left in the payload, because it is the one thing there is a button
 *  for. */
export type PoPortalAdminEvent = PoPortalEvent & { proposedDate: string | null }

/** The statuses a supplier may still act on. An order they have finished with,
 *  or one that has been cancelled, is theirs to read and nothing more. */
const OPEN_STATUSES: readonly PoStatus[] = ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'ON_HOLD']

export function isPortalOpen(status: PoStatus): boolean {
  return OPEN_STATUSES.includes(status)
}

/** A date as the supplier typed it, or null. Kept as a plain YYYY-MM-DD string
 *  the whole way: a Date here is a timezone waiting to move somebody's delivery
 *  a day. */
export function parsePortalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/** One event as a sentence, for both the supplier's own list and the admin's. */
export function portalEventSummary(kind: PoPortalEventKind, payload: Record<string, unknown>): string {
  const note = typeof payload.note === 'string' ? payload.note.trim() : ''
  switch (kind) {
    case 'ACKNOWLEDGED':
      return note ? `Accepted the order: ${note}` : 'Accepted the order.'
    case 'DATE_PROPOSED': {
      const date = parsePortalDate(payload.date)
      const opening = date ? `Offered ${date} instead.` : 'Offered a different date.'
      return note ? `${opening} ${note}` : opening
    }
    case 'SHORTAGE': {
      const lines = Array.isArray(payload.lines) ? payload.lines : []
      const parts = lines
        .map((line) => {
          const row = (line ?? {}) as Record<string, unknown>
          const what = typeof row.description === 'string' ? row.description : 'a line'
          const qty = typeof row.qty === 'string' ? row.qty : ''
          return qty ? `${what} (${qty} short)` : what
        })
        .filter(Boolean)
      const opening = parts.length ? `Short on ${parts.join('; ')}.` : 'Said something is short.'
      return note ? `${opening} ${note}` : opening
    }
    case 'MESSAGE':
      return typeof payload.text === 'string' ? payload.text.trim() : ''
  }
}

/**
 * The order as the supplier's panel receives it.
 *
 * Every field named one at a time. Nothing is spread in from the order row, and
 * nothing should ever be: the test beside this file asserts that an order
 * carrying internal notes and an approval trail comes out the other side with
 * neither.
 */
export function portalView(order: PoOrder, events: PoPortalEvent[]): PoPortalView {
  return {
    orderNumber: order.number,
    revision: order.revision,
    statusLabel: PO_STATUS_LABELS[order.status] ?? order.status,
    open: isPortalOpen(order.status),
    acknowledged: Boolean(order.acknowledgedAt),
    acknowledgedAt: order.acknowledgedAt,
    requiredByDate: order.requiredByDate,
    expectedDate: order.expectedDate,
    lines: order.lines
      // A line given up on entirely is not one they can be short of.
      .filter((line) => Number(line.qty) - Number(line.qtyCancelled) > 0)
      .map((line) => ({
        id: line.id,
        description: line.description,
        supplierSku: line.supplierSku,
        qty: String(Number(line.qty) - Number(line.qtyCancelled)),
        unit: line.unit,
        expectedDate: line.expectedDate,
        serviceName: line.serviceName,
      })),
    events,
  }
}
