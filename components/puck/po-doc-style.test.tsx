import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import manifest from '@/modules/purchase-orders/cactus.module.json'
import {
  PoDocHeader, PoDocParties, PoDocFrom, PoDocTo, PoDocShipTo, PoDocLines, PoDocTotals,
  PoDocTerms, PoDocNotes, PoDocApproval,
} from '@/modules/purchase-orders/components/puck/po-parts'
import {
  PoDocStyle, PoDocNotice, PoDocDivider, PO_DOC_SCOPE_CLASSES, poDocNoticePuckComponent,
} from '@/modules/purchase-orders/components/puck/po-chrome'
import { PO_DOC_CSS } from '@/modules/purchase-orders/components/puck/po-doc-css'
import { PO_DOC_PART_TYPES, SAMPLE_PO_CONTEXT } from '@/modules/purchase-orders/lib/doc-context'

// The Document style block sets its custom properties on the part classes rather
// than on :root, so nothing escapes the document - which matters because this
// document renders inside the site's own page as well as in the admin's Puck
// canvas. That only works while the list of part classes matches the parts that
// actually exist, and nothing else checks that.

const ctx = SAMPLE_PO_CONTEXT

/** Markup with the stylesheets stripped, for counting what is on the page. */
function visible(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, '')
}

/** What the style block wrote, with the shared stylesheet every part carries
 *  taken back out - that one mentions the custom properties too, being what
 *  reads them. */
function emitted(html: string): string {
  return html
    .split('</style>')
    .map((part) => `${part}</style>`)
    .filter((part) => !part.includes(PO_DOC_CSS.slice(0, 80)))
    .join('')
    .replace(/<\/?style>/g, '')
    .trim()
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
  ['PoDocHeader', <PoDocHeader key="h" _ctx={ctx} />],
  ['PoDocParties', <PoDocParties key="p" _ctx={ctx} />],
  ['PoDocFrom', <PoDocFrom key="f" _ctx={ctx} />],
  ['PoDocTo', <PoDocTo key="t" _ctx={ctx} />],
  ['PoDocShipTo', <PoDocShipTo key="s" _ctx={ctx} />],
  ['PoDocLines', <PoDocLines key="l" _ctx={ctx} />],
  ['PoDocTotals', <PoDocTotals key="o" _ctx={ctx} />],
  ['PoDocTerms', <PoDocTerms key="e" _ctx={ctx} />],
  ['PoDocNotes', <PoDocNotes key="n" _ctx={ctx} />],
  ['PoDocApproval', <PoDocApproval key="a" _ctx={ctx} />],
  ['PoDocNotice', <PoDocNotice key="i" _ctx={ctx} lead="Quote {{ORDER_NUMBER}}." />],
  ['PoDocDivider', <PoDocDivider key="d" />],
] as const

describe('the purchase order document blocks', () => {
  it('every part draws the sample order when no context is injected', () => {
    // The editor canvas has no purchase order. A block that threw or drew
    // nothing there would be undesignable.
    const blocks = [
      <PoDocHeader key="h" />, <PoDocParties key="p" />, <PoDocFrom key="f" />, <PoDocTo key="t" />,
      <PoDocShipTo key="s" />, <PoDocLines key="l" />, <PoDocTotals key="o" />, <PoDocTerms key="e" />,
      <PoDocNotes key="n" />, <PoDocApproval key="a" />,
      // With its own default wording, which is what Puck hands it on the canvas.
      // Bare, it draws nothing on purpose - an empty tinted box is worse than no
      // box - and that is the next test.
      <PoDocNotice key="i" lead={poDocNoticePuckComponent.defaultProps.lead} body={poDocNoticePuckComponent.defaultProps.body} />,
    ]
    for (const block of blocks) {
      expect(visible(renderToStaticMarkup(block)).trim()).not.toBe('')
    }
  })

  it('puts the sample order number and supplier on the page', () => {
    const html = visible(renderToStaticMarkup(<PoDocHeader />))
    expect(html).toContain('PO-00147')
    expect(visible(renderToStaticMarkup(<PoDocTo />))).toContain('Northern Clay Co.')
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

  it('emits nothing at all when no field on the style block is set', () => {
    // A style block nobody has touched must be provably identical to no style
    // block, or the document changes the day somebody drags one on.
    expect(emitted(renderToStaticMarkup(<PoDocStyle />))).toBe('')
    expect(emitted(renderToStaticMarkup(<PoDocStyle density="normal" />))).toBe('')
  })

  it('scopes what it does emit to the part classes rather than to the page', () => {
    const css = emitted(renderToStaticMarkup(<PoDocStyle accent="var(--color-primary)" />))
    expect(css).toContain('--po-doc-accent: var(--color-primary);')
    expect(css).toContain('.po-doc-head')
    expect(css).not.toContain(':root')
    expect(css).not.toContain('body')
  })

  it('gives a coloured divider a custom property, never an inline border colour', () => {
    // The print rules say !important to force a dark page back to ink, and
    // !important beats an inline declaration - so an inline border-top-color
    // would come out grey in the PDF, which is the one place the colour was the
    // whole point.
    const html = renderToStaticMarkup(<PoDocDivider colour="#c94f2a" />)
    expect(html).toContain('--po-doc-rule-ink:#c94f2a')
    // Checked on the markup rather than the whole render: the shared stylesheet
    // every block carries mentions border-top-color itself, being the rule that
    // reads the property.
    expect(visible(html)).not.toContain('border-top-color')
  })

  it('fills the placeholders in a notice panel', () => {
    const html = visible(renderToStaticMarkup(<PoDocNotice lead="Quote {{ORDER_NUMBER}} on your invoice." body="" />))
    expect(html).toContain('Quote PO-00147 on your invoice.')
    expect(html).not.toContain('{{')
  })

  it('draws nothing at all when a notice has been emptied', () => {
    expect(visible(renderToStaticMarkup(<PoDocNotice />)).trim()).toBe('')
  })

  it('leaves the page alone when a notice is all empty placeholders', () => {
    const html = visible(renderToStaticMarkup(<PoDocNotice lead="{{SUPPLIER_ACCOUNT}}" body="" _ctx={{ ...ctx, supplier: { ...ctx.supplier, accountNumber: '' } }} />))
    expect(html.trim()).toBe('')
  })

  it('never prints an internal note, because the document has no idea there is one', () => {
    // notes_internal is deliberately absent from the document context, so no
    // block can print it and no future block can start. "Check they have not
    // stitched us up on carriage again" must not be one careless drag away from
    // the page that gets emailed to them.
    expect(Object.keys(ctx.order)).not.toContain('notesInternal')
    const everything = PARTS.map(([, element]) => renderToStaticMarkup(element)).join('')
    expect(everything).not.toContain('notesInternal')
  })
})

describe('the manifest and the blocks agree', () => {
  const declared = (manifest.puckBlocks ?? []).map((b: { type: string }) => b.type)

  it('declares every block on the purchase order document layout type', () => {
    for (const [name] of PARTS) expect(declared).toContain(name)
    expect(declared).toContain('PoDocStyle')
    // Thirteen on the order, plus the returns note's own eight. The style block
    // and the divider are shared rather than counted twice - see
    // po-return-doc.test.tsx, which pins that sharing from the other side.
    expect(declared.length).toBe(21)
  })

  it('injects the order into every block that reads one, and no others', () => {
    for (const type of PO_DOC_PART_TYPES) expect(declared).toContain(type)
    // The style block and the divider print no figure, so neither needs the
    // document, and attaching it would only make the injected tree bigger.
    expect(PO_DOC_PART_TYPES).not.toContain('PoDocStyle')
    expect(PO_DOC_PART_TYPES).not.toContain('PoDocDivider')
  })
})
