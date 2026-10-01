import {
  dateFromText,
  documentTotal,
  ourNumbers,
  referenceByLabels,
  referenceFromFilenameAvoiding,
  REFERENCE_LABELS,
  segmentByReference,
  totalFromText,
} from '@/modules/purchase-orders/lib/document-reference'
import { pdfPages, pdfText } from '@/modules/purchase-orders/lib/pdf-text'

// What is in a file a supplier emailed us: which of their documents, for which
// of our purchase orders.
//
// A supplier's paperwork arrives three ways - a proforma, their acknowledgement
// of the order (a "sales order"), and the VAT invoice - and the invoices often
// come as one file a day, one invoice to a page, each for a different purchase
// order. This reads such a file and says what documents are in it and where:
// the kind, their reference, which of OUR purchase order numbers it quotes, the
// date and the total, and which pages it runs to. lib/pdf-split.ts can then cut
// each one out as a file of its own.
//
// Pure: bytes in, a description out. No database, no library, no network. The
// caller supplies the purchase order numbers worth looking for - the ones we
// actually issued - which is what makes finding ours exact rather than a guess
// at whatever the supplier chose to label it.
//
// Everything read here is still a reading of somebody else's document. It is
// shown to a person, or checked against the purchase order it names, before
// anything is done about it.

export type SupplierDocKind = 'proforma' | 'acknowledgement' | 'invoice' | 'credit-note' | 'unknown'

export type ReadDocument = {
  kind: SupplierDocKind
  /** 1-based, inclusive. Meaningless where `wholeFile` is set. */
  pages: [number, number]
  /**
   * The file could not be read page by page (an image, a scan with no page
   * text, a PDF this cannot follow), so this one document stands for all of
   * it. The caller treats it as the whole file and never asks lib/pdf-split.ts
   * to cut pages out of it; where the pages could at least be counted, `pages`
   * runs from 1 to that count.
   */
  wholeFile: boolean
  /** Their invoice, proforma, credit note or sales order number. */
  supplierRef: string | null
  /** Every one of OUR numbers found on these pages, as the caller supplied
   *  them. One beside a "Customer Order No." style label comes first. */
  ourPoNumbers: string[]
  /** YYYY-MM-DD. */
  date: string | null
  /** A plain amount, "1234.56". Negative ("-45.00") wherever the document
   *  printed it as negative - "-45.00", "-£45.00" or "(45.00)" - but not every
   *  credit note does, so a caller comparing it with a purchase order compares
   *  absolute values and lets `kind: 'credit-note'` say which way it goes. */
  total: string | null
}

/** What a document calls itself, matched against a whole column of a line so
 *  that "This is not a VAT invoice" is not a heading. Most specific first:
 *  "Pro Forma Invoice" contains "Invoice". */
const HEADINGS: ReadonlyArray<[Exclude<SupplierDocKind, 'unknown'>, RegExp]> = [
  ['proforma', /^pro[\s-]?forma(?:\s+(?:vat\s+|tax\s+)?invoice)?$/i],
  // "Credit note" or "credit memo", never the bare word: an invoice's payment
  // terms say "Credit" and its ledger columns say "Debit   Credit".
  ['credit-note', /^(?:vat\s+|tax\s+|sales\s+)?credit\s+(?:note|memo)$/i],
  [
    'acknowledgement',
    /^(?:sales\s+order(?:\s+acknowledge?ment|\s+confirmation)?|order\s+(?:acknowledge?ment|confirmation)|acknowledge?ment)$/i,
  ],
  ['invoice', /^(?:vat\s+|tax\s+|sales\s+)?invoice$/i],
]

/** The same four, in a filename or a subject line, where they are words among
 *  others. */
const MENTIONS: ReadonlyArray<[Exclude<SupplierDocKind, 'unknown'>, RegExp]> = [
  ['proforma', /pro[\s_-]?forma/i],
  ['credit-note', /credit[\s_-]?(?:note|memo)/i],
  ['acknowledgement', /sales[\s_-]?order|acknowledge?ment|order[\s_-]?confirm/i],
  ['invoice', /invoice/i],
]

/** How far down a page its heading can be. Suppliers put their own name and
 *  address above it, and nothing more. */
const HEADING_LINES = 40

/** Two or more spaces, or a tab: two columns sharing a line. */
const COLUMN_GAP = /\s{2,}|\t/

/** The labels a supplier puts OUR order number beside. Only ever a tie-breaker:
 *  the number itself is what is looked for. */
const OUR_LABEL = /\b(?:cust(?:omer)?|your|buyer|client)\.?\s*(?:order|ref|p\.?\s?o)|purchase\s+order|\bp\.?\s?o\.?\s*(?:no|number|ref)/i

/** A credit note's own number, then the invoice labels, which is what most
 *  accounting packages print on one anyway. */
const CREDIT_LABELS: readonly RegExp[] = [
  /\bcredit\s+note\s*(?:no|number|nr|num|ref(?:erence)?|#)\b/i,
  /\bcredit\s*(?:no|number|nr|#)\b/i,
  ...REFERENCE_LABELS.invoice,
]

/** Where the kind is not known, the labels that can only be the supplier's own
 *  reference, whatever document it is. */
const ANY_LABELS: readonly RegExp[] = [...REFERENCE_LABELS.invoice, ...REFERENCE_LABELS.acknowledgement]

function labelsFor(kind: SupplierDocKind): readonly RegExp[] {
  switch (kind) {
    case 'proforma':
      return REFERENCE_LABELS.proforma
    case 'acknowledgement':
      return REFERENCE_LABELS.acknowledgement
    case 'invoice':
      return REFERENCE_LABELS.invoice
    case 'credit-note':
      return CREDIT_LABELS
    case 'unknown':
      return ANY_LABELS
  }
}

/**
 * The kind a page's own heading gives it, or 'unknown'.
 *
 * The first heading down the page decides, with one exception: a credit note
 * anywhere in the heading area wins. Plenty of packages print "INVOICE" in the
 * letterhead and "CREDIT NOTE" underneath it, and a credit note filed as an
 * invoice is the one mistake here that costs money rather than a click.
 */
export function kindFromHeading(text: string): SupplierDocKind {
  const lines = text.split(/[\r\n]+/).slice(0, HEADING_LINES)
  let first: SupplierDocKind = 'unknown'
  for (const line of lines) {
    for (const column of line.split(COLUMN_GAP)) {
      const words = column.trim().replace(/[:.]+$/, '').replace(/\s+/g, ' ')
      if (!words) continue
      for (const [kind, heading] of HEADINGS) {
        if (!heading.test(words)) continue
        if (kind === 'credit-note') return kind
        if (first === 'unknown') first = kind
      }
    }
  }
  return first
}

/** The kind a filename or a subject line suggests, or 'unknown'. */
export function kindFromMention(text: string | null | undefined): SupplierDocKind {
  if (!text) return 'unknown'
  for (const [kind, mention] of MENTIONS) if (mention.test(text)) return kind
  return 'unknown'
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Which of OUR numbers these pages quote, found by looking for each one exactly
 * - as a whole token, any case - rather than by trusting a label. Returned as
 * the caller wrote them, one beside a label that says it is ours first, then in
 * the order they appear.
 */
export function ourPoNumbersIn(text: string, known: ReadonlySet<string>): string[] {
  const lines = text.split(/[\r\n]+/)
  const found: Array<{ number: string; at: number; labelled: boolean }> = []
  for (const number of known) {
    const trimmed = number.trim()
    if (!trimmed) continue
    // Whole token: nothing alphanumeric either side, and not carried on past
    // the end by a hyphen, slash or decimal point - PO-0003-A, PO-0003/2 and
    // PO-0003.1 are other numbers. A full stop ending a sentence is not.
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeForPattern(trimmed)}(?![A-Za-z0-9]|[-/][A-Za-z0-9]|\\.\\d)`, 'i')
    let at = -1
    let labelled = false
    for (let i = 0; i < lines.length; i += 1) {
      const hit = pattern.exec(lines[i]!)
      if (!hit) continue
      if (at === -1) at = i
      // Its label sits beside it, or on one of the two lines above.
      const near = [lines[i]!.slice(0, hit.index), lines[i - 1] ?? '', lines[i - 2] ?? ''].join('\n')
      if (OUR_LABEL.test(near)) {
        labelled = true
        break
      }
    }
    if (at !== -1) found.push({ number: trimmed, at, labelled })
  }
  return found
    .sort((a, b) => Number(b.labelled) - Number(a.labelled) || a.at - b.at)
    .map((entry) => entry.number)
}

/**
 * Every supplier document in a file, in page order.
 *
 * `knownPoNumbers` is the set of purchase order numbers worth finding - the
 * ones we issued to this supplier - and `subject` the email's subject, where
 * there was one, as the last word on what kind of document it is.
 *
 * A file whose pages cannot be told apart (an image, a scan, a PDF built in a
 * way lib/pdf-text.ts cannot follow) comes back as one document covering the
 * whole of it - every page where the pages could be counted, page 1 to 1 where
 * they could not - with whatever the filename and any readable text say. Never throws and never returns an empty list: a file
 * always holds at least one document, even if nothing about it is known.
 */
export function readSupplierDocuments(
  filename: string,
  bytes: Uint8Array,
  knownPoNumbers: ReadonlySet<string>,
  options: { subject?: string | null; now?: Date } = {},
): ReadDocument[] {
  const now = options.now ?? new Date()
  const ours = ourNumbers(knownPoNumbers)
  const fallbackKind = [kindFromMention(filename), kindFromMention(options.subject)].find((kind) => kind !== 'unknown') ?? 'unknown'

  let pages: string[] | null = null
  let wholeFile: string | null = null
  try {
    pages = pdfPages(bytes)
    // No words on any page - a scan, or a file whose pages could not be followed
    // at all - leaves the whole-file reader, which may still find something.
    if (!pages?.some((page) => page.trim())) wholeFile = pdfText(bytes)
  } catch (error) {
    // Somebody else's PDF: a file that breaks the reader must not break the
    // mail it arrived on.
    console.error('[purchase-orders] could not read the pages of', filename, error)
    pages = null
  }

  if (!pages?.some((page) => page.trim())) {
    const text = wholeFile ?? ''
    const headed = kindFromHeading(text)
    const kind = headed !== 'unknown' ? headed : fallbackKind
    return [
      {
        kind,
        pages: [1, Math.max(1, pages?.length ?? 1)],
        wholeFile: true,
        supplierRef: referenceByLabels(text, labelsFor(kind), ours) ?? referenceFromFilenameAvoiding(filename, ours),
        ourPoNumbers: ourPoNumbersIn(`${text}\n${filename}`, knownPoNumbers),
        date: text ? dateFromText(text, now) : null,
        total: text ? totalFromText(text) : null,
      },
    ]
  }

  const kinds = pages.map(kindFromHeading)
  // A page with no heading of its own is read with the labels of the nearest
  // heading before it, then the file's name, then anything at all.
  let carried: SupplierDocKind = fallbackKind
  const references = pages.map((page, index) => {
    if (kinds[index] !== 'unknown') carried = kinds[index]!
    return referenceByLabels(page, labelsFor(carried), ours)
  })

  const ranges = segmentByReference(references)
  return ranges.map(([from, to]) => {
    const text = pages.slice(from - 1, to).join('\n')
    const kind = kinds.slice(from - 1, to).find((found) => found !== 'unknown') ?? fallbackKind
    const supplierRef =
      references.slice(from - 1, to).find((reference) => reference !== null) ??
      referenceByLabels(text, labelsFor(kind), ours) ??
      (ranges.length === 1 ? referenceFromFilenameAvoiding(filename, ours) : null)
    return {
      kind,
      pages: [from, to],
      wholeFile: false,
      supplierRef,
      ourPoNumbers: ourPoNumbersIn(text, knownPoNumbers),
      date: dateFromText(text, now),
      total: documentTotal(pages.slice(from - 1, to)),
    }
  })
}
