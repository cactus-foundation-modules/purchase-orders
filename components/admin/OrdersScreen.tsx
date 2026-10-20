'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { useAdminConfirm } from '@/components/admin/useAdminConfirm'
import { PO_STATUSES, PO_STATUS_LABELS, type PoOrderListRow, type PoStatus } from '@/modules/purchase-orders/lib/types'
import { CustomerOrderCell, formatDay, input, Money, muted, OrderStatusBadge, table, td, tdRight, th, thRight } from './ui'
import { PaperworkPanel } from './PaperworkPanel'

type StatusFilter = PoStatus | 'ALL' | 'OPEN'

export function OrdersScreen({ canCreate, canBills }: { canCreate: boolean; canBills: boolean }) {
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders/orders`
  const shopOrdersBase = `/${adminPath}/m/shop/orders`
  const [askConfirm, confirmNode] = useAdminConfirm()

  const [orders, setOrders] = useState<PoOrderListRow[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<StatusFilter>('OPEN')
  const [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const params = new URLSearchParams({ status })
    if (search.trim()) params.set('search', search.trim())
    const res = await fetch(`/api/m/purchase-orders/admin/orders?${params.toString()}`)
    if (res.ok) {
      const data = await res.json()
      setOrders(data.orders ?? [])
      setTotal(data.total ?? 0)
    }
    setLoaded(true)
  }, [status, search])

  async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: res.ok, data }
  }

  /**
   * Close an order that is waiting to close, approving the invoice holding it up
   * first where there is one.
   *
   * It goes through the same two routes the order and bill screens use, one bill
   * at a time and in that order, so every rule, audit line and bookkeeping
   * handoff is the one those screens already have. It stops at the first thing
   * that is refused, which leaves the order exactly where it was and the list
   * showing what is left.
   */
  async function settleAndClose(order: PoOrderListRow) {
    const bills = order.unsettledBills
    if (bills.length > 0) {
      const lines = bills.map((b) => {
        const odd = b.matchStatus === 'VARIANCE' ? ' (does not agree with the order)' : ''
        return `${b.supplierInvoiceNumber}${odd}`
      })
      const ok = await askConfirm({
        title: `Approve ${bills.length === 1 ? 'the bill' : `${bills.length} bills`} and close ${order.number}?`,
        message: `This approves ${lines.join(', ')} to be paid, then closes the order.`,
        confirmLabel: 'Approve and close',
        danger: false,
      })
      if (!ok) return
    } else {
      const ok = await askConfirm({
        title: `Close ${order.number}?`,
        message: 'Everything on it has been delivered and invoiced. Closing files it away.',
        confirmLabel: 'Close the order',
        danger: false,
      })
      if (!ok) return
    }

    setError(null)
    setMessage(null)
    setBusyId(order.id)
    const said: string[] = []
    try {
      for (const bill of bills) {
        const approved = await post(`/api/m/purchase-orders/admin/bills/${bill.id}/transition`, { transition: 'approve' })
        if (!approved.ok) {
          setError(`Bill ${bill.supplierInvoiceNumber} was not approved, so ${order.number} is still open. ${String(approved.data.error ?? 'That did not work.')}`)
          return
        }
        const books = approved.data.books as { message?: string } | null | undefined
        if (books?.message) said.push(books.message)
      }
      const closed = await post(`/api/m/purchase-orders/admin/orders/${order.id}/transition`, { transition: 'close' })
      if (!closed.ok) {
        setError(
          `${bills.length > 0 ? 'The bill is approved, but ' : ''}${order.number} was not closed. ${String(closed.data.error ?? 'That did not work.')}`,
        )
        return
      }
      setMessage([`${order.number} is closed.`, ...said].join(' '))
    } finally {
      setBusyId(null)
      await refresh()
    }
  }

  // Debounced so typing a supplier name is not one request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh()
    }, 200)
    return () => clearTimeout(timer)
  }, [refresh])

  // Columns that only earn their place when something fills them: a site with
  // no shop, or nothing raised for a customer, has no use for the first, and the
  // second is nothing but empty cells until an order is waiting to close.
  const showCustomer = orders.some((o) => o.customerOrder !== null)
  const showActions = orders.some((o) => o.status === 'PENDING_CLOSE')

  return (
    <div>
      {confirmNode}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Purchase orders</h1>
        {canCreate && (
          <Link href={`${base}/new`} className="btn btn-primary">
            New purchase order
          </Link>
        )}
      </div>

      <PaperworkPanel onFiled={() => void refresh()} />

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select
          style={{ ...input, width: 'auto' }}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          <option value="OPEN">Still open</option>
          <option value="ALL">Everything</option>
          {PO_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PO_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <input
          style={{ ...input, width: 'auto', minWidth: 240 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Order number, supplier, note"
          aria-label="Search purchase orders"
        />
      </div>

      {(error || message) && (
        <div
          className={error ? 'alert alert-danger' : 'alert alert-success'}
          role={error ? 'alert' : 'status'}
          style={{ marginBottom: '1rem' }}
        >
          {error ?? message}
        </div>
      )}

      {loaded && orders.length === 0 && (
        <p style={{ color: 'var(--color-text-secondary)' }}>
          {status === 'OPEN'
            ? 'Nothing outstanding. Either everything has turned up, or nobody has ordered anything yet.'
            : 'No purchase orders match that.'}
        </p>
      )}

      {orders.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Number</th>
                <th style={th}>Supplier</th>
                {showCustomer && <th style={th}>Customer order</th>}
                <th style={th}>Status</th>
                <th style={th}>Raised</th>
                <th style={th}>Wanted by</th>
                <th style={th}>Expected</th>
                <th style={thRight}>Lines</th>
                <th style={thRight}>Total</th>
                {showActions && <th style={th}></th>}
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td style={td}>
                    <Link href={`${base}/${o.id}`} style={{ color: 'var(--color-primary)' }}>
                      {o.number}
                    </Link>
                    {o.revision > 1 && <span style={{ marginLeft: '0.375rem' }}>Rev {o.revision}</span>}
                  </td>
                  <td style={td}>{o.supplierName}</td>
                  {showCustomer && (
                    <td style={td}>
                      <CustomerOrderCell customerOrder={o.customerOrder} href={shopOrdersBase} />
                    </td>
                  )}
                  <td style={td}>
                    <OrderStatusBadge order={o} />
                  </td>
                  <td style={td}>{formatDay(o.raisedDate)}</td>
                  <td style={td}>{formatDay(o.requiredByDate)}</td>
                  <td style={td}>{formatDay(o.expectedDate)}</td>
                  <td style={tdRight}>{o.lineCount}</td>
                  <td style={tdRight}>
                    <Money value={o.total} currency={o.currency} />
                  </td>
                  {showActions && (
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <PendingCloseAction
                        order={o}
                        base={base}
                        canCreate={canCreate}
                        canBills={canBills}
                        busy={busyId === o.id}
                        onSettle={() => void settleAndClose(o)}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: '0.75rem', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)' }}>
            {orders.length === total ? `${total} order${total === 1 ? '' : 's'}.` : `Showing ${orders.length} of ${total}.`}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * The button on an order that is waiting to close.
 *
 * What it offers follows what is holding the order up: an invoice nobody has
 * read gets "Approve bill and close", and one that has been approved already
 * gets a plain Close. A query is neither - somebody asked the supplier something
 * and the answer is theirs to act on, so the row points at the order instead of
 * offering to wave it through.
 */
function PendingCloseAction({
  order, base, canCreate, canBills, busy, onSettle,
}: {
  order: PoOrderListRow
  base: string
  canCreate: boolean
  canBills: boolean
  busy: boolean
  onSettle: () => void
}) {
  if (order.status !== 'PENDING_CLOSE') return null

  const queried = order.unsettledBills.some((b) => b.status === 'QUERIED')
  if (queried) {
    return (
      <Link href={`${base}/${order.id}`} style={{ ...muted, color: 'var(--color-primary)' }}>
        A bill is queried
      </Link>
    )
  }

  const hasBills = order.unsettledBills.length > 0
  if (hasBills ? !(canBills && canCreate) : !canCreate) return null

  const label = !hasBills ? 'Close' : order.unsettledBills.length === 1 ? 'Approve bill and close' : 'Approve bills and close'
  return (
    <button type="button" className="btn btn-primary" disabled={busy} onClick={onSettle}>
      {busy ? 'Working...' : label}
    </button>
  )
}
