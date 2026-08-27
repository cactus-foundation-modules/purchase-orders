'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import type { PoChaseRunResult, PoReports } from '@/modules/purchase-orders/lib/types'
import { card, formatDay, formatWhen, input, Money, muted, StatusBadge, table, td, tdRight, th, thRight } from './ui'

// The Reports tab. Five questions, in the order a purchasing person asks them:
//
//   what have we promised and not got - what is late - what has arrived without
//   an invoice - what has been invoiced without arriving - and what are we
//   actually spending, with whom.
//
// Everything is worked out fresh on every load. Nothing here is stored, so a
// delivery booked in ten minutes ago has already changed the answer.

type Payload = PoReports & { truncated: boolean; canChase: boolean }

/** Files stop here, and the screen says so beside the buttons rather than
 *  letting somebody reconcile against a spreadsheet that quietly stopped. */
const EXPORT_ROW_CAP = 20_000

const EXPORTS = [
  { kind: 'orders', label: 'Orders' },
  { kind: 'lines', label: 'Order lines' },
  { kind: 'receipts', label: 'Deliveries' },
  { kind: 'bills', label: 'Supplier invoices' },
] as const

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 0.25rem', fontSize: 'var(--text-lg)' }}>{title}</h2>
      {note && <p style={{ ...muted, marginTop: 0, marginBottom: '0.75rem' }}>{note}</p>}
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>{children}</p>
}

export function ReportsScreen() {
  const adminPath = useAdminPath()
  const [data, setData] = useState<Payload | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(
    (a: string, b: string) => {
      const query = new URLSearchParams()
      if (a) query.set('from', a)
      if (b) query.set('to', b)
      return fetch(`/api/m/purchase-orders/admin/reports?${query.toString()}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((payload: Payload | null) => {
          if (!payload) {
            setError('Could not work out the reports.')
            return
          }
          setData(payload)
          setFrom(payload.from)
          setTo(payload.to)
        })
        .catch(() => setError('Could not work out the reports.'))
    },
    [],
  )

  useEffect(() => {
    void load('', '')
  }, [load])

  async function chase(orderIds: string[]) {
    if (busy || orderIds.length === 0) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const res = await fetch('/api/m/purchase-orders/admin/chase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds }),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not send those.')
        return
      }
      const result: PoChaseRunResult = await res.json()
      const sent = result.chased.length
      const failed = result.failed.length
      setNote(
        [
          sent === 0 ? 'Nothing went out.' : sent === 1 ? `Chased ${result.chased[0]!.supplierName}.` : `Chased ${sent} suppliers.`,
          failed > 0 ? `${failed === 1 ? 'One' : failed} could not be sent: ${result.failed.map((f) => `${f.orderNumber} - ${f.message}`).join('; ')}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
      await load(from, to)
    } finally {
      setBusy(false)
    }
  }

  if (!data) {
    return (
      <div>
        <div className="page-header"><h1 className="page-title">Reports</h1></div>
        {error ? <div className="alert alert-danger">{error}</div> : <p>Loading…</p>}
      </div>
    )
  }

  const money = (value: string) => <Money value={value} currency={data.baseCurrency} />
  const due = data.chase.decisions.filter((d) => d.due)
  const exportQuery = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`

  return (
    <div>
      <div className="page-header"><h1 className="page-title">Reports</h1></div>

      {error && <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>{error}</div>}
      {note && <div className="alert alert-success" style={{ marginBottom: '1rem' }}>{note}</div>}

      <p style={{ ...muted, marginTop: 0 }}>
        Every figure here is in {data.baseCurrency}. An order in another currency is converted at the rate it was
        raised at, and a supplier invoice at its own - so the committed figure is an expectation and the spend figure
        is what you were actually billed.
      </p>

      {data.truncated && (
        <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
          There is more open purchasing here than these reports look at in one go, so the figures below cover the most
          recent {EXPORT_ROW_CAP.toLocaleString('en-GB')} order lines rather than all of them.
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Committed and not yet received"
        note={`What you have ordered from suppliers and not had. Sent orders only - an approved draft in the tray is a decision, not a commitment. ${data.committed.orderCount === 1 ? 'One order' : `${data.committed.orderCount} orders`}, ${data.committed.total} ${data.baseCurrency}.`}
      >
        {data.committed.suppliers.length === 0 ? (
          <Empty>Nothing is out with a supplier. Enviable.</Empty>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Supplier</th>
                  <th style={thRight}>Orders</th>
                  <th style={thRight}>Lines</th>
                  <th style={thRight}>Value</th>
                </tr>
              </thead>
              <tbody>
                {data.committed.suppliers.map((row) => (
                  <tr key={row.supplierId}>
                    <td style={td}>{row.supplierName}</td>
                    <td style={tdRight}>{row.orderCount}</td>
                    <td style={tdRight}>{row.lineCount}</td>
                    <td style={tdRight}>{money(row.value)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...td, fontWeight: 600 }}>Total</td>
                  <td style={tdRight} />
                  <td style={tdRight} />
                  <td style={{ ...tdRight, fontWeight: 600 }}>{money(data.committed.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Late"
        note={
          data.chase.enabled
            ? `Chasing is on: a supplier hears from us once an order is ${data.chase.afterDays === 1 ? 'a day' : `${data.chase.afterDays} days`} late${data.chase.repeatDays > 0 ? `, then every ${data.chase.repeatDays === 1 ? 'day' : `${data.chase.repeatDays} days`}` : ', and then not again'}.`
            : 'Chasing is switched off, so nothing goes out on its own. You can still send one from here.'
        }
      >
        {data.overdue.length === 0 ? (
          <Empty>Nothing is late. Long may it last.</Empty>
        ) : (
          <>
            {data.canChase && due.length > 0 && (
              <div style={{ marginBottom: '0.75rem' }}>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => chase(due.map((d) => d.orderId))}
                >
                  {busy ? 'Sending…' : due.length === 1 ? 'Chase the one that is due' : `Chase the ${due.length} that are due`}
                </button>
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Order</th>
                    <th style={th}>Supplier</th>
                    <th style={th}>Status</th>
                    <th style={th}>Due</th>
                    <th style={thRight}>Days late</th>
                    <th style={thRight}>Outstanding</th>
                    <th style={th}>Chasing</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {data.overdue.map((row) => {
                    const decision = data.chase.decisions.find((d) => d.orderId === row.orderId)
                    return (
                      <tr key={row.orderId}>
                        <td style={td}>
                          <a href={`/${adminPath}/m/purchase-orders/orders/${row.orderId}`}>{row.orderNumber}</a>
                        </td>
                        <td style={td}>{row.supplierName}</td>
                        <td style={td}><StatusBadge status={row.status} /></td>
                        <td style={td}>{formatDay(row.dueDate)}</td>
                        <td style={tdRight}>{row.daysLate}</td>
                        <td style={tdRight}>{money(row.outstandingValue)}</td>
                        <td style={td}>
                          <div style={muted}>{decision?.reason ?? 'Not being chased.'}</div>
                          {row.lastChasedAt && <div style={muted}>Last chased {formatWhen(row.lastChasedAt)}</div>}
                        </td>
                        <td style={td}>
                          {data.canChase && (
                            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => chase([row.orderId])}>
                              Chase
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Arrived, not invoiced"
        note={`Goods you have taken in that nobody has billed you for yet - anything already sent back is off it. ${data.receivedNotInvoiced.total} ${data.baseCurrency}.`}
      >
        <AccrualTable rows={data.receivedNotInvoiced.rows} adminPath={adminPath} currency={data.baseCurrency} empty="Every delivery has an invoice against it." />
      </Section>

      <Section
        title="Invoiced, not arrived"
        note={`A supplier has billed for something nobody has seen. Worth a telephone call rather than a payment. ${data.invoicedNotReceived.total} ${data.baseCurrency}.`}
      >
        <AccrualTable rows={data.invoicedNotReceived.rows} adminPath={adminPath} currency={data.baseCurrency} empty="Nobody has billed you for anything that has not turned up." />
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Spend"
        note="Supplier invoices you have approved, less credits from returns, excluding VAT. Drafts and queried invoices are not spend until somebody agrees them."
      >
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>From</span>
            <input type="date" style={{ ...input, width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>To</span>
            <input type="date" style={{ ...input, width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="btn btn-secondary btn-sm" onClick={() => void load(from, to)}>Show</button>
        </div>

        <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <Figure label="Invoiced" value={data.spend.billed} currency={data.baseCurrency} />
          <Figure label="Credited back" value={data.spend.credited} currency={data.baseCurrency} />
          <Figure label="Net" value={data.spend.net} currency={data.baseCurrency} strong />
        </div>

        <h3 style={{ fontSize: 'var(--text-base)', margin: '0 0 0.5rem' }}>By supplier</h3>
        {data.spend.bySupplier.length === 0 ? (
          <Empty>No supplier invoices in that window.</Empty>
        ) : (
          <div style={{ overflowX: 'auto', marginBottom: '1.25rem' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Supplier</th>
                  <th style={thRight}>Invoices</th>
                  <th style={thRight}>Invoiced</th>
                  <th style={thRight}>Credited</th>
                  <th style={thRight}>Net</th>
                </tr>
              </thead>
              <tbody>
                {data.spend.bySupplier.map((row) => (
                  <tr key={row.supplierId}>
                    <td style={td}>{row.supplierName}</td>
                    <td style={tdRight}>{row.billCount}</td>
                    <td style={tdRight}>{money(row.billed)}</td>
                    <td style={tdRight}>{money(row.credited)}</td>
                    <td style={tdRight}>{money(row.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 style={{ fontSize: 'var(--text-base)', margin: '0 0 0.5rem' }}>Month by month</h3>
        <div style={{ overflowX: 'auto', marginBottom: '1.25rem' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Month</th>
                <th style={thRight}>Invoiced</th>
                <th style={thRight}>Credited</th>
                <th style={thRight}>Net</th>
              </tr>
            </thead>
            <tbody>
              {data.spend.byMonth.map((point) => (
                <tr key={point.key}>
                  <td style={td}>{point.label}</td>
                  <td style={tdRight}>{money(point.billed)}</td>
                  <td style={tdRight}>{money(point.credited)}</td>
                  <td style={tdRight}>{money(point.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 style={{ fontSize: 'var(--text-base)', margin: '0 0 0.5rem' }}>By category</h3>
        <p style={{ ...muted, marginTop: 0 }}>
          {data.hasBooks
            ? 'Off the invoice lines, so carriage - which hangs off the invoice rather than a line - is not in here. That is why this can come to less than the supplier table above.'
            : 'Categories come from the bookkeeping module, which is not installed here, so these are only whatever was typed on the lines. Everything else on this page works perfectly well without it.'}
        </p>
        {data.spend.byCategory.length === 0 ? (
          <Empty>Nothing categorised in that window.</Empty>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Category</th>
                  <th style={thRight}>Lines</th>
                  <th style={thRight}>Net</th>
                </tr>
              </thead>
              <tbody>
                {data.spend.byCategory.map((row) => (
                  <tr key={row.categoryId ?? 'none'}>
                    <td style={td}>
                      {row.categoryName ?? (row.categoryId ? <span style={muted}>{row.categoryId}</span> : 'Not categorised')}
                    </td>
                    <td style={tdRight}>{row.lineCount}</td>
                    <td style={tdRight}>{money(row.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ------------------------------------------------------------------ */}
      <Section
        title="Take it away with you"
        note={`Four spreadsheets, over the dates above. Amounts are plain numbers with the currency in a column of its own, so they add up wherever you open them. A file stops at ${EXPORT_ROW_CAP.toLocaleString('en-GB')} rows.`}
      >
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {EXPORTS.map((item) => (
            <a
              key={item.kind}
              className="btn btn-secondary btn-sm"
              href={`/api/m/purchase-orders/admin/reports/export?kind=${item.kind}&${exportQuery}`}
            >
              {item.label}
            </a>
          ))}
        </div>
      </Section>
    </div>
  )
}

function Figure({ label, value, currency, strong }: { label: string; value: string; currency: string; strong?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: strong ? 700 : 600 }}>
        <Money value={value} currency={currency} />
      </div>
      <div style={muted}>{label}</div>
    </div>
  )
}

function AccrualTable({
  rows,
  adminPath,
  currency,
  empty,
}: {
  rows: { orderId: string; orderNumber: string; supplierName: string; description: string; qty: string; value: string }[]
  adminPath: string
  currency: string
  empty: string
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Order</th>
            <th style={th}>Supplier</th>
            <th style={th}>Item</th>
            <th style={thRight}>Quantity</th>
            <th style={thRight}>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.orderId}-${index}`}>
              <td style={td}>
                <a href={`/${adminPath}/m/purchase-orders/orders/${row.orderId}`}>{row.orderNumber}</a>
              </td>
              <td style={td}>{row.supplierName}</td>
              <td style={td}>{row.description}</td>
              <td style={tdRight}>{Number(row.qty).toLocaleString('en-GB', { maximumFractionDigits: 3 })}</td>
              <td style={tdRight}><Money value={row.value} currency={currency} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
