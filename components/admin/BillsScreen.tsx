'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import {
  BILL_STATUSES, PO_BILL_STATUS_LABELS, type PoBillStatus, type PoBillSummary, type PoBillTotals,
} from '@/modules/purchase-orders/lib/types'
import {
  BillStatusBadge, card, formatDay, input, MatchBadge, Money, muted, table, td, tdRight, th, thRight,
} from './ui'

// The Bills tab: what your suppliers say you owe, and how much of it nobody has
// agreed to yet.
//
// The line at the top is the point of the screen. Entering invoices is easy and
// everybody does it; noticing that four of them have been sitting queried since
// March is the thing this exists to stop, so what is unagreed is in words at the
// top rather than buried in a column somebody has to add up.

export function BillsScreen({ canBills }: { canBills: boolean }) {
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders`

  const [bills, setBills] = useState<PoBillSummary[]>([])
  const [totals, setTotals] = useState<PoBillTotals>({
    openCount: 0,
    openTotal: '0.00',
    queriedCount: 0,
    approvedCount: 0,
    approvedTotal: '0.00',
  })
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<PoBillStatus | 'ALL' | 'OPEN'>('ALL')
  const [varianceOnly, setVarianceOnly] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(() => {
    const params = new URLSearchParams()
    if (search.trim()) params.set('search', search.trim())
    if (status !== 'ALL') params.set('status', status)
    if (varianceOnly) params.set('variance', '1')
    return fetch(`/api/m/purchase-orders/admin/bills?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setBills(data.bills ?? [])
          if (data.totals) setTotals(data.totals)
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [search, status, varianceOnly])

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh()
    }, 200)
    return () => clearTimeout(timer)
  }, [refresh])

  return (
    <div>
      <div
        className="page-header"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
      >
        <h1 className="page-title">Supplier bills</h1>
        {canBills && (
          <Link href={`${base}/bills/new`} className="btn btn-primary">
            Enter a bill
          </Link>
        )}
      </div>

      <div style={card}>
        {totals.openCount === 0 ? (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            Nothing is waiting. Every invoice you have entered has been dealt with one way or another.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            <strong>
              <Money value={totals.openTotal} />
            </strong>{' '}
            on {totals.openCount === 1 ? 'one bill' : `${totals.openCount} bills`} nobody has agreed to pay yet
            {totals.queriedCount > 0 && (
              <>
                , {totals.queriedCount === 1 ? 'one of them' : `${totals.queriedCount} of them`} queried with the
                supplier
              </>
            )}
            .
          </p>
        )}
        {totals.approvedCount > 0 && (
          <p style={{ ...muted, margin: '0.5rem 0 0' }}>
            Approved and waiting to be paid: <Money value={totals.approvedTotal} /> on{' '}
            {totals.approvedCount === 1 ? 'one bill' : `${totals.approvedCount} bills`}.
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{ ...input, width: 'auto', minWidth: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Their invoice number, supplier, order"
          aria-label="Search bills"
        />
        <select
          style={{ ...input, width: 'auto' }}
          value={status}
          onChange={(e) => setStatus(e.target.value as PoBillStatus | 'ALL' | 'OPEN')}
          aria-label="Filter by status"
        >
          <option value="ALL">Every bill</option>
          <option value="OPEN">Still to deal with</option>
          {BILL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PO_BILL_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={varianceOnly} onChange={(e) => setVarianceOnly(e.target.checked)} />
          Only the ones that do not agree
        </label>
      </div>

      <div style={card}>
        {loaded && bills.length === 0 && (
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            No bills here. Enter one against a purchase order from the order itself, or on its own with
            &ldquo;Enter a bill&rdquo; for the things nobody raises an order for.
          </p>
        )}
        {bills.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Their invoice</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Order</th>
                  <th style={th}>Dated</th>
                  <th style={th}>Due</th>
                  <th style={th}>Status</th>
                  <th style={th}>Against the order</th>
                  <th style={thRight}>Total</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td style={td}>
                      <Link href={`${base}/bills/${b.id}`} style={{ color: 'var(--color-primary)' }}>
                        {b.supplierInvoiceNumber}
                      </Link>
                      {b.hasAttachment && <div style={muted}>Their invoice is attached</div>}
                    </td>
                    <td style={td}>{b.supplierName}</td>
                    <td style={td}>
                      {b.orderId ? (
                        <Link href={`${base}/orders/${b.orderId}`} style={{ color: 'var(--color-primary)' }}>
                          {b.orderNumber}
                        </Link>
                      ) : (
                        <span style={muted}>None</span>
                      )}
                    </td>
                    <td style={td}>{formatDay(b.invoiceDate)}</td>
                    <td style={td}>{formatDay(b.dueDate)}</td>
                    <td style={td}>
                      <BillStatusBadge status={b.status} />
                    </td>
                    <td style={td}>
                      <MatchBadge status={b.matchStatus} count={b.varianceCount} />
                    </td>
                    <td style={tdRight}>
                      <Money value={b.total} currency={b.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!canBills && (
          <p style={{ ...muted, marginTop: '0.75rem' }}>
            You do not have permission to enter or approve a supplier bill.
          </p>
        )}
      </div>
    </div>
  )
}
