import type { FixtureLine } from '@/modules/purchase-orders/lib/pdf-fixtures.test-support'

// Pages of synthetic supplier paperwork for the inbound filing tests, laid out
// the way lib/supplier-document.test.ts lays out its invoices: two columns, the
// supplier's letterhead above the heading, our order number beside a "Customer
// Order No." label. Every name, number and address is made up.

function page(heading: string, refLabel: string, reference: string, po: string, total: string): FixtureLine[] {
  return [
    'Example Supplies Ltd',
    'Unit 1 Sample Park',
    [
      [40, heading],
      [330, 'Page 1 of 1'],
    ],
    refLabel,
    reference,
    [
      [40, 'Customer Order No.'],
      [300, 'Date'],
    ],
    [
      [40, po],
      [300, '28/09/2026'],
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
      [300, `${heading.includes('Order') ? 'Order' : 'Invoice'} Total`],
      [450, total],
    ],
  ]
}

export function invoicePage(reference: string, po: string, total = '120.00'): FixtureLine[] {
  return page('Invoice', 'Invoice No.', reference, po, total)
}

export function proformaPage(reference: string, po: string, total = '120.00'): FixtureLine[] {
  return page('Pro Forma Invoice', 'Invoice No.', reference, po, total)
}

export function acknowledgementPage(reference: string, po: string, total = '120.00'): FixtureLine[] {
  return page('Sales Order', 'Sales Order No.', reference, po, total)
}

export function creditNotePage(reference: string, po: string, total = '-20.00'): FixtureLine[] {
  return page('Credit Note', 'Credit Note No.', reference, po, total)
}
