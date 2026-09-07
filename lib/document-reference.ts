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

export type PoDocumentKind = 'proforma' | 'acknowledgement' | 'invoice'

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
  // A VAT invoice. Nearly the proforma's list, minus the proforma wording and
  // plus the one label a VAT invoice has that nothing else does.
  invoice: [
    /\btax\s+invoice\s*(?:no|number|nr|num|ref(?:erence)?|#)\b/i,
    /\binvoice\s*(?:no|number|nr|num|#)\b/i,
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

// ---------------------------------------------------------------------------
// The other two things worth reading off an invoice
// ---------------------------------------------------------------------------
//
// Same rules as the reference above, and the same modesty: these fill boxes
// somebody would otherwise type, they are always shown where they can be
// corrected, and every one of them would rather say nothing than say something
// wrong. A blank box is the behaviour all of this replaced.

/** Labels a supplier puts their invoice date beside. Most specific first, and
 *  "tax point" ahead of the bare word: an invoice that carries both is telling
 *  us the tax point is the one that counts. */
const DATE_LABELS: RegExp[] = [
  /\btax\s+point(?:\s+date)?\b/i,
  /\binvoice\s+date\b/i,
  /\bdate\s+of\s+invoice\b/i,
  /\bdocument\s+date\b/i,
  /\bdated?\b/i,
]

/** A label that belongs to somebody else's date, or to a date that is not the
 *  tax point. A due date read as an invoice date puts the terms on twice. */
const NOT_THE_INVOICE_DATE = /\b(?:due|delivery|deliver|despatch|dispatch|ship|order|payment|received?|print(?:ed)?|expiry|expires?)\b/i

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** A year as four digits. Two-digit years are this century: an invoice dated 97
 *  is a scanning error, not a document from 1997. */
function fullYear(value: number): number {
  return value >= 100 ? value : 2000 + value
}

/** Whether these three numbers are a day a supplier could plausibly have
 *  invoiced on. Deliberately narrow at both ends - a "date" in 1970 or 2098 is
 *  a page number that happened to have slashes in it. */
function plausible(year: number, month: number, dayOfMonth: number, now: Date): boolean {
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return false
  const thisYear = now.getUTCFullYear()
  if (year < thisYear - 10 || year > thisYear + 1) return false
  // The date has to survive being one: the 31st of February does not.
  const made = new Date(Date.UTC(year, month - 1, dayOfMonth))
  return made.getUTCFullYear() === year && made.getUTCMonth() === month - 1 && made.getUTCDate() === dayOfMonth
}

/**
 * The first date in a piece of text, as a plain YYYY-MM-DD, or null.
 *
 * Three shapes, which between them cover every invoice yet seen: 12/08/2026,
 * 2026-08-12, and 12 August 2026.
 *
 * Day first where it is ambiguous. This is a British platform, every supplier
 * on it writes 08/09 meaning the eighth of September, and a guess that reads it
 * as the ninth of August would be wrong far more often than it was right. A
 * first number over twelve settles it either way.
 */
export function dateInText(fragment: string, now: Date = new Date()): string | null {
  const numeric = /\b(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/.exec(fragment)
  if (numeric) {
    const first = Number(numeric[1])
    const second = Number(numeric[2])
    const third = Number(numeric[3])
    // ISO, which is the one shape where the year comes first.
    if (numeric[1]!.length === 4) {
      if (plausible(first, second, third, now)) return `${first}-${twoDigits(second)}-${twoDigits(third)}`
    } else {
      const year = fullYear(third)
      // Day first, always tried first. Only where that cannot be read at all -
      // a first number over twelve in the month's place - is the American order
      // tried, and 08/09 stays the eighth of September.
      if (plausible(year, second, first, now)) return `${year}-${twoDigits(second)}-${twoDigits(first)}`
      if (plausible(year, first, second, now)) return `${year}-${twoDigits(first)}-${twoDigits(second)}`
    }
  }

  const written = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})\b/.exec(fragment)
  if (written) {
    const month = MONTHS[written[2]!.slice(0, 3).toLowerCase()]
    const year = fullYear(Number(written[3]))
    if (month && plausible(year, month, Number(written[1]), now)) {
      return `${year}-${twoDigits(month)}-${twoDigits(Number(written[1]))}`
    }
  }

  // "August 12, 2026", which is what an American accounting package prints.
  const monthFirst = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/.exec(fragment)
  if (monthFirst) {
    const month = MONTHS[monthFirst[1]!.slice(0, 3).toLowerCase()]
    const year = fullYear(Number(monthFirst[3]))
    if (month && plausible(year, month, Number(monthFirst[2]), now)) {
      return `${year}-${twoDigits(month)}-${twoDigits(Number(monthFirst[2]))}`
    }
  }

  return null
}

/**
 * The invoice date off the text of a document, or null.
 *
 * Same two shapes as the reference: beside its label, or on one of the next few
 * lines. A label carrying somebody else's word in front of it - "due date",
 * "delivery date" - is skipped, because a due date read as a tax point puts the
 * payment terms on the bill twice.
 */
export function dateFromText(text: string, now: Date = new Date()): string | null {
  const lines = text.split(/[\r\n]+/).map((line) => line.trim())

  for (const label of DATE_LABELS) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      const found = label.exec(line)
      if (!found) continue
      const before = line.slice(0, found.index)
      if (NOT_THE_INVOICE_DATE.test(before)) continue
      // "Date due" and "Date of delivery" put the disqualifying word after the
      // label rather than in front of it.
      const after = line.slice(found.index + found[0].length)
      if (NOT_THE_INVOICE_DATE.test(after.slice(0, 12))) continue

      const sameLine = dateInText(after, now)
      if (sameLine) return sameLine

      for (let ahead = 1; ahead <= 3 && i + ahead < lines.length; ahead += 1) {
        const next = lines[i + ahead]!
        if (!next) continue
        const found2 = dateInText(next, now)
        if (found2) return found2
      }
    }
  }
  return null
}

/** Labels a supplier puts the figure they want paying beside, most specific
 *  first. The plain word "total" is last for a reason: it also sits beside the
 *  net, the VAT and the total of every column on the page. */
const TOTAL_LABELS: RegExp[] = [
  /\b(?:total|balance|amount)\s+(?:now\s+)?due\b/i,
  /\b(?:invoice|grand|document)\s+total\b/i,
  /\btotal\s+(?:to\s+pay|payable)\b/i,
  /\btotal\s*\(?\s*(?:inc|incl|including)\b[^)]*\)?/i,
  /\bamount\s+payable\b/i,
  /\btotal\b/i,
]

/** A label that is about part of the invoice rather than the whole of it. */
const NOT_THE_TOTAL = /\b(?:sub[\s-]?total|net|goods|vat|tax|discount|carriage|delivery|weight|qty|quantity|lines?|items?|excl?(?:uding)?)\b/i

/** Money as an invoice prints it: an optional symbol, thousands separators, and
 *  always the two pence. A figure with no decimal places is a quantity, a page
 *  number or a postcode far more often than it is a total. */
const MONEY = /(?:[£$€]\s?)?(-?\d{1,3}(?:,\d{3})+|-?\d+)\.(\d{2})\b/g

/** Every money-looking figure in a fragment, in pounds, in the order printed. */
function moneyIn(fragment: string): string[] {
  const out: string[] = []
  MONEY.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MONEY.exec(fragment)) !== null) {
    out.push(`${match[1]!.replace(/,/g, '')}.${match[2]}`)
  }
  return out
}

/**
 * What the document says it comes to, as a plain amount, or null.
 *
 * The LAST figure on the label's line, because a totals block prints its label
 * on the left and its figure on the right, and anything between the two is a
 * VAT rate or a column heading. Everything about this is a guess and the screen
 * treats it as one: it goes in a box beside our own arithmetic, and where the
 * two disagree the bill says so rather than either of them winning.
 */
export function totalFromText(text: string): string | null {
  const lines = text.split(/[\r\n]+/).map((line) => line.trim())

  for (const label of TOTAL_LABELS) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!
      const found = label.exec(line)
      if (!found) continue
      const prefix = line.slice(0, found.index)
      // "Sub-total" and "Subtotal" both contain a perfectly good \btotal\b -
      // a hyphen is a word boundary - so the character in front of the match
      // decides whether this is the word or the end of a longer one.
      if (/[A-Za-z-]$/.test(prefix)) continue
      if (NOT_THE_TOTAL.test(prefix)) continue

      const after = line.slice(found.index + found[0].length)
      // "Total excluding VAT" and "Total VAT" are both real labels and neither
      // is the figure being asked for here.
      if (NOT_THE_TOTAL.test(after.slice(0, 20))) continue

      const here = moneyIn(after)
      if (here.length > 0) return here[here.length - 1]!

      for (let ahead = 1; ahead <= 3 && i + ahead < lines.length; ahead += 1) {
        const next = lines[i + ahead]!
        if (!next) continue
        const ahead2 = moneyIn(next)
        if (ahead2.length > 0) return ahead2[ahead2.length - 1]!
      }
    }
  }
  return null
}

/** Everything worth reading off a supplier's invoice. Every field independently
 *  null: a scan with no text layer answers none of them, a tidy PDF answers all
 *  three, and most answer two. */
export type GuessedInvoice = {
  reference: string | null
  date: string | null
  total: string | null
}

/**
 * What we think is on the supplier's invoice, off the file they sent.
 *
 * Never throws. A PDF that will not parse, a photograph, a password-protected
 * file, a scan with no text layer: all of them come back as nulls, which leaves
 * every box exactly as empty as it was before.
 */
export function guessInvoiceDetails(
  filename: string,
  bytes: Uint8Array,
  ours: string | null = null,
  now: Date = new Date(),
): GuessedInvoice {
  let text: string | null = null
  try {
    text = pdfText(bytes)
  } catch (error) {
    // Reading somebody else's PDF is best-effort by definition, and a file that
    // breaks the reader must not break the upload it arrived on.
    console.error('[purchase-orders] could not read the text of', filename, error)
  }

  return {
    reference: (text ? referenceFromText(text, 'invoice', ours) : null) ?? referenceFromFilename(filename, ours),
    date: text ? dateFromText(text, now) : null,
    total: text ? totalFromText(text) : null,
  }
}
