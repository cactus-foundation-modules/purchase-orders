import { formatMoney } from './money'
import { fromPence, scaled } from './totals'
import { PO_STATUS_LABELS, type PoStatus } from './types'

// The rules for supplier paperwork that arrives by email: whose it is, and
// whether a document read out of it may be filed on a purchase order without a
// person looking first.
//
// PURE. No database, no network, no files - lib/inbound-run.ts does the
// fetching and the writing and asks this file every question that has an
// answer worth pinning with a test. Client-safe too: the supplier form checks
// a typed-in sender here as it is typed, and the server checks it again.
//
// The one principle every rule below follows: a document is filed only when
// the answer is certain. Our exact purchase order number, from the supplier
// that order went to, at a point in the order's life when that paperwork makes
// sense. Anything short of that is left on the Paperwork list with a sentence
// saying why, and a person decides. A proforma filed on the wrong order is an
// afternoon of confusion; an invoice filed on the wrong order is a payment to
// the wrong supplier.

// ---------------------------------------------------------------------------
// Is this our post?
// ---------------------------------------------------------------------------

/**
 * Domains any member of the public can have an address at. A supplier who
 * writes from one is matched on that exact address, never on the domain -
 * otherwise one supplier's gmail account would make every gmail user in the
 * country a supplier.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'outlook.co.uk', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aol.co.uk', 'aim.com',
  'protonmail.com', 'protonmail.ch', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.co.uk', 'gmx.net', 'mail.com', 'email.com',
  'btinternet.com', 'btopenworld.com', 'sky.com', 'virginmedia.com', 'ntlworld.com', 'blueyonder.co.uk',
  'talktalk.net', 'tiscali.co.uk', 'plus.com',
  'zoho.com', 'fastmail.com', 'fastmail.fm', 'hey.com', 'tutanota.com', 'tuta.io',
  'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
])

const ADDRESS = /^[^\s@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/

/** The domain of an email address, lower case, or null for something that is
 *  not one. */
export function domainOf(address: string | null | undefined): string | null {
  const match = ADDRESS.exec((address ?? '').trim().toLowerCase())
  return match ? match[1]! : null
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase())
}

/**
 * One extra sender as a supplier record keeps it: a whole address, or a
 * domain. "@supplier.co.uk" is written as the domain. Null for anything that is
 * neither.
 */
export function normaliseSender(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^@/, '')
  if (!value) return null
  if (value.includes('@')) return ADDRESS.test(value) ? value : null
  return DOMAIN.test(value) ? value : null
}

/** Why a typed-in sender cannot be kept, or null when it can. */
export function senderProblem(raw: string): string | null {
  const value = normaliseSender(raw)
  if (!value) return `“${raw.trim()}” is not an email address or a domain.`
  if (!value.includes('@') && isFreeMailDomain(value)) {
    return `${value} is a free email service anybody can use. Put in their whole address instead.`
  }
  return null
}

/** A typed-in list, one per line or comma separated, as the record keeps it:
 *  normalised, without repeats. Unusable entries are dropped here; the form
 *  and the route refuse them first with senderProblem. */
export function parseSenders(text: string): string[] {
  const out: string[] = []
  for (const piece of text.split(/[\s,;]+/)) {
    const value = normaliseSender(piece)
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

/** What a supplier record says about who writes on its behalf. */
export type SenderSupplier = {
  id: string
  email: string | null
  emailCc: string | null
  inboundSenders: readonly string[]
}

function addressesOf(supplier: SenderSupplier): string[] {
  const listed = [supplier.email, ...(supplier.emailCc ?? '').split(/[\s,;]+/)]
  return [
    ...listed.map((value) => (value ?? '').trim().toLowerCase()).filter((value) => ADDRESS.test(value)),
    ...supplier.inboundSenders.filter((value) => value.includes('@')),
  ]
}

function domainsOf(supplier: SenderSupplier): { derived: string[]; listed: string[] } {
  // The ordering address only. A copy-to is often somebody HERE - a buyer who
  // wants a copy of every order - and deriving a domain from it would make
  // every colleague's PDF that supplier's paperwork. A copy-to at the
  // supplier still matches as an exact address; their other staff there are
  // what "Their paperwork also comes from" is for.
  const derived = [supplier.email]
    .map(domainOf)
    .filter((domain): domain is string => domain !== null && !isFreeMailDomain(domain))
  const listed = supplier.inboundSenders.filter((value) => !value.includes('@') && !isFreeMailDomain(value))
  return { derived, listed }
}

/**
 * Which suppliers a sender could be, strongest match first.
 *
 * An exact address on a supplier record (its email, copy-to, or a listed
 * address) wins outright: that is a deliberate statement about one mailbox.
 * Failing that, the sender's domain against each supplier's own domain (worked
 * out from its ordering email only, never a free-mail one) and against any
 * domain listed on the record - a listed domain also covering its subdomains,
 * since that is what somebody typing "supplier.co.uk" means. Several suppliers
 * can come back where two share a domain; the purchase order number on the
 * document decides between them.
 *
 * `recipients` are everybody the email was sent to, To and Cc. When every one
 * of them is at the sender's own domain, the email is internal - a colleague
 * writing to a colleague - and nothing is matched by domain, whatever a
 * supplier record says. When any of them is somewhere else, the sender's
 * domain is theirs, not ours: a supplier who writes To a colleague of their
 * own with us in Cc is still that supplier. (Pass the Cc line where there is
 * one: with To alone, that email looks internal.)
 *
 * An empty list is the answer for nearly all mail, and costs a loop over the
 * supplier list and nothing else.
 */
export function matchSender(
  fromAddress: string,
  suppliers: readonly SenderSupplier[],
  recipients: readonly string[] = [],
): string[] {
  const address = (fromAddress ?? '').trim().toLowerCase()
  const domain = domainOf(address)
  if (!domain) return []

  const exact = suppliers.filter((supplier) => addressesOf(supplier).includes(address)).map((s) => s.id)
  if (exact.length > 0) return exact
  if (isFreeMailDomain(domain)) return []
  const recipientDomains = recipients.map(domainOf).filter((d): d is string => d !== null)
  if (recipientDomains.length > 0 && recipientDomains.every((recipient) => recipient === domain)) return []

  return suppliers
    .filter((supplier) => {
      const { derived, listed } = domainsOf(supplier)
      return derived.includes(domain) || listed.some((own) => domain === own || domain.endsWith(`.${own}`))
    })
    .map((supplier) => supplier.id)
}

/** Whether an attachment is a PDF worth queueing. The inbox stores a file under
 *  the type its bytes proved, so the type is the better witness; the name is
 *  there for a file the inbox could not fetch, which has only a label. */
export function isPdfAttachment(attachment: { mimeType: string; filename: string }): boolean {
  return attachment.mimeType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(attachment.filename.trim())
}

// ---------------------------------------------------------------------------
// May this document be filed, and where?
// ---------------------------------------------------------------------------

/** The three kinds of document that are ever filed. A credit note and an
 *  unknown document never are, by rule. */
export const FILEABLE_KINDS = ['proforma', 'acknowledgement', 'invoice'] as const
export type FileableKind = (typeof FILEABLE_KINDS)[number]

export const KIND_NAMES: Record<FileableKind, string> = {
  proforma: 'proforma',
  acknowledgement: 'acknowledgement',
  invoice: 'invoice',
}

/** What was read off one document in a file. */
export type InboundDocument = {
  kind: string
  supplierRef: string | null
  ourPoNumbers: readonly string[]
  total: string | null
}

/** One of our purchase orders, as far as the rules need to know it. */
export type FilingOrder = {
  id: string
  number: string
  supplierId: string
  supplierName: string
  status: PoStatus
  proformaRequired: boolean
  /** The proforma is marked paid. A new one is never filed over it. */
  proformaPaid: boolean
  total: string
  currency: string
}

export type FilingDecision =
  | { ok: true; kind: FileableKind; order: FilingOrder }
  | { ok: false; reason: string }

/** The order states each kind of paperwork makes sense in. A proforma or an
 *  acknowledgement answers an order that has been SENT; an invoice can follow
 *  it all the way to delivery. Nothing is filed on a draft (they have not been
 *  sent it), a cancelled order, or one somebody has already closed. The
 *  acknowledgement's list is the one the supplier's own link accepts it in. */
export const STATES_FOR: Record<FileableKind, readonly PoStatus[]> = {
  proforma: ['SENT', 'ACKNOWLEDGED', 'ON_HOLD'],
  acknowledgement: ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'ON_HOLD'],
  invoice: ['SENT', 'ACKNOWLEDGED', 'PART_RECEIVED', 'RECEIVED', 'ON_HOLD'],
}

/** Said wherever a proforma arrives for an order whose proforma is paid. */
export function paidProformaReason(orderNumber: string): string {
  return (
    `The proforma on ${orderNumber} has already been paid, so a new one arriving by email has not been filed over it. ` +
    'If they really have sent a revised one, ring them on a number you already hold before doing anything with it.'
  )
}

function wrongStateReason(kind: FileableKind, order: FilingOrder): string {
  const name = KIND_NAMES[kind]
  switch (order.status) {
    case 'DRAFT':
    case 'AWAITING_APPROVAL':
    case 'APPROVED':
      return `${order.number} has not been sent to ${order.supplierName} yet, so no ${name} was expected for it.`
    case 'CANCELLED':
      return `${order.number} is cancelled, so their ${name} has not been filed on it.`
    case 'CLOSED':
      return `${order.number} is closed, so their ${name} has not been filed on it.`
    case 'PENDING_CLOSE':
      return `${order.number} is already fully invoiced and waiting to be closed, so their ${name} has not been filed on it.`
    default:
      return `${order.number} is ${PO_STATUS_LABELS[order.status].toLowerCase()}, which is not when a ${name} is expected, so it has not been filed.`
  }
}

/**
 * Where one document goes, or the sentence saying why it goes nowhere.
 *
 * `candidates` are the suppliers the sender could be (matchSender). `orders`
 * holds every one of our order numbers the document could have quoted, keyed by
 * number - across ALL suppliers, so that an order to somebody else is
 * recognised and refused by name rather than missed.
 *
 * `forcedKind` is a person's choice on the Paperwork list, and replaces what
 * was read: the same rules then apply to it, so choosing by hand cannot file a
 * proforma on a cancelled order any more than the machine can.
 */
export function decideFiling(
  doc: InboundDocument,
  candidates: readonly string[],
  orders: ReadonlyMap<string, FilingOrder>,
  forcedKind: FileableKind | null = null,
): FilingDecision {
  const kind = forcedKind ?? doc.kind
  if (kind === 'credit-note') {
    return { ok: false, reason: 'This is a credit note. Credit notes are always left for a person to file.' }
  }
  if (!(FILEABLE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'Could not tell whether this is a proforma, an acknowledgement or an invoice.' }
  }
  const fileable = kind as FileableKind

  const found = [...new Set(doc.ourPoNumbers)].map((number) => orders.get(number)).filter((o): o is FilingOrder => !!o)
  if (found.length === 0) {
    return { ok: false, reason: 'None of our purchase order numbers could be found on it.' }
  }
  if (found.length > 1) {
    return {
      ok: false,
      reason: `It quotes ${found.length} of our purchase orders (${found.map((o) => o.number).join(', ')}), so which one it belongs to is a person's call.`,
    }
  }
  const order = found[0]!
  if (!candidates.includes(order.supplierId)) {
    return {
      ok: false,
      reason: `It quotes ${order.number}, which is an order to ${order.supplierName}, not to whoever sent this.`,
    }
  }
  if (!STATES_FOR[fileable].includes(order.status)) return { ok: false, reason: wrongStateReason(fileable, order) }
  if (fileable === 'proforma' && order.proformaPaid) {
    // The classic invoice fraud is a "revised" proforma with new bank details,
    // and nothing here can prove an email came from who it says. Once the money
    // has gone, nothing arriving by email replaces what was paid.
    return { ok: false, reason: paidProformaReason(order.number) }
  }
  if (fileable === 'proforma' && !order.proformaRequired) {
    return {
      ok: false,
      reason: `${order.number} is on ${order.supplierName}'s account, so no proforma was expected for it.`,
    }
  }
  if (fileable === 'invoice' && !(doc.supplierRef ?? '').trim()) {
    return { ok: false, reason: 'No invoice number could be read off it, and a bill cannot be filed without one.' }
  }
  return { ok: true, kind: fileable, order }
}

/**
 * Whether their proforma agrees with the order it is for.
 *
 * Absolute values: a document that printed its total in brackets means the
 * same money. A total that could not be read is "not checked", said as such,
 * and is NOT a disagreement - a blank is not evidence of anything.
 *
 * Returns the sentence for the order when there is something to say, null when
 * the two agree within the price tolerance.
 */
export function proformaTotalCheck(
  docTotal: string | null,
  order: { number: string; total: string; currency: string },
  tolerancePercent: number,
): { differs: boolean; sentence: string } | null {
  if (docTotal === null || docTotal.trim() === '' || !Number.isFinite(Number(docTotal))) {
    return {
      differs: false,
      sentence: 'The total on their proforma could not be read, so it has not been checked against the order.',
    }
  }
  const theirs = Math.abs(scaled(docTotal, 2))
  const ours = Math.abs(scaled(order.total, 2))
  const allowed = Math.round((ours * Math.max(0, tolerancePercent)) / 100)
  if (Math.abs(theirs - ours) <= allowed) return null
  return {
    differs: true,
    sentence:
      `Their proforma comes to ${formatMoney(fromPence(theirs), order.currency)} and ${order.number} ` +
      `comes to ${formatMoney(fromPence(ours), order.currency)}.`,
  }
}

/**
 * Whether a proforma arriving now REPLACES one the order already has, and the
 * sentence to put on the order if so. Null only for the first proforma on the
 * order, or for one PROVABLY the same document arriving again: the same
 * reference AND the same amount, both read on both sides.
 *
 * (Or the same reference read on both sides where the order's own proforma
 * was filed by hand with no amount - there is nothing else to compare.)
 *
 * Anything else that replaces a proforma is filed loudly, because a "revised"
 * proforma with new bank details is how invoice fraud is done and an email
 * cannot prove who sent it - and a replacement that cannot be compared (a
 * reference or an amount that could not be read, on either side) is exactly
 * what a careful fraud would look like. A proforma the order already has
 * counts whether it came as a file or as a reference or amount typed in by
 * hand.
 *
 * A second proforma for a DIFFERENT amount is said as such: suppliers do issue
 * a separate proforma for an extra charge, and that is a question for a
 * person, not something to take as a revision.
 */
export function proformaReplacementWarning(
  existing: { mediaId: string | null; ref: string | null; amount: string | null },
  incoming: { ref: string | null; amount: string | null },
  currency: string,
): string | null {
  const norm = (value: string | null) => (value ?? '').trim().toLowerCase()
  const has = (value: string | null) => norm(value) !== ''
  if (!existing.mediaId && !has(existing.ref) && !has(existing.amount)) return null

  const sameRef = has(existing.ref) && has(incoming.ref) && norm(existing.ref) === norm(incoming.ref)
  const bothAmounts = has(existing.amount) && has(incoming.amount)
  const sameAmount = bothAmounts && scaled(existing.amount, 2) === scaled(incoming.amount, 2)
  if (sameRef && sameAmount) return null
  // A proforma filed by hand with no amount given: the same reference read on
  // both sides is the same document. Only the EXISTING side may be missing its
  // amount for this - an incoming one that cannot be read is still flagged.
  if (sameRef && !has(existing.amount)) return null

  const check = 'Check with the supplier, on a number you already hold, and check the bank details on it, before paying.'
  if (bothAmounts && !sameAmount) {
    return (
      `A second proforma arrived by email for ${formatMoney(incoming.amount, currency)} - the one before was for ` +
      `${formatMoney(existing.amount, currency)}. An extra charge, or a revision? It has replaced the first on this order. ${check}`
    )
  }
  return `A revised proforma arrived by email and replaced the one on this order, and it could not be shown to be the same document. ${check}`
}

/**
 * Whether an invoice may be filed as a bill for everything left on the order:
 * only when their stated total is readable AND agrees with what everything
 * left would come to, within the price tolerance. Suppliers issue part
 * invoices and separate invoices for extra charges; billing "everything left"
 * on the strength of one of those would be a bill for the wrong money. Null
 * when it agrees; otherwise the sentence for the Paperwork list.
 */
export function invoiceTotalProblem(
  stated: string | null,
  leftTotal: string,
  order: { number: string; currency: string },
  tolerancePercent: number,
): string | null {
  if (stated === null || stated.trim() === '' || !Number.isFinite(Number(stated))) {
    return `The total on their invoice could not be read, so it cannot be checked against the ${formatMoney(leftTotal, order.currency)} left to invoice on ${order.number}. File it by hand.`
  }
  const theirs = Math.abs(scaled(stated, 2))
  const left = Math.abs(scaled(leftTotal, 2))
  const allowed = Math.round((left * Math.max(0, tolerancePercent)) / 100)
  if (Math.abs(theirs - left) <= allowed) return null
  return (
    `Their invoice says ${formatMoney(fromPence(theirs), order.currency)} but ${formatMoney(fromPence(left), order.currency)} ` +
    `is left to invoice on ${order.number} - a part invoice or an extra charge? File it by hand.`
  )
}

/**
 * A document read as one whole file (a scan, a picture, a PDF whose pages
 * could not be followed) and what was actually read out of it. Where the
 * evidence is only the filename or the subject, it is not filed without a
 * person: an invoice needs a total or its own reference out of the document
 * itself, and a proforma or acknowledgement needs our order number out of the
 * document itself. Null when there is enough.
 */
export function wholeFileProblem(evidence: {
  kind: string
  totalRead: boolean
  refFromText: boolean
  poFromText: boolean
}): string | null {
  if (evidence.kind === 'invoice' && !evidence.totalRead && !evidence.refFromText) {
    return 'Nothing could be read from the invoice itself (a scan or a picture, perhaps), only its filename or subject, so no bill has been written for it.'
  }
  if ((evidence.kind === 'proforma' || evidence.kind === 'acknowledgement') && !evidence.poFromText) {
    return 'Our order number could not be read from the document itself (a scan or a picture, perhaps), only its filename or subject, so it has not been filed.'
  }
  return null
}

/** A document total as a plain positive amount, for the proforma amount and a
 *  bill's stated total, or null. */
export function absoluteAmount(total: string | null): string | null {
  if (total === null || total.trim() === '' || !Number.isFinite(Number(total))) return null
  return fromPence(Math.abs(scaled(total, 2)))
}

/**
 * What the Paperwork list's "what is it?" picker starts on: what was read off
 * the document, and only when that is a kind this person may file. A credit
 * note or an unknown document starts on nothing - one click away from "a draft
 * bill for everything left" is not a default anybody should be handed - and so
 * does an invoice for somebody who may not enter bills.
 */
export function startingKind(kind: string | null, canFileInvoices: boolean): FileableKind | '' {
  if (kind === 'proforma' || kind === 'acknowledgement') return kind
  if (kind === 'invoice' && canFileInvoices) return 'invoice'
  return ''
}

// ---------------------------------------------------------------------------
// What the conversation is told
// ---------------------------------------------------------------------------

export type FiledSummary = { orderNumber: string; kind: FileableKind }

/** The one line left on the message in the inbox. Kept short: the inbox folds
 *  it to one line and cuts it at 200 characters. */
export function inboxNote(filed: readonly FiledSummary[], waiting: number, needsEyes: number): string | undefined {
  const parts: string[] = []
  if (filed.length === 1) {
    parts.push(`Filed on ${filed[0]!.orderNumber} as the ${KIND_NAMES[filed[0]!.kind]}`)
  } else if (filed.length > 1) {
    const byOrder = filed.map((f) => `${f.orderNumber} (${KIND_NAMES[f.kind]})`)
    parts.push(`Filed on ${byOrder.join(', ')}`)
  }
  if (needsEyes > 0) parts.push(`${needsEyes === 1 ? 'one document is' : `${needsEyes} documents are`} on the Paperwork list in Purchasing`)
  // Timeless on purpose: the line stays on the email after the job files it,
  // and "queued" would still be saying so a month later.
  if (waiting > 0 && filed.length === 0 && needsEyes === 0) {
    parts.push('Passed to Purchasing to file (see the order or the Paperwork list)')
  }
  if (parts.length === 0) return undefined
  const line = parts.join('; ')
  return line.length > 200 ? `${line.slice(0, 197)}...` : line
}
