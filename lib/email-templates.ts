import type { EmailTemplateDef } from '@/lib/email/registry'

// The three emails this module sends to a supplier, declared for core's single
// email editor (Settings > Emails). Core owns the wording, the wrapper design
// and the sending; this file is only the defaults.
//
// All three are transactional: a supplier who has been sent a purchase order is
// not on a mailing list, and an amendment or a cancellation they never see is
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
      '<p>Thank you,<br />{{siteName}}</p>',
    mergeTags: ['supplierName', 'orderNumber', 'orderTotal', 'requiredByDate', 'shipTo', 'lines', 'siteName'],
    requiredTags: ['orderNumber'],
    rawTags: ['lines', 'shipTo'],
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
      '<p>Thank you,<br />{{siteName}}</p>',
    mergeTags: ['supplierName', 'orderNumber', 'revision', 'amendmentReason', 'orderTotal', 'siteName'],
    requiredTags: ['orderNumber'],
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
]
