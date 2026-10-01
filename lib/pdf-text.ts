import { createDecipheriv, createHash } from 'node:crypto'
import { inflateRawSync, inflateSync } from 'node:zlib'

import {
  decodeLiteralString,
  dictOf,
  indexObjects,
  isDict,
  isRef,
  isWhitespace,
  nameOf,
  parseValue,
  readHexString,
  readLiteralString,
  readName,
  readWord,
  skipSpace,
  type PdfDict,
  type PdfIndex,
  type PdfObject,
  type PdfValue,
} from '@/modules/purchase-orders/lib/pdf-objects'

// Reading the words out of a supplier's PDF.
//
// One job and one job only: a supplier sends their proforma or their order
// acknowledgement, and somewhere on it is their own reference number that
// otherwise gets typed in by hand off the screen. lib/document-reference.ts is
// what decides which number that is; this file is what turns the bytes into
// something it can read.
//
// Written by hand rather than with a library because a module cannot add an npm
// dependency - core's package.json is what an install actually installs - and
// because the whole of what is needed here is small: find the streams, undo the
// compression, and pull the strings out of the text operators. There is no
// attempt at layout, at fonts beyond the ordinary single-byte ones, or at
// anything a PDF reader would call rendering.
//
// It is deliberately unbothered by failure. Every path that cannot make sense of
// something returns null or skips that stream, because the worst outcome here is
// a field somebody fills in themselves - which is exactly what happened before
// this file existed.

/** Bigger than any invoice, small enough that a hostile file cannot spend the
 *  whole function's memory budget on one stream. */
const MAX_STREAM_BYTES = 20 * 1024 * 1024
/** The most stream data one file may decompress, all streams together. A
 *  batch of invoices is well under a megabyte; the ceiling is there for a file
 *  built to be expensive - a small stream that inflates to a huge one, or the
 *  same one listed a thousand times. Past it the file is not read by page. */
const MAX_FILE_DECODED_BYTES = 32 * 1024 * 1024
/** The most content one file may have picked over for text, counting a stream
 *  once however many pages draw it. Same reasoning, same outcome. */
const MAX_FILE_PARSED_BYTES = 64 * 1024 * 1024
/** What we will hand back. An invoice is a page or two; a hundred thousand
 *  characters is a catalogue somebody attached by mistake. */
const MAX_TEXT_CHARS = 100_000
/** A ceiling on how much of a file is picked over. An invoice is a handful of
 *  objects; anything past this is a document that was never going to answer. */
const MAX_OBJECTS = 20_000
/** How far past an object with no `endobj` after it we are prepared to read
 *  before deciding it has no dictionary worth having. */
const MAX_DICT_CHARS = 8192

/** PDF's standard padding string, from the spec's algorithm 2. Used in place of
 *  the (empty) user password, which is what every one of these files has. */
const PASSWORD_PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

/** The four bytes appended to an object key before hashing, for AES. */
const AES_SALT = Buffer.from([0x73, 0x41, 0x6c, 0x54])

export type Encryption = {
  key: Buffer
  /** RC4, or AES-128 in CBC mode with the initialisation vector on the front. */
  cipher: 'rc4' | 'aes'
}

// ---------------------------------------------------------------------------
// RC4
//
// By hand because Node's OpenSSL 3 build no longer offers it without the legacy
// provider, and because it is twenty lines. It is used here to READ a document
// somebody sent us, never to protect one.
// ---------------------------------------------------------------------------
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff
    const t = s[i]!
    s[i] = s[j]!
    s[j] = t
  }
  const out = Buffer.allocUnsafe(data.length)
  let a = 0
  let b = 0
  for (let n = 0; n < data.length; n += 1) {
    a = (a + 1) & 0xff
    b = (b + s[a]!) & 0xff
    const t = s[a]!
    s[a] = s[b]!
    s[b] = t
    out[n] = data[n]! ^ s[(s[a]! + s[b]!) & 0xff]!
  }
  return out
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------
/** What the key derivation needs out of an encryption dictionary, however it
 *  was found. */
type EncryptionParameters = {
  v: number
  r: number
  lengthBits: number | null
  aes: boolean
  /** The crypt filter is named and is neither RC4 nor AES-128. */
  unknownFilter: boolean
  owner: Buffer
  permissions: number
  encryptMetadata: boolean
  id: Buffer
}

/**
 * The file's encryption key, worked out for the EMPTY user password.
 *
 * That is not a shortcut: a document somebody emails you to read is not one they
 * have put a password on, and a file that genuinely needs a password is one this
 * returns null for - the reference then gets typed in, as it always was.
 *
 * Handles the RC4 handlers (V1, V2) and AES-128 (V4 with AESV2). AES-256 (V5,
 * revision 5 or 6) uses an entirely different key derivation and is refused
 * rather than guessed at.
 */
function deriveEncryption(p: EncryptionParameters): Encryption | null {
  if (p.r >= 5) return null
  if (p.v === 4 && p.unknownFilter) return null
  if (p.v > 4) return null
  if (p.owner.length < 32) return null

  const keyBytes = Math.max(5, Math.min(16, Math.floor((p.lengthBits ?? (p.v === 1 ? 40 : 128)) / 8)))

  const permissionBytes = Buffer.allocUnsafe(4)
  permissionBytes.writeInt32LE(p.permissions | 0, 0)

  const parts = [PASSWORD_PAD, p.owner.subarray(0, 32), permissionBytes, p.id]
  if (p.r >= 4 && !p.encryptMetadata) {
    parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]))
  }
  let key = createHash('md5').update(Buffer.concat(parts)).digest()
  if (p.r >= 3) {
    for (let i = 0; i < 50; i += 1) key = createHash('md5').update(key.subarray(0, keyBytes)).digest()
  }
  return { key: key.subarray(0, keyBytes), cipher: p.aes ? 'aes' : 'rc4' }
}

/** The encryption, found by pattern rather than by structure - the whole-file
 *  reader's way, for a file whose structure could not be followed. */
function encryptionFor(text: string): Encryption | null {
  const dictAt = text.search(/\/Filter\s*\/Standard/)
  if (dictAt === -1) return null
  // The encryption dictionary is small; a kilobyte comfortably covers it and
  // keeps a stray /O string later in the file out of the match.
  const dict = text.slice(Math.max(0, dictAt - 200), dictAt + 1200)

  const ownerAt = dict.search(/\/O\s*\(/)
  if (ownerAt === -1) return null
  const ownerOpen = dict.indexOf('(', ownerAt)
  const dictBuffer = Buffer.from(dict, 'latin1')
  const aes = /\/CFM\s*\/AESV2/.test(dict)

  return deriveEncryption({
    v: Number(/\/V\s+(\d+)/.exec(dict)?.[1] ?? 0),
    r: Number(/\/R\s+(\d+)/.exec(dict)?.[1] ?? 0),
    lengthBits: /\/Length\s+(\d+)/.test(dict) ? Number(/\/Length\s+(\d+)/.exec(dict)![1]) : null,
    aes,
    unknownFilter: !aes && !/\/CFM\s*\/V2/.test(dict),
    owner: decodeLiteralString(readLiteralString(dictBuffer, ownerOpen).bytes),
    permissions: Number(/\/P\s+(-?\d+)/.exec(dict)?.[1] ?? 0),
    encryptMetadata: !/\/EncryptMetadata\s+false/.test(dict),
    id: Buffer.from(/\/ID\s*\[\s*<([0-9A-Fa-f]*)>/.exec(text)?.[1] ?? '', 'hex'),
  })
}

/**
 * The encryption described by a parsed `/Encrypt` dictionary and the first
 * half of the trailer's `/ID`, or null where it is not one this can open.
 *
 * Exported for lib/pdf-split.ts, which must refuse a file it could not read
 * back after cutting it.
 */
export function encryptionFromDict(dict: PdfDict, id: Buffer): Encryption | null {
  const get = (key: string) => dict.entries.get(key)
  if (nameOf(get('Filter')) !== 'Standard') return null
  const owner = get('O')
  if (typeof owner !== 'object' || owner === null || Array.isArray(owner) || owner.type !== 'string') return null

  // V4 names its crypt filter; the one used for streams is the one that matters.
  let aes = false
  let unknownFilter = false
  const v = typeof get('V') === 'number' ? (get('V') as number) : 0
  if (v === 4) {
    const streamFilter = nameOf(get('StmF')) ?? 'Identity'
    const filters = get('CF')
    const filter = isDict(filters) ? filters.entries.get(streamFilter) : undefined
    const method = isDict(filter) ? nameOf(filter.entries.get('CFM')) : null
    aes = method === 'AESV2'
    unknownFilter = method !== 'AESV2' && method !== 'V2'
  }
  const length = get('Length')
  const permissions = get('P')
  return deriveEncryption({
    v,
    r: typeof get('R') === 'number' ? (get('R') as number) : 0,
    lengthBits: typeof length === 'number' ? length : null,
    aes,
    unknownFilter,
    owner: owner.bytes,
    permissions: typeof permissions === 'number' ? permissions : 0,
    encryptMetadata: get('EncryptMetadata') !== false,
    id,
  })
}

/** The per-object key: the file key with the object and generation numbers mixed
 *  in, so the same bytes in two objects do not encrypt alike. */
function objectKey(encryption: Encryption, num: number, gen: number): Buffer {
  const suffix = Buffer.from([
    num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff,
  ])
  const parts = [encryption.key, suffix]
  if (encryption.cipher === 'aes') parts.push(AES_SALT)
  const digest = createHash('md5').update(Buffer.concat(parts)).digest()
  return digest.subarray(0, Math.min(encryption.key.length + 5, 16))
}

/** Never throws: a stream we cannot decrypt is a stream we skip. */
function decryptStream(encryption: Encryption, data: Buffer, num: number, gen: number): Buffer | null {
  const key = objectKey(encryption, num, gen)
  if (encryption.cipher === 'rc4') return rc4(key, data)
  if (data.length <= 16) return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, data.subarray(0, 16))
    decipher.setAutoPadding(false)
    const out = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()])
    // Padding is PKCS#7 and worth taking off, but a wrong-looking final byte is
    // not worth throwing the whole stream away over.
    const pad = out[out.length - 1] ?? 0
    return pad > 0 && pad <= 16 && pad <= out.length ? out.subarray(0, out.length - pad) : out
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/** Zlib, or zlib with the header missing - which some writers produce and every
 *  reader is expected to cope with. Null for anything that is not compressed
 *  text we can use. */
function inflate(data: Buffer, limit = MAX_STREAM_BYTES): Buffer | null {
  return inflateCosted(data, limit).out
}

/**
 * inflate, saying what the attempt cost. A stream that inflates past its limit
 * has done all of that work before it is refused, so it costs the limit, not
 * nothing: otherwise a file of a thousand small streams that each inflate to
 * just over the limit does gigabytes of work while its budget stays untouched.
 * A stream that fails for any other reason may still have inflated a great deal
 * before the bad byte, so it costs as much as its input could have inflated to
 * (deflate's best ratio is about 1032 to 1), up to the limit.
 */
/** The most one byte of deflate data can inflate to. */
const MAX_DEFLATE_RATIO = 1032

function inflateCosted(data: Buffer, limit: number): { out: Buffer | null; cost: number } {
  const ceiling = Math.max(1, Math.min(limit, MAX_STREAM_BYTES))
  const options = { maxOutputLength: ceiling }
  const tooBig = (error: unknown) => (error as { code?: string } | null)?.code === 'ERR_BUFFER_TOO_LARGE'
  try {
    const out = inflateSync(data, options)
    return { out, cost: out.length }
  } catch (error) {
    if (tooBig(error)) return { out: null, cost: ceiling }
    try {
      const out = inflateRawSync(data, options)
      return { out, cost: out.length }
    } catch (rawError) {
      return { out: null, cost: tooBig(rawError) ? ceiling : Math.min(ceiling, data.length * MAX_DEFLATE_RATIO) }
    }
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * The strings out of one content stream, in the order the page draws them.
 *
 * A line break goes in wherever the text position moves, which is what turns a
 * page into something with "Invoice No." on one line and the number on the next.
 * It is not layout - two columns interleave - but a label and its value are
 * drawn one after the other on every invoice yet seen, and that is the whole of
 * what is asked of this.
 *
 * Bytes become characters one for one. Anything with a multi-byte CMap comes out
 * as nonsense, and nonsense simply fails to match a label later.
 */
function textFromContentStream(data: Buffer): string {
  const out: string[] = []
  let i = 0
  while (i < data.length) {
    const c = data[i]!

    if (c === 0x28) {
      const { bytes, end } = readLiteralString(data, i)
      out.push(decodeLiteralString(bytes).toString('latin1'))
      i = end
      continue
    }

    // A hex string, but not a dictionary - "<<" opens one of those.
    if (c === 0x3c && data[i + 1] !== 0x3c) {
      const close = data.indexOf(0x3e, i + 1)
      if (close === -1) break
      const hex = data.subarray(i + 1, close).toString('latin1').replace(/[^0-9A-Fa-f]/g, '')
      out.push(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1'))
      i = close + 1
      continue
    }

    // An inline image. Its bytes are not text and can contain anything at all,
    // brackets included, so it is skipped whole.
    if (c === 0x42 && data[i + 1] === 0x49 && (data[i + 2] ?? 0x20) <= 0x20) {
      const end = data.indexOf('EI', i + 2, 'latin1')
      i = end === -1 ? data.length : end + 2
      continue
    }

    // The operators that move the text position, each of which ends a line.
    if (c === 0x54) {
      const next = data[i + 1]
      if (next === 0x64 || next === 0x44 || next === 0x2a) {
        out.push('\n')
        i += 2
        continue
      }
    }
    // ' and " both move to the next line before showing their string.
    if (c === 0x27 || c === 0x22) {
      out.push('\n')
      i += 1
      continue
    }

    i += 1
  }
  return out.join('')
}

/**
 * Every readable word in a PDF, as one string, found WITHOUT following the
 * file's structure - the fallback for a file whose page tree could not be
 * walked, and exactly the reader this file had before it could read by page.
 *
 * Objects are found by scanning for them rather than by following the
 * cross-reference table: a scan copes with a file that has been appended to, one
 * whose table is wrong, and one whose table is itself a compressed stream -
 * three things that are common and would each need their own parser.
 */
function pdfTextByScan(bytes: Uint8Array): string | null {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (file.subarray(0, 5).toString('latin1') !== '%PDF-') return null

  const text = file.toString('latin1')
  const encryption = /\/Encrypt\s/.test(text) ? encryptionFor(text) : null
  // An encrypted file we cannot unlock has nothing to offer: every stream in it
  // is noise, and scanning them all to prove it is time spent for nothing.
  if (/\/Encrypt\s/.test(text) && !encryption) return null

  const pieces: string[] = []
  let total = 0
  let decoded = 0
  const objects = /(\d+)\s+(\d+)\s+obj\b/g
  let match: RegExpExecArray | null
  let scanned = 0
  while ((match = objects.exec(text)) !== null) {
    if (total >= MAX_TEXT_CHARS) break
    scanned += 1
    if (scanned > MAX_OBJECTS) break

    const num = Number(match[1])
    const gen = Number(match[2])
    // The dictionary is looked at inside its own object and nowhere else.
    // Searching the whole file forward for the next "stream" from every object
    // in turn is quadratic, and a big file has tens of thousands of them.
    const objectEnd = text.indexOf('endobj', match.index)
    const dictEnd = objectEnd === -1 ? Math.min(text.length, match.index + MAX_DICT_CHARS) : objectEnd
    const head = text.slice(match.index, dictEnd)
    const streamOffset = head.indexOf('stream')
    if (streamOffset === -1) continue
    const streamAt = match.index + streamOffset

    const dict = head.slice(0, streamOffset)
    // Flate, or nothing at all - a content stream is one or the other. Anything
    // else in the filter list is a picture or a font wearing a stream, and
    // inflating every one of those to find no words is the slowest way to learn
    // nothing.
    const filter = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(dict)?.[1] ?? ''
    const flate = /FlateDecode/.test(filter)
    if (filter && !flate) continue
    if (/\/Subtype\s*\/Image|\/Type\s*\/(?:XRef|ObjStm|Font|Metadata)/.test(dict)) continue

    let from = streamAt + 'stream'.length
    if (text.startsWith('\r\n', from)) from += 2
    else if (text[from] === '\n' || text[from] === '\r') from += 1

    const declared = Number(/\/Length\s+(\d+)/.exec(dict)?.[1] ?? Number.NaN)
    let to = -1
    // The declared length is the only reliable end: "endstream" is nine ordinary
    // bytes and encrypted data contains whatever it likes. It is trusted only
    // when the file agrees that the stream ends where it says it does.
    if (Number.isFinite(declared) && declared > 0 && from + declared <= file.length) {
      const after = text.slice(from + declared, from + declared + 20)
      if (/^\s*endstream/.test(after)) to = from + declared
    }
    if (to === -1) to = text.indexOf('endstream', from)
    if (to === -1 || to <= from || to - from > MAX_STREAM_BYTES) continue

    let raw = file.subarray(from, to)
    if (encryption) {
      const plain = decryptStream(encryption, raw, num, gen)
      if (!plain) continue
      raw = plain
    }

    // The same ceiling on decompression as the page reader has: a file that
    // fails there for being too expensive must not simply cost as much here.
    if (decoded >= MAX_FILE_DECODED_BYTES) break
    const inflated = flate ? inflateCosted(raw, MAX_FILE_DECODED_BYTES - decoded) : { out: raw, cost: raw.length }
    decoded += inflated.cost
    const body = inflated.out
    if (!body) continue

    const piece = textFromContentStream(body)
    if (!piece.trim()) continue
    pieces.push(piece)
    total += piece.length
  }

  if (!pieces.length) return null
  return pieces.join('\n').slice(0, MAX_TEXT_CHARS)
}

// ---------------------------------------------------------------------------
// Reading by page
// ---------------------------------------------------------------------------
//
// A supplier who sends a day's invoices as one file, one invoice to a page,
// needs the file read a page at a time: which page says what is how the file
// gets split into the invoices it holds (lib/supplier-document.ts). That means
// following the structure - catalogue, page tree, each page's content - rather
// than scanning, and it means knowing where on the page each piece of text sits.

/** More pages than any batch of invoices, few enough that a page tree built as
 *  a trap cannot keep the walk going. */
const MAX_PAGES = 2000
/** How deep one form may draw another. Real documents go one level. */
const MAX_FORM_DEPTH = 8
/** The most text read out of one file, across all its pages. A file with more
 *  is not read by page at all: it is read whole, as one document. */
const MAX_FILE_CHARS = 500_000
/** The width of a character whose font does not say, as a share of the type
 *  size. Near enough the average for the sans-serif faces invoices use. */
const DEFAULT_GLYPH_WIDTH = 0.5

/** A piece of text, where it starts, how big it is, and roughly how wide. */
type Run = { x: number; y: number; size: number; width: number; text: string }

/** One `Tf` font's widths, in thousandths of the type size, by character code. */
type Widths = { first: number; widths: number[]; missing: number }

type Matrix = [number, number, number, number, number, number]

/**
 * The file, indexed, with its encryption worked out once, and what reading it
 * has cost so far. Every stream is decoded at most once per file and every form
 * read for text at most once, however many pages draw them: without that, one
 * form drawn on two thousand pages, or one stream listed as a page's content a
 * thousand times, turns a small file into minutes and gigabytes.
 */
type Document = {
  file: Buffer
  index: PdfIndex
  encryption: Encryption | null
  decoded: Map<number, Buffer | null>
  formRuns: Map<number, Run[]>
  widths: WeakMap<PdfDict, Map<string, Widths | null>>
  budget: { decoded: number; parsed: number; chars: number }
  /** A budget ran out: the text read is incomplete and must not be trusted. */
  exhausted: boolean
}

function newDocument(file: Buffer): Document {
  return {
    file,
    index: indexObjects(file),
    encryption: null,
    decoded: new Map(),
    formRuns: new Map(),
    widths: new WeakMap(),
    budget: { decoded: MAX_FILE_DECODED_BYTES, parsed: MAX_FILE_PARSED_BYTES, chars: MAX_FILE_CHARS },
    exhausted: false,
  }
}

function resolve(doc: Document, value: PdfValue | undefined, hops = 0): PdfValue | undefined {
  if (isRef(value) && hops < 8) return resolve(doc, doc.index.objects.get(value.num)?.value, hops + 1)
  return value
}

function resolveDict(doc: Document, value: PdfValue | undefined): PdfDict | null {
  const found = resolve(doc, value)
  return isDict(found) ? found : null
}

/** A stream's bytes, decrypted and decompressed, or null for anything that is
 *  not Flate or plain - which, for the streams read here, is nothing real. */
function streamData(doc: Document, object: PdfObject): Buffer | null {
  // Objects are one per number in the index, so the number is the key.
  if (doc.decoded.has(object.num)) return doc.decoded.get(object.num)!
  const data = decodeStream(doc, object)
  doc.decoded.set(object.num, data)
  return data
}

function decodeStream(doc: Document, object: PdfObject): Buffer | null {
  if (doc.budget.decoded <= 0) {
    doc.exhausted = true
    return null
  }
  if (!object.stream) return null
  const dict = dictOf(object)
  if (!dict) return null
  const length = object.stream.end - object.stream.start
  if (length <= 0 || length > MAX_STREAM_BYTES) return length === 0 ? Buffer.alloc(0) : null

  let raw: Buffer | null = doc.file.subarray(object.stream.start, object.stream.end)
  if (doc.encryption && nameOf(dict.entries.get('Type')) !== 'XRef') {
    raw = decryptStream(doc.encryption, raw, object.num, object.gen)
    if (!raw) return null
  }

  const filter = resolve(doc, dict.entries.get('Filter'))
  const filters = Array.isArray(filter) ? filter.map(nameOf) : filter === undefined ? [] : [nameOf(filter)]
  if (filters.some((name) => name !== 'FlateDecode' && name !== 'Fl')) return null
  // A predictor turns the data into rows of an image. Content never has one.
  const parms = resolveDict(doc, Array.isArray(dict.entries.get('DecodeParms')) ? undefined : dict.entries.get('DecodeParms'))
  const predictor = parms?.entries.get('Predictor')
  if (typeof predictor === 'number' && predictor > 1) return null
  if (!filters.length) {
    doc.budget.decoded -= raw.length
    return raw
  }
  // What an attempt cost is charged whether it worked or not, and a budget
  // spent by it - a stream too big for what was left, or one too big at all
  // many times over - ends the reading of the file by page.
  const { out, cost } = inflateCosted(raw, doc.budget.decoded)
  doc.budget.decoded -= cost
  if (doc.budget.decoded <= 0) doc.exhausted = true
  return out
}

/**
 * The objects inside object streams, added to the index beside the ones that
 * stand on their own. A file saved by a modern writer keeps its page objects in
 * these, and a page tree that cannot be found is a file read as one lump.
 *
 * An object written on its own wins over one packed in a stream: the only file
 * with both is one that has been updated, and the update is what stands alone.
 */
function unpackObjectStreams(doc: Document): void {
  const packed = [...doc.index.objects.values()].filter(
    (object) => nameOf(dictOf(object)?.entries.get('Type')) === 'ObjStm',
  )
  for (const container of packed) {
    const dict = dictOf(container)!
    const count = dict.entries.get('N')
    const first = dict.entries.get('First')
    if (typeof count !== 'number' || typeof first !== 'number') continue
    const data = streamData(doc, container)
    if (!data) continue

    let at = 0
    const pairs: Array<[number, number]> = []
    for (let n = 0; n < count && n < MAX_PAGES * 10; n += 1) {
      const num = readWord(data, skipSpace(data, at))
      const offset = readWord(data, skipSpace(data, num.end))
      if (!/^\d+$/.test(num.word) || !/^\d+$/.test(offset.word)) break
      pairs.push([Number(num.word), Number(offset.word)])
      at = offset.end
    }
    for (const [num, offset] of pairs) {
      if (doc.index.objects.has(num)) continue
      const parsed = parseValue(data, first + offset)
      if (!parsed) continue
      doc.index.objects.set(num, { num, gen: 0, value: parsed.value, stream: null, start: -1, end: -1 })
    }
  }
}

function fontWidths(doc: Document, resources: PdfDict | null, fontName: string): Widths | null {
  if (!resources) return null
  let known = doc.widths.get(resources)
  if (!known) {
    known = new Map()
    doc.widths.set(resources, known)
  }
  if (!known.has(fontName)) known.set(fontName, readFontWidths(doc, resources, fontName))
  return known.get(fontName)!
}

function readFontWidths(doc: Document, resources: PdfDict | null, fontName: string): Widths | null {
  const fonts = resolveDict(doc, resources?.entries.get('Font'))
  const font = resolveDict(doc, fonts?.entries.get(fontName))
  if (!font) return null
  const first = resolve(doc, font.entries.get('FirstChar'))
  const widths = resolve(doc, font.entries.get('Widths'))
  if (typeof first !== 'number' || !Array.isArray(widths)) return null
  const descriptor = resolveDict(doc, font.entries.get('FontDescriptor'))
  const missing = resolve(doc, descriptor?.entries.get('MissingWidth'))
  return {
    first,
    widths: widths.map((w) => (typeof w === 'number' ? w : 0)),
    missing: typeof missing === 'number' ? missing : 0,
  }
}

/**
 * Every piece of text a content stream draws, with where it draws it.
 *
 * Follows the text operators closely enough to know each piece's position and
 * roughly how far it runs, and follows `Do` into the forms a page draws -
 * some accounting packages put a page's entire content in one. It does not
 * follow the graphics transformation (`cm`): every page yet seen draws its text
 * unscaled, and the only use made of the positions is to tell which pieces
 * share a line and how far apart they are.
 */
function runsFromContent(
  doc: Document,
  data: Buffer,
  resources: PdfDict | null,
  depth: number,
  out: Run[],
  seenForms: Set<number>,
): void {
  doc.budget.parsed -= data.length
  if (doc.budget.parsed < 0) {
    doc.exhausted = true
    return
  }
  const budget = doc.budget
  const identity = (): Matrix => [1, 0, 0, 1, 0, 0]
  let tm = identity()
  let tlm = identity()
  let size = 10
  let widths: Widths | null = null
  let charSpacing = 0
  let wordSpacing = 0
  let scale = 1
  let leading = 0
  const operands: Array<number | string | Buffer | Array<number | Buffer>> = []

  const moveTo = (tx: number, ty: number) => {
    const [a, b, c, d, e, f] = tlm
    tlm = [a, b, c, d, tx * a + ty * c + e, tx * b + ty * d + f]
    tm = [...tlm]
  }

  const advanceOf = (bytes: Buffer): number => {
    let total = 0
    for (const code of bytes) {
      const w = widths
        ? (widths.widths[code - widths.first] ?? widths.missing) / 1000
        : DEFAULT_GLYPH_WIDTH
      total += w * size + charSpacing + (code === 0x20 ? wordSpacing : 0)
    }
    return total * scale
  }

  const show = (parts: Array<number | Buffer>) => {
    let text = ''
    let advance = 0
    for (const part of parts) {
      if (typeof part === 'number') {
        advance -= (part / 1000) * size * scale
      } else {
        text += part.toString('latin1')
        advance += advanceOf(part)
      }
    }
    const [a, b, , d, e, f] = tm
    const run = { x: e, y: f, size: Math.abs(size * (d || a || 1)), width: advance * a, text }
    tm = [tm[0], tm[1], tm[2], tm[3], e + advance * a, f + advance * b]
    if (!text.trim()) return
    if (budget.chars <= 0) {
      // Text left and no allowance to read it: the pages would come back cut
      // short, and a short page reads as a page with nothing on it - which is
      // how a batch of invoices gets glued into one. Say so instead.
      doc.exhausted = true
      return
    }
    budget.chars -= text.length
    out.push(run)
  }

  let i = 0
  while (i < data.length) {
    i = skipSpace(data, i)
    if (i >= data.length) break
    const c = data[i]!

    if (c === 0x28) {
      const { bytes, end } = readLiteralString(data, i)
      operands.push(decodeLiteralString(bytes))
      i = end
      continue
    }
    if (c === 0x3c && data[i + 1] === 0x3c) {
      // An inline dictionary, which only marked-content operators take. Its
      // contents are of no interest; getting past it whole is.
      const parsed = parseValue(data, i)
      i = parsed ? parsed.end : i + 2
      operands.push(0)
      continue
    }
    if (c === 0x3c) {
      const hex = readHexString(data, i)
      if (!hex) break
      operands.push(hex.bytes)
      i = hex.end
      continue
    }
    if (c === 0x5b) {
      // A TJ array: strings and the adjustments between them.
      const items: Array<number | Buffer> = []
      i += 1
      for (;;) {
        i = skipSpace(data, i)
        if (i >= data.length || data[i] === 0x5d) {
          i += 1
          break
        }
        if (data[i] === 0x28) {
          const { bytes, end } = readLiteralString(data, i)
          items.push(decodeLiteralString(bytes))
          i = end
        } else if (data[i] === 0x3c) {
          const hex = readHexString(data, i)
          if (!hex) {
            i = data.length
            break
          }
          items.push(hex.bytes)
          i = hex.end
        } else {
          const { word, end } = readWord(data, i)
          if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) items.push(Number(word))
          i = end > i ? end : i + 1
        }
      }
      operands.push(items)
      continue
    }
    if (c === 0x2f) {
      const { name, end } = readName(data, i)
      operands.push(name)
      i = end
      continue
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      i += 1
      continue
    }

    const { word, end } = readWord(data, i)
    i = end > i ? end : i + 1
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
      operands.push(Number(word))
      continue
    }

    const num = (n: number) => {
      const value = operands[operands.length - n]
      return typeof value === 'number' ? value : 0
    }
    switch (word) {
      case 'BT':
        tm = identity()
        tlm = identity()
        break
      case 'Tf': {
        size = num(1)
        const name = operands[operands.length - 2]
        widths = typeof name === 'string' ? fontWidths(doc, resources, name) : null
        break
      }
      case 'Tc':
        charSpacing = num(1)
        break
      case 'Tw':
        wordSpacing = num(1)
        break
      case 'Tz':
        scale = num(1) / 100
        break
      case 'TL':
        leading = num(1)
        break
      case 'Td':
        moveTo(num(2), num(1))
        break
      case 'TD':
        leading = -num(1)
        moveTo(num(2), num(1))
        break
      case 'Tm':
        tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]
        tm = [...tlm]
        break
      case 'T*':
        moveTo(0, -leading)
        break
      case 'Tj':
      case "'":
      case '"': {
        if (word !== 'Tj') moveTo(0, -leading)
        if (word === '"') {
          wordSpacing = num(3)
          charSpacing = num(2)
        }
        const text = operands[operands.length - 1]
        if (Buffer.isBuffer(text)) show([text])
        break
      }
      case 'TJ': {
        const items = operands[operands.length - 1]
        if (Array.isArray(items)) show(items)
        break
      }
      case 'Do': {
        const name = operands[operands.length - 1]
        if (typeof name === 'string' && depth < MAX_FORM_DEPTH) {
          const xobjects = resolveDict(doc, resources?.entries.get('XObject'))
          const ref = xobjects?.entries.get(name)
          const form = isRef(ref) ? doc.index.objects.get(ref.num) : undefined
          const formDict = dictOf(form)
          if (form && formDict && nameOf(formDict.entries.get('Subtype')) === 'Form' && !seenForms.has(form.num)) {
            // A form is drawn once per Do, but reading it twice on one page only
            // repeats its words, and forms reached from inside themselves are a
            // loop: both are what seenForms stops. A form another page has
            // already read is not read again - its text is the same text.
            seenForms.add(form.num)
            let runs = doc.formRuns.get(form.num)
            if (!runs) {
              runs = []
              const body = streamData(doc, form)
              const own = resolveDict(doc, formDict.entries.get('Resources'))
              if (body) runsFromContent(doc, body, own ?? resources, depth + 1, runs, seenForms)
              doc.formRuns.set(form.num, runs)
              for (const run of runs) out.push(run)
            } else {
              // Counted again against this file's text, as it is text again.
              for (const run of runs) {
                if (budget.chars <= 0) {
                  doc.exhausted = true
                  break
                }
                budget.chars -= run.text.length
                out.push(run)
              }
            }
          }
        }
        break
      }
      case 'BI': {
        // An inline image: its bytes are not text and may contain anything. It
        // ends at an "EI" standing on its own between whitespace. Searched for
        // from here with indexOf, never by turning the whole stream into a
        // string again: a page of a thousand tiny images must not cost a
        // thousand copies of itself.
        let at = data.indexOf('EI', i, 'latin1')
        while (at !== -1 && !(isWhitespace(data[at - 1]) && (at + 2 >= data.length || isWhitespace(data[at + 2])))) {
          at = data.indexOf('EI', at + 2, 'latin1')
        }
        i = at === -1 ? data.length : at + 2
        break
      }
    }
    operands.length = 0
  }
}

/**
 * Pieces of text into lines.
 *
 * Pieces drawn one after another on the same line join up, in order across the
 * page, with a single space between neighbours and three where a gap of more
 * than a character or so separates them - which is how a two-column layout
 * reads: "Invoice Date   29/09/2026" rather than the date on one line and its
 * label on the next. Pieces that are not drawn one after another stay on lines
 * of their own even when they share a height, because the order a page is drawn
 * in is the best clue there is to what belongs with what.
 */
function linesFromRuns(runs: Run[]): string[] {
  const lines: string[] = []
  let group: Run[] = []

  const flush = () => {
    if (!group.length) return
    const sorted = [...group].sort((a, b) => a.x - b.x)
    let line = sorted[0]!.text
    for (let n = 1; n < sorted.length; n += 1) {
      const before = sorted[n - 1]!
      const run = sorted[n]!
      const gap = run.x - (before.x + before.width)
      const em = before.size || 10
      line += gap > em * 1.5 ? '   ' : gap > em * 0.2 ? ' ' : ''
      line += run.text
    }
    lines.push(line)
    group = []
  }

  for (const run of runs) {
    const previous = group[group.length - 1]
    if (previous && Math.abs(run.y - previous.y) > Math.max(1, Math.min(run.size, previous.size) * 0.35)) flush()
    group.push(run)
  }
  flush()
  return lines
}

/** A page's content streams, in order: `/Contents` is one stream or an array. */
function contentOf(doc: Document, page: PdfDict): Buffer {
  const contents = resolve(doc, page.entries.get('Contents'))
  const refs = Array.isArray(contents) ? contents : [page.entries.get('Contents')]
  const parts: Buffer[] = []
  const seen = new Set<number>()
  for (const ref of refs) {
    // The same stream listed twice draws the same words twice: once is enough,
    // and a list of one stream a thousand times over is a file built to hurt.
    if (!isRef(ref) || seen.has(ref.num)) continue
    seen.add(ref.num)
    const object = doc.index.objects.get(ref.num)
    const data = object ? streamData(doc, object) : null
    // The spec reads a page's streams as one; a newline keeps an operator at the
    // end of one from running into an operand at the start of the next.
    if (data) parts.push(data, Buffer.from('\n'))
  }
  return Buffer.concat(parts)
}

/**
 * The text of every page of a PDF, in page order, or null where the file's page
 * tree cannot be followed - not a PDF, locked with a password, or built in a
 * way this does not understand. A page with no words on it (a scan, say) is an
 * empty string rather than a missing one, so the count is always the page count.
 *
 * Only what a page draws is read: its content and the forms it calls on. Form
 * fields' appearances and other annotations are not, which the whole-file
 * reader did pick up. For a supplier's own documents that loses nothing - the
 * words that matter are printed, not typed into a field - and it keeps one
 * page's annotation text off the page next to it.
 */
export function pdfPages(bytes: Uint8Array): string[] | null {
  // One file is commonly read several times over - classified, then each of its
  // documents cut out and checked against it - so the answer is kept for as
  // long as the caller holds the same bytes. Keyed on the array itself and
  // checked against a digest of its contents, so bytes changed in place are
  // read afresh rather than answered from memory.
  const digest = createHash('md5').update(bytes).digest('hex')
  const known = readPagesCache.get(bytes)
  if (known && known.digest === digest) return known.pages ? [...known.pages] : null
  const pages = readPages(bytes)
  readPagesCache.set(bytes, { digest, pages })
  return pages ? [...pages] : null
}

const readPagesCache = new WeakMap<Uint8Array, { digest: string; pages: string[] | null }>()

function readPages(bytes: Uint8Array): string[] | null {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (file.subarray(0, 5).toString('latin1') !== '%PDF-') return null

  const doc = newDocument(file)
  const trailer = doc.index.trailer
  if (!trailer) return null

  const encrypt = trailer.entries.get('Encrypt')
  if (encrypt !== undefined) {
    const dict = resolveDict(doc, encrypt)
    const ids = resolve(doc, trailer.entries.get('ID'))
    const first = Array.isArray(ids) ? ids[0] : undefined
    const id = typeof first === 'object' && first !== null && !Array.isArray(first) && first.type === 'string' ? first.bytes : Buffer.alloc(0)
    doc.encryption = dict ? encryptionFromDict(dict, id) : null
    if (!doc.encryption) return null
  } else if (/\/Encrypt\s/.test(file.toString('latin1'))) {
    // Encryption mentioned somewhere the trailer does not point: a file at odds
    // with itself, and not one to read as though it were plain.
    return null
  }
  unpackObjectStreams(doc)

  const catalogue = resolveDict(doc, trailer.entries.get('Root'))
  const root = catalogue?.entries.get('Pages')
  if (!root) return null

  const pages: string[] = []
  const visited = new Set<number>()
  let broken = false

  // Depth first, kids in order, which is page order. Resources are inherited
  // down the tree, so each node passes its own (or its parent's) along.
  const walk = (node: PdfValue | undefined, inherited: PdfDict | null, depth: number) => {
    if (broken) return
    if (pages.length >= MAX_PAGES || depth > 32 || doc.exhausted) {
      broken = true
      return
    }
    if (isRef(node)) {
      if (visited.has(node.num)) {
        broken = true
        return
      }
      visited.add(node.num)
    }
    const dict = resolveDict(doc, node)
    if (!dict) {
      broken = true
      return
    }
    const resources = resolveDict(doc, dict.entries.get('Resources')) ?? inherited
    const kids = resolve(doc, dict.entries.get('Kids'))
    const type = nameOf(dict.entries.get('Type'))
    if (type === 'Pages' || (type !== 'Page' && Array.isArray(kids))) {
      if (!Array.isArray(kids)) {
        broken = true
        return
      }
      for (const kid of kids) walk(kid, resources, depth + 1)
      return
    }
    const runs: Run[] = []
    runsFromContent(doc, contentOf(doc, dict), resources, 0, runs, new Set())
    pages.push(linesFromRuns(runs).join('\n'))
  }
  walk(root, null, 0)

  // A budget spent part way through leaves pages that read as less than they
  // say: better no answer (and the whole-file reader) than a wrong one.
  if (broken || doc.exhausted || !pages.length) return null
  return pages
}

/**
 * Every readable word in a PDF, as one string, or null where there is nothing to
 * read.
 *
 * Page by page where the file's structure can be followed, which is nearly
 * always; the whole-file scan above where it cannot, so a file that read before
 * still reads.
 */
export function pdfText(bytes: Uint8Array): string | null {
  const pages = pdfPages(bytes)
  const joined = pages?.join('\n') ?? ''
  if (joined.trim()) return joined.slice(0, MAX_TEXT_CHARS)
  return pdfTextByScan(bytes)
}
