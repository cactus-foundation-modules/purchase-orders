import {
  dictOf,
  isDict,
  isRef,
  nameOf,
  parseValue,
  readObjectAt,
  refsIn,
  serialise,
  skipSpace,
  type PdfDict,
  type PdfObject,
  type PdfRef,
  type PdfValue,
} from '@/modules/purchase-orders/lib/pdf-objects'
import { encryptionFromDict, pdfPages } from '@/modules/purchase-orders/lib/pdf-text'

// Cutting some pages out of a PDF as a file of their own.
//
// A supplier who sends a day's invoices as one file, one invoice to a page,
// wants each one filed on its own purchase order. lib/supplier-document.ts says
// which pages are which invoice; this makes the file for each.
//
// By hand, for the same reason lib/pdf-text.ts is: a module cannot add a
// dependency. It is also the only approach that works on these particular
// files, because every one of them is encrypted, and the obvious library
// refuses encrypted files outright.
//
// The trick that keeps it small is to change as little as possible. Every
// object the chosen pages use is copied byte for byte under its own number and
// generation, and the encryption dictionary and file ID go across untouched.
// Encryption keys are worked out per object from exactly those three things, so
// everything copied still decrypts. What is written new is only what has to be:
// the page tree node, listing just the chosen pages, a catalogue that points at
// it and nothing else (outlines, forms and names would point at pages that are
// gone), and a fresh cross-reference table.
//
// It refuses rather than guesses. Anything outside that shape - a
// cross-reference stream, objects packed into object streams, a file that has
// been appended to, encryption it cannot open, pages that share annotations or
// point at one another - comes back null, and so does every file that does not
// read back afterwards as exactly the pages asked for. The caller then files the
// whole original instead: slower to read, never wrong.

/** What a chosen PAGE points at and is not followed: its /Parent is the page
 *  tree node, which is written afresh. Everywhere else /Parent is followed like
 *  any other key - a form field's widget has one pointing at the field, and a
 *  copy that dropped the field would point at nothing. */
const NOT_FOLLOWED_FROM_A_PAGE: ReadonlySet<string> = new Set(['Parent'])
const FOLLOW_EVERYTHING: ReadonlySet<string> = new Set()

/** Attributes a page may inherit from its page tree node. They are carried onto
 *  the new node so a page that relied on them still has them. */
const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate']

/** Enough for any batch of invoices. */
const MAX_COPIED_OBJECTS = 20_000

type XrefEntry = { offset: number; gen: number }

/**
 * The classic cross-reference table and trailer at `startxref`, or null for
 * anything else: a cross-reference stream, a table that does not parse, a
 * trailer pointing at an earlier section.
 */
function readClassicXref(
  file: Buffer,
): { entries: Map<number, XrefEntry>; free: Map<number, XrefEntry>; trailer: PdfDict } | null {
  const text = file.toString('latin1')
  const startAt = text.lastIndexOf('startxref')
  if (startAt === -1) return null
  const offset = Number(/^startxref\s+(\d+)/.exec(text.slice(startAt, startAt + 40))?.[1] ?? Number.NaN)
  if (!Number.isInteger(offset) || offset <= 0 || offset >= file.length) return null
  if (text.slice(offset, offset + 4) !== 'xref') return null

  const entries = new Map<number, XrefEntry>()
  const free = new Map<number, XrefEntry>()
  let at = skipSpace(file, offset + 4)
  for (;;) {
    const section = /^(\d+)\s+(\d+)[ \t]*(?:\r\n|\r|\n)/.exec(text.slice(at, at + 40))
    if (!section) break
    const first = Number(section[1])
    const count = Number(section[2])
    at += section[0].length
    for (let n = 0; n < count; n += 1) {
      const row = /^(\d{10}) (\d{5}) ([nf])/.exec(text.slice(at, at + 20))
      if (!row) return null
      ;(row[3] === 'n' ? entries : free).set(first + n, { offset: Number(row[1]), gen: Number(row[2]) })
      // Twenty bytes a row by the spec; tolerate a writer that ends one short.
      at = skipSpace(file, at + 18)
    }
  }
  if (text.slice(at, at + 7) !== 'trailer') return null
  const parsed = parseValue(file, at + 7)
  if (!parsed || !isDict(parsed.value)) return null
  return { entries, free, trailer: parsed.value }
}

/**
 * Whether a file this module has just written has a cross-reference table that
 * is right: every object it lists is where it says, under the number and
 * generation it says, the size is the size meant, and the free list starts
 * where the spec says it must. Reading the file back cannot tell: the page
 * reader walks the file rather than trusting its table, and other readers do
 * trust it.
 *
 * Exported for the tests only, which hand it a table spoiled on purpose.
 */
export function checkWrittenXref(output: Buffer, size: number): boolean {
  const xref = readClassicXref(output)
  if (!xref || xref.trailer.entries.get('Size') !== size) return false
  const head = xref.free.get(0)
  if (!head || head.offset !== 0 || head.gen !== 65535 || xref.entries.has(0)) return false
  for (const [num, entry] of xref.entries) {
    if (num >= size) return false
    const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(output.subarray(entry.offset, entry.offset + 40).toString('latin1'))
    if (!header || Number(header[1]) !== num || Number(header[2]) !== entry.gen) return false
  }
  return true
}

function occurrences(text: string, needle: string): number {
  let count = 0
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1
  return count
}

/**
 * A new file holding pages `from` to `to` (1-based, inclusive) of `bytes`, or
 * null where that cannot be done safely.
 *
 * `mustContain` is text the new file has to be seen to hold once it is read
 * back - the supplier reference the pages were chosen by - as a last check that
 * the pages cut are the pages meant.
 */
export function extractPages(bytes: Uint8Array, range: [number, number], mustContain?: string | null): Uint8Array | null {
  try {
    return extract(bytes, range, mustContain ?? null)
  } catch (error) {
    // A file that breaks the splitter is a file filed whole, not a failed mail.
    console.error('[purchase-orders] could not split a PDF', error)
    return null
  }
}

function extract(bytes: Uint8Array, [from, to]: [number, number], mustContain: string | null): Uint8Array | null {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (file.subarray(0, 5).toString('latin1') !== '%PDF-') return null
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return null

  const text = file.toString('latin1')
  // One body, one table, one end: anything appended to since is refused, as is
  // anything packed where a byte-for-byte copy cannot reach it.
  if (occurrences(text, '%%EOF') !== 1 || occurrences(text, 'startxref') !== 1) return null
  if (/\/Type\s*\/(?:XRef|ObjStm)\b/.test(text)) return null

  const xref = readClassicXref(file)
  if (!xref) return null
  const { entries, trailer } = xref
  if (trailer.entries.has('Prev') || trailer.entries.has('XRefStm')) return null

  const cache = new Map<number, PdfObject | null>()
  const objectFor = (num: number): PdfObject | null => {
    if (cache.has(num)) return cache.get(num)!
    const entry = entries.get(num)
    const object = entry
      ? readObjectAt(file, entry.offset, { strict: true, lengthOf: (ref) => lengthOf(ref) })
      : null
    const valid = object && object.num === num && object.gen === entry!.gen ? object : null
    cache.set(num, valid)
    return valid
  }
  const lengthOf = (ref: PdfRef): number | null => {
    const entry = entries.get(ref.num)
    if (!entry) return null
    const object = readObjectAt(file, entry.offset, { strict: true })
    return object && typeof object.value === 'number' ? object.value : null
  }
  const resolve = (value: PdfValue | undefined): PdfValue | undefined =>
    isRef(value) ? (objectFor(value.num)?.value ?? undefined) : value

  // The trailer's pointers. /Encrypt must be an object of its own, as it is in
  // every file this is for; a dictionary written inline is refused.
  const rootRef = trailer.entries.get('Root')
  const encryptRef = trailer.entries.get('Encrypt')
  const size = trailer.entries.get('Size')
  const id = trailer.entries.get('ID')
  if (!isRef(rootRef) || typeof size !== 'number') return null
  if (encryptRef !== undefined) {
    if (!isRef(encryptRef)) return null
    const dict = dictOf(objectFor(encryptRef.num))
    const firstId = Array.isArray(id) ? id[0] : undefined
    const idBytes =
      typeof firstId === 'object' && firstId !== null && !Array.isArray(firstId) && firstId.type === 'string'
        ? firstId.bytes
        : Buffer.alloc(0)
    if (!dict || !encryptionFromDict(dict, idBytes)) return null
  }

  const catalogue = objectFor(rootRef.num)
  const pagesRef = dictOf(catalogue)?.entries.get('Pages')
  if (!catalogue || !isRef(pagesRef)) return null
  const pagesNode = objectFor(pagesRef.num)
  const pagesDict = dictOf(pagesNode)
  if (!pagesNode || !pagesDict || pagesNode.stream) return null

  // A flat page tree only: each chosen page is copied as it is, /Parent and
  // all, and that /Parent has to be the node written back below.
  const kids = resolve(pagesDict.entries.get('Kids'))
  if (!Array.isArray(kids) || kids.length < to) return null
  const pageRefs: PdfRef[] = []
  for (const kid of kids) {
    if (!isRef(kid)) return null
    const page = dictOf(objectFor(kid.num))
    if (!page || nameOf(page.entries.get('Type')) !== 'Page') return null
    const parent = page.entries.get('Parent')
    if (!isRef(parent) || parent.num !== pagesRef.num) return null
    pageRefs.push(kid)
  }
  const chosen = pageRefs.slice(from - 1, to)
  const chosenNums = new Set(chosen.map((ref) => ref.num))

  // Annotations belonging to a page that is staying behind must not also belong
  // to one that is going.
  const annotationsOf = (ref: PdfRef): number[] => {
    const annots = resolve(dictOf(objectFor(ref.num))?.entries.get('Annots'))
    return Array.isArray(annots) ? annots.filter(isRef).map((annot) => annot.num) : []
  }
  const leftBehind = new Set(pageRefs.filter((ref) => !chosenNums.has(ref.num)).flatMap(annotationsOf))
  if (chosen.some((ref) => annotationsOf(ref).some((num) => leftBehind.has(num)))) return null

  // Everything the chosen pages use, not following a page's own /Parent.
  // Reaching another page, the page tree or the catalogue by any other road
  // means the pages are tied to something that is not coming with them.
  const skipFor = (num: number) => (chosenNums.has(num) ? NOT_FOLLOWED_FROM_A_PAGE : FOLLOW_EVERYTHING)
  const copied = new Set<number>()
  const gather = (start: number[]): boolean => {
    const queue = [...start]
    while (queue.length) {
      const num = queue.pop()!
      if (copied.has(num)) continue
      if (num === rootRef.num || num === pagesRef.num) return false
      const object = objectFor(num)
      if (!object) return false
      const type = nameOf(dictOf(object)?.entries.get('Type'))
      if ((type === 'Page' && !chosenNums.has(num)) || type === 'Pages' || type === 'Catalog') return false
      copied.add(num)
      if (copied.size > MAX_COPIED_OBJECTS) return false
      for (const ref of refsIn(object.value, skipFor(num))) {
        if (!copied.has(ref.num)) queue.push(ref.num)
      }
    }
    return true
  }
  if (!gather(chosen.map((ref) => ref.num))) return null
  if (isRef(encryptRef) && !gather([encryptRef.num])) return null

  // The new page tree node: the old one's inheritable attributes, only the
  // chosen kids, and the right count. Written under the old number and
  // generation, so a string in it (there never is one) would still decrypt.
  const node = new Map<string, PdfValue>([
    ['Type', { type: 'name', name: 'Pages' }],
    ['Kids', chosen],
    ['Count', chosen.length],
  ])
  for (const key of INHERITED) {
    const value = pagesDict.entries.get(key)
    if (value === undefined) continue
    node.set(key, value)
    // An inherited resource is copied like anything else the pages use.
    if (!gather(refsIn(value).map((ref) => ref.num))) return null
  }

  // Closed over itself: nothing copied may point anywhere that is not being
  // written. The walk above should make this true by construction; this says
  // so rather than assuming it.
  for (const num of copied) {
    for (const ref of refsIn(objectFor(num)!.value, skipFor(num))) {
      if (!copied.has(ref.num) && ref.num !== rootRef.num && ref.num !== pagesRef.num) return null
    }
  }

  // Header: the version line, and the line of high bytes after it where the
  // original has one, which tells a transfer program the file is binary.
  const firstLineEnd = text.search(/\r\n|\r|\n/)
  if (firstLineEnd === -1) return null
  let headerEnd = firstLineEnd + (text.startsWith('\r\n', firstLineEnd) ? 2 : 1)
  const second = /^%[^\r\n]*(?:\r\n|\r|\n)/.exec(text.slice(headerEnd, headerEnd + 200))
  if (second) headerEnd += second[0].length

  const parts: Buffer[] = [file.subarray(0, headerEnd)]
  let length = headerEnd
  const offsets = new Map<number, XrefEntry>()
  const write = (chunk: Buffer) => {
    parts.push(chunk)
    length += chunk.length
  }

  const numbers = [...copied, rootRef.num, pagesRef.num].sort((a, b) => a - b)
  for (const num of numbers) {
    if (num === rootRef.num) {
      offsets.set(num, { offset: length, gen: catalogue.gen })
      write(Buffer.from(`${num} ${catalogue.gen} obj\n<< /Type /Catalog /Pages ${pagesRef.num} ${pagesNode.gen} R >>\nendobj\n`, 'latin1'))
    } else if (num === pagesRef.num) {
      offsets.set(num, { offset: length, gen: pagesNode.gen })
      write(Buffer.from(`${num} ${pagesNode.gen} obj\n${serialise({ type: 'dict', entries: node })}\nendobj\n`, 'latin1'))
    } else {
      const object = objectFor(num)!
      offsets.set(num, { offset: length, gen: object.gen })
      write(file.subarray(object.start, object.end))
      write(Buffer.from('\n', 'latin1'))
    }
  }

  // A fresh table: object 0 as the head of the free list, then one subsection
  // for each run of consecutive numbers present.
  const xrefAt = length
  const rows: string[] = ['xref\n0 1\n0000000000 65535 f \n']
  const present = [...offsets.keys()].sort((a, b) => a - b)
  for (let n = 0; n < present.length; ) {
    let end = n
    while (end + 1 < present.length && present[end + 1] === present[end]! + 1) end += 1
    rows.push(`${present[n]} ${end - n + 1}\n`)
    for (let k = n; k <= end; k += 1) {
      const entry = offsets.get(present[k]!)!
      rows.push(`${String(entry.offset).padStart(10, '0')} ${String(entry.gen).padStart(5, '0')} n \n`)
    }
    n = end + 1
  }
  const tail = new Map<string, PdfValue>([
    ['Size', size],
    ['Root', rootRef],
  ])
  if (isRef(encryptRef)) tail.set('Encrypt', encryptRef)
  if (id !== undefined) tail.set('ID', id)
  rows.push(`trailer\n${serialise({ type: 'dict', entries: tail })}\nstartxref\n${xrefAt}\n%%EOF\n`)
  write(Buffer.from(rows.join(''), 'latin1'))

  const output = Buffer.concat(parts, length)
  if (!checkWrittenXref(output, size)) return null

  // The check that makes all of the above safe to rely on: read the new file
  // back, and it must be exactly the pages asked for, saying what they said.
  // The original is read through the caller's own bytes, so a file already read
  // to decide how to split it is not read again for every piece.
  const original = pdfPages(bytes)
  const readBack = pdfPages(output)
  if (!original || !readBack || readBack.length !== to - from + 1) return null
  const expected = original.slice(from - 1, to)
  if (readBack.some((page, n) => page !== expected[n])) return null
  if (mustContain && !readBack.join('\n').toLowerCase().includes(mustContain.toLowerCase())) return null

  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
}
