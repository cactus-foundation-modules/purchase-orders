// Page settings for the purchase order document - paper, margins, print scale.
//
// Deliberately not a second set of the same fields. A purchase order, the
// supplier's invoice and the customer invoice it all leads to sit in one folder
// on somebody's desk; two ideas of what "A4 with a 16mm margin" means would show,
// and somebody who has set up one document would have to learn the other from
// scratch. They are CORE's (lib/documents/page-settings.tsx).
//
// The PDF FOOTER is not here. There is exactly one footer layout type, shared by
// every document a site prints, and it is core's too - see lib/document.tsx's
// `renderPoRunningFooter`.
//
// Kept as a file of its own rather than pointed at straight from the manifest, so
// the indirection is visible here rather than being a surprise in a JSON file.
//
// CLIENT-SAFE, and it has to stay that way: the generated
// lib/puck/module-layout-roots.ts imports `poDocPageSettings` from here by name
// and that file is loaded by the Puck editor bundle as well as by the server.

export {
  documentPageSettings as poDocPageSettings,
  docPageSetup,
  docPageSetupFromLayout,
  type DocPageSetup,
} from '@/lib/documents/page-settings'
