'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import {
  availableTransitions, canSend, closeBlockedReason, editMode, TRANSITION_ACTIONS,
} from '@/modules/purchase-orders/lib/lifecycle'
import type { PoTransition } from '@/modules/purchase-orders/lib/lifecycle'
import { fullyInvoiced } from '@/modules/purchase-orders/lib/billing'
import { nextPaperworkStep, PAPERWORK_STEP_LABELS } from '@/modules/purchase-orders/lib/next-step'
import type { PoPaperworkStep } from '@/modules/purchase-orders/lib/next-step'
import type { PoAccess } from '@/modules/purchase-orders/lib/permissions'
import { isReceivable } from '@/modules/purchase-orders/lib/receiving'
import { orderStanding } from '@/modules/purchase-orders/lib/standing'
import { orderTotals } from '@/modules/purchase-orders/lib/totals'
import type {
  PoAuditEntry,
  PoBillSummary,
  PoOrder,
  PoReceiptSummary,
  PoDespatchableLine,
  PoReturnSummary,
  PoRevisionSummary,
  PoShipment,
  PoStatus,
  PoSupplier,
} from '@/modules/purchase-orders/lib/types'
import { canRecordDespatch, DESPATCHES_CARD_ID } from './order/DespatchesCard'
import { emptyForm, formBody, formFromOrder, type Form, type FormDefaults } from './order/form'
import { OrderActionBar, type BarAction, type BarNote } from './order/OrderActionBar'
import { OrderEditForm } from './order/OrderEditForm'
import { OrderView } from './order/OrderView'
import { NO_DOCUMENTS, type PortalState, type SupplierDocuments } from './order/shared'
import { StepModal } from './order/StepModals'
import { SUPPLIER_LINK_CARD_ID } from './order/SupplierLinkCard'
import { formatWhen, Money, OrderStatusBadge } from './ui'

// The order screen: one order, read or edited.
//
// This file owns the state and every request, and decides what can be DONE to
// the order - which it hands to the bar at the top as one list. What the order
// looks like lives under ./order: the form, the read-only view, and a card each
// for the three things with paperwork of their own.

export type { FormDefaults } from './order/form'

type Props = {
  orderId: string | null
  access: PoAccess
  defaults: FormDefaults
  hasCatalogue: boolean
}

/** Brings a card up under the bar. After the next paint, because the card may
 *  only just have been told to open and has no height to scroll to yet. */
function scrollToCard(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

export function OrderScreen({ orderId, access, defaults, hasCatalogue }: Props) {
  const router = useRouter()
  const adminPath = useAdminPath()
  const base = `/${adminPath}/m/purchase-orders/orders`

  const isNew = orderId === null
  const [order, setOrder] = useState<PoOrder | null>(null)
  const [history, setHistory] = useState<PoAuditEntry[]>([])
  const [revisions, setRevisions] = useState<PoRevisionSummary[]>([])
  const [receipts, setReceipts] = useState<PoReceiptSummary[]>([])
  const [returns, setReturns] = useState<PoReturnSummary[]>([])
  const [bills, setBills] = useState<PoBillSummary[]>([])
  // What the supplier says they have SENT, drop by drop. Its own request for the
  // same reason deliveries and invoices are: most orders arrive in one go and
  // never have a despatch filed against them at all.
  const [shipments, setShipments] = useState<PoShipment[]>([])
  // What is still left to send, worked out by the server off the same function
  // the save is clamped against - rather than by this screen doing the same
  // arithmetic and getting a different answer on a stale page.
  const [despatchable, setDespatchable] = useState<PoDespatchableLine[]>([])
  const [documents, setDocuments] = useState<SupplierDocuments>(NO_DOCUMENTS)
  // The supplier's link, and what they have said through it. Its own request
  // again: most orders never have a link at all, and the join would be earning
  // its keep on a minority of order screens.
  const [portal, setPortal] = useState<PortalState | null>(null)
  // Handed back once, when it is made. There is no way to ask for it again -
  // only the hash is stored - so it stays on screen until the page is left.
  const [newLink, setNewLink] = useState<string | null>(null)
  // Why this order is changing. Only asked for on an amendment - an order the
  // supplier is already holding - and required there, because "what changed" is
  // the first thing they will ask.
  const [amendReason, setAmendReason] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [suppliers, setSuppliers] = useState<PoSupplier[]>([])
  const [form, setForm] = useState<Form>(() => emptyForm(defaults))
  const [editing, setEditing] = useState(isNew)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [loaded, setLoaded] = useState(isNew)
  // Whether the despatch form is showing. Held here rather than on its card
  // because the button that opens it is in the bar with every other action.
  const [despatchOpen, setDespatchOpen] = useState(false)
  // Which piece of paperwork has its window open, if any. The windows do their
  // own requests - see StepModals - and hand back a sentence to say.
  const [openStep, setOpenStep] = useState<PoPaperworkStep | null>(null)

  // Written as a promise chain rather than an async body called from the effect:
  // every setState lands in a callback, which is what keeps the load out of the
  // synchronous render pass.
  const loadOrder = useCallback(
    () =>
      Promise.all([
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}`).then((r) => (r.ok ? r.json() : null)),
        // Deliveries come back on their own request rather than on the order's,
        // because the order screen is drawn far more often than a delivery is
        // booked in and the join is only earning its keep on one of those.
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}/receipts`)
          .then((r) => (r.ok ? r.json() : { receipts: [] }))
          .catch(() => ({ receipts: [] })),
        // Returns come back on their own request too, and for the same reason:
        // most orders never have one, and joining for it on every order screen
        // would be a join earning its keep on a small minority of them.
        fetch(`/api/m/purchase-orders/admin/returns?orderId=${encodeURIComponent(orderId ?? '')}`)
          .then((r) => (r.ok ? r.json() : { returns: [] }))
          .catch(() => ({ returns: [] })),
        // And the invoices, for the same reason again.
        fetch(`/api/m/purchase-orders/admin/bills?orderId=${encodeURIComponent(orderId ?? '')}`)
          .then((r) => (r.ok ? r.json() : { bills: [] }))
          .catch(() => ({ bills: [] })),
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        // And the despatches, for the same reason again.
        fetch(`/api/m/purchase-orders/admin/orders/${orderId}/shipments`)
          .then((r) => (r.ok ? r.json() : { shipments: [], outstanding: [] }))
          .catch(() => ({ shipments: [], outstanding: [] })),
      ])
        .then(([data, deliveries, sentBack, invoices, supplierLink, despatches]) => {
          if (data?.order) {
            setOrder(data.order)
            setHistory(data.history ?? [])
            setRevisions(data.revisions ?? [])
            setDocuments(data.documents ?? NO_DOCUMENTS)
            setForm(formFromOrder(data.order))
          }
          setReceipts(deliveries?.receipts ?? [])
          setReturns(sentBack?.returns ?? [])
          setBills(invoices?.bills ?? [])
          setPortal(supplierLink ?? null)
          setShipments(despatches?.shipments ?? [])
          setDespatchable(despatches?.outstanding ?? [])
          setLoaded(true)
        })
        .catch(() => setLoaded(true)),
    [orderId],
  )

  useEffect(() => {
    if (!orderId) return
    void loadOrder()
  }, [orderId, loadOrder])

  useEffect(() => {
    fetch('/api/m/purchase-orders/admin/suppliers')
      .then((r) => (r.ok ? r.json() : { suppliers: [] }))
      .then((d) => setSuppliers(d.suppliers ?? []))
      .catch(() => setSuppliers([]))
  }, [])

  // The same arithmetic the server will do on save, run here only so the person
  // typing watches the numbers move. Nothing on the wire depends on it.
  const totals = useMemo(
    () =>
      orderTotals({
        lines: form.lines.map((l) => ({
          qty: l.qty || '0',
          unitCost: l.unitCost || '0',
          discountPercent: l.discountPercent || '0',
          taxRatePercent: l.taxRatePercent || '0',
        })),
        taxMode: form.taxMode,
        discountAmount: form.discountAmount || '0',
        carriageAmount: form.carriageAmount || '0',
        surchargeAmount: form.surchargeAmount || '0',
      }),
    [form],
  )

  async function save() {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const url = isNew ? '/api/m/purchase-orders/admin/orders' : `/api/m/purchase-orders/admin/orders/${orderId}`
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formBody(form, amendReason)),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not save that order.')
        return
      }
      if (isNew) {
        const data = await res.json()
        router.push(`${base}/${data.id}`)
        return
      }
      setEditing(false)
      setAmendReason('')
      await loadOrder()
    } finally {
      setSaving(false)
    }
  }

  async function runTransition(transition: PoTransition) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition, note: note.trim() || undefined }),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not do that.')
      return
    }
    setNote('')
    await loadOrder()
  }

  async function sendOrder() {
    if (sending) return
    setSending(true)
    setError(null)
    setSent(null)
    try {
      const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Could not send that order.')
        return
      }
      setNote('')
      setSent(`Sent to ${data.to}${data.cc?.length ? ` (copied to ${data.cc.join(', ')})` : ''}.`)
      await loadOrder()
    } finally {
      setSending(false)
    }
  }

  // Cancelling the balance of one line, which is NOT an edit: an amendment
  // rewrites every line wholesale and refuses to touch one that has a delivery
  // against it, which is exactly the line somebody wants to give up on.
  async function cancelLine(lineId: string) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/lines/${lineId}`, { method: 'POST' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not cancel that line.')
      return
    }
    await loadOrder()
  }

  async function loadPortal() {
    const data = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    setPortal(data ?? null)
  }

  async function makePortalLink() {
    setError(null)
    setNewLink(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'Could not make a link for that one.')
      return
    }
    setNewLink(data.url ?? null)
    await loadPortal()
    // The link is shown once and never again, and the button that made it is at
    // the top of the screen while the card that shows it is near the bottom.
    scrollToCard(SUPPLIER_LINK_CARD_ID)
  }

  async function revokePortalLink(tokenId: string) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal/${tokenId}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not stop that link.')
      return
    }
    await loadPortal()
  }

  async function revokeAllPortalLinks() {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not stop those links.')
      return
    }
    setNewLink(null)
    await loadPortal()
  }

  // Taking the supplier up on a date they offered. The whole order reloads
  // afterwards rather than the date being patched in here, because the date is
  // now on the order and the order is what the screen draws.
  async function applyPortalDate(eventId: string) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/portal/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId }),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not use that date.')
      return
    }
    await loadOrder()
  }

  // The proforma. Marking it paid is what releases the supplier's own confirm
  // button, so it is a decision somebody makes rather than something inferred
  // from a bank feed nobody has connected.
  async function payProforma(paymentRef: string, sendProof: boolean) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/proforma`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentRef: paymentRef.trim() || undefined, sendProof }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'Could not mark that as paid.')
      return
    }
    // The payment is in either way. If the supplier could not be told, say so
    // here rather than leaving somebody to find out when they ring up asking -
    // and the same for a proof that was asked for and did not travel.
    if (data.emailProblem || data.proofProblem) setError(data.emailProblem ?? data.proofProblem)
    await loadOrder()
  }

  /**
   * Filing a document that arrived some other way - by email, or in the post.
   *
   * Multipart rather than JSON because a PDF cannot ride on JSON. Where the
   * reference box is empty the server reads the file for their own number; it
   * comes back on the reloaded order, and is said out loud rather than quietly
   * appearing, because a number nobody typed is worth a glance.
   */
  async function fileDocument(kind: 'proforma' | 'acknowledgement' | 'payment-proof', chosen: File) {
    setError(null)
    const body = new FormData()
    body.set('kind', kind)
    body.set('file', chosen)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/documents`, { method: 'POST', body })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'That file was not saved.')
      return false
    }
    if (data.readOffTheFile) {
      setSent(`Filed. We read ${data.readOffTheFile} off the file as their number - change it if that is not right.`)
    }
    await loadOrder()
    return true
  }

  /** Their own numbers, typed in or corrected. An empty box clears one. */
  async function saveSupplierRefs(body: Record<string, string>) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/documents`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not save that.')
      return false
    }
    await loadOrder()
    return true
  }

  async function unpayProforma() {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/proforma`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not take that back.')
      return
    }
    await loadOrder()
  }

  async function setProformaTerms(required: boolean) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/proforma`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required }),
    })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not change that.')
      return
    }
    await loadOrder()
  }

  /** Reloads the despatch card on its own. The order itself has not changed - a
   *  despatch moves no stock and no status - so pulling the whole order back
   *  would be a round trip to redraw a table that is already right. */
  async function loadShipments() {
    const data = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/shipments`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    setShipments(data?.shipments ?? [])
    setDespatchable(data?.outstanding ?? [])
  }

  /** Writing down what the supplier has just emailed to say has left them.
   *  Returns what the server made of it, so the card can say "recorded
   *  DSP-00007" and own up to anything it had to trim. */
  async function recordDespatch(body: Record<string, unknown>): Promise<{ number: string; trimmed: number } | null> {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}/shipments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(data.error ?? 'Could not record that despatch.')
      return null
    }
    setShipments(data.shipments ?? [])
    setDespatchable(data.outstanding ?? [])
    return { number: data.number as string, trimmed: Number(data.trimmed ?? 0) }
  }

  async function deleteDespatch(shipmentId: string) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/shipments/${shipmentId}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not remove that despatch.')
      return
    }
    await loadShipments()
  }

  async function deleteOrder() {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/orders/${orderId}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not delete that order.')
      return
    }
    router.push(base)
  }

  const dismiss = () => {
    setError(null)
    setSent(null)
  }

  if (!loaded) return <p>Loading…</p>
  if (!isNew && !order) {
    return (
      <div>
        <OrderActionBar
          backHref={base}
          backLabel="Orders"
          title="Purchase order"
          actions={[]}
          error={null}
          success={null}
          onDismiss={dismiss}
        />
        <div className="alert alert-danger">That purchase order is not here any more.</div>
      </div>
    )
  }

  const status: PoStatus = order?.status ?? 'DRAFT'
  const mode = editMode(status)
  const canEditNow = isNew || (access.canCreate && mode !== 'refused')
  const amending = !isNew && mode === 'amend'
  const transitions = order ? availableTransitions(status, access) : []
  const sendable = !isNew && access.canCreate && canSend(status, order!.approvalRequired).ok
  // Why the Close button will be refused, worked out from the invoices already
  // on the screen rather than from a second request. The route says the same
  // thing back if anybody presses it anyway - a check only the browser does is
  // not a check.
  const closeBlocked = closeBlockedReason(
    status,
    bills.filter((b) => b.status === 'DRAFT' || b.status === 'QUERIED').length,
  )

  /** Save and Cancel, and nothing else: an order half-edited is not one to be
   *  emailing, closing or booking goods in against. */
  function editActions(): BarAction[] {
    const blocked = !form.supplierId
      ? 'Pick a supplier first.'
      : amending && !amendReason.trim()
        ? 'Say what has changed first. It is the first thing the supplier will ask.'
        : undefined
    return [
      {
        key: 'cancel-edit',
        label: isNew ? 'Discard' : 'Cancel',
        placement: 'secondary',
        disabled: saving,
        onClick: () => {
          if (isNew) {
            router.push(base)
            return
          }
          setForm(formFromOrder(order!))
          setAmendReason('')
          setError(null)
          setEditing(false)
        },
      },
      {
        key: 'save',
        label: saving ? 'Saving…' : isNew ? 'Create order' : amending ? 'Save as a new revision' : 'Save changes',
        placement: 'primary',
        disabled: saving || blocked !== undefined,
        title: blocked,
        onClick: () => void save(),
      },
    ]
  }

  /**
   * Everything that can be done to this order as it stands, in one list.
   *
   * At most one `primary`: the thing an order in this state is waiting for. An
   * order that has never gone out is waiting to be emailed; one that has is NOT
   * waiting to be emailed again, so that drops to an ordinary button the moment
   * a sent date is on it - a solid "send" on an order sent ten minutes ago is how
   * a supplier gets the same order twice.
   */
  function viewActions(o: PoOrder): BarAction[] {
    const list: BarAction[] = []
    const has = (t: PoTransition) => transitions.includes(t)
    // A supplier who drop-ships sends the goods to the customer: nothing is ever
    // booked in here, and nobody here is told when a pallet leaves them.
    const receivable = access.canReceive && isReceivable(status) && !o.supplierDropships
    let primary: PoTransition | 'email' | 'receive' | 'paperwork' | null = null

    // The next piece of paperwork, where whoever is looking may file it. Their
    // documents are buying; saying money has moved, and entering an invoice,
    // are paying.
    const expected = nextPaperworkStep({
      status,
      proformaRequired: o.proformaRequired,
      proformaReceived: o.proformaReceived,
      proformaPaid: o.proformaPaid,
      acknowledged: Boolean(o.acknowledgedAt) || Boolean(o.ackMediaId),
      fullyInvoiced: fullyInvoiced(o.lines),
    })
    const mayFile: Record<PoPaperworkStep, boolean> = {
      PROFORMA: access.canCreate,
      PAYMENT: access.canApprove || access.canBills,
      ACKNOWLEDGEMENT: access.canCreate,
      INVOICE: access.canBills,
    }
    const step = expected && mayFile[expected] ? expected : null
    // Goods still on their way come before the invoice for them - except from a
    // drop-shipper, where no goods are ever on their way here.
    const goodsFirst = step === 'INVOICE' && receivable && (status === 'ACKNOWLEDGED' || status === 'PART_RECEIVED')

    if (sendable && !o.sentAt) primary = 'email'
    else if (has('approve')) primary = 'approve'
    else if (has('submit') && o.approvalRequired) primary = 'submit'
    else if (step && !goodsFirst) primary = 'paperwork'
    else if (receivable && (status === 'ACKNOWLEDGED' || status === 'PART_RECEIVED')) primary = 'receive'
    else if (status === 'PENDING_CLOSE' && has('close')) primary = 'close'
    // Nothing left to collect and nothing left to arrive: all that remains is to
    // say so. `expected`, not `step` - somebody who may not enter the invoice is
    // not therefore invited to close an order that still wants one.
    else if (!expected && has('close') && (status === 'RECEIVED' || (o.supplierDropships && isReceivable(status)))) primary = 'close'
    else if (has('resume')) primary = 'resume'

    if (canEditNow) {
      list.push({
        key: 'edit',
        label: amending ? 'Amend' : 'Edit',
        placement: 'secondary',
        title: amending ? 'The supplier already has this order. Your changes are saved as a new revision.' : undefined,
        onClick: () => {
          setEditing(true)
          window.scrollTo({ top: 0 })
        },
      })
    }
    // Plain links rather than fetches: one is a page to look at and the other is
    // a file to save, and the browser does both better than we would. The
    // document link redirects through a route that mints its own short-lived
    // token, so nothing here has to carry one.
    list.push({
      key: 'document',
      label: 'View document',
      placement: 'secondary',
      href: `/api/m/purchase-orders/admin/orders/${o.id}/document`,
      newTab: true,
    })
    if (sendable) {
      list.push({
        key: 'email',
        label: sending ? 'Sending…' : o.sentAt ? 'Email it again' : 'Email it to the supplier',
        placement: primary === 'email' ? 'primary' : 'secondary',
        disabled: sending,
        title: o.sentAt
          ? 'Sends the order as it stands now, as a PDF. Any note you add goes with it.'
          : 'Goes as a PDF attachment. Any note you add goes with it.',
        onClick: () => void sendOrder(),
      })
    }
    if (step) {
      list.push({
        key: 'paperwork',
        label: PAPERWORK_STEP_LABELS[step],
        placement: primary === 'paperwork' ? 'primary' : 'secondary',
        onClick: () => setOpenStep(step),
      })
    }
    if (receivable) {
      list.push({
        key: 'receive',
        label: 'Book goods in',
        placement: primary === 'receive' ? 'primary' : 'secondary',
        href: `/${adminPath}/m/purchase-orders/receiving/${o.id}`,
      })
    }
    // Not until the supplier has confirmed the order. Before that the things to
    // do are the proforma, the payment and their acknowledgement, and a bill
    // button beside them is an invitation to enter the proforma as an invoice.
    // Goods turning up counts as confirmation; and an order that already has a
    // bill against it keeps the button, however it got there.
    const confirmed =
      Boolean(o.acknowledgedAt) ||
      status === 'ACKNOWLEDGED' || status === 'PART_RECEIVED' || status === 'RECEIVED' || status === 'PENDING_CLOSE'
    if (access.canBills && (confirmed || bills.length > 0)) {
      list.push({
        key: 'bill',
        // The window above is the short road for an ordinary invoice. This is
        // the long one, for a bill with things on it the order never had.
        label: step === 'INVOICE' ? 'Enter a bill on the full form' : 'Enter a bill',
        placement: step === 'INVOICE' ? 'menu' : 'secondary',
        href: `/${adminPath}/m/purchase-orders/bills/new?orderId=${o.id}`,
      })
    }

    list.push({
      key: 'pdf',
      label: 'Download PDF',
      placement: 'menu',
      href: `/api/m/purchase-orders/admin/orders/${o.id}/pdf`,
      external: true,
    })
    if (!o.supplierDropships && canRecordDespatch(o, despatchable, access.canReceive || access.canCreate)) {
      list.push({
        key: 'despatch',
        label: 'Record a despatch',
        placement: 'menu',
        title: 'The supplier has told you something has left them.',
        onClick: () => {
          setDespatchOpen(true)
          scrollToCard(DESPATCHES_CARD_ID)
        },
      })
    }
    // Only once something has turned up that has not already gone back. A "send
    // something back" on an order still waiting for its first delivery is an
    // invitation to raise a credit claim the supplier will refuse.
    if (access.canReceive && o.lines.some((l) => Number(l.qtyReceived) - Number(l.qtyReturned) > 0)) {
      list.push({
        key: 'return',
        label: 'Send something back',
        placement: 'menu',
        href: `/${adminPath}/m/purchase-orders/returns/new?orderId=${o.id}`,
      })
    }
    if (access.canCreate && portal?.enabled && o.sentAt) {
      list.push({
        key: 'link',
        label: 'Make a link for the supplier',
        placement: 'menu',
        onClick: () => void makePortalLink(),
      })
    }

    for (const t of transitions) {
      const drastic = t === 'cancel'
      list.push({
        key: `transition-${t}`,
        label: TRANSITION_ACTIONS[t],
        placement: primary === t ? 'primary' : 'menu',
        danger: drastic,
        disabled: t === 'close' && closeBlocked !== null,
        title: t === 'close' && closeBlocked ? closeBlocked : undefined,
        onClick: () => {
          if (drastic && !window.confirm(`Cancel ${o.number}? The supplier is not told - that is still yours to do.`)) return
          void runTransition(t)
        },
      })
    }
    if (access.canCreate && status === 'DRAFT') {
      list.push({
        key: 'delete',
        label: 'Delete this draft',
        placement: 'menu',
        danger: true,
        onClick: () => {
          if (window.confirm(`Delete ${o.number}? A draft that is deleted is gone for good.`)) void deleteOrder()
        },
      })
    }
    return list
  }

  // Asked for on an amendment and nowhere else while editing; offered, not asked
  // for, wherever reading the order leaves something to do that a note rides on.
  const barNote: BarNote | null = editing
    ? amending
      ? {
          label: 'What has changed',
          hint: 'The supplier already has this order. Saving files their copy as a revision and gives you a fresh one to send them.',
          value: amendReason,
          onChange: setAmendReason,
          required: true,
        }
      : null
    : transitions.length > 0 || sendable
      ? {
          label: 'Note',
          hint: 'Optional. It goes in the email if you send the order, and into the history against whatever you do next.',
          value: note,
          onChange: setNote,
        }
      : null

  // Read off the history rather than off a column: the entry written when the
  // order was raised is the one place that says whether a person raised it.
  const created = history.find((h) => h.action === 'order.created')
  const raisedAutomatically = created
    ? created.detail.raisedBy === 'AUTO' || (created.detail.raisedBy === undefined && created.userId === null)
    : false

  return (
    <div>
      <OrderActionBar
        backHref={base}
        backLabel="Orders"
        title={isNew ? 'New purchase order' : editing ? `Editing ${order!.number}` : order!.number}
        titleSuffix={!isNew && order!.revision > 1 ? `Rev ${order!.revision}` : null}
        badge={!isNew && order ? <OrderStatusBadge order={order} /> : null}
        subtitle={
          editing ? (
            <>
              {suppliers.find((s) => s.id === form.supplierId)?.name ?? 'No supplier picked'} ·{' '}
              <Money value={totals.total} currency={form.currency} />
            </>
          ) : (
            <>
              {order!.supplierName} · <Money value={order!.total} currency={order!.currency} />
            </>
          )
        }
        actions={editing ? editActions() : viewActions(order!)}
        note={barNote}
        error={error}
        success={sent}
        onDismiss={dismiss}
      />

      {!editing && order && (
        <StepModal
          step={openStep}
          order={order}
          documents={documents}
          fullFormHref={`/${adminPath}/m/purchase-orders/bills/new?orderId=${order.id}`}
          onClose={() => setOpenStep(null)}
          onDone={(message, problem) => {
            setOpenStep(null)
            setError(problem ? message : null)
            setSent(problem ? null : message)
            void loadOrder()
          }}
        />
      )}

      {editing ? (
        <OrderEditForm form={form} setForm={setForm} suppliers={suppliers} totals={totals} hasCatalogue={hasCatalogue} />
      ) : (
        <OrderView
          order={order!}
          standing={orderStanding(
            {
              status,
              proformaRequired: order!.proformaRequired,
              proformaReceived: order!.proformaReceived,
              proformaPaid: order!.proformaPaid,
              approvalRequired: order!.approvalRequired,
              dropships: order!.supplierDropships,
              sentAt: order!.sentAt,
              sourceKind: order!.sourceKind,
              sourceOrderNumber: typeof order!.sourceRef?.orderNumber === 'string' ? order!.sourceRef.orderNumber : null,
              raisedAutomatically,
              cancelReason: order!.cancelReason,
              closeReason: order!.closeReason,
            },
            formatWhen,
          )}
          history={history}
          revisions={revisions}
          receipts={receipts}
          returns={returns}
          bills={bills}
          returnsBase={`/${adminPath}/m/purchase-orders/returns`}
          billsBase={`/${adminPath}/m/purchase-orders/bills`}
          onCancelLine={access.canCreate && mode === 'amend' ? cancelLine : null}
          portal={portal}
          newLink={newLink}
          onRevokeLink={access.canCreate ? revokePortalLink : null}
          onRevokeAllLinks={access.canCreate ? revokeAllPortalLinks : null}
          onApplyDate={access.canCreate ? applyPortalDate : null}
          shipments={shipments}
          despatchable={despatchable}
          onRecordDespatch={(access.canReceive || access.canCreate) && !order!.supplierDropships ? recordDespatch : null}
          onDeleteDespatch={access.canReceive || access.canCreate ? deleteDespatch : null}
          despatchOpen={despatchOpen}
          onDespatchOpenChange={setDespatchOpen}
          documents={documents}
          onPayProforma={access.canApprove || access.canBills ? payProforma : null}
          onUnpayProforma={access.canApprove || access.canBills ? unpayProforma : null}
          onSetProformaTerms={access.canCreate ? setProformaTerms : null}
          onFileDocument={access.canCreate ? fileDocument : null}
          onFileProof={access.canApprove || access.canBills ? fileDocument : null}
          onSaveSupplierRefs={access.canCreate ? saveSupplierRefs : null}
        />
      )}
    </div>
  )
}
