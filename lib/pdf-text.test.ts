import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { pdfText } from '@/modules/purchase-orders/lib/pdf-text'

// The PDFs that prompted this file are a real supplier's, with a real customer's
// address on them, so none of them is in this repository. What is here instead is
// a document built to the same shape - the same operators, the same drawing
// order, a label on one line and its value on the next - which is the whole of
// what the reader is asked to cope with.

/** A one-page PDF whose content stream draws the lines given, in order. */
function samplePdf(lines: string[], options: { compress: boolean }): Buffer {
  const content =
    'BT /F1 10 Tf 40 700 Td\n' +
    lines.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) Tj 0 -14 Td`).join('\n') +
    '\nET\n'
  const stream = options.compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
  ]

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  objects.forEach((body, index) => {
    parts.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1'))
  })
  parts.push(
    Buffer.from(
      `4 0 obj\n<< /Length ${stream.length}${options.compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
      'latin1',
    ),
  )
  parts.push(stream)
  parts.push(Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'))
  return Buffer.concat(parts)
}

describe('pdfText', () => {
  it('reads a compressed content stream', () => {
    const text = pdfText(samplePdf(['Invoice No.', '0000008633'], { compress: true }))
    expect(text).toContain('Invoice No.')
    expect(text).toContain('0000008633')
  })

  it('reads a stream that was never compressed', () => {
    const text = pdfText(samplePdf(['Sales No.', '0000966554'], { compress: false }))
    expect(text).toContain('0000966554')
  })

  it('keeps the label and its value on separate lines, in drawing order', () => {
    const text = pdfText(samplePdf(['Invoice No.', '0000008633', 'Invoice Date', '04/09/2026'], { compress: true }))
    const lines = (text ?? '').split(/\n+/).map((line) => line.trim()).filter(Boolean)
    expect(lines.indexOf('0000008633')).toBe(lines.indexOf('Invoice No.') + 1)
  })

  it('resolves the escapes inside a string', () => {
    const text = pdfText(samplePdf(['Smith (Reading) Ltd'], { compress: true }))
    expect(text).toContain('Smith (Reading) Ltd')
  })

  it('is not a PDF, and says so rather than guessing', () => {
    expect(pdfText(Buffer.from('\x89PNG\r\n\x1a\n and then some pixels', 'latin1'))).toBeNull()
  })

  it('has nothing to say about a file it cannot decrypt', () => {
    // A revision-6 encryption dictionary: legitimate, and deliberately not
    // supported. The answer is null rather than a stream of noise.
    const locked = Buffer.concat([
      samplePdf(['Invoice No.', '0000008633'], { compress: true }),
      Buffer.from('9 0 obj\n<< /Filter /Standard /V 5 /R 6 /Length 256 /O (x) >>\nendobj\n/Encrypt 9 0 R\n', 'latin1'),
    ])
    expect(pdfText(locked)).toBeNull()
  })
})
