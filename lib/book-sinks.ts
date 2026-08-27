import { getInstalledManifests } from '@/lib/modules/live-status'
import type { PoBookSinkResult, PoBooksOutcome } from './books-outcome'
import { modulePublicExtensionPointComponents } from '@/lib/modules/extension-points.public'
import type { PoLedgerLine } from './ledger'

// `purchase-orders.bill-approved`, `.bill-voided` and `.bill-credited` - the
// seam a bookkeeping module hangs off.
//
// Purchasing knows nothing about VAT schemes, chart-of-accounts codes, filed
// returns or HMRC, and this file is what keeps it that way. When a bill is
// approved, this module hands a plain, serialisable statement of fact to every
// module registered at the point and records what each one said. A site with no
// such module gathers nothing and does nothing - no query, no branch, no button.
//
// The payload is the contract. It is deliberately flat and self-describing: the
// module on the other end must never have to import a purchase-orders type,
// because it does not depend on this module and its files still have to compile
// on a site where this one is absent. Adding a field is safe; renaming or
// repurposing one is not, and needs a new point name.
//
// Nothing here imports from '@/modules/uk-bookkeeping/...'. That directory does
// not exist at build time on a site without the books.

/** One line of the entry, in the SITE's own currency - the conversion is done
 *  here, because only this module knows the rate the bill was struck at. */
export type PoBookLine = PoLedgerLine

/** The supplier's own invoice, already in the media library. Handed over as a
 *  reference rather than as bytes: it is one file, in one place, under the site
 *  owner's control, and copying it would leave two of them to tidy up. */
export type PoBookDocument = {
  mediaId: string | null
  url: string
  filename: string
  mimeType: string
  sizeBytes: number
  mediaProvider: string | null
  mediaKey: string | null
}

export type PoBookSupplier = {
  name: string
  accountNumber: string | null
  taxRegistrationNumber: string | null
}

/** What this module hands over when somebody approves a supplier's invoice. */
export type PoBillApprovedPayload = {
  /** Always 'purchase-orders'. A recorder may listen at more than one
   *  publisher's point and needs to say where a record came from. */
  source: 'purchase-orders'
  /** This module's own id for the bill. The dedupe key on the other side is
   *  built from it, NOT from the supplier's invoice number: two suppliers
   *  numbering their first invoice "INV-001" is ordinary, and filing the second
   *  one as a duplicate of the first would lose it silently. */
  billId: string
  /** The number on the supplier's document, for the entry's reference. */
  invoiceNumber: string
  orderId: string | null
  orderNumber: string | null
  supplier: PoBookSupplier
  /** yyyy-mm-dd. The invoice date, which is the tax point. */
  taxPointDate: string
  /** yyyy-mm-dd it falls due, or null where the supplier gave no terms. */
  dueDate: string | null
  /** What the supplier billed in, and what the site keeps its books in. */
  currency: string
  baseCurrency: string
  /** Base currency per 1 unit of the supplier's currency, at the invoice date. */
  fxRate: string
  /** The whole bill in the BASE currency, as decimal strings. */
  totals: { net: string; tax: string; gross: string }
  /** One line per line on the invoice, in the base currency, each carrying the
   *  category and VAT treatment somebody chose for it. */
  lines: PoBookLine[]
  description: string
  document?: PoBookDocument
}

/** The matching statement when an approved bill is withdrawn. */
export type PoBillVoidedPayload = {
  source: 'purchase-orders'
  billId: string
  invoiceNumber: string
  orderNumber: string | null
  supplierName: string
  /** ISO timestamp it was withdrawn. */
  voidedAt: string
  reason: string
  /** yyyy-mm-dd the VAT belonged to, as the original said. */
  taxPointDate: string
  description: string
}

/** What this module hands over when a supplier credits goods sent back.
 *
 *  Every figure is a POSITIVE magnitude: what was credited, not a negative
 *  purchase. The recorder negates. */
export type PoBillCreditedPayload = {
  source: 'purchase-orders'
  returnId: string
  /** This module's own returns-note number, unique across the site. */
  returnNumber: string
  orderId: string
  orderNumber: string
  /** The posted bill this credits, where there is exactly one and it is in the
   *  books. Null is ordinary: goods often go back before the invoice arrives,
   *  and a credit against nothing is still a real reduction of expenditure. */
  billId: string | null
  billInvoiceNumber: string | null
  supplier: PoBookSupplier
  /** yyyy-mm-dd. The tax point of the CREDIT - the day the money came back, not
   *  the day of the purchase. */
  taxPointDate: string
  currency: string
  baseCurrency: string
  fxRate: string
  totals: { net: string; tax: string; gross: string }
  lines: PoBookLine[]
  /** Why the goods went back, in the words whoever raised the return typed. */
  reason: string
  description: string
}

/** What a registered module says back. Never throws in the caller's face - see
 *  `dispatch`, which treats a throw as a failed sink, not a failed bill. */
export type PoBookOutcome = { ok: boolean; message: string }

export type PoBookSink<T> = (payload: T) => Promise<PoBookOutcome> | PoBookOutcome

// The stored shape and the reader for it live in lib/books-outcome.ts, which
// touches nothing but an object - this file imports the database, and the two
// admin screens that read an outcome are client components.
export type { PoBookSinkResult, PoBooksOutcome } from './books-outcome'

export const BILL_APPROVED_POINT = 'purchase-orders.bill-approved'
export const BILL_VOIDED_POINT = 'purchase-orders.bill-voided'
export const BILL_CREDITED_POINT = 'purchase-orders.bill-credited'

type ExtensionPointEntry = { point: string; id: string }

/**
 * Everybody listening at one point.
 *
 * Two halves, and both are needed: the generated registry says whose code is in
 * this build, and the installed manifests say who is actually installed. Shop's
 * `gatherSinks` does the same job for its own points - it cannot be imported
 * here, because this module does not depend on the shop.
 */
async function gatherSinks<T>(point: string): Promise<{ id: string; sink: PoBookSink<T> }[]> {
  const fns = modulePublicExtensionPointComponents[point] ?? {}
  if (Object.keys(fns).length === 0) return []

  const modules = await getInstalledManifests()
  const gathered: { id: string; sink: PoBookSink<T> }[] = []
  for (const mod of modules) {
    const manifest = mod.manifest as { extensionPoints?: ExtensionPointEntry[] } | null
    for (const entry of manifest?.extensionPoints ?? []) {
      if (entry.point !== point) continue
      const fn = fns[entry.id] as PoBookSink<T> | undefined
      if (fn) gathered.push({ id: entry.id, sink: fn })
    }
  }
  return gathered
}

/** Whether anything is listening at all, so a screen only offers a "send it to
 *  the books" button where there are books to send it to. */
export async function hasBookSinks(): Promise<boolean> {
  return (await gatherSinks(BILL_APPROVED_POINT)).length > 0
}

/**
 * Hands one payload to every registered sink and reports what each said.
 *
 * A sink that fails NEVER fails the thing that caused it. Somebody has approved
 * an invoice, or withdrawn one, or recorded a credit that has already landed in
 * the bank; a bookkeeping module that is mid-VAT-return, or simply broken, must
 * not roll that back. What it said is recorded against the document, where the
 * owner can see it and press the button again.
 */
async function dispatch<T>(point: string, payload: T): Promise<PoBookSinkResult[]> {
  const sinks = await gatherSinks<T>(point)
  const results: PoBookSinkResult[] = []
  for (const { id, sink } of sinks) {
    const at = new Date().toISOString()
    try {
      const outcome = await sink(payload)
      results.push({ id, ok: Boolean(outcome?.ok), message: String(outcome?.message ?? '').slice(0, 500), at })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[purchase-orders] books sink "${id}" failed at ${point}:`, message)
      results.push({ id, ok: false, message: message.slice(0, 500), at })
    }
  }
  return results
}

export function dispatchBillApproved(payload: PoBillApprovedPayload): Promise<PoBookSinkResult[]> {
  return dispatch(BILL_APPROVED_POINT, payload)
}

export function dispatchBillVoided(payload: PoBillVoidedPayload): Promise<PoBookSinkResult[]> {
  return dispatch(BILL_VOIDED_POINT, payload)
}

export function dispatchBillCredited(payload: PoBillCreditedPayload): Promise<PoBookSinkResult[]> {
  return dispatch(BILL_CREDITED_POINT, payload)
}

/**
 * The several answers as one, for the column and the sentence on the screen.
 *
 * "Everybody agreed" is the only thing that counts as ok. One set of books
 * refusing while another accepts is vanishingly rare and worth being loud about
 * rather than averaging away.
 */
export function summariseResults(results: PoBookSinkResult[]): PoBooksOutcome {
  const at = new Date().toISOString()
  if (results.length === 0) {
    return { ok: false, message: 'There is no bookkeeping module on this site to send it to.', at, results }
  }
  const ok = results.every((result) => result.ok)
  const message = results.map((result) => result.message).filter(Boolean).join(' ') ||
    (ok ? 'Sent to the books.' : 'The books did not say why.')
  return { ok, message, at, results }
}
