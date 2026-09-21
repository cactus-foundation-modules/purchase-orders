'use client'

import { PO_PORTAL_EVENT_LABELS } from '@/modules/purchase-orders/lib/portal-view'
import type { PoOrder } from '@/modules/purchase-orders/lib/types'
import { card, Field, formatWhen, input, linkButton, muted, table, td, th } from '../ui'
import type { PortalState } from './shared'

type SupplierLinkProps = {
  order: PoOrder
  portal: PortalState | null
  newLink: string | null
  onRevokeLink: ((tokenId: string) => void) | null
  onRevokeAllLinks: (() => void) | null
  onApplyDate: ((eventId: string) => void) | null
}

/** Where the bar scrolls to once it has made a link, so the link - shown once
 *  and never again - is on screen rather than three cards down. */
export const SUPPLIER_LINK_CARD_ID = 'po-supplier-link'

/**
 * The supplier's own link to this order, and everything they have said through
 * it.
 *
 * Two things worth knowing about this card. The link itself is shown once, at
 * the moment it is made, because only its hash is stored - so there is no screen
 * that can show it again and no backup that leaks it. And what the supplier says
 * is a PROPOSAL: the only button here that changes the order is the one that
 * takes them up on a date, and somebody in this building presses it.
 */
export function SupplierLinkCard({ order, portal, newLink, onRevokeLink, onRevokeAllLinks, onApplyDate }: SupplierLinkProps) {
  // Null while it is still loading. Drawing an empty card first and filling it in
  // afterwards reads as a fault on a fast connection.
  if (!portal) return null

  const live = portal.tokens.filter((token) => token.live)

  return (
    <>
      <div style={{ ...card, scrollMarginTop: '9rem' }} id={SUPPLIER_LINK_CARD_ID}>
        <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>The supplier&apos;s link</h2>

        {!portal.enabled ? (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            Supplier links are switched off. Turn them on in Settings, Purchase Orders, and the link goes out with the
            order.
          </p>
        ) : (
          <>
            <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
              A link to this one order and nothing else. The supplier can read it, accept it, offer a different date or
              tell you something is short. They cannot change a thing on it. Links last {portal.lifetimeDays} days and
              can be stopped at any time.
            </p>

            {newLink && (
              <div style={{ marginBottom: '0.75rem' }}>
                <Field label="The new link" hint="Copy it now. It is not stored, so this is the only time it can be shown.">
                  <input style={input} readOnly value={newLink} onFocus={(e) => e.currentTarget.select()} />
                </Field>
              </div>
            )}

            {portal.tokens.length === 0 ? (
              <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
                {order.sentAt
                  ? 'No link has been made for this order yet. Make a link, under More at the top, makes one.'
                  : 'Send this order to the supplier and a link goes out with it.'}
              </p>
            ) : (
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Made</th>
                    <th style={th}>By</th>
                    <th style={th}>Until</th>
                    <th style={th}>Opened</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {portal.tokens.map((token) => (
                    <tr key={token.id}>
                      <td style={td}>{formatWhen(token.createdAt)}</td>
                      <td style={td}>{token.createdByName ?? 'The order email'}</td>
                      <td style={td}>
                        {token.revokedAt ? `Stopped ${formatWhen(token.revokedAt)}` : formatWhen(token.expiresAt)}
                      </td>
                      <td style={td}>
                        {token.useCount === 0 ? 'Never' : `${token.useCount} times, last ${formatWhen(token.lastUsedAt)}`}
                      </td>
                      <td style={td}>
                        {token.live && onRevokeLink && (
                          <button style={{ ...linkButton, color: 'var(--color-danger)' }} onClick={() => onRevokeLink(token.id)}>
                            Stop it
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {live.length > 1 && onRevokeAllLinks && (
              <div style={{ marginTop: '0.75rem' }}>
                <button style={{ ...linkButton, color: 'var(--color-danger)' }} onClick={onRevokeAllLinks}>
                  Stop every link
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {portal.events.length > 0 && (
        <div style={card}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>What the supplier said</h2>
          <p style={{ ...muted, marginTop: 0 }}>
            Nothing here has changed the order. A date is yours to accept; anything else is yours to act on.
          </p>
          <table style={table}>
            <tbody>
              {portal.events.map((event) => (
                <tr key={event.id}>
                  <td style={td}>{PO_PORTAL_EVENT_LABELS[event.kind]}</td>
                  <td style={td}>{event.summary}</td>
                  <td style={td}>{formatWhen(event.createdAt)}</td>
                  <td style={td}>
                    {/* Only where it would actually change something. A button
                        that sets the date it is already on is a button that
                        teaches people the buttons do nothing.
                        Two shapes: dates offered line by line, which is what a
                        supplier shipping an order in drops answers with, and one
                        date for the whole order, which is what everything filed
                        before per-line dates existed carries. */}
                    {onApplyDate && event.proposedLines?.length > 0 && (
                      <button style={linkButton} onClick={() => onApplyDate(event.id)}>
                        Use {event.proposedLines.length === 1
                          ? `${event.proposedLines[0]!.date}`
                          : `these ${event.proposedLines.length} dates`}
                      </button>
                    )}
                    {onApplyDate &&
                      !event.proposedLines?.length &&
                      event.proposedDate &&
                      event.proposedDate !== order.expectedDate && (
                        <button style={linkButton} onClick={() => onApplyDate(event.id)}>
                          Use {event.proposedDate}
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
