import { describe, expect, it } from 'vitest'

import {
  dateFromText,
  documentTotal,
  guessDocumentReference,
  guessInvoiceDetails,
  referenceFromText,
  segmentByReference,
  totalFromText,
} from '@/modules/purchase-orders/lib/document-reference'
import { buildPdf, type FixtureLine } from '@/modules/purchase-orders/lib/pdf-fixtures.test-support'
import { pdfPages } from '@/modules/purchase-orders/lib/pdf-text'
import {
  kindFromHeading,
  kindFromMention,
  ourPoNumbersIn,
  readSupplierDocuments,
} from '@/modules/purchase-orders/lib/supplier-document'

// Every document here is made up: an invented supplier, invented numbers, no
// customer at all. The shapes - the headings, the labels, the page-per-invoice
// batches, the two-column date - are those of real supplier paperwork.

const NOW = new Date('2026-09-30T12:00:00.000Z')
const KNOWN = new Set(['PO-00012', 'PO-00013', 'PO-00014', 'PO-00020'])

/** One page of a VAT invoice, laid out in two columns like the real ones. */
function invoicePage(reference: string, po: string, date: string, total: string): FixtureLine[] {
  return [
    'Example Supplies Ltd',
    'Unit 1 Sample Park',
    [
      [40, 'Invoice'],
      [330, 'Page 1 of 1'],
    ],
    'Invoice No.',
    reference,
    [
      [40, 'Customer Order No.'],
      [300, 'Invoice Date'],
    ],
    [
      [40, po],
      [300, date],
    ],
    '1 x Desk, white   100.00',
    [
      [300, 'Total Net Amount'],
      [450, '100.00'],
    ],
    [
      [300, 'Total VAT Amount'],
      [450, '20.00'],
    ],
    [
      [300, 'Invoice Total'],
      [450, total],
    ],
  ]
}

describe('readSupplierDocuments', () => {
  it('reads a daily batch: one invoice to a page, each for a different purchase order', () => {
    const file = buildPdf(
      [
        invoicePage('0000900001', 'PO-00012', '29/09/2026', '120.00'),
        invoicePage('0000900002', 'PO-00013', '29/09/2026', '240.00'),
        invoicePage('0000900003', 'PO-00014', '28/09/2026', '360.50'),
      ],
      { encrypt: true, viaForm: true },
    )
    expect(readSupplierDocuments('Invoices.PDF', file, KNOWN, { now: NOW })).toEqual([
      { kind: 'invoice', pages: [1, 1], wholeFile: false, supplierRef: '0000900001', ourPoNumbers: ['PO-00012'], date: '2026-09-29', total: '120.00' },
      { kind: 'invoice', pages: [2, 2], wholeFile: false, supplierRef: '0000900002', ourPoNumbers: ['PO-00013'], date: '2026-09-29', total: '240.00' },
      { kind: 'invoice', pages: [3, 3], wholeFile: false, supplierRef: '0000900003', ourPoNumbers: ['PO-00014'], date: '2026-09-28', total: '360.50' },
    ])
  })

  it('keeps a continuation page with the invoice before it', () => {
    const file = buildPdf([
      invoicePage('0000900001', 'PO-00012', '29/09/2026', '120.00'),
      ['Continued', '1 x Pedestal, white   80.00'],
      invoicePage('0000900002', 'PO-00013', '29/09/2026', '240.00'),
    ])
    const documents = readSupplierDocuments('Invoices.PDF', file, KNOWN, { now: NOW })
    expect(documents.map((document) => [document.pages, document.supplierRef])).toEqual([
      [[1, 2], '0000900001'],
      [[3, 3], '0000900002'],
    ])
  })

  it('reads one reference across every page as one document', () => {
    const page = invoicePage('0000900001', 'PO-00012', '29/09/2026', '120.00')
    const documents = readSupplierDocuments('Invoices.PDF', buildPdf([page, page]), KNOWN, { now: NOW })
    expect(documents).toHaveLength(1)
    expect(documents[0]!.pages).toEqual([1, 2])
  })

  it('knows a proforma from an invoice, though its heading says both', () => {
    const file = buildPdf([
      [
        'Example Supplies Ltd',
        'Pro Forma Invoice',
        'This is not a VAT invoice',
        'Invoice No.',
        '0000008001',
        'Invoice Date',
        '28/09/2026',
        'Customer Order No.',
        'PO-00020',
        'Invoice Total',
        '379.08',
      ],
    ], { encrypt: true })
    expect(readSupplierDocuments('Pro Forma Invoice 0000008001.PDF', file, KNOWN, { now: NOW })).toEqual([
      { kind: 'proforma', pages: [1, 1], wholeFile: false, supplierRef: '0000008001', ourPoNumbers: ['PO-00020'], date: '2026-09-28', total: '379.08' },
    ])
  })

  it('reads a sales order acknowledgement quoting our number as "Cust Order No."', () => {
    const file = buildPdf([
      [
        'Example Supplies Ltd',
        'Order Acknowledgement',
        'Sales No.',
        '0000970001',
        'Invoice/Tax Date',
        '28/09/2026',
        'Cust Order No.',
        'PO-00020',
        'DATE REQUIRED',
        '06/10/2026',
        'TOTAL GROSS',
        '379.08',
      ],
    ])
    const [document] = readSupplierDocuments('Sales Order 0000970001.PDF', file, KNOWN, { now: NOW })
    expect(document).toMatchObject({ kind: 'acknowledgement', supplierRef: '0000970001', ourPoNumbers: ['PO-00020'] })
  })

  it('reads a credit note, and its own number', () => {
    const file = buildPdf([
      ['Example Supplies Ltd', 'Credit Note', 'Credit Note No.', 'CN-000451', 'Your Order No.', 'PO-00014', 'Date', '30/09/2026', 'Total', '-45.00'],
    ])
    const [document] = readSupplierDocuments('Document.PDF', file, KNOWN, { now: NOW })
    expect(document).toMatchObject({ kind: 'credit-note', supplierRef: 'CN-000451', ourPoNumbers: ['PO-00014'], date: '2026-09-30', total: '-45.00' })
  })

  it('falls back on the filename, then the subject, for a document with no heading', () => {
    const file = buildPdf([['Invoice No.', '0000900009', 'Your ref PO-00012']])
    expect(readSupplierDocuments('Invoices.PDF', file, KNOWN)[0]!.kind).toBe('invoice')
    expect(readSupplierDocuments('scan.pdf', file, KNOWN, { subject: 'Your invoice PO-00012' })[0]!.kind).toBe('invoice')
    expect(readSupplierDocuments('scan.pdf', file, KNOWN)[0]!.kind).toBe('unknown')
  })

  it('never reads one of our numbers back as theirs', () => {
    const file = buildPdf([['Invoice', 'Invoice No.', 'PO-00012', '0000900001']])
    expect(readSupplierDocuments('Invoices.PDF', file, KNOWN)[0]!.supplierRef).toBe('0000900001')
  })

  it('describes a file with no pages worth reading from its name alone', () => {
    expect(readSupplierDocuments('Sales Order 0000970002 PO-00013.jpg', Buffer.from('not a pdf'), KNOWN)).toEqual([
      { kind: 'acknowledgement', pages: [1, 1], wholeFile: true, supplierRef: '0000970002', ourPoNumbers: ['PO-00013'], date: null, total: null },
    ])
  })
})

describe('ourPoNumbersIn', () => {
  it('matches whole tokens only, in any case', () => {
    expect(ourPoNumbersIn('Ref po-00012 and PO-000123', new Set(['PO-00012']))).toEqual(['PO-00012'])
    expect(ourPoNumbersIn('Ref PO-000123', new Set(['PO-00012']))).toEqual([])
    expect(ourPoNumbersIn('XPO-00012', new Set(['PO-00012']))).toEqual([])
  })

  it('puts a number beside its label ahead of one that merely appears', () => {
    const text = ['Replaces PO-00013', 'Customer Order No.', 'PO-00012'].join('\n')
    expect(ourPoNumbersIn(text, new Set(['PO-00013', 'PO-00012']))).toEqual(['PO-00012', 'PO-00013'])
  })
})

describe('kinds', () => {
  it('reads the heading, most specific first', () => {
    expect(kindFromHeading('Example Ltd\nPro Forma Invoice')).toBe('proforma')
    expect(kindFromHeading('Example Ltd\nSales Order')).toBe('acknowledgement')
    expect(kindFromHeading('Example Ltd\nOrder Acknowledgement')).toBe('acknowledgement')
    expect(kindFromHeading('Example Ltd\nCredit Note')).toBe('credit-note')
    expect(kindFromHeading('Example Ltd\nInvoice   Page 1 of 1')).toBe('invoice')
    expect(kindFromHeading('This is not a VAT invoice')).toBe('unknown')
  })

  it('reads a filename or a subject', () => {
    expect(kindFromMention('Pro Forma Invoice 0000008633.PDF')).toBe('proforma')
    expect(kindFromMention('Sales Order 0000966554.PDF')).toBe('acknowledgement')
    expect(kindFromMention('Invoices.PDF')).toBe('invoice')
    expect(kindFromMention('Credit_Note_12.pdf')).toBe('credit-note')
    expect(kindFromMention(null)).toBe('unknown')
  })
})

describe('segmentByReference', () => {
  it('starts a document where the reference changes, and nowhere else', () => {
    expect(segmentByReference(['A', null, 'B', 'b', 'C'])).toEqual([
      [1, 2],
      [3, 4],
      [5, 5],
    ])
    expect(segmentByReference([null, 'A', null])).toEqual([[1, 3]])
    expect(segmentByReference([])).toEqual([])
  })
})

describe('dateFromText, two columns', () => {
  it('reads a date across a wide gap, with somebody else\'s label to its left', () => {
    expect(dateFromText('Customer Order No.   PO-00012   Invoice Date              29/09/2026', NOW)).toBe('2026-09-29')
  })

  it('still refuses a due date in its own column', () => {
    expect(dateFromText('Invoice No. 123   Due Date   29/10/2026', NOW)).toBeNull()
  })

  it('reads the day first', () => {
    expect(dateFromText('Account 55   Invoice Date   01/10/2026', NOW)).toBe('2026-10-01')
  })
})

describe('guessInvoiceDetails on a file of several invoices', () => {
  it('reads the first of them, as the bill screen always has', () => {
    const file = buildPdf(
      [invoicePage('0000900001', 'PO-00012', '29/09/2026', '120.00'), invoicePage('0000900002', 'PO-00013', '27/09/2026', '240.00')],
      { encrypt: true, viaForm: true },
    )
    expect(guessInvoiceDetails('Invoices.PDF', file, null, NOW)).toEqual({ reference: '0000900001', date: '2026-09-29', total: '120.00' })
  })
})

// ---------------------------------------------------------------------------
// Fix round 1: two-column references, credit notes, totals, token boundaries
// ---------------------------------------------------------------------------

describe('references on a two-column line', () => {
  it('reads theirs on the right with ours on the left', () => {
    expect(referenceFromText('Customer Order No.   PO-00028   Invoice No.   INV-5501', 'invoice', 'PO-00028')).toBe('INV-5501')
    expect(referenceFromText('Your Order No.   PO-00028   Invoice No.   INV-5502', 'invoice')).toBe('INV-5502')
    expect(referenceFromText('Cust Order No.   PO-00028   Sales Order No.   0000970001', 'acknowledgement')).toBe('0000970001')
  })

  it('reads the value under its own label when the labels share a line', () => {
    const text = ['Customer Order No.   Invoice No.', 'PO-00028   INV-5503'].join('\n')
    expect(referenceFromText(text, 'invoice')).toBe('INV-5503')
  })

  it('splits a batch drawn that way into its invoices', () => {
    const page = (reference: string, po: string): FixtureLine[] => [
      [
        [40, 'Invoice'],
        [330, 'Page 1 of 1'],
      ],
      [
        [40, 'Customer Order No.'],
        [150, po],
        [300, 'Invoice No.'],
        [420, reference],
      ],
    ]
    const file = buildPdf([page('INV-5501', 'PO-00012'), page('INV-5502', 'PO-00013')], { encrypt: true, viaForm: true })
    expect(readSupplierDocuments('Invoices.PDF', file, KNOWN).map((document) => [document.supplierRef, document.ourPoNumbers])).toEqual([
      ['INV-5501', ['PO-00012']],
      ['INV-5502', ['PO-00013']],
    ])
    expect(guessDocumentReference('invoice', 'Invoices.PDF', file, 'PO-00012')).toBe('INV-5501')
  })
})

describe('credit notes under an invoice letterhead', () => {
  it('are credit notes', () => {
    expect(kindFromHeading('Example Supplies Ltd\nINVOICE\nCREDIT NOTE')).toBe('credit-note')
    expect(kindFromHeading('Example Supplies Ltd\nINVOICE   CREDIT NOTE')).toBe('credit-note')
  })
})

describe('totals', () => {
  it('takes the last page of a long invoice, where the grand total is', () => {
    const file = buildPdf([
      ['Invoice', 'Invoice No.', 'INV-6001', 'Total', '500.00'],
      ['Invoice', 'Invoice No.', 'INV-6001', 'Total', '750.00'],
    ])
    expect(readSupplierDocuments('Invoices.PDF', file, KNOWN)[0]).toMatchObject({ pages: [1, 2], total: '750.00' })
    expect(guessInvoiceDetails('Invoices.PDF', file).total).toBe('750.00')
  })

  it('reads the right figure off a totals line in columns', () => {
    expect(totalFromText('Total Net Amount   100.00   Invoice Total   120.00')).toBe('120.00')
    expect(totalFromText('Invoice Total 120.00   Carriage 5.00')).toBe('120.00')
  })

  it('does not read an items table\'s "Total" column heading as the total', () => {
    const text = ['Qty   Description   Price   Total', '2   Desk   145.00   290.00', 'TOTAL GROSS   379.08'].join('\n')
    expect(totalFromText(text)).toBe('379.08')
  })
})

describe('our numbers carried on by a hyphen or a slash', () => {
  it('are other numbers', () => {
    expect(ourPoNumbersIn('PO-0003-A and PO-0003/2', new Set(['PO-0003']))).toEqual([])
    expect(ourPoNumbersIn('Order PO-0003. Thanks', new Set(['PO-0003']))).toEqual(['PO-0003'])
    expect(ourPoNumbersIn('(PO-0003)', new Set(['PO-0003']))).toEqual(['PO-0003'])
  })
})

describe('a file that cannot be read page by page', () => {
  it('is one whole-file document, with its real page count where known', () => {
    const blank = buildPdf([[], [], []])
    expect(readSupplierDocuments('Invoices.PDF', blank, KNOWN)).toEqual([
      { kind: 'invoice', pages: [1, 3], wholeFile: true, supplierRef: null, ourPoNumbers: [], date: null, total: null },
    ])
  })
})

// ---------------------------------------------------------------------------
// Fix round 2
// ---------------------------------------------------------------------------

describe('a batch with more text than the reader will hold', () => {
  it('is read as one whole file, never cut into documents that swallow each other', () => {
    // 200 invoices of ~5k characters each: past the reader's allowance of text.
    // Reading on regardless left the later pages empty, and empty pages joined
    // the invoice before them - one "document" of 103 invoices.
    const items = Array.from({ length: 60 }, (_, n) => `${n + 1} x Example office item number ${n + 1}, white finish   ${(n + 10).toFixed(2)}`)
    const pages = Array.from({ length: 200 }, (_, n): FixtureLine[] => [
      'Invoice',
      'Invoice No.',
      `INV-${5000 + n}`,
      'Customer Order No.',
      `PO-${String(n).padStart(5, '0')}`,
      ...items,
    ])
    const file = buildPdf(pages, { encrypt: true })
    const known = new Set(pages.map((_, n) => `PO-${String(n).padStart(5, '0')}`))
    expect(pdfPages(file)).toBeNull()
    const documents = readSupplierDocuments('Invoices.PDF', file, known)
    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({ wholeFile: true, kind: 'invoice' })
  })
})

describe('totals as the released reader read them, and in columns', () => {
  it('steps over a currency sign or code standing on its own', () => {
    expect(totalFromText('Invoice Total   £   120.00')).toBe('120.00')
    expect(totalFromText('Total (inc VAT)   GBP   120.00')).toBe('120.00')
    expect(totalFromText('Amount Due   EUR   99.50')).toBe('99.50')
  })

  it('reads the figure under its own heading in a row of headings', () => {
    expect(totalFromText('Invoice Date   Due Date   Amount Due\n29/09/2026   29/10/2026   £1,234.56')).toBe('1234.56')
    expect(totalFromText('Net   VAT   Grand Total\n100.00   20.00   120.00')).toBe('120.00')
    expect(totalFromText('Total Net   Total VAT   Invoice Total\n100.00   20.00   120.00')).toBe('120.00')
    expect(totalFromText('Invoice Total   Paid\n120.00   20.00')).toBe('120.00')
  })

  it('still skips an items table\'s bare "Total" column', () => {
    expect(totalFromText('Qty   Price   Total\n2   145.00   290.00\nTOTAL GROSS   379.08')).toBe('379.08')
  })

  it('reads single-cell totals exactly as before', () => {
    expect(totalFromText('Total due £1,234.56')).toBe('1234.56')
    expect(totalFromText('Invoice total   987.00')).toBe('987.00')
    expect(totalFromText('Amount due\n£450.00')).toBe('450.00')
    expect(totalFromText('Total\n120.00')).toBe('120.00')
    expect(totalFromText('Invoice Total\n£ 1,200.00 GBP')).toBe('1200.00')
    expect(totalFromText('Subtotal 1,000.00\nVAT 200.00\nTotal due 1,200.00')).toBe('1200.00')
  })
})

describe('credit, as a word on an invoice', () => {
  it('is not a credit note', () => {
    expect(kindFromHeading('Example Supplies Ltd\nInvoice\nPayment Terms   Credit')).toBe('invoice')
    expect(kindFromHeading('Example Supplies Ltd\nInvoice\nDebit   Credit')).toBe('invoice')
    expect(kindFromHeading('Example Supplies Ltd\nSales Credit')).toBe('unknown')
    expect(kindFromHeading('Example Supplies Ltd\nInvoice\nCredit Memo')).toBe('credit-note')
  })
})

describe('our numbers carried on by a decimal point', () => {
  it('are other numbers, but a full stop at the end of a sentence is not', () => {
    expect(ourPoNumbersIn('Ref PO-0003.1', new Set(['PO-0003']))).toEqual([])
    expect(ourPoNumbersIn('Your order PO-0003.', new Set(['PO-0003']))).toEqual(['PO-0003'])
    expect(ourPoNumbersIn('Your order PO-0003. Thanks', new Set(['PO-0003']))).toEqual(['PO-0003'])
  })
})

describe('an unreadable file\'s reference', () => {
  it('is read with the labels its own heading calls for', () => {
    // No page tree to follow, so only the whole-file reader sees it. The
    // heading says credit note; the filename says nothing.
    const text = ['Credit Note', 'Credit Note No.', 'CN-000777'].join('\n')
    const content = text.split('\n').map((line, n) => `BT /F1 10 Tf 40 ${780 - 14 * n} Td (${line}) Tj ET`).join('\n')
    const file = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\ntrailer\n<< >>\n%%EOF\n`,
      'latin1',
    )
    expect(readSupplierDocuments('scan.pdf', file, KNOWN)[0]).toMatchObject({ wholeFile: true, kind: 'credit-note', supplierRef: 'CN-000777' })
  })
})

// ---------------------------------------------------------------------------
// Fix round 3
// ---------------------------------------------------------------------------

describe('totals that are not the total', () => {
  it('skips a sub total written as two words', () => {
    expect(totalFromText('Sub Total 100.00\nVAT 20.00\nTotal 120.00')).toBe('120.00')
    expect(totalFromText('SUB TOTAL   100.00\nTOTAL   120.00')).toBe('120.00')
  })

  it('skips what has been paid', () => {
    expect(totalFromText('Total Paid 50.00\nTotal 120.00')).toBe('120.00')
    expect(totalFromText('Total Payments 50.00\nTotal 120.00')).toBe('120.00')
    expect(totalFromText('Total Received 50.00\nTotal 120.00')).toBe('120.00')
    expect(totalFromText('Total Refunded 10.00\nTotal 120.00')).toBe('120.00')
  })

  it('takes the gross off a row of net, VAT and gross', () => {
    expect(totalFromText('Total   1,000.00   200.00   1,200.00')).toBe('1200.00')
    expect(totalFromText('Invoice Total   £   1,000.00   200.00   1,200.00')).toBe('1200.00')
    // A figure then a word is still the figure beside the label.
    expect(totalFromText('Invoice Total 120.00   Carriage 5.00')).toBe('120.00')
    // Ambiguous, and read as it always was: the last figure.
    expect(totalFromText('Total 100.00 20.00')).toBe('20.00')
  })

  it('prefers a specific label anywhere to the bare word on a page of terms', () => {
    const pages = ['Invoice No. INV-1\nInvoice Total 250.00', 'Terms\nOur total liability limited to 1.00 per item']
    expect(documentTotal(pages)).toBe('250.00')
    // The last page still wins label for label.
    expect(documentTotal(['Invoice Total 100.00', 'Invoice Total 250.00'])).toBe('250.00')
  })

  it('reads a negative the same however it is written', () => {
    expect(totalFromText('Total -120.00')).toBe('-120.00')
    expect(totalFromText('Total -£120.00')).toBe('-120.00')
    expect(totalFromText('Total £-120.00')).toBe('-120.00')
    expect(totalFromText('Total (120.00)')).toBe('-120.00')
    expect(totalFromText('Total (£120.00)')).toBe('-120.00')
    expect(totalFromText('Total £120.00')).toBe('120.00')
    // A hyphen joining a word to a figure is not a minus sign.
    expect(totalFromText('Total ref A-120.00')).toBe('120.00')
  })
})
