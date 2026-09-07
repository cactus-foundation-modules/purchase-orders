import { describe, expect, it } from 'vitest'

import {
  dateFromText,
  dateInText,
  referenceFromFilename,
  referenceFromText,
  totalFromText,
} from '@/modules/purchase-orders/lib/document-reference'

// The two documents these rules were written against are a real supplier's, so
// what is quoted here is their SHAPE - the labels, the order, and the trap. The
// trap is the last test in each block: their acknowledgement carries our own
// purchase order number as well as theirs, under a label of its own.

/** A proforma, drawn the way a PDF draws one: label, then value, line by line. */
const PROFORMA = [
  'Dynamic Office Seating Ltd',
  'Pro Forma Invoice',
  'VAT Number',
  'GB',
  '883592674',
  'Invoice No.',
  '0000008633',
  'Invoice Date',
  '04/09/2026',
  'Customer Order No.',
  'PO-00012',
  'Account No.',
  'DESKWELL',
].join('\n')

const ACKNOWLEDGEMENT = [
  'Dynamic Office Seating Ltd',
  'Order Acknowledgement',
  'Sales No.',
  '0000966554',
  'Invoice/Tax Date',
  '04/09/2026',
  'Cust Order No.',
  'PO-00012',
].join('\n')

describe('referenceFromText', () => {
  it('takes the invoice number off a proforma', () => {
    expect(referenceFromText(PROFORMA, 'proforma', 'PO-00012')).toBe('0000008633')
  })

  it('takes the sales number off an acknowledgement', () => {
    expect(referenceFromText(ACKNOWLEDGEMENT, 'acknowledgement', 'PO-00012')).toBe('0000966554')
  })

  it('reads a value sitting beside its label', () => {
    const laidOut = 'Invoice No.      INV-99213\nInvoice Date     04/09/2026'
    expect(referenceFromText(laidOut, 'proforma')).toBe('INV-99213')
  })

  it('never hands back our own order number off their paperwork', () => {
    const ourNumberOnly = 'Cust Order No.\nPO-00012\nDATE REQUIRED\n04/09/2026'
    expect(referenceFromText(ourNumberOnly, 'acknowledgement', 'PO-00012')).toBeNull()
  })

  it('refuses a date, however confidently it is labelled', () => {
    expect(referenceFromText('Invoice No.\n04/09/2026', 'proforma')).toBeNull()
  })

  it('refuses an amount', () => {
    expect(referenceFromText('Invoice Number\n160.54', 'proforma')).toBeNull()
  })

  it('says nothing where there is no label at all', () => {
    expect(referenceFromText('Thank you for your order.\n133.78', 'proforma')).toBeNull()
  })

  it('does not read a proforma number off an acknowledgement label', () => {
    expect(referenceFromText('Sales No.\n0000966554', 'proforma')).toBeNull()
  })
})

describe('referenceFromFilename', () => {
  it('takes the number off the end of a document name', () => {
    expect(referenceFromFilename('Pro Forma Invoice 0000008633.PDF')).toBe('0000008633')
    expect(referenceFromFilename('Sales Order 0000966554.pdf')).toBe('0000966554')
  })

  it('ignores a copy counter', () => {
    expect(referenceFromFilename('Sales Order 0000966554 (2).pdf')).toBe('0000966554')
  })

  it('ignores a year on its own', () => {
    expect(referenceFromFilename('invoice 2026.pdf')).toBeNull()
  })

  it('has nothing to offer from a scanner', () => {
    expect(referenceFromFilename('scan.pdf')).toBeNull()
    expect(referenceFromFilename('IMG_0042.jpeg')).toBeNull()
  })

  it('will not hand our own order number back to us', () => {
    expect(referenceFromFilename('acknowledgement PO-00012.pdf', 'PO-00012')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The other two things worth reading off an invoice
// ---------------------------------------------------------------------------

describe('dateInText', () => {
  const now = new Date('2026-09-07T00:00:00.000Z')

  it('reads the British order first', () => {
    expect(dateInText('08/09/2026', now)).toBe('2026-09-08')
    expect(dateInText('12.08.2026', now)).toBe('2026-08-12')
    expect(dateInText('12-08-26', now)).toBe('2026-08-12')
  })

  it('reads an ISO date as itself', () => {
    expect(dateInText('2026-08-12', now)).toBe('2026-08-12')
  })

  it('falls back to the American order only when day-first cannot be read', () => {
    // 09/25 cannot be the ninth of the twenty-fifth month.
    expect(dateInText('09/25/2026', now)).toBe('2026-09-25')
  })

  it('reads a written month either way round', () => {
    expect(dateInText('12 August 2026', now)).toBe('2026-08-12')
    expect(dateInText('3rd Sept 2026', now)).toBe('2026-09-03')
    expect(dateInText('August 12, 2026', now)).toBe('2026-08-12')
  })

  it('refuses a date that is not one', () => {
    expect(dateInText('31/02/2026', now)).toBeNull()
    expect(dateInText('12/08/1994', now)).toBeNull()
    expect(dateInText('nothing here', now)).toBeNull()
  })
})

describe('dateFromText', () => {
  const now = new Date('2026-09-07T00:00:00.000Z')

  it('takes the tax point ahead of anything else on the page', () => {
    const text = ['Date 01/01/2026', 'Tax point 12/08/2026'].join('\n')
    expect(dateFromText(text, now)).toBe('2026-08-12')
  })

  it('reads a value on the line below its label', () => {
    expect(dateFromText('Invoice Date\n12/08/2026', now)).toBe('2026-08-12')
  })

  it('will not read a due date as an invoice date', () => {
    expect(dateFromText('Due date 30/09/2026', now)).toBeNull()
    expect(dateFromText('Date due 30/09/2026', now)).toBeNull()
    expect(dateFromText('Delivery date 30/09/2026', now)).toBeNull()
  })

  it('prefers the invoice date to a delivery date further up the page', () => {
    const text = ['Delivery date 01/09/2026', 'Invoice date 12/08/2026'].join('\n')
    expect(dateFromText(text, now)).toBe('2026-08-12')
  })
})

describe('totalFromText', () => {
  it('takes the figure at the end of the label line', () => {
    expect(totalFromText('Total due £1,234.56')).toBe('1234.56')
    expect(totalFromText('Invoice total   987.00')).toBe('987.00')
  })

  it('reads the figure on the line below', () => {
    expect(totalFromText('Amount due\n£450.00')).toBe('450.00')
  })

  it('prefers the total due to the subtotal and the VAT', () => {
    const text = ['Subtotal 1,000.00', 'VAT 200.00', 'Total due 1,200.00'].join('\n')
    expect(totalFromText(text)).toBe('1200.00')
  })

  it('will not read a net or a VAT line as the total', () => {
    expect(totalFromText('Sub-total 1,000.00')).toBeNull()
    expect(totalFromText('Total VAT 200.00')).toBeNull()
    expect(totalFromText('Total excluding VAT 1,000.00')).toBeNull()
  })

  it('ignores a figure with no pence on it', () => {
    expect(totalFromText('Total due 1200')).toBeNull()
  })

  it('says nothing where there is nothing to say', () => {
    expect(totalFromText('Thank you for your business')).toBeNull()
  })
})
