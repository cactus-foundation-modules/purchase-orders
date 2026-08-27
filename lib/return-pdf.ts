import { printPath } from '@/lib/documents/pdf'
import { poReturnDocumentBasePath, signPoReturnPrintToken } from '@/modules/purchase-orders/lib/print-token'
import { poReturnPageSetup } from '@/modules/purchase-orders/lib/return-document'
import { renderPoPdf } from '@/modules/purchase-orders/lib/pdf'

// One returns note, printed. The two callers - the admin's download button and
// the email that attaches it - go through here so neither can drift on which URL
// is printed, which token opens it, or which page settings the sheet uses.
//
// `printPath` is core's: it adds the token, the `print=1` flag a block reads to
// drop anything that only makes sense on screen, and a cache-busting nonce
// without which whatever sits in front of the site happily serves last month's
// document from a fixed URL.
export async function poReturnDocumentPdf(returnNumber: string): Promise<Uint8Array> {
  const path = printPath(poReturnDocumentBasePath(returnNumber), signPoReturnPrintToken(returnNumber))
  return renderPoPdf(path, await poReturnPageSetup())
}
