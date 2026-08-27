import type { EmailTemplateDef } from '@/lib/email/registry'

// The emails this module sends: four to a supplier, and one to you when a
// supplier answers back through their own link. Declared for core's single email
// editor (Settings > Emails), which owns the wording, the wrapper design and the
// sending; this file is only the defaults.
//
// All of them are transactional: a supplier who has been sent a purchase order
// is not on a mailing list, and an amendment or a cancellation they never see is
// how two of something turn up.
//
// `lines` is the table the sending code assembles, every value escaped as it
// goes - hence rawTags. Everything else core escapes as normal, which matters
// because a line description is whatever somebody typed into the line editor.

export const purchaseOrdersEmailTemplates: EmailTemplateDef[] = [
  {
    key: 'purchase-orders.sent',
    label: 'Purchase order sent to supplier',
    subject: 'Purchase order {{orderNumber}} from {{siteName}}',
    bodyHtml:
      '<p>Hello {{supplierName}},</p>' +
      '<p>Our purchase order <strong>{{orderNumber}}</strong> is attached. Please quote that number on your paperwork.</p>' +
      '<table>{{lines}}</table>' +
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
      '<table>{{lines}}</table>' +
      '<p>{{reason}}</p>' +
      '<p>Please raise a credit note for {{creditExpected}}, quoting {{returnNumber}}.</p>' +
      '<p>Thank you,<br />{{siteName}}</p>',
    mergeTags: ['supplierName', 'returnNumber', 'orderNumber', 'creditExpected', 'reason', 'lines', 'siteName'],
    requiredTags: ['returnNumber'],
    rawTags: ['lines'],
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
]
