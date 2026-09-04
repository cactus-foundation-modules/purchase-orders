import { pdfText } from '@/modules/purchase-orders/lib/pdf-text'

// The supplier's own number, read off the document they sent.
//
// Every supplier quotes their own reference on their paperwork - a proforma
// invoice number, a sales order number against an acknowledgement - and every
// one of them puts it next to a label saying what it is. So the guess is the
// dullest possible thing: find the label, take what is beside it, and refuse
// anything that does not look like a reference.
//
// It is a GUESS and it is treated as one everywhere it is used. It only ever
// fills a box somebody left empty, it is always shown on the screen where it can
// be corrected, and a wrong answer costs one edit. That is why the rules below
// lean towards saying nothing: a blank box is the behaviour this replaced.
//
// The trap worth naming, because it is on both sample documents that prompted
// all this: a supplier's acknowledgement carries OUR purchase order number too,
// under "Cust Order No.". A guesser that reads that one back to us has achieved
// nothing except making the screen look confident.

export type PoDocumentKind = 'proforma' | 'acknowledgement'

/** Labels, most specific first. Each is matched against a whole line, and the
 *  value may sit after it on that line or on the line below - which of the two
 *  depends entirely on how the document was drawn. */
const LABELS: Record<PoDocumentKind, RegExp[]> = {
  proforma: [
    /\bpro[\s-]?forma\s+(?:invoice\s+)?(?:no|number|nr|num|ref(?:erence)?|#)\b/i,
    /\binvoice\s*(?:no|number|nr|num|#)\b/i,
    /\bpro[\s-]?forma\s*(?:no|number|#)\b/i,
    /\binvoice\s+ref(?:erence)?\b/i,
    /\bdocument\s*(?:no|number|#)\b/i,
  ],
  acknowledgement: [
    /\bsales\s+order\s*(?:no|number|nr|num|#)\b/i,
    /\bsales\s*(?:no|number|nr|num|#)\b/i,
    /\back(?:nowledge?ment)?\s*(?:no|number|ref(?:erence)?|#)\b/i,
    /\border\s+(?:confirmation|acknowledge?ment)\s*(?:no|number|ref(?:erence)?|#)\b/i,
    /\bour\s+(?:order\s+)?ref(?:erence)?\b/i,
    /\border\s*(?:no|number|nr|num|#)\b/i,
  ],
}

/** Words that turn a label into somebody else's number - ours, usually. A line
 *  reading "Cust Order No. PO-00012" matches the order label perfectly well and
 *  is the last thing we want. */
const NOT_THEIRS = /\b(?:cust(?:omer)?|your|buyer|client|purchase\s+order|p\.?o\.?)\b/i

/** What a device calls a file it made itself. Whatever number is in one of these
 *  is a counter or a timestamp, and never a supplier's reference. */
const CAMERA_NAME = /^(?:img|dsc[nf]?|photo|image|picture|pic|scan(?:ned)?(?:[\s_-]*document)?|screenshot|screen[\s_-]?shot|document|doc)[\s_-]*[\d\s_.:()-]*$/i

/** What a reference is allowed to look like. Letters, digits and the handful of
 *  separators suppliers use, at least one digit, and nothing long enough to be a
 *  sentence somebody has run into the field. */
const SHAPE = /^[A-Za-z0-9][A-Za-z0-9/_.\-]{1,39}$/

function looksLikeADate(value: string): boolean {
  return (
    /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}$/.test(value) ||
    // A bare year on its own is a year, whatever label it was sitting beside.
    /^(?:19|20)\d{2}$/.test(value)
  )
}

function looksLikeMoney(value: string): boolean {
  return /^[£$€]?\d{1,3}(?:,\d{3})*(?:\.\d{2})$/.test(value) || /^\d+\.\d{2}$/.test(value)
}

/** Is this a number a supplier would quote back at us? `ours` is our own order
 *  number, which appears on their paperwork under a label of its own and must
 *  never come back as theirs. */
function acceptable(value: string, ours: string | null): boolean {
  const trimmed = value.trim().replace(/^[:.\-\s]+/, '').replace(/[.,;:]+$/, '')
  if (!SHAPE.test(trimmed)) return false
  if (!/\d/.test(trimmed)) return false
  if (looksLikeADate(trimmed) || looksLikeMoney(trimmed)) return false
  if (ours && trimmed.toLowerCase() === ours.trim().toLowerCase()) return false
  return true
}

function tidy(value: string): string {
  return value.trim().replace(/^[:.\-\s]+/, '').replace(/[.,;:]+$/, '')
}

/**
 * The reference off the text of a document, or null.
 *
 * Two shapes are handled because both are ordinary: the value beside the label
 * on the same line, which is what a text layout gives, and the value on the next
 * line, which is what the drawing order of a laid-out PDF gives. Three lines of
 * lookahead, because a label and its value can have a blank between them and
 * nothing useful is that far away.
 */
export function referenceFromText(
  text: string,
  kind: PoDocumentKind,
  ours: string | null = null,
): string | null {
  const lines = text.split(/[\r\n]+/).map((line) => line.trim())

  for (const label of LABELS[kind]) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      const found = label.exec(line)
      if (!found) continue
      // Whatever came before the label decides whose number this is.
      if (NOT_THEIRS.test(line.slice(0, found.index))) continue

      const sameLine = tidy(line.slice(found.index + found[0].length))
      // The rest of the line can carry the value and then some: take the first
      // word of it, which is where a reference always is.
      const firstWord = sameLine.split(/\s+/)[0] ?? ''
      if (acceptable(firstWord, ours)) return tidy(firstWord)

      for (let ahead = 1; ahead <= 3 && i + ahead < lines.length; ahead += 1) {
        const next = lines[i + ahead]!
        if (!next) continue
        const word = next.split(/\s+/)[0] ?? ''
        if (acceptable(word, ours)) return tidy(word)
        // A line that is plainly another label is not a value, but it is also
        // not a reason to stop: labels and values interleave on a drawn page.
      }
    }
  }
  return null
}

/**
 * The reference off the filename, for when the text says nothing.
 *
 * Worth having on its own: plenty of accounting systems name the file after the
 * document - "Pro Forma Invoice 0000008633.pdf" - and a photographed or scanned
 * acknowledgement has no text in it at all, only pixels, which nothing here
 * pretends to read.
 *
 * The LAST qualifying word wins, because that is where the number goes in every
 * such name yet seen.
 */
export function referenceFromFilename(filename: string, ours: string | null = null): string | null {
  const dot = filename.lastIndexOf('.')
  const stem = (dot === -1 ? filename : filename.slice(0, dot)).trim()
  // A camera, a scanner or a screenshot names its own files, and the number in
  // one of those names is a counter. "IMG_0042" is not anybody's invoice.
  if (CAMERA_NAME.test(stem)) return null
  const words = stem.split(/[\s_]+/).filter(Boolean)
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = tidy(words[i]!)
    // Short numbers in a filename are copy counters and page numbers far more
    // often than they are references - "invoice (2)", "scan 3".
    if (word.replace(/\D/g, '').length < 4) continue
    if (acceptable(word, ours)) return word
  }
  return null
}

/**
 * What we think the supplier's own reference is, off the file they sent.
 *
 * Never throws. A PDF that will not parse, an image, a password-protected file,
 * a scan with no text layer: all of them fall through to the filename, and then
 * to null, which leaves the field exactly as empty as it was before.
 */
export function guessDocumentReference(
  kind: PoDocumentKind,
  filename: string,
  bytes: Uint8Array,
  ours: string | null = null,
): string | null {
  try {
    const text = pdfText(bytes)
    if (text) {
      const found = referenceFromText(text, kind, ours)
      if (found) return found
    }
  } catch (error) {
    // Reading somebody else's PDF is best-effort by definition, and a file that
    // breaks the reader must not break the upload it arrived on.
    console.error('[purchase-orders] could not read the text of', filename, error)
  }
  return referenceFromFilename(filename, ours)
}
