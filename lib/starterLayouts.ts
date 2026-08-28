// Starter templates for the purchase order document, collected by
// scripts/generate-module-layout-types.mjs via the manifest's
// layoutTypes.types[].starterImport / starterExport.
//
// One publishes by default, because the document stands where nothing else can
// render: it IS the page an admin opens, the PDF that gets emailed and the sheet
// a supplier files. A site that installed this module and found a blank page
// would reasonably call it broken.
//
// The standard template is ALSO the fallback the renderer falls back to when no
// layout is published at all - see lib/document.tsx. Unlike a quote, a purchase
// order may never refuse to print: it is a commitment to spend money and
// somebody is standing at a goods-in desk holding the other copy.

const block = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } })

// The letterhead: core's own Site Logo block, sitting above the heading. Core's
// rather than this module's so that the purchase order and the invoice draw the
// same logo the same way, and so it can be moved or resized without a field on
// the heading block.
//
// showIcon off: a site that has uploaded no logo should print its own name, not
// the Cactus mark.
const logo = (height: number) => ({
  type: 'SiteLogo',
  props: {
    id: 'po-doc-logo', homeUrl: '/', imageUrl: '', imageUrlDark: '', align: 'left',
    cellHeight: height, showTextWithLogo: 'false', showIcon: 'false', textColor: '',
  },
})

const STANDARD_CONTENT = [
  logo(48),
  block('PoDocHeader', 'po-doc-head', {
    heading: '', fontFamily: '', titleSize: 'medium', sides: 'logo-left', rule: 'hairline',
    factsLayout: 'columns', numberStyle: 'row', showRevision: 'yes',
    orderLabel: 'Order', showDate: 'yes', dateLabel: 'Date',
    showRequired: 'yes', requiredLabel: 'Wanted by',
    showExpected: 'no', expectedLabel: 'Expected',
    showAccount: 'yes', accountLabel: 'Account',
    showTerms: 'no', termsLabel: 'Payment terms', showIntro: 'yes',
  }),
  block('PoDocParties', 'po-doc-parties', {
    fontFamily: '', order: 'to-first', columns: '2',
    showTo: 'yes', toLabel: 'To', showFrom: 'yes', fromLabel: 'From',
    showAccount: 'yes', accountLabel: 'Account',
    showContact: 'yes', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
  }),
  block('PoDocShipTo', 'po-doc-shipto', {
    heading: 'Deliver to', fontFamily: '', look: 'panel',
    showDate: 'yes', dateLabel: 'Wanted by', showInstructions: 'yes', showCountry: 'no',
  }),
  block('PoDocLines', 'po-doc-lines', {
    fontFamily: '', headStyle: 'rule', rowRules: 'every', zebra: 'no', headCase: 'caps',
    descWidth: 'auto', showSupplierSku: 'yes', showOurSku: 'no',
    showLineDates: 'yes', showDiscount: 'yes',
    itemLabel: 'Description', codeLabel: 'Your code', qtyLabel: 'Qty',
    costLabel: 'Unit cost', totalLabel: 'Line total',
  }),
  block('PoDocTotals', 'po-doc-totals', {
    fontFamily: '', emphasis: 'rule', width: 'normal',
    subtotalLabel: 'Goods', discountLabel: 'Discount', carriageLabel: 'Carriage',
    showCarriageRow: 'charged', taxLabel: 'VAT', totalLabel: 'Order total', showCurrency: 'yes',
    note: '',
  }),
  block('PoDocNotes', 'po-doc-notes', { showHeading: 'yes', heading: 'Notes', capsHeading: 'yes', fontFamily: '' }),
  block('PoDocTerms', 'po-doc-terms', {
    heading: 'Terms', fontFamily: '', columns: '1', capsHeading: 'yes',
    showPaymentTerms: 'yes', paymentLabel: 'Payment terms',
    showDeliveryTerms: 'yes', deliveryLabel: 'Delivery terms',
    extraHeading: 'Also', extra: '',
  }),
]

/** What the document renders when nothing at all has been published - which is
 *  every site until somebody publishes one, and any site whose layout has been
 *  deleted. The standard template's own blocks, so a missing layout prints what a
 *  fresh install would have been given. */
export const PO_DOCUMENT_FALLBACK_DATA = {
  content: STANDARD_CONTENT,
  root: { props: {} },
  zones: {},
}

export function purchaseOrderDocumentStarters() {
  return [
    {
      id: 'starter-po-document-standard',
      name: 'Standard purchase order',
      description: 'Heading, both addresses, where it is going, the lines, the money and your terms - in the order a supplier reads.',
      publishByDefault: true,
      data: PO_DOCUMENT_FALLBACK_DATA,
    },
    {
      id: 'starter-po-document-designed',
      name: 'Designed purchase order',
      description: 'The same order, laid out properly: a rule in your own colour under the heading, the delivery address in a panel, a banded line table and the instruction to quote your number where nobody can miss it.',
      data: {
        // Colours are site tokens, not values - `var(--color-primary)` for the
        // accent and `var(--color-bg-subtle)` for the bands. So the template is
        // the SHAPE of a designed order, drawn in whatever colours the site
        // already uses, and somebody who wants their own accent changes one field
        // on the style block rather than five blocks' worth of them.
        content: [
          block('PoDocStyle', 'po-doc-style', {
            accent: 'var(--color-primary)', labelColour: 'var(--color-primary)', titleColour: '',
            tableHeadBg: 'var(--color-bg-subtle)', tableHeadInk: '',
            panelBg: 'var(--color-bg-subtle)', panelInk: '', zebraBg: '',
            ruleWeight: 'thick', corners: 'square', density: 'normal',
            bodyFont: '', headingFont: '',
          }),
          logo(72),
          block('PoDocHeader', 'po-doc-head', {
            heading: '', fontFamily: '', titleSize: 'display', sides: 'logo-left', rule: 'accent',
            factsLayout: 'stacked', numberStyle: 'lead', showRevision: 'yes',
            orderLabel: 'Order', showDate: 'yes', dateLabel: 'Raised',
            showRequired: 'yes', requiredLabel: 'Wanted by',
            showExpected: 'no', showAccount: 'yes', accountLabel: 'Account',
            showTerms: 'yes', termsLabel: 'Payment terms', showIntro: 'yes',
          }),
          block('PoDocParties', 'po-doc-parties', {
            fontFamily: '', order: 'to-first', columns: '2',
            showTo: 'yes', toLabel: 'Supplier', showFrom: 'yes', fromLabel: 'Ordered by',
            showAccount: 'yes', accountLabel: 'Account',
            showContact: 'yes', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
          }),
          block('PoDocShipTo', 'po-doc-shipto', {
            heading: 'Deliver to', fontFamily: '', look: 'panel',
            showDate: 'yes', dateLabel: 'Wanted by', showInstructions: 'yes', showCountry: 'no',
          }),
          block('PoDocNotice', 'po-doc-notice', {
            lead: 'Quote {{ORDER_NUMBER}} on your invoice and delivery note.',
            body: 'Please tell us before you ship short or substitute anything. Invoices that do not carry this order number will be held.',
            panelStyle: 'panel', hideWhenEmpty: 'yes', fontFamily: '',
          }),
          block('PoDocLines', 'po-doc-lines', {
            fontFamily: '', headStyle: 'filled', rowRules: 'every', zebra: 'no', headCase: 'caps',
            descWidth: 'half', showSupplierSku: 'yes', showOurSku: 'yes',
            showLineDates: 'yes', showDiscount: 'yes',
            itemLabel: 'Description', codeLabel: 'Your code', qtyLabel: 'Qty',
            costLabel: 'Unit cost', totalLabel: 'Line total',
          }),
          block('PoDocTotals', 'po-doc-totals', {
            fontFamily: '', emphasis: 'accent', width: 'normal',
            subtotalLabel: 'Goods', discountLabel: 'Discount', carriageLabel: 'Carriage',
            showCarriageRow: 'always', taxLabel: 'VAT', totalLabel: 'Order total', showCurrency: 'yes',
            note: '',
          }),
          block('PoDocNotes', 'po-doc-notes', { showHeading: 'yes', heading: 'Notes', capsHeading: 'yes', fontFamily: '' }),
          block('PoDocTerms', 'po-doc-terms', {
            heading: 'Terms', fontFamily: '', columns: '2', capsHeading: 'yes',
            showPaymentTerms: 'yes', paymentLabel: 'Payment terms',
            showDeliveryTerms: 'yes', deliveryLabel: 'Delivery terms',
            extraHeading: 'Invoicing', extra: 'One invoice per delivery, quoting this order number and your delivery note reference. Send invoices by email; we do not accept them with the goods.',
          }),
          block('PoDocApproval', 'po-doc-approval', {
            fontFamily: '', showRaised: 'yes', raisedLabel: 'Raised by',
            showApproved: 'yes', approvedLabel: 'Authorised by',
            showSignature: 'no', signatureLabel: 'Signature', showDate: 'yes',
          }),
        ],
        root: { props: {} },
        zones: {},
      },
    },
    {
      id: 'starter-po-document-plain',
      name: 'Just the order',
      description: 'Heading, the supplier, where it goes and the lines. For a business that agrees its terms once and would rather not reprint them on every sheet.',
      data: {
        content: [
          logo(48),
          block('PoDocHeader', 'po-doc-head', {
            heading: '', fontFamily: '', titleSize: 'medium', sides: 'logo-left', rule: 'hairline',
            factsLayout: 'columns', numberStyle: 'row', showRevision: 'yes',
            showDate: 'yes', showRequired: 'yes', showExpected: 'no',
            showAccount: 'yes', showTerms: 'no', showIntro: 'no',
          }),
          block('PoDocTo', 'po-doc-to', {
            heading: 'To', fontFamily: '', showAccount: 'yes', accountLabel: 'Account',
            showContact: 'yes', showEmail: 'yes', showPhone: 'no', showRegistration: 'no', align: 'left',
          }),
          block('PoDocShipTo', 'po-doc-shipto', {
            heading: 'Deliver to', fontFamily: '', look: 'plain',
            showDate: 'yes', dateLabel: 'Wanted by', showInstructions: 'yes', showCountry: 'no',
          }),
          block('PoDocLines', 'po-doc-lines', {
            fontFamily: '', headStyle: 'rule', rowRules: 'every', zebra: 'no', headCase: 'caps',
            descWidth: 'auto', showSupplierSku: 'yes', showOurSku: 'no',
            showLineDates: 'no', showDiscount: 'yes',
          }),
          block('PoDocTotals', 'po-doc-totals', {
            fontFamily: '', emphasis: 'rule', width: 'normal',
            showCarriageRow: 'charged', showCurrency: 'yes', note: '',
          }),
        ],
        root: { props: {} },
        zones: {},
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// The returns note
// ---------------------------------------------------------------------------
//
// A second layout type on the same module, collected the same way. Two starters
// rather than three: a returns note is a docket, not a sales document, and the
// difference between "plain" and "standard" on one page of it would be a choice
// nobody wanted to make.
//
// The Document style block and the Divider are the SAME blocks the order uses -
// declared on both layout types in the manifest rather than written twice - so a
// business that has designed its purchasing paperwork once has designed both.

const RETURN_STANDARD_CONTENT = [
  logo(48),
  block('PoRetHeader', 'po-ret-head', {
    heading: '', fontFamily: '', titleSize: 'medium', sides: 'logo-left', rule: 'hairline',
    factsLayout: 'columns', numberStyle: 'row',
    returnLabel: 'Return', showDate: 'yes', dateLabel: 'Date',
    orderLabel: 'Against order', showAccount: 'yes', accountLabel: 'Account', showIntro: 'yes',
  }),
  block('PoRetParties', 'po-ret-parties', {
    fontFamily: '', order: 'to-first', columns: '2',
    showTo: 'yes', toLabel: 'Returned to', showFrom: 'yes', fromLabel: 'Returned by',
    showAccount: 'yes', accountLabel: 'Account',
    showContact: 'yes', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
  }),
  block('PoRetReason', 'po-ret-reason', {
    showHeading: 'yes', heading: 'Why they are going back', capsHeading: 'yes',
    look: 'panel', fontFamily: '',
  }),
  block('PoRetLines', 'po-ret-lines', {
    fontFamily: '', headStyle: 'rule', rowRules: 'every', zebra: 'no', headCase: 'caps',
    descWidth: 'auto', showSupplierSku: 'yes', showReceipt: 'yes',
    itemLabel: 'Description', codeLabel: 'Your code', qtyLabel: 'Going back',
    costLabel: 'Unit cost', totalLabel: 'Credit due',
  }),
  block('PoRetTotals', 'po-ret-totals', {
    fontFamily: '', emphasis: 'rule', width: 'normal',
    subtotalLabel: 'Goods', showTax: 'yes', taxLabel: 'VAT',
    totalLabel: 'Credit due', showCurrency: 'yes', note: '',
  }),
  block('PoRetNotes', 'po-ret-notes', {
    showHeading: 'yes', heading: 'Notes', showTerms: 'yes', termsHeading: 'Terms',
    capsHeading: 'yes', fontFamily: '',
  }),
]

/** What the note renders when nothing at all has been published - which is every
 *  site until somebody publishes one. Same reasoning as the order: a returns
 *  note may never refuse to print, because a courier is standing there. */
export const PO_RETURN_FALLBACK_DATA = {
  content: RETURN_STANDARD_CONTENT,
  root: { props: {} },
  zones: {},
}

export function purchaseReturnDocumentStarters() {
  return [
    {
      id: 'starter-po-return-standard',
      name: 'Standard returns note',
      description: 'Heading, both addresses, why the goods are going back, what is in the box and what you expect to be credited.',
      publishByDefault: true,
      data: PO_RETURN_FALLBACK_DATA,
    },
    {
      id: 'starter-po-return-designed',
      name: 'Designed returns note',
      description: 'The same note with your own accent colour, the reason in a panel where nobody can miss it, a banded line table and the amount you are owed spelled out at the top.',
      data: {
        content: [
          // Colours are site tokens, not values, exactly as the order's designed
          // starter uses them - so this is the SHAPE of a designed note in
          // whatever colours the site already wears.
          block('PoDocStyle', 'po-ret-style', {
            accent: 'var(--color-primary)', labelColour: 'var(--color-primary)', titleColour: '',
            tableHeadBg: 'var(--color-bg-subtle)', tableHeadInk: '',
            panelBg: 'var(--color-bg-subtle)', panelInk: '', zebraBg: '',
            ruleWeight: 'thick', corners: 'square', density: 'normal',
            bodyFont: '', headingFont: '',
          }),
          logo(72),
          block('PoRetHeader', 'po-ret-head', {
            heading: '', fontFamily: '', titleSize: 'display', sides: 'logo-left', rule: 'accent',
            factsLayout: 'stacked', numberStyle: 'lead',
            returnLabel: 'Return', showDate: 'yes', dateLabel: 'Raised',
            orderLabel: 'Against order', showAccount: 'yes', accountLabel: 'Account', showIntro: 'yes',
          }),
          block('PoRetParties', 'po-ret-parties', {
            fontFamily: '', order: 'to-first', columns: '2',
            showTo: 'yes', toLabel: 'Returned to', showFrom: 'yes', fromLabel: 'Returned by',
            showAccount: 'yes', accountLabel: 'Account',
            showContact: 'yes', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
          }),
          block('PoRetNotice', 'po-ret-notice', {
            lead: 'Please credit {{CREDIT_EXPECTED}} against order {{ORDER_NUMBER}}.',
            body: 'Quote {{RETURN_NUMBER}} on your credit note. Anything sent back to us against this return will be refused.',
            panelStyle: 'panel', hideWhenEmpty: 'yes', fontFamily: '',
          }),
          block('PoRetReason', 'po-ret-reason', {
            showHeading: 'yes', heading: 'Why they are going back', capsHeading: 'yes',
            look: 'outline', fontFamily: '',
          }),
          block('PoRetLines', 'po-ret-lines', {
            fontFamily: '', headStyle: 'filled', rowRules: 'every', zebra: 'no', headCase: 'caps',
            descWidth: 'half', showSupplierSku: 'yes', showReceipt: 'yes',
            itemLabel: 'Description', codeLabel: 'Your code', qtyLabel: 'Going back',
            costLabel: 'Unit cost', totalLabel: 'Credit due',
          }),
          block('PoRetTotals', 'po-ret-totals', {
            fontFamily: '', emphasis: 'accent', width: 'normal',
            subtotalLabel: 'Goods', showTax: 'yes', taxLabel: 'VAT',
            totalLabel: 'Credit due', showCurrency: 'yes', note: '',
          }),
          block('PoRetNotes', 'po-ret-notes', {
            showHeading: 'yes', heading: 'Notes', showTerms: 'yes', termsHeading: 'Terms',
            capsHeading: 'yes', fontFamily: '',
          }),
        ],
        root: { props: {} },
        zones: {},
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// The packing slip
// ---------------------------------------------------------------------------
//
// A third layout type on the same module, collected the same way. It is the
// sheet that goes IN THE BOX, printed by the supplier off their own link - which
// is why it carries no money and does not name them. See
// lib/packing-slip-context.ts for the whole of that reasoning; there is no field
// here to print a price from, so no starter can accidentally offer one.
//
// Two starters, like the returns note: a packing slip is a docket, and the
// difference between "plain" and "standard" on one page of it would be a choice
// nobody wanted to make.

const PACKING_STANDARD_CONTENT = [
  logo(48),
  block('PoPsHeader', 'po-ps-head', {
    heading: '', fontFamily: '', titleSize: 'medium', sides: 'logo-left', rule: 'hairline',
    factsLayout: 'columns', numberStyle: 'row',
    showSlipNumber: 'yes', slipLabel: 'Delivery', showDate: 'yes', dateLabel: 'Sent',
    orderLabel: 'Order', showReference: 'yes', referenceLabel: 'Your reference', showIntro: 'yes',
  }),
  block('PoPsFrom', 'po-ps-from', {
    heading: 'From', fontFamily: '', align: 'left',
    showContact: 'no', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
  }),
  block('PoPsShipTo', 'po-ps-shipto', {
    heading: 'Delivered to', fontFamily: '', look: 'panel',
    showInstructions: 'no', showCountry: 'no',
  }),
  block('PoPsLines', 'po-ps-lines', {
    fontFamily: '', headStyle: 'rule', headCase: 'caps', rowRules: 'every', zebra: 'no',
    descWidth: 'wide', showOurSku: 'yes', showSupplierSku: 'no', showOrdered: 'yes',
    itemLabel: 'Item', codeLabel: 'Code', qtyLabel: 'In this delivery', orderedLabel: 'Ordered',
    showPartialNote: 'yes', partialNote: '',
  }),
  block('PoPsTracking', 'po-ps-tracking', {
    showHeading: 'yes', heading: 'How it travelled', capsHeading: 'yes', fontFamily: '', look: 'plain',
    carrierLabel: 'Carrier', trackingLabel: 'Tracking', showDate: 'no', dateLabel: 'Sent',
  }),
  block('PoPsNotes', 'po-ps-notes', {
    showHeading: 'yes', heading: 'Notes', capsHeading: 'yes', fontFamily: '', columns: '1',
    showNotes: 'yes', showTerms: 'yes', termsHeading: 'If anything is wrong',
    extraHeading: '', extra: '',
  }),
]

/** What the slip renders when nothing at all has been published - which is every
 *  site until somebody publishes one. Same reasoning as the order and the
 *  returns note: a packing slip may never refuse to print, because somebody is
 *  standing over an open box with a roll of tape. */
export const PO_PACKING_SLIP_FALLBACK_DATA = {
  content: PACKING_STANDARD_CONTENT,
  root: { props: {} },
  zones: {},
}

export function purchasePackingSlipStarters() {
  return [
    {
      id: 'starter-po-packing-standard',
      name: 'Standard packing slip',
      description: 'Your name at the top, where it is going, what is in this box against what was ordered, and how it travelled. No prices anywhere.',
      publishByDefault: true,
      data: PO_PACKING_SLIP_FALLBACK_DATA,
    },
    {
      id: 'starter-po-packing-designed',
      name: 'Designed packing slip',
      description: 'The same slip in your own accent colour, with the delivery address in a panel, a banded item table and a line telling your customer what to do if something is missing.',
      data: {
        content: [
          // Colours are site tokens, not values, exactly as the order's designed
          // starter uses them - so this is the SHAPE of a designed slip in
          // whatever colours the site already wears.
          block('PoDocStyle', 'po-ps-style', {
            accent: 'var(--color-primary)', labelColour: 'var(--color-primary)', titleColour: '',
            tableHeadBg: 'var(--color-bg-subtle)', tableHeadInk: '',
            panelBg: 'var(--color-bg-subtle)', panelInk: '', zebraBg: '',
            ruleWeight: 'thick', corners: 'square', density: 'normal',
            bodyFont: '', headingFont: '',
          }),
          logo(72),
          block('PoPsHeader', 'po-ps-head', {
            heading: '', fontFamily: '', titleSize: 'display', sides: 'logo-left', rule: 'accent',
            factsLayout: 'stacked', numberStyle: 'lead',
            showSlipNumber: 'yes', slipLabel: 'Delivery', showDate: 'yes', dateLabel: 'Sent',
            orderLabel: 'Order', showReference: 'yes', referenceLabel: 'Your reference', showIntro: 'yes',
          }),
          block('PoPsFrom', 'po-ps-from', {
            heading: 'From', fontFamily: '', align: 'left',
            showContact: 'no', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
          }),
          block('PoPsShipTo', 'po-ps-shipto', {
            heading: 'Delivered to', fontFamily: '', look: 'panel',
            showInstructions: 'no', showCountry: 'no',
          }),
          block('PoPsLines', 'po-ps-lines', {
            fontFamily: '', headStyle: 'filled', headCase: 'caps', rowRules: 'every', zebra: 'no',
            descWidth: 'half', showOurSku: 'yes', showSupplierSku: 'no', showOrdered: 'yes',
            itemLabel: 'Item', codeLabel: 'Code', qtyLabel: 'In this delivery', orderedLabel: 'Ordered',
            showPartialNote: 'yes', partialNote: '',
          }),
          block('PoPsTracking', 'po-ps-tracking', {
            showHeading: 'yes', heading: 'How it travelled', capsHeading: 'yes', fontFamily: '', look: 'panel',
            carrierLabel: 'Carrier', trackingLabel: 'Tracking', showDate: 'yes', dateLabel: 'Sent',
          }),
          block('PoPsNotes', 'po-ps-notes', {
            showHeading: 'yes', heading: 'Notes', capsHeading: 'yes', fontFamily: '', columns: '2',
            showNotes: 'yes', showTerms: 'yes', termsHeading: 'If anything is wrong',
            extraHeading: 'Questions', extra: 'Quote {{ORDER_NUMBER}} and we will find it straight away. {{BUSINESS_EMAIL}} {{BUSINESS_PHONE}}',
          }),
        ],
        root: { props: {} },
        zones: {},
      },
    },
  ]
}
