import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import manifest from '@/modules/purchase-orders/cactus.module.json'
import {
  PoPsHeader, PoPsFrom, PoPsShipTo, PoPsLines, PoPsTracking, PoPsNotes,
} from '@/modules/purchase-orders/components/puck/po-packing-parts'
import { PO_DOC_SCOPE_CLASSES } from '@/modules/purchase-orders/components/puck/po-chrome'
import { PO_PS_PART_TYPES, SAMPLE_PO_PS_CONTEXT } from '@/modules/purchase-orders/lib/packing-slip-context'

// The packing slip draws with the SAME stylesheet and the SAME Document style
// block as the purchase order and the returns note, which only works while every
// class it renders is on that block's scope list.
//
// And then there is the rule this document actually lives or dies by: it goes IN
// THE BOX, and on a drop-shipped order the person opening that box is the
// customer. No prices. No supplier name. The tests below are the ones that would
// catch the day somebody adds a "show cost" field because it seemed harmless.

const ctx = SAMPLE_PO_PS_CONTEXT

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
  ['PoPsHeader', <PoPsHeader key="h" _ctx={ctx} />],
  ['PoPsFrom', <PoPsFrom key="f" _ctx={ctx} />],
  ['PoPsShipTo', <PoPsShipTo key="s" _ctx={ctx} />],
  ['PoPsLines', <PoPsLines key="l" _ctx={ctx} />],
  ['PoPsTracking', <PoPsTracking key="t" _ctx={ctx} />],
  ['PoPsNotes', <PoPsNotes key="n" _ctx={ctx} />],
] as const

const everything = () => PARTS.map(([, element]) => visible(renderToStaticMarkup(element))).join('')

describe('the packing slip blocks', () => {
  it('every part draws the sample slip when no context is injected', () => {
    // The editor canvas has no despatch. A block that threw or drew nothing
    // there would be undesignable.
    const blocks = [
      <PoPsHeader key="h" />, <PoPsFrom key="f" />, <PoPsShipTo key="s" />,
      <PoPsLines key="l" />, <PoPsTracking key="t" />, <PoPsNotes key="n" />,
    ]
    for (const block of blocks) {
      expect(visible(renderToStaticMarkup(block)).trim()).not.toBe('')
    }
  })

  it('has no money on it anywhere', () => {
    // Not a unit cost, not a line total, not a currency symbol. The context has
    // no price on it at all, so this is belt and braces on a rule that would be
    // very expensive to break once: a customer opening a box and reading what
    // their supplier charged us for it.
    const html = everything()
    expect(html).not.toMatch(/[£$€]/)
    expect(Object.keys(ctx.slip.lines[0]!)).not.toContain('unitCost')
    expect(Object.keys(ctx.slip.lines[0]!)).not.toContain('lineTotal')
    expect(Object.keys(ctx.slip)).not.toContain('total')
  })

  it('does not name the supplier', () => {
    // They are the ones printing it. The customer bought from us.
    expect(Object.keys(ctx)).not.toContain('supplier')
    expect(everything()).not.toContain('Northern Clay')
  })

  it('puts the despatch, the order and where it is going on the page', () => {
    const head = visible(renderToStaticMarkup(<PoPsHeader />))
    expect(head).toContain('DSP-00007')
    // The order number has no hide switch: a box nobody can file against an
    // order is a box and a mystery.
    expect(head).toContain('PO-00147')
    expect(visible(renderToStaticMarkup(<PoPsShipTo />))).toContain('Sample Customer Ltd')
  })

  it('says what is in this box against what was ordered', () => {
    const html = visible(renderToStaticMarkup(<PoPsLines />))
    expect(html).toContain('Oak desk 1600mm, silver legs')
    expect(html).toContain('8')
    expect(html).toContain('12')
  })

  it('says when the rest is still to come, and only then', () => {
    expect(visible(renderToStaticMarkup(<PoPsLines />))).toContain('still to come')
    const complete = { ...ctx, slip: { ...ctx.slip, partial: false } }
    expect(visible(renderToStaticMarkup(<PoPsLines _ctx={complete} />))).not.toContain('still to come')
  })

  it('draws nothing at all when nobody said how it travelled', () => {
    // A heading over an empty box is worse than no box.
    const bare = { ...ctx, slip: { ...ctx.slip, carrier: '', trackingRef: '' } }
    const html = visible(renderToStaticMarkup(<PoPsTracking _ctx={bare} showDate="no" />))
    expect(html.trim()).toBe('')
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

  it('fills the placeholders in its own wording', () => {
    const html = visible(
      renderToStaticMarkup(<PoPsNotes extra="Quote {{ORDER_NUMBER}} and ring {{BUSINESS_PHONE}}." />),
    )
    expect(html).toContain('Quote PO-00147 and ring 0113 496 0000.')
    expect(html).not.toContain('{{')
  })
})

describe('the manifest and the packing slip blocks agree', () => {
  const declared = (manifest.puckBlocks ?? []) as { type: string; layoutTypes: string[] }[]
  const onSlip = declared.filter((b) => b.layoutTypes.includes('purchasePackingSlip')).map((b) => b.type)

  it('declares every packing slip block on the packing slip layout type', () => {
    for (const [name] of PARTS) expect(onSlip).toContain(name)
  })

  it('shares the document style and the divider rather than writing them a third time', () => {
    expect(onSlip).toContain('PoDocStyle')
    expect(onSlip).toContain('PoDocDivider')
    for (const type of ['PoDocStyle', 'PoDocDivider']) {
      const block = declared.find((b) => b.type === type)!
      expect(block.layoutTypes).toContain('purchaseOrderDocument')
      expect(block.layoutTypes).toContain('purchaseReturnDocument')
    }
  })

  it('injects the despatch into every block that reads one, and no others', () => {
    for (const type of PO_PS_PART_TYPES) expect(onSlip).toContain(type)
    expect(PO_PS_PART_TYPES).not.toContain('PoDocStyle')
    expect(PO_PS_PART_TYPES).not.toContain('PoDocDivider')
  })

  it('declares the packing slip layout type with a starter of its own', () => {
    const type = manifest.layoutTypes.types.find((t: { key: string }) => t.key === 'purchasePackingSlip')
    expect(type).toBeTruthy()
    expect(type!.starterExport).toBe('purchasePackingSlipStarters')
  })

  it('drops its own tables before the tables they point at', () => {
    // Teardown runs in the order declared. A despatch points at an order line,
    // so it has to go first.
    const teardown = manifest.teardown as string[]
    expect(teardown.indexOf('po_shipment_lines')).toBeLessThan(teardown.indexOf('po_shipments'))
    expect(teardown.indexOf('po_shipments')).toBeLessThan(teardown.indexOf('po_orders'))
    expect(teardown.indexOf('po_shipments')).toBeLessThan(teardown.indexOf('po_portal_tokens'))
  })
})
