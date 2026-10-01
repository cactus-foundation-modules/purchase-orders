import { describe, expect, it } from 'vitest'

import { buildPdf } from '@/modules/purchase-orders/lib/pdf-fixtures.test-support'
import { invoicePage } from '@/modules/purchase-orders/lib/inbound-fixtures.test-support'
import {
  absoluteAmount,
  decideFiling,
  inboxNote,
  isPdfAttachment,
  matchSender,
  normaliseSender,
  parseSenders,
  proformaTotalCheck,
  invoiceTotalProblem,
  proformaReplacementWarning,
  senderProblem,
  startingKind,
  wholeFileProblem,
  type FilingOrder,
  type SenderSupplier,
} from '@/modules/purchase-orders/lib/inbound-filing'
import { documentPiece } from '@/modules/purchase-orders/lib/inbound-run'
import { pdfPages } from '@/modules/purchase-orders/lib/pdf-text'

// The rules that decide whether an emailed document is filed without anybody
// looking. Every one of them errs towards "leave it for a person".

const acme: SenderSupplier = { id: 'acme', email: 'orders@acme.example', emailCc: 'buying@acme.example', inboundSenders: [] }
const sole: SenderSupplier = { id: 'sole', email: 'jo.trader@gmail.com', emailCc: null, inboundSenders: [] }
const billing: SenderSupplier = {
  id: 'billing',
  email: 'sales@widgets.example',
  emailCc: null,
  inboundSenders: ['invoices.example', 'ar@books-platform.example'],
}
const SUPPLIERS = [acme, sole, billing]

describe('matchSender', () => {
  it('recognises anybody at the supplier’s own domain', () => {
    expect(matchSender('orders@acme.example', SUPPLIERS)).toEqual(['acme'])
    expect(matchSender('Kim.Jones@ACME.example', SUPPLIERS)).toEqual(['acme'])
  })

  it('never turns a free-mail domain into a supplier', () => {
    expect(matchSender('jo.trader@gmail.com', SUPPLIERS)).toEqual(['sole'])
    expect(matchSender('somebody.else@gmail.com', SUPPLIERS)).toEqual([])
  })

  it('reads the extra senders a supplier lists, subdomains of a listed domain included', () => {
    expect(matchSender('no-reply@invoices.example', SUPPLIERS)).toEqual(['billing'])
    expect(matchSender('bot@eu.invoices.example', SUPPLIERS)).toEqual(['billing'])
    expect(matchSender('ar@books-platform.example', SUPPLIERS)).toEqual(['billing'])
    // The listed ADDRESS is exact: the rest of that platform's customers are
    // not this supplier.
    expect(matchSender('ar2@books-platform.example', SUPPLIERS)).toEqual([])
  })

  it('does not stretch a derived domain to its subdomains or its lookalikes', () => {
    expect(matchSender('x@mail.acme.example', SUPPLIERS)).toEqual([])
    expect(matchSender('x@notacme.example', SUPPLIERS)).toEqual([])
  })

  it('returns every supplier sharing a domain, for the order number to decide', () => {
    const sister: SenderSupplier = { id: 'sister', email: 'trade@acme.example', emailCc: null, inboundSenders: [] }
    expect(matchSender('kim@acme.example', [acme, sister])).toEqual(['acme', 'sister'])
    // An exact address wins outright.
    expect(matchSender('trade@acme.example', [acme, sister])).toEqual(['sister'])
  })

  it('never takes a colleague for a supplier whose copy-to is somebody here', () => {
    const careless: SenderSupplier = { id: 'careless', email: 'sales@careless.example', emailCc: 'buyer@our-shop.example', inboundSenders: [] }
    // The copy-to is not a domain to match on, internal mail or not.
    expect(matchSender('colleague@our-shop.example', [careless], ['accounts@our-shop.example'])).toEqual([])
    expect(matchSender('colleague@our-shop.example', [careless], ['sales@careless.example', 'accounts@our-shop.example'])).toEqual([])
    // The copy-to address itself is still an exact match, and their own
    // domain still matches.
    expect(matchSender('buyer@our-shop.example', [careless], ['accounts@our-shop.example'])).toEqual(['careless'])
    expect(matchSender('kim@careless.example', [careless], ['accounts@our-shop.example'])).toEqual(['careless'])
  })

  it('matches nothing by domain on internal mail, even where a supplier record lists our domain', () => {
    const listsUs: SenderSupplier = { id: 'lists-us', email: 'sales@other.example', emailCc: null, inboundSenders: ['our-shop.example'] }
    expect(matchSender('colleague@our-shop.example', [listsUs], ['accounts@our-shop.example'])).toEqual([])
  })

  it('never counts the sender’s own domain as ours because they put a colleague in the To line', () => {
    expect(matchSender('kim@acme.example', SUPPLIERS, ['buying@our-shop.example', 'jo@acme.example'])).toEqual(['acme'])
  })

  it('reads the Cc line: To their own colleague, Cc us, is still the supplier', () => {
    // To alone looks internal...
    expect(matchSender('kim@acme.example', SUPPLIERS, ['jo@acme.example'])).toEqual([])
    // ...and the Cc line says it is not.
    expect(matchSender('kim@acme.example', SUPPLIERS, ['jo@acme.example', 'buying@our-shop.example'])).toEqual(['acme'])
  })

  it('ignores mail with no address at all', () => {
    expect(matchSender('', SUPPLIERS)).toEqual([])
    expect(matchSender('+447700900000', SUPPLIERS)).toEqual([])
  })
})

describe('the senders a supplier record keeps', () => {
  it('normalises and refuses', () => {
    expect(normaliseSender('@Invoices.Example')).toBe('invoices.example')
    expect(normaliseSender('AR@Books.example ')).toBe('ar@books.example')
    expect(normaliseSender('not a thing')).toBeNull()
    expect(senderProblem('hotmail.co.uk')).toMatch(/free email service/)
    expect(senderProblem('jo@hotmail.co.uk')).toBeNull()
    expect(senderProblem('nonsense')).toMatch(/not an email address or a domain/)
    expect(parseSenders('a.example\n@a.example, b@c.example')).toEqual(['a.example', 'b@c.example'])
  })
})

describe('isPdfAttachment', () => {
  it('goes by the stored type, and by the name where there is no copy', () => {
    expect(isPdfAttachment({ mimeType: 'application/pdf', filename: 'x' })).toBe(true)
    expect(isPdfAttachment({ mimeType: 'application/octet-stream', filename: 'Invoice.PDF' })).toBe(true)
    expect(isPdfAttachment({ mimeType: 'image/png', filename: 'logo.png' })).toBe(false)
  })
})

function order(overrides: Partial<FilingOrder> = {}): FilingOrder {
  return {
    id: 'o12',
    number: 'PO-00012',
    supplierId: 'acme',
    supplierName: 'Acme Supplies',
    status: 'SENT',
    proformaRequired: true,
    proformaPaid: false,
    total: '120.00',
    currency: 'GBP',
    ...overrides,
  }
}

function orders(...list: FilingOrder[]): Map<string, FilingOrder> {
  return new Map(list.map((o) => [o.number, o]))
}

const doc = { kind: 'proforma', supplierRef: 'PF-1', ourPoNumbers: ['PO-00012'], total: '120.00' }

describe('decideFiling', () => {
  it('files a proforma quoting exactly one of the sender’s sent orders', () => {
    const decision = decideFiling(doc, ['acme'], orders(order()))
    expect(decision).toMatchObject({ ok: true, kind: 'proforma', order: { id: 'o12' } })
  })

  it('never files a credit note or an unknown document', () => {
    expect(decideFiling({ ...doc, kind: 'credit-note' }, ['acme'], orders(order()))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/credit note/i),
    })
    expect(decideFiling({ ...doc, kind: 'unknown' }, ['acme'], orders(order()))).toMatchObject({ ok: false })
  })

  it('refuses no order number, and more than one', () => {
    expect(decideFiling({ ...doc, ourPoNumbers: [] }, ['acme'], orders(order()))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/None of our purchase order numbers/),
    })
    const two = decideFiling({ ...doc, ourPoNumbers: ['PO-00012', 'PO-00013'] }, ['acme'], orders(order(), order({ id: 'o13', number: 'PO-00013' })))
    expect(two).toMatchObject({ ok: false, reason: expect.stringMatching(/PO-00012, PO-00013/) })
  })

  it('refuses an order that went to somebody else, by name', () => {
    const theirs = order({ supplierId: 'other', supplierName: 'Other Ltd' })
    expect(decideFiling(doc, ['acme'], orders(theirs))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/an order to Other Ltd/),
    })
  })

  it('routes each kind by the state of the order', () => {
    expect(decideFiling(doc, ['acme'], orders(order({ status: 'DRAFT' })))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/has not been sent/),
    })
    expect(decideFiling(doc, ['acme'], orders(order({ status: 'CANCELLED' })))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cancelled/),
    })
    const invoice = { ...doc, kind: 'invoice', supplierRef: 'INV-1' }
    expect(decideFiling(invoice, ['acme'], orders(order({ status: 'DRAFT' })))).toMatchObject({ ok: false })
    expect(decideFiling(invoice, ['acme'], orders(order({ status: 'RECEIVED' })))).toMatchObject({ ok: true, kind: 'invoice' })
    expect(decideFiling(invoice, ['acme'], orders(order({ status: 'PENDING_CLOSE' })))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/fully invoiced/),
    })
    const ack = { ...doc, kind: 'acknowledgement' }
    expect(decideFiling(ack, ['acme'], orders(order({ status: 'ACKNOWLEDGED' })))).toMatchObject({ ok: true })
    expect(decideFiling(ack, ['acme'], orders(order({ status: 'CLOSED' })))).toMatchObject({ ok: false })
  })

  it('files an acknowledgement on an order whose proforma is not paid', () => {
    // Decided 2026-09-30: they have accepted it, so it is acknowledged.
    expect(decideFiling({ ...doc, kind: 'acknowledgement' }, ['acme'], orders(order({ proformaRequired: true })))).toMatchObject({ ok: true })
  })

  it('never files a proforma over one already paid, by machine or by hand', () => {
    const paid = order({ status: 'ACKNOWLEDGED', proformaPaid: true })
    expect(decideFiling(doc, ['acme'], orders(paid))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already been paid.*ring them/),
    })
    expect(decideFiling(doc, ['acme'], orders(paid), 'proforma')).toMatchObject({ ok: false })
    // Their acknowledgement and their invoice are unaffected.
    expect(decideFiling({ ...doc, kind: 'acknowledgement' }, ['acme'], orders(paid))).toMatchObject({ ok: true })
  })

  it('refuses a proforma on an order that is on their account', () => {
    expect(decideFiling(doc, ['acme'], orders(order({ proformaRequired: false })))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no proforma was expected/),
    })
  })

  it('refuses an invoice with no number to file it under', () => {
    expect(decideFiling({ ...doc, kind: 'invoice', supplierRef: null }, ['acme'], orders(order()))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/No invoice number/),
    })
  })

  it('applies the same rules to a person’s choice of kind', () => {
    expect(decideFiling({ ...doc, kind: 'credit-note' }, ['acme'], orders(order()), 'proforma')).toMatchObject({ ok: true })
    expect(decideFiling(doc, ['acme'], orders(order({ status: 'CANCELLED' })), 'acknowledgement')).toMatchObject({ ok: false })
  })
})

describe('proformaTotalCheck', () => {
  const po = { number: 'PO-00012', total: '100.00', currency: 'GBP' }

  it('agrees within the tolerance, comparing absolute values', () => {
    expect(proformaTotalCheck('101.50', po, 2)).toBeNull()
    expect(proformaTotalCheck('-100.00', po, 0)).toBeNull()
    expect(proformaTotalCheck('(100.00)'.replace(/[()]/g, ''), po, 0)).toBeNull()
  })

  it('flags a difference beyond it, naming both figures', () => {
    const check = proformaTotalCheck('126.00', po, 2)
    expect(check?.differs).toBe(true)
    expect(check?.sentence).toContain('£126.00')
    expect(check?.sentence).toContain('£100.00')
  })

  it('says a missing total was not checked, and does not call it a difference', () => {
    const check = proformaTotalCheck(null, po, 2)
    expect(check?.differs).toBe(false)
    expect(check?.sentence).toMatch(/could not be read/)
  })

  it('keeps amounts positive for the order and the bill', () => {
    expect(absoluteAmount('-45.5')).toBe('45.50')
    expect(absoluteAmount(null)).toBeNull()
  })
})

describe('proformaReplacementWarning', () => {
  const first = { mediaId: 'm1', ref: 'PF-1', amount: '150.00' }

  it('says nothing for the first proforma, or the same document provably arriving again', () => {
    expect(proformaReplacementWarning({ mediaId: null, ref: null, amount: null }, { ref: 'PF-1', amount: '150.00' }, 'GBP')).toBeNull()
    expect(proformaReplacementWarning(first, { ref: 'pf-1', amount: '150' }, 'GBP')).toBeNull()
  })

  it('flags a new reference as a revision, bank details and all', () => {
    expect(proformaReplacementWarning(first, { ref: 'PF-2', amount: '150.00' }, 'GBP')).toMatch(/revised proforma.*bank details/)
  })

  it('flags a different amount as a second proforma: extra charge or revision', () => {
    const warning = proformaReplacementWarning({ mediaId: 'm1', ref: 'PF-1', amount: '170.34' }, { ref: 'PF-2', amount: '46.80' }, 'GBP')
    expect(warning).toMatch(/A second proforma arrived by email for £46\.80 - the one before was for £170\.34\. An extra charge, or a revision\?/)
    expect(warning).toMatch(/bank details/)
  })

  it('flags every replacement that cannot be compared', () => {
    // Nothing read off the new one.
    expect(proformaReplacementWarning(first, { ref: null, amount: null }, 'GBP')).toMatch(/could not be shown to be the same/)
    // Same reference, amount unread on the new one.
    expect(proformaReplacementWarning(first, { ref: 'PF-1', amount: null }, 'GBP')).toMatch(/could not be shown to be the same/)
    // Same amount, reference unread.
    expect(proformaReplacementWarning(first, { ref: null, amount: '150.00' }, 'GBP')).toMatch(/could not be shown to be the same/)
    // The order's own had a file but no reference or amount recorded.
    expect(proformaReplacementWarning({ mediaId: 'm1', ref: null, amount: null }, { ref: 'PF-1', amount: '150.00' }, 'GBP')).not.toBeNull()
  })

  it('takes the same reference as the same document where the order’s own was filed without an amount', () => {
    // A proforma uploaded by hand with no amount typed: nothing else to compare.
    expect(proformaReplacementWarning({ mediaId: 'm1', ref: 'PF-1', amount: null }, { ref: 'pf-1', amount: '150.00' }, 'GBP')).toBeNull()
    // But only the EXISTING side may be missing it.
    expect(proformaReplacementWarning({ mediaId: 'm1', ref: 'PF-1', amount: null }, { ref: 'PF-1', amount: null }, 'GBP')).toBeNull()
    expect(proformaReplacementWarning(first, { ref: 'PF-1', amount: null }, 'GBP')).not.toBeNull()
    // A different reference is still a revision.
    expect(proformaReplacementWarning({ mediaId: 'm1', ref: 'PF-1', amount: null }, { ref: 'PF-2', amount: '150.00' }, 'GBP')).not.toBeNull()
  })

  it('counts a proforma typed in by hand, with no file, as one the order has', () => {
    expect(proformaReplacementWarning({ mediaId: null, ref: 'PF-1', amount: null }, { ref: 'PF-9', amount: '150.00' }, 'GBP')).not.toBeNull()
    expect(proformaReplacementWarning({ mediaId: null, ref: null, amount: '150.00' }, { ref: 'PF-9', amount: '150.00' }, 'GBP')).not.toBeNull()
  })
})

describe('invoiceTotalProblem', () => {
  const po = { number: 'PO-00031', currency: 'GBP' }

  it('files only when their total agrees with what is left, within the tolerance', () => {
    expect(invoiceTotalProblem('170.34', '170.34', po, 2)).toBeNull()
    expect(invoiceTotalProblem('172.00', '170.34', po, 2)).toBeNull()
  })

  it('sends a part invoice or an extra charge to a person, saying so', () => {
    expect(invoiceTotalProblem('46.80', '170.34', po, 2)).toBe(
      'Their invoice says £46.80 but £170.34 is left to invoice on PO-00031 - a part invoice or an extra charge? File it by hand.',
    )
  })

  it('never files an invoice whose total could not be read', () => {
    expect(invoiceTotalProblem(null, '170.34', po, 2)).toMatch(/could not be read.*£170\.34.*PO-00031/)
  })
})

describe('wholeFileProblem', () => {
  it('will not bill from a filename', () => {
    expect(wholeFileProblem({ kind: 'invoice', totalRead: false, refFromText: false, poFromText: true })).toMatch(/no bill/)
    expect(wholeFileProblem({ kind: 'invoice', totalRead: true, refFromText: false, poFromText: true })).toBeNull()
    expect(wholeFileProblem({ kind: 'invoice', totalRead: false, refFromText: true, poFromText: true })).toBeNull()
  })

  it('needs our order number out of the document itself for a proforma or an acknowledgement', () => {
    expect(wholeFileProblem({ kind: 'proforma', totalRead: true, refFromText: true, poFromText: false })).toMatch(/not been filed/)
    expect(wholeFileProblem({ kind: 'acknowledgement', totalRead: false, refFromText: false, poFromText: true })).toBeNull()
  })
})

describe('startingKind', () => {
  it('starts on nothing for a credit note, an unknown document, or an invoice somebody may not enter', () => {
    expect(startingKind('credit-note', true)).toBe('')
    expect(startingKind('unknown', true)).toBe('')
    expect(startingKind(null, true)).toBe('')
    expect(startingKind('invoice', false)).toBe('')
    expect(startingKind('invoice', true)).toBe('invoice')
    expect(startingKind('proforma', false)).toBe('proforma')
  })
})

describe('inboxNote', () => {
  it('says where it went, briefly', () => {
    expect(inboxNote([{ orderNumber: 'PO-00012', kind: 'proforma' }], 0, 0)).toBe('Filed on PO-00012 as the proforma')
    expect(inboxNote([
      { orderNumber: 'PO-00012', kind: 'invoice' },
      { orderNumber: 'PO-00013', kind: 'invoice' },
    ], 0, 1)).toBe('Filed on PO-00012 (invoice), PO-00013 (invoice); one document is on the Paperwork list in Purchasing')
    // Still true once the job has filed it: the line stays on the email.
    expect(inboxNote([], 1, 0)).toBe('Passed to Purchasing to file (see the order or the Paperwork list)')
    expect(inboxNote([], 0, 0)).toBeUndefined()
  })
})

describe('documentPiece', () => {
  const batch = buildPdf([invoicePage('0000900001', 'PO-00012'), invoicePage('0000900002', 'PO-00013')], { encrypt: true })
  const base = { filename: 'Invoices.pdf', pageCount: 2, wholeFile: false }

  it('cuts one invoice out of a batch, and the cut reads back as that invoice', () => {
    const piece = documentPiece({ ...base, pageFrom: 2, pageTo: 2, supplierRef: '0000900002' }, batch, 'invoice')
    expect(piece.note).toBeNull()
    expect(piece.filename).toBe('Invoices (page 2).pdf')
    const pages = pdfPages(piece.bytes)
    expect(pages).toHaveLength(1)
    expect(pages?.[0]).toContain('0000900002')
    expect(pages?.[0]).not.toContain('0000900001')
  })

  it('falls back to the whole file with the page written down when the cut cannot be checked', () => {
    const piece = documentPiece({ ...base, pageFrom: 2, pageTo: 2, supplierRef: 'NOT-ON-THE-PAGE' }, batch, 'invoice')
    expect(piece.bytes).toBe(batch)
    expect(piece.note).toBe('Their invoice is page 2 of 2 in the attached file.')
  })

  it('never cuts a file read as one whole document', () => {
    const piece = documentPiece({ ...base, pageFrom: 1, pageTo: 2, wholeFile: true, supplierRef: null }, batch, 'proforma')
    expect(piece.bytes).toBe(batch)
    expect(piece.note).toBeNull()
  })
})
