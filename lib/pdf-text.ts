import { createDecipheriv, createHash } from 'node:crypto'
import { inflateRawSync, inflateSync } from 'node:zlib'

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

type Encryption = {
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

/** The literal string inside a pair of brackets, brackets nested inside it and
 *  backslash escapes both respected. Returns the raw bytes and where it ended. */
function readLiteralString(raw: Buffer, open: number): { bytes: Buffer; end: number } {
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
function decodeLiteralString(raw: Buffer): Buffer {
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
function encryptionFor(text: string): Encryption | null {
  const dictAt = text.search(/\/Filter\s*\/Standard/)
  if (dictAt === -1) return null
  // The encryption dictionary is small; a kilobyte comfortably covers it and
  // keeps a stray /O string later in the file out of the match.
  const dict = text.slice(Math.max(0, dictAt - 200), dictAt + 1200)

  const v = Number(/\/V\s+(\d+)/.exec(dict)?.[1] ?? 0)
  const r = Number(/\/R\s+(\d+)/.exec(dict)?.[1] ?? 0)
  if (r >= 5) return null

  const isAes = /\/CFM\s*\/AESV2/.test(dict)
  if (v === 4 && !isAes && !/\/CFM\s*\/V2/.test(dict)) return null
  if (v > 4) return null

  const lengthBits = Number(/\/Length\s+(\d+)/.exec(dict)?.[1] ?? (v === 1 ? 40 : 128))
  const keyBytes = Math.max(5, Math.min(16, Math.floor(lengthBits / 8)))

  const ownerAt = dict.search(/\/O\s*\(/)
  if (ownerAt === -1) return null
  const ownerOpen = dict.indexOf('(', ownerAt)
  const dictBuffer = Buffer.from(dict, 'latin1')
  const owner = decodeLiteralString(readLiteralString(dictBuffer, ownerOpen).bytes)
  if (owner.length < 32) return null

  const permissions = Number(/\/P\s+(-?\d+)/.exec(dict)?.[1] ?? 0)
  const idHex = /\/ID\s*\[\s*<([0-9A-Fa-f]*)>/.exec(text)?.[1] ?? ''
  const id = Buffer.from(idHex, 'hex')

  const permissionBytes = Buffer.allocUnsafe(4)
  permissionBytes.writeInt32LE(permissions | 0, 0)

  const parts = [PASSWORD_PAD, owner.subarray(0, 32), permissionBytes, id]
  if (r >= 4 && /\/EncryptMetadata\s+false/.test(dict)) {
    parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]))
  }
  let key = createHash('md5').update(Buffer.concat(parts)).digest()
  if (r >= 3) {
    for (let i = 0; i < 50; i += 1) key = createHash('md5').update(key.subarray(0, keyBytes)).digest()
  }
  return { key: key.subarray(0, keyBytes), cipher: isAes ? 'aes' : 'rc4' }
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
function inflate(data: Buffer): Buffer | null {
  const options = { maxOutputLength: MAX_STREAM_BYTES }
  try {
    return inflateSync(data, options)
  } catch {
    try {
      return inflateRawSync(data, options)
    } catch {
      return null
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
 * Every readable word in a PDF, as one string, or null where there is nothing to
 * read.
 *
 * Objects are found by scanning for them rather than by following the
 * cross-reference table: a scan copes with a file that has been appended to, one
 * whose table is wrong, and one whose table is itself a compressed stream -
 * three things that are common and would each need their own parser.
 */
export function pdfText(bytes: Uint8Array): string | null {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (file.subarray(0, 5).toString('latin1') !== '%PDF-') return null

  const text = file.toString('latin1')
  const encryption = /\/Encrypt\s/.test(text) ? encryptionFor(text) : null
  // An encrypted file we cannot unlock has nothing to offer: every stream in it
  // is noise, and scanning them all to prove it is time spent for nothing.
  if (/\/Encrypt\s/.test(text) && !encryption) return null

  const pieces: string[] = []
  let total = 0
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

    const body = flate ? inflate(raw) : raw
    if (!body) continue

    const piece = textFromContentStream(body)
    if (!piece.trim()) continue
    pieces.push(piece)
    total += piece.length
  }

  if (!pieces.length) return null
  return pieces.join('\n').slice(0, MAX_TEXT_CHARS)
}
