import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

// Synthetic PDFs for the tests of lib/pdf-text.ts, lib/supplier-document.ts and
// lib/pdf-split.ts.
//
// The files these were written for are a real supplier's, carrying real
// customers' names and addresses, so none of them is in this repository. What
// is built here instead is a file of the same SHAPE: the same page structure,
// the same encryption (RC4, 128-bit, V2 revision 3, empty passwords), the same
// habit of drawing each piece of text as its own positioned block, optionally
// inside a form the page then draws. Every word on every page is made up.
//
// Also the shapes a splitter must refuse - object streams, cross-reference
// streams, an appended update, annotations shared between pages - so the
// refusals are tested against files that really are built that way.

/** One line of a page: a plain string drawn at the left margin, or pieces
 *  drawn at the x positions given, all on the same line. */
export type FixtureLine = string | ReadonlyArray<readonly [number, string]>

export type FixtureOptions = {
  /** Deflate the content streams. Default true. */
  compress?: boolean
  /** RC4, 128-bit, V2 revision 3, empty user and owner passwords. */
  encrypt?: boolean
  /** Put each page's text in a form XObject the page draws, as the files this
   *  was written for do. */
  viaForm?: boolean
  /** Pack the page objects into an object stream. Implies `xrefStream`. */
  objectStream?: boolean
  /** A cross-reference stream in place of the classic table. */
  xrefStream?: boolean
  /** Two levels of page tree: pages in pairs under intermediate nodes. */
  nestedTree?: boolean
  /** Append an update replacing one page's text. 1-based page number. */
  incremental?: { page: number; lines: FixtureLine[] }
  /** Link annotations: one per page, one shared by every page, or one on the
   *  first page pointing at the second. Or form fields: a text field on each
   *  page (a widget whose /Parent is the field), or one field with a widget on
   *  the first two pages. Their strings are written plain, so they belong in
   *  unencrypted files: an encrypted one would need them encrypted too. */
  annotations?: 'own' | 'shared' | 'cross-link' | 'widget' | 'field-across-pages'
  // The rest build files meant to hurt, for the tests that make sure they don't.
  /** List each page's content stream this many times in its /Contents. */
  repeatContents?: number
  /** With `viaForm`: one form, holding the first page's text, drawn by every
   *  page. */
  sharedForm?: boolean
  /** With `viaForm`: each form draws itself. */
  formLoop?: boolean
  /** The top page tree node lists itself among its kids. */
  cyclicTree?: boolean
  /** Appended to each page's drawing (inside its form, with `viaForm`). */
  extraContent?: string
  /** This many extra content streams on the first page, each a small stream
   *  that inflates to `bytes` of spaces. Distinct objects, so no cache helps. */
  bombs?: { count: number; bytes: number; truncated?: boolean }
  /** Shaped like a linearized file: a first-page section at the front whose
   *  trailer carries /Root, /Encrypt and /ID, and a main trailer at the end
   *  that carries only /Size. Classic table only. */
  linearizedStyle?: boolean
}

/** PDF's standard padding string (the spec's algorithm 2). */
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

const FILE_ID = Buffer.from('5f1c0a9e37b24d6c8e01f2a3b4c5d6e7', 'hex')
/** The same permissions the files this imitates carry: print, nothing else. */
const PERMISSIONS = -1852

function md5(...parts: Buffer[]): Buffer {
  return createHash('md5').update(Buffer.concat(parts)).digest()
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff
    ;[s[i], s[j]] = [s[j]!, s[i]!]
  }
  const out = Buffer.allocUnsafe(data.length)
  let a = 0
  let b = 0
  for (let n = 0; n < data.length; n += 1) {
    a = (a + 1) & 0xff
    b = (b + s[a]!) & 0xff
    ;[s[a], s[b]] = [s[b]!, s[a]!]
    out[n] = data[n]! ^ s[(s[a]! + s[b]!) & 0xff]!
  }
  return out
}

function xorKey(key: Buffer, value: number): Buffer {
  return Buffer.from(key.map((byte) => byte ^ value))
}

/** The spec's algorithms 2, 3 and 5 for revision 3, empty passwords. */
function encryptionKeys(): { key: Buffer; owner: Buffer; user: Buffer } {
  let ownerHash = md5(PAD)
  for (let i = 0; i < 50; i += 1) ownerHash = md5(ownerHash)
  const ownerKey = ownerHash.subarray(0, 16)
  let owner = rc4(ownerKey, PAD)
  for (let i = 1; i <= 19; i += 1) owner = rc4(xorKey(ownerKey, i), owner)

  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(PERMISSIONS, 0)
  let key = md5(PAD, owner, permissions, FILE_ID)
  for (let i = 0; i < 50; i += 1) key = md5(key.subarray(0, 16))
  key = key.subarray(0, 16)

  let user = rc4(key, md5(PAD, FILE_ID))
  for (let i = 1; i <= 19; i += 1) user = rc4(xorKey(key, i), user)
  return { key, owner, user: Buffer.concat([user, Buffer.alloc(16)]) }
}

function objectKey(key: Buffer, num: number, gen: number): Buffer {
  return md5(key, Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff])).subarray(0, 16)
}

/** Bytes as a literal string, every one written as an octal escape. */
function octalString(bytes: Buffer): string {
  return `(${[...bytes].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('')})`
}

function escapeText(text: string): string {
  return text.replace(/([()\\])/g, '\\$1')
}

/** A page's lines as content: every piece its own positioned text block. */
export function contentFor(lines: readonly FixtureLine[]): string {
  return lines
    .map((line, index) => {
      const y = 780 - 14 * index
      const pieces: ReadonlyArray<readonly [number, string]> = typeof line === 'string' ? [[40, line]] : line
      return pieces.map(([x, text]) => `BT\n/F1 10 Tf\n${x} ${y} Td\n(${escapeText(text)}) Tj\nET`).join('\n')
    })
    .join('\n')
}

type FixtureObject = { num: number; entries: string; stream?: Buffer; flate?: boolean }

/** A synthetic PDF, one page per entry of `pages`. */
export function buildPdf(pages: ReadonlyArray<readonly FixtureLine[]>, options: FixtureOptions = {}): Buffer {
  const compress = options.compress ?? true
  const xrefStream = options.xrefStream || options.objectStream
  const encryption = options.encrypt ? encryptionKeys() : null

  let next = 1
  const catalogueNum = next++
  const pagesNum = next++
  const fontNum = next++
  const objects: FixtureObject[] = []

  const streamOf = (num: number, content: string, deflate = compress): Buffer => {
    let bytes: Buffer = Buffer.from(content, 'latin1')
    if (deflate) bytes = deflateSync(bytes)
    if (encryption) bytes = rc4(objectKey(encryption.key, num, 0), bytes)
    return bytes
  }

  // The page tree: flat, or pages in pairs under intermediate nodes.
  const parentOf: number[] = []
  const intermediates: Array<{ num: number; pages: number[] }> = []
  pages.forEach((_, index) => {
    if (!options.nestedTree) {
      parentOf.push(pagesNum)
      return
    }
    if (index % 2 === 0) intermediates.push({ num: next++, pages: [] })
    const group = intermediates[intermediates.length - 1]!
    group.pages.push(index)
    parentOf.push(group.num)
  })

  const pageNums: number[] = []
  const contentNums: number[] = []
  const formNums: number[] = []
  const extra = options.extraContent ? `\n${options.extraContent}` : ''
  for (const lines of pages) {
    const pageNum = next++
    const contentNum = next++
    pageNums.push(pageNum)
    contentNums.push(contentNum)
    if (options.viaForm) {
      if (options.sharedForm && formNums.length) {
        formNums.push(formNums[0]!)
      } else {
        const formNum = next++
        formNums.push(formNum)
        const loop = options.formLoop ? ` /XObject << /Fm0 ${formNum} 0 R >>` : ''
        objects.push({
          num: formNum,
          entries: `/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F1 ${fontNum} 0 R >>${loop} >>`,
          stream: streamOf(formNum, `${contentFor(lines)}${extra}${options.formLoop ? '\n/Fm0 Do' : ''}`),
          flate: compress,
        })
      }
      objects.push({ num: contentNum, entries: '', stream: streamOf(contentNum, 'q\n/Fm0 Do\nQ\n'), flate: compress })
    } else {
      objects.push({ num: contentNum, entries: '', stream: streamOf(contentNum, `${contentFor(lines)}${extra}`), flate: compress })
    }
  }

  // Decompression bombs: compressed once, written many times.
  const bombNums: number[] = []
  if (options.bombs) {
    const whole = deflateSync(Buffer.alloc(options.bombs.bytes, 0x20))
    // Cut short, it fails at the very end - after all the work - with an error
    // that is not about size.
    const packedBomb = options.bombs.truncated ? whole.subarray(0, whole.length - 8) : whole
    for (let n = 0; n < options.bombs.count; n += 1) {
      const num = next++
      bombNums.push(num)
      objects.push({
        num,
        entries: '',
        stream: encryption ? rc4(objectKey(encryption.key, num, 0), packedBomb) : packedBomb,
        flate: true,
      })
    }
  }

  // Annotations, before the pages that list them.
  const annotsOf: string[] = pages.map(() => '')
  if (options.annotations === 'own') {
    pageNums.forEach((_, index) => {
      const num = next++
      objects.push({ num, entries: `/Type /Annot /Subtype /Link /Rect [40 40 140 60] /Border [0 0 0] /A << /S /URI /URI (https://example.com/${index + 1}) >>` })
      annotsOf[index] = ` /Annots [${num} 0 R]`
    })
  } else if (options.annotations === 'shared') {
    const num = next++
    objects.push({ num, entries: '/Type /Annot /Subtype /Link /Rect [40 40 140 60] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >>' })
    pageNums.forEach((_, index) => {
      annotsOf[index] = ` /Annots [${num} 0 R]`
    })
  } else if (options.annotations === 'cross-link' && pageNums.length > 1) {
    const num = next++
    objects.push({ num, entries: `/Type /Annot /Subtype /Link /Rect [40 40 140 60] /Border [0 0 0] /Dest [${pageNums[1]} 0 R /Fit]` })
    annotsOf[0] = ` /Annots [${num} 0 R]`
  } else if (options.annotations === 'widget') {
    pageNums.forEach((pageNum, index) => {
      const field = next++
      const widget = next++
      objects.push({ num: field, entries: `/FT /Tx /T (field${index + 1}) /V (value ${index + 1}) /DA (/F1 10 Tf 0 g) /Kids [${widget} 0 R]` })
      objects.push({ num: widget, entries: `/Type /Annot /Subtype /Widget /Rect [40 40 140 60] /P ${pageNum} 0 R /Parent ${field} 0 R` })
      annotsOf[index] = ` /Annots [${widget} 0 R]`
    })
  } else if (options.annotations === 'field-across-pages' && pageNums.length > 1) {
    const field = next++
    const widgets = [next++, next++]
    objects.push({ num: field, entries: `/FT /Tx /T (shared) /DA (/F1 10 Tf 0 g) /Kids [${widgets.map((num) => `${num} 0 R`).join(' ')}]` })
    widgets.forEach((widget, index) => {
      objects.push({ num: widget, entries: `/Type /Annot /Subtype /Widget /Rect [40 40 140 60] /P ${pageNums[index]} 0 R /Parent ${field} 0 R` })
      annotsOf[index] = ` /Annots [${widget} 0 R]`
    })
  }

  const contentsFor = (index: number): string => {
    const refs = Array<number>(options.repeatContents ?? 1).fill(contentNums[index]!)
    if (index === 0) refs.push(...bombNums)
    return refs.length === 1 ? `${refs[0]} 0 R` : `[${refs.map((num) => `${num} 0 R`).join(' ')}]`
  }
  const pageObjects: FixtureObject[] = pageNums.map((num, index) => ({
    num,
    entries:
      `/Type /Page /Parent ${parentOf[index]} 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >>${options.viaForm ? ` /XObject << /Fm0 ${formNums[index]} 0 R >>` : ''} >> ` +
      `/Contents ${contentsFor(index)}${annotsOf[index]}`,
  }))

  objects.push({ num: catalogueNum, entries: `/Type /Catalog /Pages ${pagesNum} 0 R` })
  const topKids = [...(options.nestedTree ? intermediates.map((node) => node.num) : pageNums), ...(options.cyclicTree ? [pagesNum] : [])]
  objects.push({ num: pagesNum, entries: `/Type /Pages /Kids [${topKids.map((num) => `${num} 0 R`).join(' ')}] /Count ${pageNums.length}` })
  for (const node of intermediates) {
    objects.push({
      num: node.num,
      entries: `/Type /Pages /Parent ${pagesNum} 0 R /Kids [${node.pages.map((index) => `${pageNums[index]} 0 R`).join(' ')}] /Count ${node.pages.length}`,
    })
  }
  objects.push({ num: fontNum, entries: '/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding' })

  let encryptNum: number | null = null
  if (encryption) {
    encryptNum = next++
    objects.push({
      num: encryptNum,
      entries: `/Filter /Standard /V 2 /R 3 /Length 128 /P ${PERMISSIONS} /O ${octalString(encryption.owner)} /U ${octalString(encryption.user)}`,
    })
  }

  // Page objects either stand alone or go into one object stream.
  const packed = new Map<number, { container: number; index: number }>()
  if (options.objectStream) {
    const containerNum = next++
    let header = ''
    let body = ''
    pageObjects.forEach((object, index) => {
      header += `${object.num} ${body.length} `
      body += `<< ${object.entries} >>\n`
      packed.set(object.num, { container: containerNum, index })
    })
    objects.push({
      num: containerNum,
      entries: `/Type /ObjStm /N ${pageObjects.length} /First ${header.length}`,
      stream: streamOf(containerNum, header + body),
      flate: compress,
    })
  } else {
    objects.push(...pageObjects)
  }

  const idText = `[<${FILE_ID.toString('hex')}> <${FILE_ID.toString('hex')}>]`
  const trailerExtras = `/Root ${catalogueNum} 0 R${encryptNum ? ` /Encrypt ${encryptNum} 0 R` : ''} /ID ${idText}`

  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  let length = parts[0]!.length
  const offsets = new Map<number, number>()
  const write = (chunk: Buffer | string) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk
    parts.push(buffer)
    length += buffer.length
  }
  const writeObject = (object: FixtureObject) => {
    offsets.set(object.num, length)
    if (object.stream) {
      write(`${object.num} 0 obj\n<< ${object.entries} /Length ${object.stream.length}${object.flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`)
      write(object.stream)
      write('\nendstream\nendobj\n')
    } else {
      write(`${object.num} 0 obj\n<< ${object.entries} >>\nendobj\n`)
    }
  }
  if (options.linearizedStyle) {
    const num = next++
    writeObject({ num, entries: '/Linearized 1' })
    write(`xref\n0 0\ntrailer\n<< ${trailerExtras} >>\nstartxref\n0\n%%EOF\n`)
  }
  for (const object of [...objects].sort((a, b) => a.num - b.num)) writeObject(object)

  let xrefAt: number
  let size: number
  if (xrefStream) {
    const xrefNum = next++
    size = next
    xrefAt = length
    offsets.set(xrefNum, length)
    const rows = Buffer.alloc(size * 7)
    for (let num = 0; num < size; num += 1) {
      const at = num * 7
      const inStream = packed.get(num)
      if (inStream) {
        rows[at] = 2
        rows.writeUInt32BE(inStream.container, at + 1)
        rows.writeUInt16BE(inStream.index, at + 5)
      } else if (offsets.has(num)) {
        rows[at] = 1
        rows.writeUInt32BE(offsets.get(num)!, at + 1)
      } else {
        rows.writeUInt16BE(num === 0 ? 65535 : 0, at + 5)
      }
    }
    write(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] ${trailerExtras} /Length ${rows.length} >>\nstream\n`)
    write(rows)
    write('\nendstream\nendobj\n')
  } else {
    size = next
    xrefAt = length
    let table = `xref\n0 ${size}\n0000000000 65535 f \n`
    for (let num = 1; num < size; num += 1) {
      const offset = offsets.get(num)
      table += offset === undefined ? '0000000000 00000 f \n' : `${String(offset).padStart(10, '0')} 00000 n \n`
    }
    write(`${table}trailer\n<< /Size ${size}${options.linearizedStyle ? '' : ` ${trailerExtras}`} >>\n`)
  }
  write(`startxref\n${xrefAt}\n%%EOF\n`)

  if (options.incremental && !xrefStream) {
    // The page's text replaced by an appended object under the same number,
    // exactly as an editor saving "incrementally" does it.
    const index = options.incremental.page - 1
    const num = options.viaForm ? formNums[index]! : contentNums[index]!
    const at = length
    const stream = streamOf(num, contentFor(options.incremental.lines))
    const extra = options.viaForm
      ? `/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F1 ${fontNum} 0 R >> >> `
      : ''
    write(`${num} 0 obj\n<< ${extra}/Length ${stream.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`)
    write(stream)
    write('\nendstream\nendobj\n')
    const updateAt = length
    write(`xref\n${num} 1\n${String(at).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Prev ${xrefAt} ${trailerExtras} >>\nstartxref\n${updateAt}\n%%EOF\n`)
  }

  return Buffer.concat(parts, length)
}
