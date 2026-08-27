import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import manifest from '@/modules/purchase-orders/cactus.module.json'
import {
  PoRetHeader, PoRetParties, PoRetTo, PoRetLines, PoRetTotals, PoRetReason, PoRetNotes,
  PoRetNotice, poRetNoticePuckComponent,
} from '@/modules/purchase-orders/components/puck/po-return-parts'
import { PO_DOC_SCOPE_CLASSES } from '@/modules/purchase-orders/components/puck/po-chrome'
import { PO_RET_PART_TYPES, SAMPLE_PO_RET_CONTEXT } from '@/modules/purchase-orders/lib/return-doc-context'

// The returns note draws with the SAME stylesheet and the SAME Document style
// block as the purchase order, which only works while every class it renders is
// on that block's scope list. A returns block that quietly stopped being reached
// by the style block would look right in the editor and wrong in the PDF.

const ctx = SAMPLE_PO_RET_CONTEXT

/** Markup with the stylesheets stripped, for counting what is on the page. */
function visible(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, '')
}

/** The class names on every element at the top of a block's output. Anything
 *  nested is inside one of these and inherits, so only the roots matter. */
function rootClasses(html: string): string[] {
  const stripped = visible(html).replace(/<link[^>]*>/g, '')
  const found: string[] = []
  let depth = 0
  const tagRe = /<(\/?)([a-z0-9]+)([^>]*)>/gi
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(stripped))) {
    const closing = match[1] ?? ''
    const tag = match[2] ?? ''
    const attrs = match[3] ?? ''
    if (closing) {
      depth -= 1
      continue
    }
    if (depth === 0) {
      const cls = /class="([^"]*)"/.exec(attrs)
      found.push(cls?.[1] ?? '')
    }
    if (!attrs.endsWith('/') && !/^(img|br|hr|input|meta)$/i.test(tag)) depth += 1
  }
  return found
}

const PARTS = [
  ['PoRetHeader', <PoRetHeader key="h" _ctx={ctx} />],
  ['PoRetParties', <PoRetParties key="p" _ctx={ctx} />],
  ['PoRetTo', <PoRetTo key="t" _ctx={ctx} />],
  ['PoRetLines', <PoRetLines key="l" _ctx={ctx} />],
  ['PoRetTotals', <PoRetTotals key="o" _ctx={ctx} />],
  ['PoRetReason', <PoRetReason key="r" _ctx={ctx} />],
  ['PoRetNotes', <PoRetNotes key="n" _ctx={ctx} />],
  ['PoRetNotice', <PoRetNotice key="i" _ctx={ctx} lead="Credit {{RETURN_NUMBER}}." />],
] as const

describe('the returns note blocks', () => {
  it('every part draws the sample note when no context is injected', () => {
    // The editor canvas has no return. A block that threw or drew nothing there
    // would be undesignable.
    const blocks = [
      <PoRetHeader key="h" />, <PoRetParties key="p" />, <PoRetTo key="t" />, <PoRetLines key="l" />,
      <PoRetTotals key="o" />, <PoRetReason key="r" />, <PoRetNotes key="n" />,
      <PoRetNotice key="i" lead={poRetNoticePuckComponent.defaultProps.lead} body={poRetNoticePuckComponent.defaultProps.body} />,
    ]
    for (const block of blocks) {
      expect(visible(renderToStaticMarkup(block)).trim()).not.toBe('')
    }
  })

  it('puts the return, the order it is against and the supplier on the page', () => {
    const head = visible(renderToStaticMarkup(<PoRetHeader />))
    expect(head).toContain('SRN-00014')
    // The order number has no hide switch: a return nobody can file against an
    // order is a box on a dock and a mystery.
    expect(head).toContain('PO-00147')
    expect(visible(renderToStaticMarkup(<PoRetTo />))).toContain('Northern Clay Co.')
  })

  it('prints the credit as a positive figure, never as a negative', () => {
    // "-£396.00" on a page headed "Returns note" invites the question of which
    // way round it is meant, and that question costs a phone call.
    const html = visible(renderToStaticMarkup(<PoRetTotals />))
    expect(html).toContain('£396.00')
    expect(html).not.toContain('-£396.00')
  })

  it('names the delivery each line came in on', () => {
    expect(visible(renderToStaticMarkup(<PoRetLines />))).toContain('GRN-00032')
  })

  it('keeps every root class inside the style block s scope list', () => {
    for (const [name, element] of PARTS) {
      for (const cls of rootClasses(renderToStaticMarkup(element))) {
        const first = cls.split(/\s+/)[0]
        if (!first) continue
        expect(PO_DOC_SCOPE_CLASSES, `${name} renders an unscoped root class "${first}"`).toContain(first)
      }
    }
  })

  it('fills the placeholders in a notice panel', () => {
    const html = visible(renderToStaticMarkup(<PoRetNotice lead="Credit {{CREDIT_EXPECTED}} against {{ORDER_NUMBER}}." body="" />))
    expect(html).toContain('Credit £396.00 against PO-00147.')
    expect(html).not.toContain('{{')
  })

  it('draws nothing at all when a notice has been emptied', () => {
    expect(visible(renderToStaticMarkup(<PoRetNotice />)).trim()).toBe('')
  })

  it('leaves the page alone when nobody said why the goods are going back', () => {
    // A heading over an empty box is worse than no box, and "Why they are going
    // back:" followed by white space reads as an accusation.
    const html = visible(renderToStaticMarkup(<PoRetReason _ctx={{ ...ctx, ret: { ...ctx.ret, reason: '' } }} />))
    expect(html.trim()).toBe('')
  })
})

describe('the manifest and the returns blocks agree', () => {
  const declared = (manifest.puckBlocks ?? []) as { type: string; layoutTypes: string[] }[]
  const onReturn = declared.filter((b) => b.layoutTypes.includes('purchaseReturnDocument')).map((b) => b.type)

  it('declares every returns block on the returns layout type', () => {
    for (const [name] of PARTS) expect(onReturn).toContain(name)
  })

  it('shares the document style and the divider rather than writing them twice', () => {
    // A business that has designed its purchasing paperwork once has designed
    // both documents. Two style blocks would be two things to keep in step.
    expect(onReturn).toContain('PoDocStyle')
    expect(onReturn).toContain('PoDocDivider')
    for (const type of ['PoDocStyle', 'PoDocDivider']) {
      const block = declared.find((b) => b.type === type)!
      expect(block.layoutTypes).toContain('purchaseOrderDocument')
    }
  })

  it('injects the return into every block that reads one, and no others', () => {
    for (const type of PO_RET_PART_TYPES) expect(onReturn).toContain(type)
    expect(PO_RET_PART_TYPES).not.toContain('PoDocStyle')
    expect(PO_RET_PART_TYPES).not.toContain('PoDocDivider')
  })

  it('declares the returns layout type with a starter of its own', () => {
    const type = manifest.layoutTypes.types.find((t: { key: string }) => t.key === 'purchaseReturnDocument')
    expect(type).toBeTruthy()
    expect(type!.starterExport).toBe('purchaseReturnDocumentStarters')
  })
})
