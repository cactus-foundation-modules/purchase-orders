import type { CSSProperties, ReactNode } from 'react'
import { googleFontHrefForFamily } from '@/lib/design/tokens'
import { SiteColourField, SiteFontField } from '@/lib/puck/fields/registry'
import { formatMoney } from '@/modules/purchase-orders/lib/money'
import { PO_DOC_CSS } from '@/modules/purchase-orders/components/puck/po-doc-css'
import { SAMPLE_PO_CONTEXT, type PoDocContext } from '@/modules/purchase-orders/lib/doc-context'

// What every block of the purchase order document shares: the context it reads,
// the stylesheet it carries, the fields that appear on all of them, and the
// token substitution the written blocks do.
//
// Deliberately the same shape as the shop's invoice blocks and Quote for Shop's
// quote blocks. A business with all three installed is designing three documents
// that end up in the same folder on somebody's desk, and three different ideas
// of what a size field means, or of where the font picker lives, would show.
//
// Nothing here is a client component: there is nothing to click on a purchase
// order.

export type DocProps = { _ctx?: PoDocContext; fontFamily?: string }

/** Context absent means the editor canvas, where a sample order is drawn instead
 *  of a column of empty boxes. */
export function useCtx(props: DocProps): PoDocContext {
  return props._ctx ?? SAMPLE_PO_CONTEXT
}

/** One <style> per part. Identical rules every time, so a document holding every
 *  block costs one set of rules repeated, not one set per block. */
export function Style() {
  return <style dangerouslySetInnerHTML={{ __html: PO_DOC_CSS }} />
}

// ---------------------------------------------------------------------------
// Typeface
// ---------------------------------------------------------------------------
//
// Left blank, a block uses the site's own fonts (po-doc-css binds every part to
// the variables Appearance > Styles emits, headings to the heading font and the
// rest to the body one). Set, it uses that family instead.
//
// Applied INLINE rather than through a class, because the CSS binding above is a
// class rule and would otherwise win against anything inherited.

export function fontStyle(props: { fontFamily?: string }): CSSProperties | undefined {
  const family = props.fontFamily?.trim()
  return family ? { fontFamily: family } : undefined
}

/** The stylesheet a chosen family needs, when it is a Google face rather than a
 *  system one. Rendered inside the block so it travels with the document: the
 *  PDF is a browser opening the page, and nothing else gets a chance to add a
 *  <link> of its own. */
export function FontLink({ family }: { family?: string }) {
  const href = googleFontHrefForFamily(family?.trim())
  return href ? <link rel="stylesheet" href={href} /> : null
}

// ---------------------------------------------------------------------------
// Field labels
// ---------------------------------------------------------------------------
//
// Puck draws the label for its own field types and NOT for `type: 'custom'` - a
// custom field is handed the whole row and is expected to head itself. So every
// font, colour and size menu here supplies its own, in the same wording the
// shop's invoice blocks use: the two panels sit under the same Layouts tab.

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: 'var(--color-text)',
  marginBottom: '0.375rem',
}

function labelled(label: string, control: ReactNode): ReactNode {
  return (
    <div>
      {label && <label style={fieldLabelStyle}>{label}</label>}
      {control}
    </div>
  )
}

const FONT_LABEL = 'Font (blank uses the site font)'

export const fontField = {
  type: 'custom' as const,
  label: FONT_LABEL,
  render: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    labelled(FONT_LABEL, <SiteFontField value={value} onChange={onChange} />),
}

const HEADING_FONT_LABEL = 'Heading font (blank uses the site heading font)'

export const headingFontField = {
  type: 'custom' as const,
  label: HEADING_FONT_LABEL,
  render: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    labelled(HEADING_FONT_LABEL, <SiteFontField value={value} onChange={onChange} />),
}

// ---------------------------------------------------------------------------
// Sizes, radii and gaps
// ---------------------------------------------------------------------------
//
// Menus of pixel values, matching the shop's and the quote's. Blank means
// untouched: nothing is emitted at all for an empty box, so the stylesheet's own
// fallback stands and a layout saved before a field existed renders exactly what
// it rendered then.
//
// The value lands as a `--po-doc-*` custom property set INLINE on the block's
// root element, and the stylesheet reads it with the old hard-coded value as its
// fallback. A property rather than `font-size` because several of these sizes
// belong to a descendant (a table's column headings, the small print) rather
// than to the root itself.

const PX_SIZES = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 48, 56, 64, 72]

const selectStyle: CSSProperties = {
  width: '100%',
  padding: '0.375rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  fontSize: '0.8125rem',
  fontFamily: 'inherit',
}

/** A menu of sizes with "Default" at the top. Not a client component: it is only
 *  ever rendered inside the Puck editor, which is client-side already, and
 *  marking it would open a client boundary in the published render path. */
function SizeSelect({
  value, onChange, sizes, unit, zeroLabel,
}: {
  value: string | number | undefined
  onChange: (value: string) => void
  sizes: number[]
  unit: string
  zeroLabel?: string
}) {
  const current = value === undefined || value === null ? '' : String(value).trim()
  const known = current === '' || sizes.some((n) => `${n}${unit}` === current)
  return (
    <select style={selectStyle} value={current} onChange={(event) => onChange(event.target.value)}>
      <option value="">Default</option>
      {!known && <option value={current}>{`${current} (set by hand)`}</option>}
      {sizes.map((n) => (
        <option key={n} value={`${n}${unit}`}>{n === 0 && zeroLabel ? zeroLabel : `${n}${unit}`}</option>
      ))}
    </select>
  )
}

/** A text size, in px. Blank means "leave it as the document has it". */
export function sizeField(label: string) {
  return {
    type: 'custom' as const,
    label,
    render: ({ value, onChange }: { value: string | number | undefined; onChange: (value: string) => void }) =>
      labelled(label, <SizeSelect value={value} onChange={onChange} sizes={PX_SIZES} unit="px" />),
  }
}

const RADII = [0, 1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32]

/** A corner radius, in px. */
export function radiusField(label: string) {
  return {
    type: 'custom' as const,
    label,
    render: ({ value, onChange }: { value: string | number | undefined; onChange: (value: string) => void }) =>
      labelled(label, <SizeSelect value={value} onChange={onChange} sizes={RADII} unit="px" zeroLabel="Square (0px)" />),
  }
}

const SPACES = [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80]

/** A gap, in px. */
export function spaceField(label: string) {
  return {
    type: 'custom' as const,
    label,
    render: ({ value, onChange }: { value: string | number | undefined; onChange: (value: string) => void }) =>
      labelled(label, <SizeSelect value={value} onChange={onChange} sizes={SPACES} unit="px" zeroLabel="None (0px)" />),
  }
}

/** One CSS length from whatever a field holds, or null for "not set". A bare
 *  number is read as points, which is what the shop's older boxes stored and
 *  what somebody typing into this by hand almost certainly means. */
export function cssLength(raw: number | string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? `${raw}pt` : null
  const value = raw.trim()
  if (!value) return null
  if (/^-?[\d.]+$/.test(value)) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? `${n}pt` : null
  }
  return /^-?[\d.]+(px|pt|rem|em|%|mm|cm|in)$/.test(value) ? value : null
}

/** The `--po-doc-*` properties for the fields somebody actually set. An empty
 *  field emits nothing at all, so the stylesheet's own fallback stands. */
export function sizeVars(sizes: Record<string, number | string | undefined>): CSSProperties {
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(sizes)) {
    const length = cssLength(raw)
    if (length) out[name] = length
  }
  return out as CSSProperties
}

/** A colour picked from the site's own palette, or typed in. Blank everywhere
 *  means "leave it as it was". */
export function colourField(label: string) {
  return {
    type: 'custom' as const,
    label,
    render: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
      labelled(label, <SiteColourField value={value} onChange={onChange} allowManual />),
  }
}

export const yesNo = [
  { value: 'yes', label: 'Show' },
  { value: 'no', label: 'Hide' },
]

/** A date, as somebody would write it on paper. Accepts both the plain
 *  `2026-04-27` a date column gives and the full timestamp a timestamptz does. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** Plain text from a settings textarea, split on blank lines into paragraphs - a
 *  textarea is not a rich-text field and paragraphs are all it can mean. */
export function paragraphs(value: string): string[] {
  return value.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
//
// The written blocks - the notice panel and the terms - are sentences somebody
// types, and a sentence about this order needs this order's numbers in it. So
// they are written with {{PLACEHOLDERS}} and filled here.
//
// A fixed, small list rather than a path into the order object: somebody writing
// "Quote {{ORDER_NUMBER}} on your invoice" is doing something they can hold in
// their head. A known token with nothing behind it disappears; a token nobody
// recognises stays where it is, because it is a typo and it will show on the
// sample order in the editor.

export function poTokens(ctx: PoDocContext): Record<string, string> {
  const { order, buyer, supplier, site } = ctx
  const bareUrl = (site.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  return {
    ORDER_NUMBER: order.number ?? '',
    REVISION: String(order.revision ?? 1),
    ORDER_DATE: formatDate(order.raisedDate),
    REQUIRED_BY: formatDate(order.requiredByDate),
    EXPECTED_DATE: formatDate(order.expectedDate),
    PAYMENT_TERMS: order.paymentTerms ?? '',
    DELIVERY_TERMS: order.deliveryTerms ?? '',
    SUBTOTAL: formatMoney(order.subtotal, order.currency),
    TOTAL: formatMoney(order.total, order.currency),
    SUPPLIER_NAME: supplier.name ?? '',
    SUPPLIER_ACCOUNT: supplier.accountNumber ?? '',
    SHIP_TO: [order.shipTo.name, ...order.shipTo.addressLines].filter(Boolean).join(', '),
    BUSINESS_NAME: buyer.name || site.name || '',
    BUSINESS_EMAIL: buyer.email ?? '',
    BUSINESS_PHONE: buyer.phone ?? '',
    BUSINESS_ADDRESS: buyer.addressLines.join(', '),
    VAT_NUMBER: buyer.vatNumber ?? '',
    COMPANY_NUMBER: buyer.companyNumber ?? '',
    SITE_NAME: site.name ?? '',
    SITE_URL: bareUrl,
  }
}

const TOKEN_RE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g

/** Fills {{TOKENS}} and tidies up after itself: an empty token leaves a hole,
 *  and the hole would otherwise show as a double space or a stranded comma in
 *  the middle of an otherwise finished sentence. */
export function fillTokens(text: string, tokens: Record<string, string>): string {
  return text
    .replace(TOKEN_RE, (whole: string, name: string) => tokens[name] ?? whole)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/([([])\s+/g, '$1')
    .replace(/\s+([)\]])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

/** The list somebody can reach, printed under the fields that accept them. Puck
 *  has no help text of its own on a text field, so it rides on the label. */
export const TOKEN_HINT =
  'Placeholders: {{ORDER_NUMBER}} {{REVISION}} {{ORDER_DATE}} {{REQUIRED_BY}} {{EXPECTED_DATE}} {{TOTAL}} {{SUBTOTAL}} {{PAYMENT_TERMS}} {{DELIVERY_TERMS}} {{SUPPLIER_NAME}} {{SUPPLIER_ACCOUNT}} {{SHIP_TO}} {{BUSINESS_NAME}} {{BUSINESS_EMAIL}} {{BUSINESS_PHONE}} {{BUSINESS_ADDRESS}} {{VAT_NUMBER}} {{COMPANY_NUMBER}} {{SITE_URL}}'
