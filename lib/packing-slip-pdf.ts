import { printPath, renderDocumentPdf, documentPdfFilename } from '@/lib/documents/pdf'
import { poPackingSlipBasePath, signPoPackingSlipToken } from '@/modules/purchase-orders/lib/print-token'
import { poPackingSlipPageSetup } from '@/modules/purchase-orders/lib/packing-slip-document'

// One packing slip, printed. Three callers go through here - the supplier
// downloading it off their own link, somebody here downloading it off the order
// screen, and anybody re-downloading it later - so none of them can drift on
// which URL is printed, which token opens it, or which page settings the sheet
// uses.
//
// The footer CSS is the ORDER's, imported rather than copied: the strip at the
// foot of a page is one design for everything a business prints.
const FOOTER_CSS = `
.cactus-pdf-footer .shp-inv-footer, .cactus-pdf-footer .shp-inv-notice { margin-top: 0; }
.cactus-pdf-footer .po-doc-notice, .cactus-pdf-footer .po-doc-terms { margin-top: 0; }
`

export async function poPackingSlipPdf(shipmentNumber: string): Promise<Uint8Array> {
  const path = printPath(poPackingSlipBasePath(shipmentNumber), signPoPackingSlipToken(shipmentNumber))
  return renderDocumentPdf({
    path,
    pageSetup: await poPackingSlipPageSetup(),
    footerCss: FOOTER_CSS,
    label: 'packing slip',
  })
}

/** The filename a browser saves it as. */
export function poPackingSlipFilename(prefix: string, shipmentNumber: string): string {
  return documentPdfFilename(prefix, shipmentNumber, 'packing-slip')
}
