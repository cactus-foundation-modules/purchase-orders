import { describe, expect, it } from 'vitest'

import { buildPdf, type FixtureLine } from '@/modules/purchase-orders/lib/pdf-fixtures.test-support'
import { pdfPages, pdfText } from '@/modules/purchase-orders/lib/pdf-text'

// Reading a PDF a page at a time. Every file here is synthetic, built by
// lib/pdf-fixtures.test-support.ts to the shape of the supplier files this was
// written for - never a copy of one.

const THREE_PAGES: FixtureLine[][] = [
  ['Invoice', 'Invoice No.', 'INV-1001'],
  ['Invoice', 'Invoice No.', 'INV-1002'],
  ['Invoice', 'Invoice No.', 'INV-1003'],
]

describe('pdfPages', () => {
  it('reads each page on its own, in order', () => {
    const pages = pdfPages(buildPdf(THREE_PAGES))
    expect(pages).toHaveLength(3)
    expect(pages?.[0]).toContain('INV-1001')
    expect(pages?.[1]).toContain('INV-1002')
    expect(pages?.[1]).not.toContain('INV-1001')
    expect(pages?.[2]).toContain('INV-1003')
  })

  it('reads streams that were never compressed', () => {
    expect(pdfPages(buildPdf(THREE_PAGES, { compress: false }))?.[2]).toContain('INV-1003')
  })

  it('opens the empty-password RC4 encryption, text inside a form, as the real ones are', () => {
    const pages = pdfPages(buildPdf(THREE_PAGES, { encrypt: true, viaForm: true }))
    expect(pages).toEqual(['Invoice\nInvoice No.\nINV-1001', 'Invoice\nInvoice No.\nINV-1002', 'Invoice\nInvoice No.\nINV-1003'])
  })

  it('finds pages packed into an object stream, behind a cross-reference stream', () => {
    const pages = pdfPages(buildPdf(THREE_PAGES, { objectStream: true, encrypt: true }))
    expect(pages?.map((page) => page.split('\n').pop())).toEqual(['INV-1001', 'INV-1002', 'INV-1003'])
  })

  it('follows a cross-reference stream with no trailer', () => {
    expect(pdfPages(buildPdf(THREE_PAGES, { xrefStream: true }))).toHaveLength(3)
  })

  it('reads the newest version of a page that has been updated', () => {
    const pages = pdfPages(
      buildPdf(THREE_PAGES, { encrypt: true, incremental: { page: 2, lines: ['Invoice', 'Invoice No.', 'INV-2002'] } }),
    )
    expect(pages?.[1]).toContain('INV-2002')
    expect(pages?.[1]).not.toContain('INV-1002')
  })

  it('walks a page tree more than one level deep in page order', () => {
    const pages = pdfPages(buildPdf(THREE_PAGES, { nestedTree: true }))
    expect(pages?.map((page) => page.split('\n').pop())).toEqual(['INV-1001', 'INV-1002', 'INV-1003'])
  })

  it('joins pieces drawn on one line, across the page, with a wide gap between columns', () => {
    // Drawn date first, label second, as some accounting packages do: the
    // reading order across the page is what comes out.
    const pages = pdfPages(
      buildPdf([
        [
          [
            [330, '29/09/2026'],
            [40, 'Customer Order No.'],
            [150, 'PO-00012'],
            [240, 'Invoice Date'],
          ],
        ],
      ]),
    )
    expect(pages?.[0]).toBe('Customer Order No.   PO-00012   Invoice Date   29/09/2026')
  })

  it('keeps pieces on separate heights on separate lines', () => {
    expect(pdfPages(buildPdf([['Invoice No.', '0000008633']]))?.[0]).toBe('Invoice No.\n0000008633')
  })

  it('is not a PDF, and says so', () => {
    expect(pdfPages(Buffer.from('\x89PNG\r\n\x1a\n and then some pixels', 'latin1'))).toBeNull()
  })

  it('will not open an encryption it does not support', () => {
    // Revision 6 is AES-256: legitimate, and deliberately refused.
    const locked = Buffer.from(buildPdf(THREE_PAGES, { encrypt: true }).toString('latin1').replace('/V 2 /R 3', '/V 5 /R 6'), 'latin1')
    expect(pdfPages(locked)).toBeNull()
    expect(pdfText(locked)).toBeNull()
  })
})

describe('pdfText', () => {
  it('is every page, joined', () => {
    const text = pdfText(buildPdf(THREE_PAGES, { encrypt: true, viaForm: true }))
    expect(text?.split('\n').filter((line) => line.startsWith('INV-'))).toEqual(['INV-1001', 'INV-1002', 'INV-1003'])
  })
})

// Files built to be expensive. Each must finish quickly and either read what it
// honestly holds or give up - never grind through gigabytes to get there. The
// time bounds are generous so a slow machine does not fail them; what they
// catch is the difference between linear and repeated work, which is orders of
// magnitude.
describe('pdfPages on hostile files', () => {
  const PADDING = '0 0 m 1 1 l S\n'

  function timed<T>(work: () => T): { result: T; ms: number } {
    const started = performance.now()
    const result = work()
    return { result, ms: performance.now() - started }
  }

  it('reads a stream listed a thousand times in /Contents once', () => {
    const file = buildPdf([['Invoice No.', 'INV-7001']], { repeatContents: 2000, extraContent: PADDING.repeat(40_000) })
    const before = process.memoryUsage().rss
    const { result, ms } = timed(() => pdfPages(file))
    expect(result).toEqual(['Invoice No.\nINV-7001'])
    expect(ms).toBeLessThan(5000)
    // Two thousand copies of a half-megabyte stream would be a gigabyte.
    expect(process.memoryUsage().rss - before).toBeLessThan(400 * 1024 * 1024)
  })

  it('reads one big form drawn on hundreds of pages once, not once a page', () => {
    // 400 pages x a 2 MB form is 800 MB of content if each page re-reads it -
    // far past the file's allowance, so this only reads at all if it is shared.
    const pages = Array.from({ length: 400 }, () => ['Invoice No.', 'INV-7002'])
    const file = buildPdf(pages, { viaForm: true, sharedForm: true, extraContent: PADDING.repeat(150_000) })
    const { result, ms } = timed(() => pdfPages(file))
    expect(result).toHaveLength(400)
    expect(new Set(result)).toEqual(new Set(['Invoice No.\nINV-7002']))
    expect(ms).toBeLessThan(10_000)
  })

  it('steps over a flood of inline images in linear time', () => {
    const flood = 'BI /W 1 /H 1 /BPC 8 /CS /G ID x EI\n'.repeat(100_000)
    const file = buildPdf([['Invoice No.', 'INV-7003']], { extraContent: flood })
    const { result, ms } = timed(() => pdfPages(file))
    expect(result?.[0]).toBe('Invoice No.\nINV-7003')
    expect(ms).toBeLessThan(5000)
  })

  it('gives up on a stream that inflates past the allowance, and the whole-file reader is bounded too', () => {
    // Three pages, each a few kilobytes that inflate to 15 MB: 45 MB in all.
    const file = buildPdf(
      [['INV-7004'], ['INV-7005'], ['INV-7006']],
      { extraContent: `%${' '.repeat(15 * 1024 * 1024)}\n` },
    )
    expect(file.length).toBeLessThan(200_000)
    const { result, ms } = timed(() => pdfPages(file))
    expect(result).toBeNull()
    expect(ms).toBeLessThan(5000)
    expect(timed(() => pdfText(file)).ms).toBeLessThan(5000)
  })

  it('refuses a page tree that contains itself', () => {
    const { result, ms } = timed(() => pdfPages(buildPdf(THREE_PAGES, { cyclicTree: true })))
    expect(result).toBeNull()
    expect(ms).toBeLessThan(1000)
  })

  it('reads a form that draws itself once, and stops', () => {
    const { result, ms } = timed(() => pdfPages(buildPdf(THREE_PAGES, { viaForm: true, formLoop: true })))
    expect(result?.map((page) => page.split('\n').pop())).toEqual(['INV-1001', 'INV-1002', 'INV-1003'])
    expect(ms).toBeLessThan(1000)
  })

  it('answers the same bytes from memory, and changed bytes afresh', () => {
    const file = buildPdf(THREE_PAGES)
    const first = pdfPages(file)
    expect(pdfPages(file)).toEqual(first)
    // Same object, contents spoiled in place: read again, not remembered.
    file.write('XXXXX', 0, 'latin1')
    expect(pdfPages(file)).toBeNull()
  })
})

// Fix round 2: allowances that ran out without saying so.
describe('pdfPages when an allowance runs out', () => {
  it('gives up on a thousand distinct streams that each inflate past the limit, quickly', () => {
    // Each is ~21 KB that inflates to 21 MB - just over the per-stream limit -
    // so each one is refused, but only after the work is done. Charged for
    // nothing, a thousand of them is twenty gigabytes of inflating.
    const file = buildPdf([['Invoice No.', 'INV-8001']], { bombs: { count: 1000, bytes: 21 * 1024 * 1024 } })
    const before = process.memoryUsage().rss
    const started = performance.now()
    expect(pdfPages(file)).toBeNull()
    const pagesMs = performance.now() - started
    const scanStarted = performance.now()
    pdfText(file)
    const scanMs = performance.now() - scanStarted
    expect(pagesMs).toBeLessThan(1500)
    expect(scanMs).toBeLessThan(1500)
    expect(process.memoryUsage().rss - before).toBeLessThan(300 * 1024 * 1024)
  })
})

// Fix round 3
describe('pdfPages on a linearized file', () => {
  it('finds the catalogue in the front trailer when the last one carries only /Size', () => {
    const pages = pdfPages(buildPdf(THREE_PAGES, { encrypt: true, linearizedStyle: true }))
    expect(pages?.map((page) => page.split('\n').pop())).toEqual(['INV-1001', 'INV-1002', 'INV-1003'])
  })
})

describe('pdfPages on streams that fail late', () => {
  it('charges a stream that breaks after inflating for the work it did', () => {
    // Each ~15 KB inflates 15 MB of spaces and then fails for being cut short,
    // not for being too big. Charged only its own size, a thousand of them is
    // fifteen gigabytes of inflating.
    const file = buildPdf([['Invoice No.', 'INV-8101']], { bombs: { count: 1000, bytes: 15 * 1024 * 1024, truncated: true } })
    const started = performance.now()
    expect(pdfPages(file)).toBeNull()
    pdfText(file)
    expect(performance.now() - started).toBeLessThan(3000)
  })
})
