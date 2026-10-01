import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { buildPdf, type FixtureLine, type FixtureOptions } from '@/modules/purchase-orders/lib/pdf-fixtures.test-support'
import { checkWrittenXref, extractPages } from '@/modules/purchase-orders/lib/pdf-split'
import { pdfPages } from '@/modules/purchase-orders/lib/pdf-text'
import { readSupplierDocuments } from '@/modules/purchase-orders/lib/supplier-document'

// Cutting pages out of synthetic supplier files, and reading every cut back:
// with our own reader always, and with poppler's pdftotext as well where it is
// installed, as a reader that owes nothing to the code that wrote the file.
// Where pdftotext is missing, only that check is skipped, never the test.

const POPPLER = !spawnSync('pdftotext', ['-v']).error
// Said out loud, so a run without poppler does not pass quietly.
if (!POPPLER) console.warn('[pdf-split.test] pdftotext is not on PATH: the independent read-back is skipped')
const scratch = mkdtempSync(join(tmpdir(), 'po-pdf-split-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let written = 0
/** What pdftotext makes of a file, one string per page, or null where it is
 *  not installed. Anything it writes to stderr is a complaint about the file
 *  and fails the test. */
function poppler(bytes: Uint8Array): string[] | null {
  if (!POPPLER) return null
  written += 1
  const path = join(scratch, `part-${written}.pdf`)
  writeFileSync(path, bytes)
  const result = spawnSync('pdftotext', [path, '-'], { encoding: 'latin1' })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  // A form feed after every page, the last included.
  return result.stdout.split('\f').slice(0, -1)
}

function invoicePage(reference: string, po: string): FixtureLine[] {
  return [
    'Example Supplies Ltd',
    [
      [40, 'Invoice'],
      [330, 'Page 1 of 1'],
    ],
    'Invoice No.',
    reference,
    'Customer Order No.',
    po,
    [
      [300, 'Invoice Total'],
      [450, '120.00'],
    ],
  ]
}

const BATCH: FixtureLine[][] = [
  invoicePage('0000900001', 'PO-00012'),
  invoicePage('0000900002', 'PO-00013'),
  invoicePage('0000900003', 'PO-00014'),
]
const KNOWN = new Set(['PO-00012', 'PO-00013', 'PO-00014'])

/** Split a file into the documents it holds, and check every piece both ways. */
function splitAndCheck(file: Buffer): void {
  const documents = readSupplierDocuments('Invoices.PDF', file, KNOWN)
  expect(documents.length).toBeGreaterThan(1)
  for (const document of documents) {
    const part = extractPages(file, document.pages, document.supplierRef)
    expect(part, `pages ${document.pages.join('-')}`).not.toBeNull()
    const expectedPages = document.pages[1] - document.pages[0] + 1
    const others = documents.filter((other) => other !== document).map((other) => other.supplierRef!)

    const ours = pdfPages(part!)
    expect(ours).toHaveLength(expectedPages)
    expect(ours!.join('\n')).toContain(document.supplierRef)
    for (const other of others) expect(ours!.join('\n')).not.toContain(other)
    // And it reads, whole, as the same document it was cut from.
    expect(readSupplierDocuments('part.pdf', part!, KNOWN).map((found) => found.supplierRef)).toEqual([document.supplierRef])

    const theirs = poppler(part!)
    if (theirs) {
      expect(theirs).toHaveLength(expectedPages)
      expect(theirs.join('\n')).toContain(document.supplierRef)
      for (const other of others) expect(theirs.join('\n')).not.toContain(other)
    }
  }
}

describe('extractPages', () => {
  it('splits a plain file one invoice to a page', () => {
    splitAndCheck(buildPdf(BATCH))
  })

  it('splits an encrypted file, text inside forms, as the real ones are', () => {
    const file = buildPdf(BATCH, { encrypt: true, viaForm: true })
    splitAndCheck(file)
    // The encryption and the file's identity go across untouched.
    const part = Buffer.from(extractPages(file, [2, 2])!).toString('latin1')
    const original = file.toString('latin1')
    expect(part).toContain(/\/ID \[[^\]]*\]/.exec(original)![0])
    const encrypt = /\d+ 0 obj\n<< \/Filter \/Standard[\s\S]*?endobj/.exec(original)![0]
    expect(part).toContain(encrypt)
  })

  it('keeps a continuation page with its invoice', () => {
    splitAndCheck(
      buildPdf(
        [BATCH[0]!, ['Continued', '1 x Pedestal, white   80.00'], BATCH[1]!],
        { encrypt: true },
      ),
    )
  })

  it('cuts a run of pages, and the whole file', () => {
    const file = buildPdf(BATCH, { encrypt: true })
    expect(pdfPages(extractPages(file, [2, 3])!)).toHaveLength(2)
    expect(pdfPages(extractPages(file, [1, 3])!)).toHaveLength(3)
    const theirs = poppler(extractPages(file, [2, 3])!)
    if (theirs) expect(theirs).toHaveLength(2)
  })

  it('takes a page with its own annotations along', () => {
    const part = extractPages(buildPdf(BATCH, { annotations: 'own' }), [2, 2])
    expect(part).not.toBeNull()
    expect(Buffer.from(part!).toString('latin1')).toContain('https://example.com/2')
    expect(Buffer.from(part!).toString('latin1')).not.toContain('https://example.com/1')
  })

  it('takes a form field along with its widget, rather than leaving the widget pointing at nothing', () => {
    const file = buildPdf(BATCH, { annotations: 'widget' })
    const part = extractPages(file, [2, 2])
    expect(part).not.toBeNull()
    const text = Buffer.from(part!).toString('latin1')
    expect(text).toContain('/T (field2)')
    expect(text).not.toContain('/T (field1)')
    const theirs = poppler(part!)
    if (theirs) expect(theirs).toHaveLength(1)
  })

  it('writes a cross-reference table that is right, and knows one that is not', () => {
    const part = Buffer.from(extractPages(buildPdf(BATCH, { encrypt: true }), [2, 2])!)
    const size = Number(/\/Size (\d+)/.exec(part.toString('latin1'))![1])
    expect(checkWrittenXref(part, size)).toBe(true)
    expect(checkWrittenXref(part, size + 1)).toBe(false)

    // One object's offset nudged by a byte: it no longer points at its header.
    const text = part.toString('latin1')
    // The table, not the "startxref" that points at it.
    const table = text.lastIndexOf('\nxref\n') + 1
    const row = /\n(\d{10}) 00000 n /.exec(text.slice(table))!
    const nudged = String(Number(row[1]) + 1).padStart(10, '0')
    const at = table + row.index + 1
    const spoiled = Buffer.from(text.slice(0, at) + nudged + text.slice(at + 10), 'latin1')
    expect(checkWrittenXref(spoiled, size)).toBe(false)

    // And the head of the free list must be where the spec puts it.
    const noHead = Buffer.from(text.replace('0000000000 65535 f ', '0000000000 00000 f '), 'latin1')
    expect(checkWrittenXref(noHead, size)).toBe(false)
  })

  it('refuses a page range that is not there', () => {
    const file = buildPdf(BATCH)
    expect(extractPages(file, [0, 1])).toBeNull()
    expect(extractPages(file, [2, 1])).toBeNull()
    expect(extractPages(file, [3, 4])).toBeNull()
  })

  it('refuses a cut that does not hold the reference it was chosen by', () => {
    expect(extractPages(buildPdf(BATCH), [1, 1], '0000900002')).toBeNull()
  })

  const refused: Array<[string, FixtureOptions]> = [
    ['an object stream', { objectStream: true }],
    ['a cross-reference stream', { xrefStream: true }],
    ['an appended update', { encrypt: true, incremental: { page: 2, lines: invoicePage('0000900009', 'PO-00013') } }],
    ['an annotation shared between pages', { annotations: 'shared' }],
    ['a link from one page to another', { annotations: 'cross-link' }],
    ['a page tree more than one level deep', { nestedTree: true }],
    ['a form field with widgets on more than one page', { annotations: 'field-across-pages' }],
    ['a linearized file (two sections, two trailers)', { encrypt: true, linearizedStyle: true }],
  ]
  it.each(refused)('refuses %s', (_, options) => {
    const file = buildPdf(BATCH, options)
    // Readable, so the refusal is the splitter's and not the reader's.
    expect(pdfPages(file)).toHaveLength(3)
    expect(extractPages(file, [1, 1])).toBeNull()
  })

  it('refuses an encryption it cannot open', () => {
    const locked = Buffer.from(buildPdf(BATCH, { encrypt: true }).toString('latin1').replace('/V 2 /R 3', '/V 5 /R 6'), 'latin1')
    expect(extractPages(locked, [1, 1])).toBeNull()
  })

  it('refuses what is not a PDF', () => {
    expect(extractPages(Buffer.from('not a pdf'), [1, 1])).toBeNull()
  })
})
