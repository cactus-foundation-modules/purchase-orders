import { describe, expect, it } from 'vitest'

import {
  referenceFromFilename,
  referenceFromText,
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
