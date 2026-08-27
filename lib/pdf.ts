import { renderDocumentPdf, documentPdfFilename } from '@/lib/documents/pdf'
import type { DocPageSetup } from '@/modules/purchase-orders/lib/doc-page-settings'

// Turning the purchase order document into a PDF.
//
// The machinery is core's (lib/documents/pdf.ts): the headless browser, the
// serverless-versus-local chromium split, the cache-busting nonce on the print
// URL, the running-footer capture and the empty header template Chrome insists
// on. What is left here is this module's own share of it - which document is
// being printed, and the one rule the footer template needs about class names
// core has never heard of.

export { printPath } from '@/lib/documents/pdf'

/** Kept under a name of this module's own because the PDF routes catch it by
 *  name and this module is pinned separately from core. It IS core's class, not
 *  a subclass, so `instanceof` still answers for anything core throws across a
 *  version skew. */
export { DocumentPdfUnavailableError as PoPdfUnavailableError } from '@/lib/documents/pdf'

/**
 * The footer template is a document of its own, and these blocks sit directly
 * under its body rather than inside a purchase order. Their top margin is spacing
 * between sections of a document; in the template there is nothing above them to
 * be spaced from, so it comes off.
 *
 * Both prefixes, because the shared footer can hold either module's blocks: this
 * module's, and the shop's, which is what a site that designed a footer before
 * Purchase Orders arrived will have on it.
 */
const FOOTER_CSS = `
.cactus-pdf-footer .shp-inv-footer, .cactus-pdf-footer .shp-inv-notice { margin-top: 0; }
.cactus-pdf-footer .po-doc-notice, .cactus-pdf-footer .po-doc-terms { margin-top: 0; }
`

/**
 * Prints one purchase order to PDF bytes.
 *
 * `path` is a site-relative URL (the order's own document page, signed token and
 * all). It is fetched over HTTP from the site's own address rather than rendered
 * in-process, because that is the only way to be certain the PDF and the page
 * agree - and because a Puck layout of async server components cannot be
 * rendered to a string by hand.
 */
export async function renderPoPdf(path: string, setup?: DocPageSetup): Promise<Uint8Array> {
  return renderDocumentPdf({ path, pageSetup: setup, footerCss: FOOTER_CSS, label: 'purchase order' })
}

/** The filename a browser saves it as. */
export function poPdfFilename(prefix: string, orderNumber: string): string {
  return documentPdfFilename(prefix, orderNumber, 'purchase-order')
}
