import { sendEmail, type EmailAttachment } from '@/lib/email'
import { escapeHtml } from '@/lib/email/blocks'
import { renderEmailTemplate } from '@/lib/email/render'
import { isEmailConfigured } from '@/lib/config/env'
import { getSiteConfig } from '@/lib/config/site'
import { formatMoney, formatQty } from '@/modules/purchase-orders/lib/money'
import { getPoConfigCached } from '@/modules/purchase-orders/lib/config'
import { poPdfFilename } from '@/modules/purchase-orders/lib/pdf'
import { poDocumentPdf } from '@/modules/purchase-orders/lib/order-pdf'
import { poReturnDocumentPdf } from '@/modules/purchase-orders/lib/return-pdf'
import type { PoDocContext } from '@/modules/purchase-orders/lib/doc-context'
import type { PoRetDocContext } from '@/modules/purchase-orders/lib/return-doc-context'

// The emails this module sends a supplier: here is your order, here is the
// amended one, please treat that one as cancelled, and here are the goods coming
// back. Plus one that comes the other way, telling the buyer a supplier has
// answered through their own link.
//
// The wording, the on/off switch and the wrapper design all come from core's
// Settings > Emails (the defaults are in lib/email-templates.ts). This file only
// supplies the merge values, the attachment and the decision about whether a
// failure is worth shouting about.
//
// Two different treatments, deliberately:
//
//  - "Send this order" is somebody pressing a button and being told it went. A
//    failure comes back as a failure, in the words the mailer gave, and the order
//    is NOT stamped as sent.
//  - The cancellation note rides along with a status change that has already
//    happened. Cancelling an order must not fail because an email would not send;
//    that one is best-effort and logged.

/** The site's own name, with a sane stand-in: these must still send on a site
 *  whose config row has never been filled in. */
async function siteName(): Promise<string> {
  const config = await getSiteConfig()
  return config?.siteName ?? 'us'
}

/** The line table, assembled here and every value escaped as it goes - a line
 *  description is whatever somebody typed into the line editor. Declared as a
 *  rawTag on the template for exactly that reason: it is markup this code built,
 *  not text passed through. */
function linesHtml(ctx: PoDocContext): string {
  const rows = ctx.order.lines
    .map((line) => {
      const qty = formatQty(Number(line.qty) - Number(line.qtyCancelled))
      const code = line.supplierSku ? ` (${escapeHtml(line.supplierSku)})` : ''
      return (
        '<tr>' +
        `<td>${escapeHtml(line.description)}${code}</td>` +
        `<td align="center">${escapeHtml(qty)} ${escapeHtml(line.unit)}</td>` +
        `<td align="right">${escapeHtml(formatMoney(line.lineTotal, ctx.order.currency))}</td>` +
        '</tr>'
      )
    })
    .join('')
  return `<table cellpadding="6" cellspacing="0" border="0" width="100%">${rows}</table>`
}

/** The delivery address as one escaped block. Also a rawTag: it is built here,
 *  with the line breaks this code put in. */
function shipToHtml(ctx: PoDocContext): string {
  const { shipTo } = ctx.order
  const lines = [shipTo.name, ...shipTo.addressLines, shipTo.contact, shipTo.phone].filter(Boolean)
  return lines.map((line) => escapeHtml(line)).join('<br />')
}

/**
 * The order as a file to travel with the email, or null where it would not
 * print.
 *
 * The attachment is most of the point: a supplier's sales desk files the PDF
 * against the job, and a link they have to click, on a page they cannot reach
 * without a token, is no use to them at all.
 *
 * NEVER throws, and a failure is only logged. Printing runs a headless browser,
 * which is comfortably the most likely thing here to fall over, and an order that
 * reaches the supplier as an email with the lines in the body beats one that
 * never reaches them because the PDF would not render.
 */
async function orderAttachment(orderNumber: string): Promise<EmailAttachment | null> {
  try {
    const [bytes, config] = await Promise.all([poDocumentPdf(orderNumber), getPoConfigCached()])
    return {
      filename: poPdfFilename(config.pdfFilenamePrefix, orderNumber),
      content: Buffer.from(bytes),
      contentType: 'application/pdf',
    }
  } catch (error) {
    console.error('[purchase-orders] could not print the document for order', orderNumber, error)
    return null
  }
}

/**
 * The supplier's own link, as the paragraph that goes in the email - or nothing
 * at all where there is no link to give them.
 *
 * Built here, as markup, and declared as a rawTag on both order templates. The
 * alternative - a bare URL merged into a sentence the template holds - leaves a
 * site with the portal switched off sending "see it online:" followed by
 * nothing, which is worse than not mentioning it.
 */
function portalLinkHtml(url: string | null): string {
  if (!url) return ''
  return (
    '<p>You can see this order, accept it, or tell us about a delay or a shortage here:<br />' +
    `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`
  )
}

export type SupplierRecipients = { to: string; cc: string[] }

/** Who the order goes to: the supplier's ordering address, with whatever else the
 *  supplier record lists copied in. */
export function supplierRecipients(email: string | null, emailCc: string | null): SupplierRecipients | null {
  const to = (email ?? '').trim()
  if (!to.includes('@')) return null
  const cc = (emailCc ?? '')
    .split(/[,;\s]+/)
    .map((address) => address.trim())
    .filter((address) => address.includes('@'))
  return { to, cc }
}

/**
 * Sends one purchase order to its supplier, with the document attached.
 *
 * `kind` picks the template: the first time it goes out, and the amended one that
 * replaces it. Throws on anything that stops it going, because the person who
 * pressed the button is owed a real error rather than a green tick and silence.
 */
export async function sendOrderToSupplier(
  ctx: PoDocContext,
  recipients: SupplierRecipients,
  kind: 'sent' | 'amended',
  reason?: string | null,
  portalLink?: string | null,
): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error('Email is not set up on this site. Add a Brevo key or SMTP details in Settings, Emails.')
  }
  const name = await siteName()
  const { order } = ctx

  const vars: Record<string, string> =
    kind === 'sent'
      ? {
          supplierName: ctx.supplier.name || 'there',
          orderNumber: order.number,
          orderTotal: formatMoney(order.total, order.currency),
          requiredByDate: order.requiredByDate ?? 'as soon as you can',
          shipTo: shipToHtml(ctx),
          lines: linesHtml(ctx),
          portalLink: portalLinkHtml(portalLink ?? null),
          siteName: name,
        }
      : {
          supplierName: ctx.supplier.name || 'there',
          orderNumber: order.number,
          revision: String(order.revision),
          amendmentReason: (reason ?? '').trim(),
          orderTotal: formatMoney(order.total, order.currency),
          portalLink: portalLinkHtml(portalLink ?? null),
          siteName: name,
        }

  const rendered = await renderEmailTemplate(`purchase-orders.${kind}`, vars)
  if (!rendered) {
    throw new Error('That email has been switched off in Settings, Emails.')
  }

  const attachment = await orderAttachment(order.number)
  await sendEmail({
    to: recipients.to,
    ...(recipients.cc.length ? { cc: recipients.cc } : {}),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...(attachment ? { attachments: [attachment] } : {}),
  })
}

/**
 * Asks a supplier where a late order has got to.
 *
 * Throws, unlike the cancellation note, and deliberately: the caller records a
 * chase in the order's history only when one actually went, and a log full of
 * chases nobody received is worse than no log at all - it is the thing that stops
 * the next one being sent. The runner catches it and reports the failure.
 *
 * No attachment. The supplier already has the order; sending the PDF again reads
 * as a fresh one, and a supplier who files it twice is a supplier who ships it
 * twice.
 */
export async function sendOrderChase(
  supplierName: string,
  orderNumber: string,
  recipients: SupplierRecipients,
  vars: { dueDate: string; daysLate: number; lines: { description: string; supplierSku: string | null; unit: string; qtyOutstanding: string }[] },
  portalLink: string | null,
): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error('Email is not set up on this site, so nothing can be chased.')
  }
  const rows = vars.lines
    .map(
      (line) =>
        '<tr>' +
        `<td>${escapeHtml(line.description)}${line.supplierSku ? ` (${escapeHtml(line.supplierSku)})` : ''}</td>` +
        `<td align="center">${escapeHtml(formatQty(line.qtyOutstanding))} ${escapeHtml(line.unit)}</td>` +
        '</tr>',
    )
    .join('')

  const rendered = await renderEmailTemplate('purchase-orders.chase', {
    supplierName: supplierName || 'there',
    orderNumber,
    dueDate: vars.dueDate,
    daysLate: vars.daysLate === 1 ? 'a day' : `${vars.daysLate} days`,
    lines: `<table cellpadding="6" cellspacing="0" border="0" width="100%">${rows}</table>`,
    portalLink: portalLinkHtml(portalLink),
    siteName: await siteName(),
  })
  if (!rendered) {
    throw new Error('The chase email is switched off in Settings, Emails, so nothing was sent.')
  }
  await sendEmail({
    to: recipients.to,
    ...(recipients.cc.length ? { cc: recipients.cc } : {}),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })
}

/**
 * Tells a supplier an order they were sent is cancelled.
 *
 * Best-effort and never throws: the order has already been cancelled by the time
 * this runs, and undoing that because an email bounced would leave the two out of
 * step in the worst possible direction.
 */
export async function sendOrderCancelled(
  supplierName: string,
  orderNumber: string,
  recipients: SupplierRecipients,
  reason: string | null,
): Promise<void> {
  if (!isEmailConfigured()) return
  try {
    const rendered = await renderEmailTemplate('purchase-orders.cancelled', {
      supplierName: supplierName || 'there',
      orderNumber,
      cancelReason: (reason ?? '').trim(),
      siteName: await siteName(),
    })
    if (!rendered) return
    await sendEmail({
      to: recipients.to,
      ...(recipients.cc.length ? { cc: recipients.cc } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    })
  } catch (error) {
    console.error('[purchase-orders] cancellation email failed for', orderNumber, error)
  }
}

/**
 * Tells the buyer that a supplier has said something through their link.
 *
 * The other direction from everything else in this file, and the reason the
 * portal is worth having at all: a supplier offering a later date, or saying half
 * the order is short, is only useful if somebody reads it, and nobody sits
 * watching a purchase order screen waiting.
 *
 * Best-effort and never throws. The supplier has already been told their message
 * landed by the time this runs, and it did - it is in the order's own history
 * whether this email sends or not.
 */
export async function sendPortalReplyToBuyer(
  to: string,
  supplierName: string,
  orderNumber: string,
  what: string,
): Promise<void> {
  if (!isEmailConfigured() || !to.includes('@')) return
  try {
    const rendered = await renderEmailTemplate('purchase-orders.portal-reply', {
      supplierName: supplierName || 'A supplier',
      orderNumber,
      what,
      siteName: await siteName(),
    })
    if (!rendered) return
    await sendEmail({ to, subject: rendered.subject, html: rendered.html, text: rendered.text })
  } catch (error) {
    console.error('[purchase-orders] could not tell anybody about a portal reply to', orderNumber, error)
  }
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

/**
 * The returns note as a file to travel with the email, or null where it would
 * not print.
 *
 * Never throws, and a failure is only logged - same treatment as the order's
 * attachment and for the same reason. A note that reaches the supplier's returns
 * desk with the lines in the body beats one that never reaches them because a
 * headless browser fell over.
 */
async function returnAttachment(returnNumber: string): Promise<EmailAttachment | null> {
  try {
    const [bytes, config] = await Promise.all([poReturnDocumentPdf(returnNumber), getPoConfigCached()])
    return {
      filename: poPdfFilename(config.returnPdfFilenamePrefix, returnNumber),
      content: Buffer.from(bytes),
      contentType: 'application/pdf',
    }
  } catch (error) {
    console.error('[purchase-orders] could not print the document for return', returnNumber, error)
    return null
  }
}

/** The lines going back, assembled here and every value escaped as it goes. */
function returnLinesHtml(ctx: PoRetDocContext): string {
  const rows = ctx.ret.lines
    .map((line) => {
      const code = line.supplierSku ? ` (${escapeHtml(line.supplierSku)})` : ''
      return (
        '<tr>' +
        `<td>${escapeHtml(line.description)}${code}</td>` +
        `<td align="center">${escapeHtml(formatQty(line.qty))} ${escapeHtml(line.unit)}</td>` +
        `<td align="right">${escapeHtml(formatMoney(line.lineTotal, ctx.ret.currency))}</td>` +
        '</tr>'
      )
    })
    .join('')
  return `<table cellpadding="6" cellspacing="0" border="0" width="100%">${rows}</table>`
}

/**
 * Sends one returns note to its supplier, with the document attached.
 *
 * Throws on anything that stops it going, exactly as sending an order does: the
 * person who pressed the button is owed a real error rather than a green tick and
 * a box of desks nobody is expecting.
 */
export async function sendReturnToSupplier(
  ctx: PoRetDocContext,
  recipients: SupplierRecipients,
): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error('Email is not set up on this site. Add a Brevo key or SMTP details in Settings, Emails.')
  }
  const name = await siteName()
  const { ret } = ctx

  const rendered = await renderEmailTemplate('purchase-orders.return-sent', {
    supplierName: ctx.supplier.name || 'there',
    returnNumber: ret.number,
    orderNumber: ret.orderNumber,
    creditExpected: formatMoney(ret.creditExpected, ret.currency),
    reason: (ret.reason ?? '').trim(),
    lines: returnLinesHtml(ctx),
    siteName: name,
  })
  if (!rendered) {
    throw new Error('That email has been switched off in Settings, Emails.')
  }

  const attachment = await returnAttachment(ret.number)
  await sendEmail({
    to: recipients.to,
    ...(recipients.cc.length ? { cc: recipients.cc } : {}),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...(attachment ? { attachments: [attachment] } : {}),
  })
}
