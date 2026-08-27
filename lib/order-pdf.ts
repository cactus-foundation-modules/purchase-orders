import { printPath } from '@/lib/documents/pdf'
import { poDocumentBasePath, signPoPrintToken } from '@/modules/purchase-orders/lib/print-token'
import { poDocumentPageSetup } from '@/modules/purchase-orders/lib/document'
import { renderPoPdf } from '@/modules/purchase-orders/lib/pdf'

// One purchase order, printed. The two callers - the admin's download button and
// the email that attaches it - go through here so neither can drift on which URL
// is printed, which token opens it, or which page settings the sheet uses.
//
// `printPath` is core's: it adds the token, the `print=1` flag a block reads to
// drop anything that only makes sense on screen, and a cache-busting nonce
// without which whatever sits in front of the site happily serves last month's
// document from a fixed URL. That last one is not theoretical - it cost the shop
// half an hour of an owner's afternoon.
export async function poDocumentPdf(orderNumber: string): Promise<Uint8Array> {
  const path = printPath(poDocumentBasePath(orderNumber), signPoPrintToken(orderNumber))
  return renderPoPdf(path, await poDocumentPageSetup())
}
