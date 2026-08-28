import { headers } from 'next/headers'
import { getSessionFromCookie } from '@/lib/auth/session'
import {
  CLOSED_SHOP_ORDER_STATUSES,
  listPosForShopOrder,
  livePos,
  planFromShopOrder,
  readShopOrder,
} from '@/modules/purchase-orders/lib/from-order'
import { formatMoney } from '@/modules/purchase-orders/lib/money'
import { getPoAccess } from '@/modules/purchase-orders/lib/permissions'
import { orderTotals } from '@/modules/purchase-orders/lib/totals'
import { PO_STATUS_LABELS } from '@/modules/purchase-orders/lib/types'
import { RaisePurchaseOrders } from './RaisePurchaseOrders'

// Contributed to shop's `shop.order-detail-panels` point, which hands us
// `orderId`, `orderNumber` and `orderStatus` and wraps nothing - a panel draws
// its own card, and renders NULL rather than an empty one when it has nothing
// to say about the order it is looking at.
//
// The permission check is here as well as on the manifest entry. The host does
// honour that entry, but a component that renders whatever it is handed is one
// refactor away from appearing on a screen it should never reach.
//
// Everything shown is worked out by the same `planFromOrder` the button runs
// through, and totalled by the same `orderTotals` the draft will be written
// with, so what somebody reads here is what they get when they press it.

export async function OrderPurchasePanel({
  orderId,
  orderNumber,
  orderStatus,
}: {
  orderId: string
  orderNumber: string
  orderStatus: string
}) {
  const user = await getSessionFromCookie()
  if (!user) return null
  const access = await getPoAccess(user)
  if (!access.canAccess) return null

  const raised = await listPosForShopOrder(orderId)
  const live = livePos(raised)

  const order = await readShopOrder(orderId)
  const plan = order ? await planFromShopOrder(order) : null

  const stillOpen = !CLOSED_SHOP_ORDER_STATUSES.has(orderStatus)
  const canRaise = access.canCreate && stillOpen && live.length === 0 && (plan?.groups.length ?? 0) > 0

  // Nothing raised, nothing to raise and nothing to explain: say nothing at all.
  if (raised.length === 0 && (plan?.groups.length ?? 0) === 0 && (plan?.skipped.length ?? 0) === 0) return null

  const adminPath = (await headers()).get('x-cactus-admin-path') ?? ''

  return (
    <section className="sox-card">
      <div className="sox-card-head"><h2>Purchasing</h2></div>
      <div className="sox-card-body" style={{ display: 'grid', gap: '1rem' }}>
        {raised.length > 0 && (
          <div style={{ display: 'grid', gap: '0.375rem' }}>
            {raised.map((po) => (
              <div key={po.id} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
                <a href={`/${adminPath}/m/purchase-orders/orders/${po.id}`} style={{ fontWeight: 600 }}>{po.number}</a>
                <span>{po.supplierName}</span>
                <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.8125rem' }}>
                  {PO_STATUS_LABELS[po.status]} · {formatMoney(po.total, po.currency)}
                  {po.raisedAutomatically && ' · drafted automatically when this order was paid'}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* The case automation creates and the button did not: a live purchase
            order against an order that has since been cancelled or refunded.
            Nobody chose to raise this one, so nobody is watching it - and the
            goods may already be on their way, which is why this says so rather
            than doing anything about it. */}
        {!stillOpen && live.length > 0 && (
          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-warning)' }}>
            This order is {orderStatus.toLowerCase()}, but{' '}
            {live.length === 1 ? 'a purchase order for it is' : `${live.length} purchase orders for it are`} still live.
            Check with the supplier before cancelling {live.length === 1 ? 'it' : 'them'} - the goods may already be on
            their way.
          </p>
        )}

        {live.length > 0 ? (
          stillOpen && (
            <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
              Already ordered. Cancel {live.length === 1 ? 'that purchase order' : 'those purchase orders'} first if you
              want to raise {orderNumber} again.
            </p>
          )
        ) : (
          plan && plan.groups.length > 0 && (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              <p style={{ margin: 0, fontSize: '0.8125rem' }}>
                {plan.groups.length === 1
                  ? 'One draft purchase order, delivered straight to the customer:'
                  : `${plan.groups.length} draft purchase orders, delivered straight to the customer:`}
              </p>
              <ul style={{ margin: 0, paddingLeft: '1.125rem', fontSize: '0.8125rem' }}>
                {plan.groups.map((group) => {
                  const totals = orderTotals({
                    taxMode: 'EXCLUSIVE',
                    carriageAmount: group.carriageAmount,
                    lines: group.lines.map((line) => ({
                      qty: String(line.qty),
                      unitCost: line.unitCost,
                      taxRatePercent: group.taxRatePercent,
                    })),
                  })
                  // Where the prices came from. Only ever said when a price
                  // list actually did the pricing - on the sites that have not
                  // switched them on there is nothing to say, and a line saying
                  // "priced off the product" on every order would be noise.
                  const priced = group.lines.filter((line) => line.costSource === 'CATALOGUE')
                  const dropped = group.lines.filter((line) => line.discontinued)
                  return (
                    <li key={group.supplierId}>
                      {group.supplierName} - {group.lines.length}{' '}
                      {group.lines.length === 1 ? 'line' : 'lines'}, {formatMoney(totals.total, group.currency)}
                      {priced.length > 0 && (
                        <span style={{ color: 'var(--color-text-secondary)' }}>
                          {' '}
                          ({priced.length === group.lines.length ? 'all' : priced.length} priced off their own list)
                        </span>
                      )}
                      {dropped.length > 0 && (
                        <div style={{ color: 'var(--color-warning)' }}>
                          {dropped.length === 1
                            ? `${dropped[0]!.supplierSku ?? dropped[0]!.productName} is marked as no longer sold on their list.`
                            : `${dropped.length} of these are marked as no longer sold on their list.`}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
              {canRaise && <RaisePurchaseOrders orderId={orderId} />}
              {!stillOpen && (
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                  This order is {orderStatus.toLowerCase()}, so nothing is being ordered for it.
                </p>
              )}
            </div>
          )
        )}

        {plan && plan.skipped.length > 0 && (
          <div style={{ display: 'grid', gap: '0.25rem' }}>
            <p style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 600 }}>
              {plan.skipped.length === 1 ? 'One line cannot be ordered' : `${plan.skipped.length} lines cannot be ordered`}
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.125rem', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
              {plan.skipped.map((item) => (
                <li key={item.itemId}>{item.productName} - {item.reason}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
