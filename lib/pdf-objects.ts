// The objects inside a PDF, parsed rather than pattern-matched.
//
// lib/pdf-text.ts began life picking strings out of whatever streams it could
// find, which is enough to read one document. Reading a file PAGE BY PAGE, and
// cutting pages out of it (lib/pdf-split.ts), both need the structure: which
// object is the catalogue, which the page tree, which streams draw which page.
// This is the small parser both of them share.
//
// It understands the PDF object syntax - numbers, names, strings, arrays,
// dictionaries, references - and where each object starts and ends in the file.
// It does not decrypt or decompress anything; that stays in pdf-text.ts, which
// is where the encryption lives.
//
// Like everything else here it prefers saying nothing to guessing: a value it
// cannot parse comes back as null, and the caller gives up on that object.

export type PdfName = { type: 'name'; name: string }
export type PdfRef = { type: 'ref'; num: number; gen: number }
/** The raw bytes between the brackets, escapes resolved. Strings inside an
 *  encrypted file are still encrypted here. */
export type PdfString = { type: 'string'; bytes: Buffer }
export type PdfDict = { type: 'dict'; entries: Map<string, PdfValue> }
export type PdfValue = number | boolean | null | PdfName | PdfRef | PdfString | PdfDict | PdfValue[]

/** One indirect object. `start` is where its "N G obj" header begins and `end`
 *  is just past its `endobj`, which between them are the bytes a copy takes. */
export type PdfObject = {
  num: number
  gen: number
  value: PdfValue
  /** Where the stream's data sits, for an object that is a stream. */
  stream: { start: number; end: number } | null
  start: number
  end: number
}

/** Nesting deeper than any real document goes; a hostile one does not get to
 *  recurse the function off the end of the stack. */
const MAX_DEPTH = 64

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/** The literal string inside a pair of brackets, brackets nested inside it and
 *  backslash escapes both respected. Returns the raw bytes and where it ended. */
export function readLiteralString(raw: Buffer, open: number): { bytes: Buffer; end: number } {
  const out: number[] = []
  let depth = 1
  let i = open + 1
  while (i < raw.length) {
    const c = raw[i]!
    if (c === 0x5c) {
      // A backslash escape. The value itself is decoded later; here we only need
      // to be sure the escaped byte cannot close the string.
      out.push(c, raw[i + 1] ?? 0)
      i += 2
      continue
    }
    if (c === 0x28) depth += 1
    else if (c === 0x29) {
      depth -= 1
      if (depth === 0) return { bytes: Buffer.from(out), end: i + 1 }
    }
    out.push(c)
    i += 1
  }
  return { bytes: Buffer.from(out), end: i }
}

/** A PDF literal string, with its escapes resolved. */
export function decodeLiteralString(raw: Buffer): Buffer {
  const out: number[] = []
  let i = 0
  while (i < raw.length) {
    const c = raw[i]!
    if (c !== 0x5c) {
      out.push(c)
      i += 1
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) break
    if (next >= 0x30 && next <= 0x37) {
      let digits = ''
      i += 1
      while (digits.length < 3 && raw[i] !== undefined && raw[i]! >= 0x30 && raw[i]! <= 0x37) {
        digits += String.fromCharCode(raw[i]!)
        i += 1
      }
      out.push(parseInt(digits, 8) & 0xff)
      continue
    }
    const simple: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }
    const mapped = simple[next]
    // A backslash before a newline is a line continuation and contributes
    // nothing at all, which is why this is not simply "push whatever follows".
    if (mapped !== undefined) out.push(mapped)
    else if (next !== 0x0a && next !== 0x0d) out.push(next)
    i += 2
  }
  return Buffer.from(out)
}

/** A hex string's bytes. `open` is the `<`; returns where the `>` ended. */
export function readHexString(raw: Buffer, open: number): { bytes: Buffer; end: number } | null {
  const close = raw.indexOf(0x3e, open + 1)
  if (close === -1) return null
  const hex = raw.subarray(open + 1, close).toString('latin1').replace(/[^0-9A-Fa-f]/g, '')
  return { bytes: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'), end: close + 1 }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function isWhitespace(c: number | undefined): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
}

export function isDelimiter(c: number | undefined): boolean {
  return (
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
    c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
  )
}

/** Past whitespace and comments. */
export function skipSpace(buf: Buffer, from: number): number {
  let i = from
  while (i < buf.length) {
    const c = buf[i]
    if (isWhitespace(c)) {
      i += 1
    } else if (c === 0x25) {
      while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1
    } else {
      break
    }
  }
  return i
}

/** A bare word - a keyword, a number, an operator - up to the next delimiter. */
export function readWord(buf: Buffer, from: number): { word: string; end: number } {
  let i = from
  while (i < buf.length && !isWhitespace(buf[i]) && !isDelimiter(buf[i])) i += 1
  return { word: buf.subarray(from, i).toString('latin1'), end: i }
}

/** A name after its slash, with `#xx` escapes resolved. `from` is the slash. */
export function readName(buf: Buffer, from: number): { name: string; end: number } {
  const { word, end } = readWord(buf, from + 1)
  return { name: word.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), end }
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/
const INTEGER = /^\d+$/

/**
 * One value starting at `from`, or null where there is not one.
 *
 * A reference ("12 0 R") is three tokens that only make sense together, so a
 * whole number is always given the chance to be the start of one.
 */
export function parseValue(buf: Buffer, from: number, depth = 0): { value: PdfValue; end: number } | null {
  if (depth > MAX_DEPTH) return null
  const i = skipSpace(buf, from)
  if (i >= buf.length) return null
  const c = buf[i]!

  if (c === 0x3c && buf[i + 1] === 0x3c) {
    const entries = new Map<string, PdfValue>()
    let at = i + 2
    for (;;) {
      at = skipSpace(buf, at)
      if (at >= buf.length) return null
      if (buf[at] === 0x3e && buf[at + 1] === 0x3e) return { value: { type: 'dict', entries }, end: at + 2 }
      if (buf[at] !== 0x2f) return null
      const key = readName(buf, at)
      const parsed = parseValue(buf, key.end, depth + 1)
      if (!parsed) return null
      entries.set(key.name, parsed.value)
      at = parsed.end
    }
  }

  if (c === 0x3c) {
    const hex = readHexString(buf, i)
    return hex ? { value: { type: 'string', bytes: hex.bytes }, end: hex.end } : null
  }

  if (c === 0x28) {
    const { bytes, end } = readLiteralString(buf, i)
    return { value: { type: 'string', bytes: decodeLiteralString(bytes) }, end }
  }

  if (c === 0x5b) {
    const items: PdfValue[] = []
    let at = i + 1
    for (;;) {
      at = skipSpace(buf, at)
      if (at >= buf.length) return null
      if (buf[at] === 0x5d) return { value: items, end: at + 1 }
      const parsed = parseValue(buf, at, depth + 1)
      if (!parsed) return null
      items.push(parsed.value)
      at = parsed.end
    }
  }

  if (c === 0x2f) {
    const { name, end } = readName(buf, i)
    return { value: { type: 'name', name }, end }
  }

  const { word, end } = readWord(buf, i)
  if (word === 'true') return { value: true, end }
  if (word === 'false') return { value: false, end }
  if (word === 'null') return { value: null, end }
  if (!NUMBER.test(word)) return null

  if (INTEGER.test(word)) {
    // Perhaps the first of "num gen R".
    const genAt = skipSpace(buf, end)
    const gen = readWord(buf, genAt)
    if (INTEGER.test(gen.word)) {
      const rAt = skipSpace(buf, gen.end)
      const r = readWord(buf, rAt)
      if (r.word === 'R') return { value: { type: 'ref', num: Number(word), gen: Number(gen.word) }, end: r.end }
    }
  }
  return { value: Number(word), end }
}

// ---------------------------------------------------------------------------
// Looking values up
// ---------------------------------------------------------------------------

export function isDict(value: PdfValue | undefined): value is PdfDict {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && value.type === 'dict'
}

export function isRef(value: PdfValue | undefined): value is PdfRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && value.type === 'ref'
}

export function nameOf(value: PdfValue | undefined): string | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && value.type === 'name'
    ? value.name
    : null
}

/** The dictionary part of an object, whether it is a plain dictionary or a
 *  stream's. */
export function dictOf(object: PdfObject | null | undefined): PdfDict | null {
  return object && isDict(object.value) ? object.value : null
}

/** Every reference inside a value, in the order written, not following into
 *  the objects they point at. Keys in `skipKeys` are passed over, which is how
 *  a page's `/Parent` is kept out of a walk that wants only what it uses. */
export function refsIn(value: PdfValue, skipKeys: ReadonlySet<string> = new Set(), out: PdfRef[] = []): PdfRef[] {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, skipKeys, out)
  } else if (isRef(value)) {
    out.push(value)
  } else if (isDict(value)) {
    for (const [key, item] of value.entries) {
      if (!skipKeys.has(key)) refsIn(item, skipKeys, out)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

const HEADER = /^(\d+)\s+(\d+)\s+obj\b/

/**
 * The indirect object whose "N G obj" header is at `offset`, or null.
 *
 * A stream ends where its `/Length` says it does, and nowhere else: encrypted
 * or compressed data contains whatever bytes it likes, "endstream" included.
 * `lengthOf` answers a `/Length` that is itself a reference. With `strict`
 * set, a length that cannot be confirmed, or a missing `endobj`, is a refusal;
 * without it, the first "endstream" is accepted as the next best thing, which
 * is right for reading and wrong for copying.
 */
export function readObjectAt(
  buf: Buffer,
  offset: number,
  options: { strict: boolean; lengthOf?: (ref: PdfRef) => number | null },
): PdfObject | null {
  const head = HEADER.exec(buf.subarray(offset, offset + 40).toString('latin1'))
  if (!head) return null
  const num = Number(head[1])
  const gen = Number(head[2])
  const parsed = parseValue(buf, offset + head[0].length)
  if (!parsed) return null

  let at = skipSpace(buf, parsed.end)
  let stream: PdfObject['stream'] = null
  if (isDict(parsed.value) && buf.subarray(at, at + 6).toString('latin1') === 'stream') {
    let from = at + 6
    if (buf[from] === 0x0d && buf[from + 1] === 0x0a) from += 2
    else if (buf[from] === 0x0a || buf[from] === 0x0d) from += 1

    const lengthValue = parsed.value.entries.get('Length')
    const declared =
      typeof lengthValue === 'number' ? lengthValue : isRef(lengthValue) ? (options.lengthOf?.(lengthValue) ?? null) : null
    let to = -1
    if (declared !== null && Number.isInteger(declared) && declared >= 0 && from + declared <= buf.length) {
      const after = skipSpace(buf, from + declared)
      if (buf.subarray(after, after + 9).toString('latin1') === 'endstream') to = from + declared
    }
    if (to === -1) {
      if (options.strict) return null
      to = buf.indexOf('endstream', from, 'latin1')
      if (to === -1) return null
    }
    stream = { start: from, end: to }
    at = skipSpace(buf, buf.indexOf('endstream', to, 'latin1') + 9)
  }

  let end = at
  if (buf.subarray(at, at + 6).toString('latin1') === 'endobj') end = at + 6
  else if (options.strict) return null
  return { num, gen, value: parsed.value, stream, start: offset, end }
}

/** The file's objects, found by walking it from front to back, with the last
 *  definition of each number winning - which is what an appended update means.
 *  The walk steps over each object once it is read, so the bytes inside a
 *  stream never get the chance to look like a header. */
export type PdfIndex = {
  objects: Map<number, PdfObject>
  /** The newest trailer - the last `trailer` dictionary or cross-reference
   *  stream dictionary in the file - with /Root, /Encrypt and /ID each taken
   *  from the newest one that has it. A linearized file's last trailer often
   *  carries only /Size; its /Root is in the one at the front. */
  trailer: PdfDict | null
}

/** More than any invoice, few enough that a hostile file cannot make the walk
 *  expensive. */
const MAX_OBJECTS = 20_000

export function indexObjects(buf: Buffer): PdfIndex {
  const text = buf.toString('latin1')
  const objects = new Map<number, PdfObject>()
  const pendingLength: PdfObject[] = []
  const trailers: Array<{ at: number; dict: PdfDict }> = []

  const lengthOf = (ref: PdfRef): number | null => {
    const found = objects.get(ref.num)
    return found && typeof found.value === 'number' ? found.value : null
  }

  const headers = /(\d+)\s+(\d+)\s+obj\b/g
  let match: RegExpExecArray | null
  let seen = 0
  while ((match = headers.exec(text)) !== null) {
    seen += 1
    if (seen > MAX_OBJECTS) break
    // A header starts a line or follows a delimiter; "12 0 obj" in the middle of
    // a run of digits is the tail of something else.
    const before = buf[match.index - 1]
    if (match.index > 0 && !isWhitespace(before) && !isDelimiter(before)) continue

    const object = readObjectAt(buf, match.index, { strict: false, lengthOf })
    if (!object) continue
    objects.set(object.num, object)
    const dict = dictOf(object)
    if (object.stream && dict && isRef(dict.entries.get('Length'))) pendingLength.push(object)
    if (dict && nameOf(dict.entries.get('Type')) === 'XRef') trailers.push({ at: object.start, dict })
    headers.lastIndex = Math.max(headers.lastIndex, object.end)
  }

  // A /Length that pointed at an object further on could not be answered on the
  // way past; now it can, and the stream is re-read against it.
  for (const object of pendingLength) {
    const again = readObjectAt(buf, object.start, { strict: false, lengthOf })
    if (again && objects.get(object.num) === object) objects.set(object.num, again)
  }

  for (let at = text.indexOf('trailer'); at !== -1; at = text.indexOf('trailer', at + 7)) {
    const parsed = parseValue(buf, at + 'trailer'.length)
    if (parsed && isDict(parsed.value)) trailers.push({ at, dict: parsed.value })
  }
  trailers.sort((a, b) => b.at - a.at)
  const newest = trailers[0]?.dict
  if (!newest) return { objects, trailer: null }
  const merged = new Map(newest.entries)
  for (const key of ['Root', 'Encrypt', 'ID']) {
    if (merged.has(key)) continue
    const older = trailers.find((candidate) => candidate.dict.entries.has(key))
    if (older) merged.set(key, older.dict.entries.get(key)!)
  }
  return { objects, trailer: { type: 'dict', entries: merged } }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A value back as PDF syntax. Strings go out as hex, which carries any bytes
 *  at all - encrypted ones included - without a single escape to get wrong. */
export function serialise(value: PdfValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
  if (Array.isArray(value)) return `[${value.map(serialise).join(' ')}]`
  switch (value.type) {
    case 'name':
      return `/${value.name.replace(/[^!-~]|[#()<>[\]{}/%]/g, (ch) => `#${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)}`
    case 'ref':
      return `${value.num} ${value.gen} R`
    case 'string':
      return `<${value.bytes.toString('hex')}>`
    case 'dict':
      return `<<${[...value.entries].map(([key, item]) => `${serialise({ type: 'name', name: key })} ${serialise(item)}`).join(' ')}>>`
  }
}
