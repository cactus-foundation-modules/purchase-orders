import type { EmailTemplateDef } from '@/lib/email/registry'

// The emails this module sends: five to a supplier, and one to you when a
// supplier answers back through their own link. Declared for core's single email
// editor (Settings > Emails), which owns the wording, the wrapper design and the
// sending; this file is only the defaults.
//
// All of them are transactional: a supplier who has been sent a purchase order
// is not on a mailing list, and an amendment or a cancellation they never see is
// how two of something turn up.
//
// `lines` is the whole table the sending code assembles, `<table>` tags and all,
// every value escaped as it goes - hence rawTags. Everything else core escapes as
// normal, which matters because a line description is whatever somebody typed into
// the line editor.
//
// It goes in bare. NEVER wrap it in a `<table>` of its own: a table nested
// straight inside another table is not markup any browser accepts, and every
// mail client fixes it by throwing the rest of the message - the delivery
// address, the sign-off - clean out of the wrapper's cell, where it lands
// unstyled and jammed against the left edge.

export const purchaseOrdersEmailTemplates: EmailTemplateDef[] = [
  {
    key: 'purchase-orders.sent',
    label: 'Purchase order sent to supplier',
    subject: 'Purchase order {{orderNumber}} from {{siteName}}',
    bodyHtml:
      '<p>Hello {{supplierName}},</p>' +
      '<p>Our purchase order <strong>{{orderNumber}}</strong> is attached. Please quote that number on your paperwork.</p>' +
      '{{lines}}' +
      '<p>Delivery is wanted by {{requiredByDate}}, to:</p>' +
      '<p>{{shipTo}}</p>' +
      '{{portalLink}}' +
      '<p>Thank you,<br />{{siteName}}</p>',
    mergeTags: ['supplierName', 'orderNumber', 'orderTotal', 'requiredByDate', 'shipTo', 'lines', 'portalLink', 'siteName'],
    requiredTags: ['orderNumber'],
    // portalLink is a whole paragraph built in code, or nothing at all where the
    // supplier link is switched off - so a template carrying it never ends up
    // with a dangling "see it online:" and no link after it.
    rawTags: ['lines', 'shipTo', 'portalLink'],
    transactional: true,
  },
  {
    key: 'purchase-orders.amended',
    label: 'Purchase order amended',
    subject: 'Amended purchase order {{orderNumber}} (revision {{revision}})',
    bodyHtml:
      '<p>Hello {{supplierName}},</p>' +
      '<p>Purchase order <strong>{{orderNumber}}</strong> has changed. Revision {{revision}} is attached and replaces the one we sent before.</p>' +
      '<p>{{amendmentReason}}</p>' +
      '{{portalLink}}' +
      '<p>Thank you,<br />{{siteName}}</p>',
    mergeTags: ['supplierName', 'orderNumber', 'revision', 'amendmentReason', 'orderTotal', 'portalLink', 'siteName'],
    requiredTags: ['orderNumber'],
    rawTags: ['portalLink'],
    transactional: true,
  },
  {
    key: 'purchase-orders.return-sent',
    label: 'Returns note sent to supplier',
    subject: 'Returns note {{returnNumber}} against order {{orderNumber}}',
    bodyHtml:
      '<p>Hello {{supplierName}},</p>' +
      '<p>We are returning the goods below against our order <strong>{{orderNumber}}</strong>. Our returns note {{returnNumber}} is attached.</p>' +
      '{{lines}}' +
      '<p>{{reason}}</p>' +
      '<p>Please raise a credit note for {{creditExpected}}, quoting {{returnNumber}}.</p>' +
      '<p>Thank you,<br />{{siteName}}</p>',
    mergeTags: ['supplierName', 'returnNumber', 'orderNumber', 'creditExpected', 'reason', 'lines', 'siteName'],
    requiredTags: ['returnNumber'],
    rawTags: ['lines'],
    transactional: true,
  },
  {
    // The one that goes out on its own, without anybody pressing anything.
    // Written to be short and to sound like a person rather than a system: a
    // supplier who is genuinely late does not need a lecture, and one who is
    // late because nobody told us the date moved needs somewhere to say so -
    // which is what the link is for.
    key: 'purchase-orders.chase',
    label: 'Chasing a late purchase order',
    subject: 'Still waiting on purchase order {{orderNumber}}',
    bodyHtml:
      '<p>Hello {{supplierName}},</p>' +
      '<p>Our purchase order <strong>{{orderNumber}}</strong> was due on {{dueDate}} and has not arrived. ' +
      'That is {{daysLate}} now, so we thought we would ask.</p>' +
      '<p>Still to come:</p>' +
      '{{lines}}' +
      '{{portalLink}}' +
      '<p>If it is already on its way, do ignore this.</p>' +
      '<p>Thank you,<br />{{siteName}}</p>',
    mergeTags: ['supplierName', 'orderNumber', 'dueDate', 'daysLate', 'lines', 'portalLink', 'siteName'],
    requiredTags: ['orderNumber'],
    rawTags: ['lines', 'portalLink'],
    transactional: true,
  },
  {
    key: 'purchase-orders.cancelled',
    label: 'Purchase order cancelled',
    subject: 'Purchase order {{orderNumber}} cancelled',
    bodyHtml:
      '<p>Hello {{supplierName}},</p>' +
      '<p>Please treat purchase order <strong>{{orderNumber}}</strong> as cancelled. Do not supply against it.</p>' +
      '<p>{{cancelReason}}</p>' +
      '<p>Thank you,<br />{{siteName}}</p>',
    mergeTags: ['supplierName', 'orderNumber', 'cancelReason', 'siteName'],
    requiredTags: ['orderNumber'],
    transactional: true,
  },
  {
    // The one email in this list that goes to YOU rather than to a supplier. A
    // supplier offering a later date or saying half of it is short is only worth
    // having if somebody reads it, and nobody sits watching an order screen.
    key: 'purchase-orders.portal-reply',
    label: 'A supplier replied through their link',
    subject: '{{supplierName}} replied about {{orderNumber}}',
    bodyHtml:
      '<p>{{supplierName}} has used their link to purchase order <strong>{{orderNumber}}</strong> and said:</p>' +
      '<blockquote>{{what}}</blockquote>' +
      '<p>Nothing on the order has changed. Open it in Purchasing to take them up on it, or to disagree.</p>',
    mergeTags: ['supplierName', 'orderNumber', 'what', 'siteName'],
    requiredTags: ['orderNumber'],
    transactional: true,
  },
  {
    // The second one that comes to YOU. Sent only when an automatic draft could
    // not buy everything on a paid order - never to say it went fine, because a
    // machine that writes every morning to say so is a machine nobody reads, and
    // the drafts are on the Orders tab either way.
    key: 'purchase-orders.auto-draft',
    label: 'An automatic draft could not buy everything',
    subject: 'Purchasing needs a look at {{orderNumber}}',
    bodyHtml:
      '<p>{{orderNumber}} has been paid for and its purchase orders were drafted automatically.</p>' +
      '<p><strong>{{whatHappened}}</strong></p>' +
      '{{lines}}' +
      '<p>Nothing has been sent to any supplier. Open the customer order to see where it stands, ' +
      'or Purchasing to send the drafts that did come out.</p>',
    mergeTags: ['orderNumber', 'whatHappened', 'lines', 'siteName'],
    requiredTags: ['orderNumber'],
    // The table is built in code with every value escaped as it goes - a product
    // name is whatever a supplier's spreadsheet called it.
    rawTags: ['lines'],
    transactional: true,
  },
]
