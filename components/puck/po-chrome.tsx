import type { CSSProperties } from 'react'
import {
  Style, FontLink, fontStyle, fontField, headingFontField, sizeField, radiusField, spaceField,
  sizeVars, cssLength, colourField, fillTokens, poTokens, paragraphs, useCtx, TOKEN_HINT,
  type DocProps,
} from '@/modules/purchase-orders/components/puck/po-shared'

// The purchase order document's chrome: the three blocks that carry no priced
// line of their own. One sets the document's colours and spacing for every other
// block; the other two - a notice panel and a rule - are things somebody writes
// or draws rather than things the order supplies.
//
// Same contract as po-parts.tsx: one render path each, shared by the Puck editor
// and the published document, so what is designed on the canvas and what comes
// out of the printer are the same thing by construction.

// ---------------------------------------------------------------------------
// Document style
// ---------------------------------------------------------------------------
//
// One block, dropped once anywhere on the layout, that sets the document's accent
// colour, its table fill, its rule weight and its spacing. Everything else reads
// those through `--po-doc-*` custom properties whose fallbacks are exactly what
// the document looks like with no style block on it - so a layout carrying none
// is unchanged by this existing.
//
// The properties are set ON THE PART CLASSES, not on `:root`. The document
// renders inside the site's own page at /purchase-order/<number> and inside the
// admin's Puck canvas, and a document-wide rule from one block has no business
// reaching either. Listing the part classes keeps every declaration inside the
// document.
//
// A part added later must be added to this list, or it silently keeps the
// fallbacks. There is a test that fails when it drifts.

export const PO_DOC_SCOPE_CLASSES = [
  'po-doc-head',
  'po-doc-intro',
  'po-doc-lead',
  'po-doc-parties',
  'po-doc-shipto',
  'po-doc-lines',
  'po-doc-totals',
  'po-doc-note',
  'po-doc-terms',
  'po-doc-notes',
  'po-doc-notice',
  'po-doc-approval',
  'po-doc-rule',
]

const RULE_WEIGHTS: Record<string, string> = {
  hairline: '1px',
  medium: '2px',
  thick: '3px',
  heavy: '5px',
}

const RADII: Record<string, string> = { square: '0', soft: '4px', round: '10px' }

const DENSITIES: Record<string, { row: string; gap: string; gapLg: string }> = {
  compact: { row: '0.375rem', gap: '1rem', gapLg: '1.25rem' },
  normal: { row: '0.625rem', gap: '1.5rem', gapLg: '1.75rem' },
  roomy: { row: '0.9375rem', gap: '2.25rem', gapLg: '2.75rem' },
}

type StyleProps = {
  accent?: string; labelColour?: string; titleColour?: string
  tableHeadBg?: string; tableHeadInk?: string
  panelBg?: string; panelInk?: string; zebraBg?: string
  ruleWeight?: string; ruleWeightPx?: string; corners?: string; cornerRadius?: string; density?: string
  blockGap?: string; blockGapLarge?: string
  bodyFont?: string; headingFont?: string
}

/** `--name: value;` for every field somebody actually set. A blank field emits
 *  nothing at all rather than an empty value, so the CSS fallback stands. */
function declarations(pairs: [string, string | undefined][]): string {
  return pairs
    .filter(([, value]) => Boolean(value && value.trim()))
    .map(([name, value]) => `${name}: ${value!.trim()};`)
    .join(' ')
}

export function PoDocStyle(props: StyleProps) {
  // 'normal' is what the stylesheet already falls back to, so saying it again
  // would emit three declarations that change nothing - and would stop a block
  // nobody has touched from being provably identical to no block at all.
  const density = props.density && props.density !== 'normal' ? DENSITIES[props.density] : undefined
  const css = declarations([
    ['--po-doc-accent', props.accent],
    ['--po-doc-label', props.labelColour],
    ['--po-doc-title-ink', props.titleColour],
    ['--po-doc-thead-bg', props.tableHeadBg],
    ['--po-doc-thead-ink', props.tableHeadInk],
    ['--po-doc-panel-bg', props.panelBg],
    ['--po-doc-panel-ink', props.panelInk],
    ['--po-doc-zebra-bg', props.zebraBg],
    // The picked thickness, or an exact one where somebody asked for exactly
    // that. The exact menu wins, and blank in it leaves the preset standing.
    ['--po-doc-rule-w', cssLength(props.ruleWeightPx) ?? RULE_WEIGHTS[props.ruleWeight ?? '']],
    ['--po-doc-radius', cssLength(props.cornerRadius) ?? RADII[props.corners ?? '']],
    ['--po-doc-row-y', density?.row],
    ['--po-doc-gap', cssLength(props.blockGap) ?? density?.gap],
    ['--po-doc-gap-lg', cssLength(props.blockGapLarge) ?? density?.gapLg],
    ['--po-doc-body-font', props.bodyFont?.trim()],
    ['--po-doc-head-font', props.headingFont?.trim()],
  ])

  const selector = PO_DOC_SCOPE_CLASSES.map((name) => `.${name}`).join(', ')
  return (
    <>
      <Style />
      <FontLink family={props.bodyFont} />
      <FontLink family={props.headingFont} />
      {css && <style dangerouslySetInnerHTML={{ __html: `${selector} { ${css} }` }} />}
    </>
  )
}

export const poDocStylePuckComponent = {
  label: 'Purchase order: Document style',
  fields: {
    accent: colourField('Accent colour (rules, the total, the notice bar)'),
    labelColour: colourField('Small headings ("To", "Terms")'),
    titleColour: colourField('Heading and total'),
    tableHeadBg: colourField('Line table header background'),
    tableHeadInk: colourField('Line table header text'),
    panelBg: colourField('Panel background (deliver to, notice)'),
    panelInk: colourField('Notice panel text'),
    zebraBg: colourField('Alternating row shading'),
    ruleWeight: { type: 'select' as const, label: 'Accent rule thickness', options: [
      { value: 'hairline', label: 'Hairline' },
      { value: 'medium', label: 'Medium' },
      { value: 'thick', label: 'Thick' },
      { value: 'heavy', label: 'Heavy' },
    ] },
    ruleWeightPx: spaceField('…or exactly this thick'),
    corners: { type: 'select' as const, label: 'Corners', options: [
      { value: 'square', label: 'Square' },
      { value: 'soft', label: 'Slightly rounded' },
      { value: 'round', label: 'Rounded' },
    ] },
    cornerRadius: radiusField('…or exactly this radius'),
    density: { type: 'select' as const, label: 'Spacing', options: [
      { value: 'compact', label: 'Compact' },
      { value: 'normal', label: 'Normal' },
      { value: 'roomy', label: 'Roomy' },
    ] },
    blockGap: spaceField('…or exactly this gap between blocks'),
    blockGapLarge: spaceField('…and this one before the small print'),
    bodyFont: fontField,
    headingFont: headingFontField,
  },
  defaultProps: {
    accent: '', labelColour: '', titleColour: '',
    tableHeadBg: '', tableHeadInk: '', panelBg: '', panelInk: '', zebraBg: '',
    ruleWeight: 'thick', ruleWeightPx: '', corners: 'square', cornerRadius: '',
    density: 'normal', blockGap: '', blockGapLarge: '',
    bodyFont: '', headingFont: '',
  },
  render: PoDocStyle,
}
export const poDocStylePuckRscComponent = { ...poDocStylePuckComponent, render: PoDocStyle }

// ---------------------------------------------------------------------------
// Notice panel
// ---------------------------------------------------------------------------
//
// The sentence a purchase order says before it says any numbers: quote this
// number on your invoice, do not substitute, tell us before you ship short.

const NOTICE_STYLES = [
  { value: 'panel', label: 'Tinted panel with an accent bar' },
  { value: 'outline', label: 'Outlined box' },
  { value: 'plain', label: 'Plain text' },
  { value: 'quiet', label: 'Small print' },
]

type NoticeProps = DocProps & {
  radius?: string; padding?: string
  lead?: string; body?: string; panelStyle?: string; hideWhenEmpty?: string
  bodyPt?: number | string
}

export function PoDocNotice(props: NoticeProps) {
  const ctx = useCtx(props)
  const tokens = poTokens(ctx)
  const font = fontStyle(props)
  const lead = fillTokens(props.lead?.trim() ?? '', tokens)
  const body = fillTokens(props.body?.trim() ?? '', tokens)
  // Everything written was tokens, and every token was empty. An empty tinted box
  // is worse than no box.
  if (!lead && !body && props.hideWhenEmpty !== 'no') return null
  const variant = NOTICE_STYLES.some((s) => s.value === props.panelStyle) ? props.panelStyle : 'panel'
  const paras = paragraphs(body)

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-notice po-doc-notice-${variant}`}
        style={{
          ...font,
          ...sizeVars({ '--po-doc-notice-size': props.bodyPt }),
          ...(cssLength(props.radius) ? { '--po-doc-radius': cssLength(props.radius)! } : {}),
          ...(cssLength(props.padding) ? { '--po-doc-notice-pad': cssLength(props.padding)! } : {}),
        }}
      >
        {/* The lead runs into the first paragraph rather than sitting above it -
            "Quote PO-00147 on all paperwork. Deliveries without it may be
            refused." is one sentence with a bold opening, not a heading. */}
        {paras.length > 0 ? (
          paras.map((para, i) => (
            <p key={i}>
              {i === 0 && lead && <span className="po-doc-notice-lead">{lead} </span>}
              {para}
            </p>
          ))
        ) : (
          lead && <p><span className="po-doc-notice-lead">{lead}</span></p>
        )}
      </section>
    </>
  )
}

export const poDocNoticePuckComponent = {
  label: 'Purchase order: Notice panel',
  fields: {
    lead: { type: 'text' as const, label: 'Opening words, in bold' },
    body: { type: 'textarea' as const, label: `The rest of it. ${TOKEN_HINT}` },
    panelStyle: { type: 'select' as const, label: 'Look', options: NOTICE_STYLES },
    hideWhenEmpty: { type: 'select' as const, label: 'When there is nothing to say', options: [
      { value: 'yes', label: 'Leave it off the page' },
      { value: 'no', label: 'Print the empty panel' },
    ] },
    fontFamily: fontField,
    bodyPt: sizeField('Text size'),
    radius: radiusField('Corners'),
    padding: spaceField('Space inside the panel'),
  },
  defaultProps: {
    lead: 'Quote {{ORDER_NUMBER}} on your invoice and delivery note.',
    body: 'Please tell us before you ship short or substitute anything. Invoices that do not carry this order number will be held.',
    panelStyle: 'panel', hideWhenEmpty: 'yes', fontFamily: '', radius: '', padding: '',
  },
  render: PoDocNotice,
}
export const poDocNoticePuckRscComponent = { ...poDocNoticePuckComponent, render: PoDocNotice }

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

const SPACES: Record<string, string> = {
  none: '0',
  small: '0.75rem',
  medium: '1.5rem',
  large: '2.5rem',
}

type DividerProps = {
  weight?: string; weightPx?: string; colour?: string; width?: string
  spaceAbove?: string; spaceBelow?: string; spaceAbovePx?: string; spaceBelowPx?: string
}

export function PoDocDivider(props: DividerProps) {
  const width = props.width === 'short' || props.width === 'centre' ? ` po-doc-rule-${props.width}` : ''
  const colour = props.colour?.trim()
  return (
    <>
      <Style />
      <hr
        className={`po-doc-rule${width}`}
        style={{
          borderTopWidth: cssLength(props.weightPx) ?? RULE_WEIGHTS[props.weight ?? 'hairline'] ?? '1px',
          marginTop: cssLength(props.spaceAbovePx) ?? SPACES[props.spaceAbove ?? 'medium'] ?? SPACES.medium,
          marginBottom: cssLength(props.spaceBelowPx) ?? SPACES[props.spaceBelow ?? 'medium'] ?? SPACES.medium,
          // The colour goes on the custom property the stylesheet reads, NOT on
          // border-top-color. The print rules say !important to force a dark-mode
          // page back to ink on paper, and !important beats an inline
          // declaration - so a coloured rule would come out grey in the PDF,
          // which is the one place the colour was the whole point.
          ...(colour ? { '--po-doc-rule-ink': colour } : {}),
        } as CSSProperties}
      />
    </>
  )
}

export const poDocDividerPuckComponent = {
  label: 'Purchase order: Divider',
  fields: {
    weight: { type: 'select' as const, label: 'Thickness', options: [
      { value: 'hairline', label: 'Hairline' },
      { value: 'medium', label: 'Medium' },
      { value: 'thick', label: 'Thick' },
      { value: 'heavy', label: 'Heavy' },
    ] },
    weightPx: spaceField('…or exactly this thick'),
    colour: colourField('Colour (blank uses the document border)'),
    width: { type: 'select' as const, label: 'Width', options: [
      { value: 'full', label: 'Right across' },
      { value: 'short', label: 'Short, at the left' },
      { value: 'centre', label: 'Short, centred' },
    ] },
    spaceAbove: { type: 'select' as const, label: 'Space above', options: [
      { value: 'none', label: 'None' },
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ] },
    spaceAbovePx: spaceField('…or exactly this much above'),
    spaceBelow: { type: 'select' as const, label: 'Space below', options: [
      { value: 'none', label: 'None' },
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ] },
    spaceBelowPx: spaceField('…or exactly this much below'),
  },
  defaultProps: {
    weight: 'hairline', weightPx: '', colour: '', width: 'full',
    spaceAbove: 'medium', spaceAbovePx: '', spaceBelow: 'medium', spaceBelowPx: '',
  },
  render: PoDocDivider,
}
export const poDocDividerPuckRscComponent = { ...poDocDividerPuckComponent, render: PoDocDivider }
