import { matchSender, type SenderSupplier } from '@/modules/purchase-orders/lib/inbound-filing'

/** One proforma filed on an order from a supplier's email, as far as picking
 *  its sender needs to know it. */
export type FiledProforma = {
  filedAs: string
  filedMediaId: string | null
  fromAddress: string
}

/**
 * Who sent the proforma an order is paying, where it came in by email.
 *
 * The person who raises a proforma is rarely the mailbox the order went to:
 * the order goes to sales@, and anya@ at the same firm sends the proforma
 * back. She is the one waiting to hear it has been paid, so the payment note
 * goes to her (see withProformaSender).
 *
 * The proforma the order holds now wins - a revised one replaces the first,
 * and its sender is the one chasing. Failing that, the newest filed (`filed`
 * comes newest first).
 *
 * Only an address that is the supplier's own counts: one on their record, or
 * at their domain. A proforma somebody here forwarded and filed by hand has a
 * colleague as its sender, and telling a colleague the supplier has been paid
 * reaches nobody who releases the order. Null then, and wherever there is no
 * emailed proforma at all - an uploaded one has no sender.
 */
export function proformaSender(
  filed: readonly FiledProforma[],
  proformaMediaId: string | null,
  supplier: SenderSupplier | null,
): string | null {
  if (!supplier) return null
  const proformas = filed.filter((doc) => doc.filedAs === 'proforma')
  const current =
    (proformaMediaId ? proformas.find((doc) => doc.filedMediaId === proformaMediaId) : undefined) ?? proformas[0]
  const address = (current?.fromAddress ?? '').trim().toLowerCase()
  if (!address) return null
  return matchSender(address, [supplier]).includes(supplier.id) ? address : null
}

/**
 * The payment note's recipients with the proforma's sender in place of the
 * ordering address the order went to.
 *
 * Wherever the ordering address appears - To when the note goes to the
 * ordering desk, a copy-to when it goes to accounts - the sender takes its
 * place. Where it appears nowhere the sender is copied in anyway: the person
 * who asked for the money is the one who has to hear it has gone. No address
 * twice, and nothing changed where there is no sender to put in.
 */
export function withProformaSender<R extends { to: string; cc: string[] }>(
  recipients: R,
  orderingEmail: string | null,
  sender: string | null,
): R {
  if (!sender) return recipients
  const key = (address: string) => address.trim().toLowerCase()
  const ordering = key(orderingEmail ?? '')
  const swap = (address: string) => (ordering && key(address) === ordering ? sender : address)

  const to = swap(recipients.to)
  const seen = new Set([key(to)])
  const cc: string[] = []
  for (const address of [...recipients.cc.map(swap), sender]) {
    if (seen.has(key(address))) continue
    seen.add(key(address))
    cc.push(address)
  }
  return { ...recipients, to, cc }
}
