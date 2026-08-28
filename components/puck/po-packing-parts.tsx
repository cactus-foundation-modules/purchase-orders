import { formatQty, formatQtyUnit } from '@/modules/purchase-orders/lib/money'
import {
  Style, FontLink, fontStyle, fontField, sizeField, radiusField, spaceField, sizeVars, cssLength,
  yesNo, formatDate, paragraphs,
} from '@/modules/purchase-orders/components/puck/po-shared'
import {
  PartyColumn, hasParty, partySizes, PARTY_ALIGN, PARTY_ALIGN_FIELD, PARTY_DETAIL_FIELDS,
  PARTY_SIZE_FIELDS, TITLE_SIZES, HEAD_RULES, DESC_WIDTHS,
  type PartyDisplayProps, type PartySizeProps,
} from '@/modules/purchase-orders/components/puck/po-parts'
import { SAMPLE_PO_PS_CONTEXT, type PoPsDocContext } from '@/modules/purchase-orders/lib/packing-slip-context'

// The packing slip, as draggable blocks on the `purchasePackingSlip` layout
// type: the heading, who it is from, where it is going, what is in the box, how
// it travelled, and anything else worth saying.
//
// THE ONE RULE THIS DOCUMENT HAS. It goes in the box, and on a drop-shipped
// order the person opening that box is the customer. So there is no money on it
// anywhere and the supplier is not named on it - and that is enforced by the
// context rather than by a field somebody could switch on: PoPsDocContext has no
// price on it and no supplier party, so no block here can print either and no
// block added later can start. See lib/packing-slip-context.ts.
//
// What IS shared with the order and the returns note: the stylesheet (`po-doc-*`
// classes throughout, so a site's Document style block reaches this slip as
// well), the address column, and the size and colour fields. Same contract too -
// one render path each, shared by the Puck editor and the published document,
// and nothing here is a client component.

export type PsProps = { _ctx?: PoPsDocContext; fontFamily?: string }

/** Context absent means the editor canvas, where a sample slip is drawn instead
 *  of a column of empty boxes. */
function usePs(props: PsProps): PoPsDocContext {
  return props._ctx ?? SAMPLE_PO_PS_CONTEXT
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
//
// A short list, and shorter than the order's on purpose: there is no total to
// put in a sentence and no supplier to name. What is left is the two numbers
// somebody quotes on the phone and the business saying them.

function psTokens(ctx: PoPsDocContext): Record<string, string> {
  const { slip, buyer, site } = ctx
  const bareUrl = (site.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  return {
    SLIP_NUMBER: slip.number ?? '',
    DESPATCH_DATE: formatDate(slip.despatchedDate),
    ORDER_NUMBER: slip.orderNumber ?? '',
    ORDER_DATE: formatDate(slip.orderDate),
    CUSTOMER_REFERENCE: slip.customerReference ?? '',
    CARRIER: slip.carrier ?? '',
    TRACKING: slip.trackingRef ?? '',
    DELIVER_TO: [ctx.shipTo.name, ...ctx.shipTo.addressLines].filter(Boolean).join(', '),
    BUSINESS_NAME: buyer.name || site.name || '',
    BUSINESS_EMAIL: buyer.email ?? '',
    BUSINESS_PHONE: buyer.phone ?? '',
    BUSINESS_ADDRESS: buyer.addressLines.join(', '),
    SITE_NAME: site.name ?? '',
    SITE_URL: bareUrl,
  }
}

const TOKEN_RE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g

/** Fills {{TOKENS}} and tidies up after itself: an empty token leaves a hole,
 *  and the hole would otherwise show as a double space or a stranded comma. */
function fillPsTokens(text: string, tokens: Record<string, string>): string {
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

const PS_TOKEN_HINT =
  'Placeholders: {{SLIP_NUMBER}} {{DESPATCH_DATE}} {{ORDER_NUMBER}} {{ORDER_DATE}} {{CUSTOMER_REFERENCE}} {{CARRIER}} {{TRACKING}} {{DELIVER_TO}} {{BUSINESS_NAME}} {{BUSINESS_EMAIL}} {{BUSINESS_PHONE}} {{BUSINESS_ADDRESS}} {{SITE_URL}}'

// ---------------------------------------------------------------------------
// Heading
// ---------------------------------------------------------------------------
//
// The order number has no "hide" switch, exactly as the returns note's has none.
// A box on somebody's floor with no order number on the paperwork inside it is a
// box and a mystery.

type PsHeaderProps = PsProps & {
  heading?: string
  titleSize?: string; sides?: string; rule?: string
  factsLayout?: string; numberStyle?: string
  slipLabel?: string; dateLabel?: string; orderLabel?: string; referenceLabel?: string
  showDate?: string; showSlipNumber?: string; showReference?: string; showIntro?: string
  titlePt?: number | string; numberPt?: number | string; factsPt?: number | string; introPt?: number | string
}

export function PoPsHeader(props: PsHeaderProps) {
  const ctx = usePs(props)
  const { slip } = ctx
  const heading = props.heading?.trim() || ctx.copy.heading || 'Packing slip'
  const font = fontStyle(props)
  const sizes = sizeVars({
    '--po-doc-title-size': props.titlePt,
    '--po-doc-lead-size': props.numberPt,
    '--po-doc-facts-size': props.factsPt,
  })

  const headClass = [
    'po-doc-head',
    props.sides === 'title-left' ? 'po-doc-swap' : '',
    (HEAD_RULES[props.rule ?? 'hairline'] ?? '').trim(),
  ].filter(Boolean).join(' ')
  const stacked = props.factsLayout === 'stacked'
  const leadNumber = props.numberStyle === 'lead'

  // Built as a list and filtered, so a row with no value is not a row - a label
  // with nothing beside it is a line of white space under a heading.
  const facts: { label: string; value: string }[] = []
  if (!leadNumber && props.showSlipNumber !== 'no') {
    facts.push({ label: props.slipLabel?.trim() || 'Delivery', value: slip.number ?? '' })
  }
  if (props.showDate !== 'no') {
    facts.push({ label: props.dateLabel?.trim() || 'Sent', value: formatDate(slip.despatchedDate) })
  }
  facts.push({ label: props.orderLabel?.trim() || 'Order', value: slip.orderNumber ?? '' })
  if (props.showReference !== 'no') {
    facts.push({ label: props.referenceLabel?.trim() || 'Your reference', value: slip.customerReference ?? '' })
  }
  const rows = facts.filter((row) => row.value.trim() !== '')

  const intro = props.showIntro !== 'no' ? ctx.copy.intro : ''

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <header className={headClass} style={{ ...font, ...sizes }}>
        <div className="po-doc-meta">
          <h1 className={`po-doc-h1${TITLE_SIZES[props.titleSize ?? 'medium'] ?? ''}`} style={font}>
            {heading}
          </h1>
          {leadNumber && slip.number && <p className="po-doc-lead">{slip.number}</p>}
          {rows.length > 0 && (
            <dl className={`po-doc-facts${stacked ? ' po-doc-facts-stack' : ''}`}>
              {rows.map((row, i) => (
                <div className="po-doc-fact" key={`${row.label}-${i}`}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </header>
      {intro && (
        <p className="po-doc-intro" style={{ ...font, ...sizeVars({ '--po-doc-intro-size': props.introPt }) }}>
          {intro}
        </p>
      )}
    </>
  )
}

export const poPsHeaderPuckComponent = {
  label: 'Packing slip: Heading',
  fields: {
    heading: { type: 'text' as const, label: 'Heading (blank uses the one in Purchase Orders settings)' },
    fontFamily: fontField,
    titleSize: { type: 'select' as const, label: 'Heading size', options: [
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
      { value: 'display', label: 'Very large' },
    ] },
    titlePt: sizeField('Heading size (overrides the menu above)'),
    sides: { type: 'select' as const, label: 'The heading sits', options: [
      { value: 'logo-left', label: 'At the right' },
      { value: 'title-left', label: 'At the left' },
    ] },
    rule: { type: 'select' as const, label: 'Rule underneath', options: [
      { value: 'hairline', label: 'Hairline' },
      { value: 'accent', label: 'Thick, in the accent colour' },
      { value: 'none', label: 'None' },
    ] },
    factsLayout: { type: 'select' as const, label: 'Dates and numbers', options: [
      { value: 'columns', label: 'Labels and values in two columns' },
      { value: 'stacked', label: 'One line each, label first' },
    ] },
    numberStyle: { type: 'select' as const, label: 'The delivery number', options: [
      { value: 'row', label: 'As a row, with the rest' },
      { value: 'lead', label: 'On its own, above the dates' },
    ] },
    showSlipNumber: { type: 'select' as const, label: 'Delivery number row', options: yesNo },
    slipLabel: { type: 'text' as const, label: '"Delivery" row label' },
    showDate: { type: 'select' as const, label: 'The date it was sent', options: yesNo },
    dateLabel: { type: 'text' as const, label: '"Sent" row label' },
    // No switch for the order number, exactly as the returns note has none.
    orderLabel: { type: 'text' as const, label: '"Order" row label' },
    showReference: { type: 'select' as const, label: 'Your customer’s own reference', options: yesNo },
    referenceLabel: { type: 'text' as const, label: '"Your reference" row label' },
    showIntro: { type: 'select' as const, label: 'The opening line from settings', options: yesNo },
    numberPt: sizeField('Delivery number size'),
    factsPt: sizeField('Dates and numbers size'),
    introPt: sizeField('Opening line size'),
  },
  defaultProps: {
    heading: '', fontFamily: '', titleSize: 'medium', sides: 'logo-left', rule: 'hairline',
    factsLayout: 'columns', numberStyle: 'row',
    showSlipNumber: 'yes', slipLabel: 'Delivery', showDate: 'yes', dateLabel: 'Sent',
    orderLabel: 'Order', showReference: 'yes', referenceLabel: 'Your reference', showIntro: 'yes',
  },
  render: PoPsHeader,
}
export const poPsHeaderPuckRscComponent = { ...poPsHeaderPuckComponent, render: PoPsHeader }

// ---------------------------------------------------------------------------
// Who it is from
// ---------------------------------------------------------------------------
//
// Us, and only us. The supplier printing this slip is not on it: the customer
// opening the box bought from this business, and a name they have never heard of
// on the paperwork inside is a support call at best.

type PsFromProps = PsProps & PartyDisplayProps & PartySizeProps & { heading?: string; align?: string }

export function PoPsFrom(props: PsFromProps) {
  const ctx = usePs(props)
  if (!hasParty(ctx.buyer)) return null
  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-parties po-doc-party-one${PARTY_ALIGN[props.align ?? 'left'] ?? ''}`}
        style={{ ...fontStyle(props), ...partySizes(props) }}
      >
        <PartyColumn party={ctx.buyer} heading={props.heading?.trim() || 'From'} props={props} />
      </section>
    </>
  )
}

export const poPsFromPuckComponent = {
  label: 'Packing slip: Who it is from',
  fields: {
    heading: { type: 'text' as const, label: 'Heading' },
    fontFamily: fontField,
    align: PARTY_ALIGN_FIELD,
    ...PARTY_DETAIL_FIELDS,
    ...PARTY_SIZE_FIELDS,
  },
  defaultProps: {
    heading: 'From', fontFamily: '', align: 'left',
    showContact: 'no', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
  },
  render: PoPsFrom,
}
export const poPsFromPuckRscComponent = { ...poPsFromPuckComponent, render: PoPsFrom }

// ---------------------------------------------------------------------------
// Where the box is going
// ---------------------------------------------------------------------------

/** "GB" -> "United Kingdom", and anything the runtime cannot name back as it
 *  came. en-GB is pinned for the same reason every other figure on this document
 *  is: the server renders it for the PDF and the browser renders it on the
 *  editor canvas, and the two must agree. */
function countryName(code: string | null | undefined): string {
  const raw = (code ?? '').trim()
  if (raw.length !== 2) return raw
  try {
    return new Intl.DisplayNames(['en-GB'], { type: 'region' }).of(raw.toUpperCase()) ?? raw
  } catch {
    return raw
  }
}

type PsShipToProps = PsProps & {
  heading?: string; look?: string; showInstructions?: string; showCountry?: string
  headingPt?: number | string; addressPt?: number | string; instructionsPt?: number | string
  radius?: string; padding?: string
}

const SHIPTO_LOOKS = [
  { value: 'plain', label: 'Plain text' },
  { value: 'panel', label: 'Tinted panel' },
  { value: 'outline', label: 'Outlined box' },
]

export function PoPsShipTo(props: PsShipToProps) {
  const ctx = usePs(props)
  const { shipTo } = ctx
  const font = fontStyle(props)
  const country = props.showCountry === 'yes' ? countryName(shipTo.country) : ''
  const lines = [shipTo.name, ...shipTo.addressLines, country].filter(Boolean)
  const contact = [shipTo.contact, shipTo.phone].filter(Boolean).join(' · ')
  const instructions = props.showInstructions === 'yes' ? shipTo.instructions?.trim() ?? '' : ''
  if (lines.length === 0 && !contact && !instructions) return null
  const look = SHIPTO_LOOKS.some((l) => l.value === props.look) ? props.look : 'panel'

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-shipto po-doc-shipto-${look}`}
        style={{
          ...font,
          ...sizeVars({
            '--po-doc-h2-size': props.headingPt,
            '--po-doc-party-size': props.addressPt,
            '--po-doc-instructions-size': props.instructionsPt,
          }),
          ...(cssLength(props.radius) ? { '--po-doc-radius': cssLength(props.radius)! } : {}),
          ...(cssLength(props.padding) ? { '--po-doc-notice-pad': cssLength(props.padding)! } : {}),
        }}
      >
        <h2 className="po-doc-h2 po-doc-h2-caps" style={font}>{props.heading?.trim() || 'Delivered to'}</h2>
        <address>
          {lines.map((line, i) => (
            <span key={i} className={i === 0 ? 'po-doc-strong' : undefined}>{line}</span>
          ))}
          {contact && <span>{contact}</span>}
        </address>
        {instructions && <p className="po-doc-instructions">{instructions}</p>}
      </section>
    </>
  )
}

export const poPsShipToPuckComponent = {
  label: 'Packing slip: Delivered to',
  fields: {
    heading: { type: 'text' as const, label: 'Heading' },
    fontFamily: fontField,
    look: { type: 'select' as const, label: 'Look', options: SHIPTO_LOOKS },
    // OFF by default. Delivery instructions are for the driver, and this sheet
    // is inside the box by the time anybody reads it.
    showInstructions: { type: 'select' as const, label: 'Delivery instructions', options: yesNo },
    showCountry: { type: 'select' as const, label: 'Country under the postcode', options: yesNo },
    radius: radiusField('Corners'),
    padding: spaceField('Space inside the box'),
    headingPt: sizeField('Heading size'),
    addressPt: sizeField('Address size'),
    instructionsPt: sizeField('Instructions size'),
  },
  defaultProps: {
    heading: 'Delivered to', fontFamily: '', look: 'panel',
    showInstructions: 'no', showCountry: 'no', radius: '', padding: '',
  },
  render: PoPsShipTo,
}
export const poPsShipToPuckRscComponent = { ...poPsShipToPuckComponent, render: PoPsShipTo }

// ---------------------------------------------------------------------------
// What is in the box
// ---------------------------------------------------------------------------
//
// Three columns and no fourth: what it is, our code for it, and how many. There
// is no price column here and there is no field to make one - see the note at
// the top of this file.

type PsLinesProps = PsProps & {
  showOurSku?: string; showSupplierSku?: string; showOrdered?: string
  itemLabel?: string; codeLabel?: string; qtyLabel?: string; orderedLabel?: string
  headStyle?: string; rowRules?: string; zebra?: string; headCase?: string
  headPt?: number | string; rowPt?: number | string; skuPt?: number | string
  headRadius?: string; headRadiusEdges?: string; headPadX?: string; headPadY?: string
  rowPadY?: string; rowRadius?: string; descWidth?: string
  showPartialNote?: string; partialNote?: string
}

export function PoPsLines(props: PsLinesProps) {
  const { slip } = usePs(props)
  const font = fontStyle(props)
  const showOurSku = props.showOurSku !== 'no'
  const showSupplierSku = props.showSupplierSku === 'yes'
  // On unless the layout says otherwise, matching the default below. A slip that
  // says "8" where twelve were ordered and does not mention the twelve is the
  // single most common reason a delivery gets reported as wrong when it is not.
  const showOrdered = props.showOrdered !== 'no'

  const tableClass = [
    'po-doc-lines',
    props.headStyle === 'filled' ? 'po-doc-thead-fill' : '',
    props.zebra === 'yes' ? 'po-doc-zebra' : '',
    props.rowRules === 'none' ? 'po-doc-rows-none' : '',
    props.headRadiusEdges === 'every' ? 'po-doc-thead-round-all' : '',
    props.headCase === 'plain' ? 'po-doc-thead-plain' : '',
  ].filter(Boolean).join(' ')

  const shape: Record<string, string> = {}
  const headRadius = cssLength(props.headRadius)
  if (headRadius) shape['--po-doc-thead-radius'] = headRadius
  const rowRadius = cssLength(props.rowRadius)
  if (rowRadius) shape['--po-doc-row-radius'] = rowRadius
  const headPadX = cssLength(props.headPadX)
  if (headPadX) shape['--po-doc-thead-pad-x'] = headPadX
  const headPadY = cssLength(props.headPadY)
  if (headPadY) shape['--po-doc-thead-pad-y'] = headPadY
  const rowPadY = cssLength(props.rowPadY)
  if (rowPadY) shape['--po-doc-row-y'] = rowPadY
  const descWidth = DESC_WIDTHS[props.descWidth ?? 'wide'] ?? ''
  const columnCount = 2 + (showOurSku ? 1 : 0) + (showSupplierSku ? 1 : 0) + (showOrdered ? 1 : 0)

  // Said out loud rather than left to somebody counting a box against an order:
  // "eight of the twelve" is the single most common reason a delivery gets
  // reported as wrong when it is not.
  const partialNote =
    props.showPartialNote !== 'no' && slip.partial
      ? props.partialNote?.trim() || 'The rest of this order is still to come and will arrive separately.'
      : ''

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <table
        className={tableClass}
        style={{
          ...font,
          ...sizeVars({
            '--po-doc-thead-size': props.headPt,
            '--po-doc-row-size': props.rowPt,
            '--po-doc-sku-size': props.skuPt,
          }),
          ...shape,
        }}
      >
        <thead>
          <tr>
            <th style={descWidth ? { width: descWidth } : undefined}>{props.itemLabel?.trim() || 'Item'}</th>
            {showOurSku && <th>{props.codeLabel?.trim() || 'Code'}</th>}
            {showSupplierSku && <th>Supplier code</th>}
            <th className="po-doc-num">{props.qtyLabel?.trim() || 'In this delivery'}</th>
            {showOrdered && <th className="po-doc-num">{props.orderedLabel?.trim() || 'Ordered'}</th>}
          </tr>
        </thead>
        <tbody>
          {slip.lines.map((line, index) => {
            const alt = index % 2 === 1 ? ' po-doc-alt' : ''
            return (
              <tr key={line.id} className={alt.trim() || undefined}>
                <td><span className="po-doc-name">{line.description}</span></td>
                {showOurSku && <td className="po-doc-sku">{line.ourSku ?? ''}</td>}
                {showSupplierSku && <td className="po-doc-sku">{line.supplierSku ?? ''}</td>}
                <td className="po-doc-num">{formatQtyUnit(line.qty, line.unit)}</td>
                {showOrdered && <td className="po-doc-num">{formatQty(line.qtyOrdered)}</td>}
              </tr>
            )
          })}
          {slip.lines.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="po-doc-empty">There is nothing on this delivery.</td>
            </tr>
          )}
        </tbody>
      </table>
      {partialNote && <p className="po-doc-note" style={font}>{partialNote}</p>}
    </>
  )
}

export const poPsLinesPuckComponent = {
  label: 'Packing slip: What is in the box',
  fields: {
    fontFamily: fontField,
    headStyle: { type: 'select' as const, label: 'Column headings', options: [
      { value: 'rule', label: 'Ruled underneath' },
      { value: 'filled', label: 'On a tinted band' },
    ] },
    headCase: { type: 'select' as const, label: 'Heading wording', options: [
      { value: 'caps', label: 'CAPITALS' },
      { value: 'plain', label: 'As typed' },
    ] },
    rowRules: { type: 'select' as const, label: 'Lines between rows', options: [
      { value: 'every', label: 'Under every row' },
      { value: 'none', label: 'None' },
    ] },
    zebra: { type: 'select' as const, label: 'Shade alternate rows', options: yesNo },
    descWidth: { type: 'select' as const, label: 'Width of the item column', options: [
      { value: 'auto', label: 'Let it work itself out' },
      { value: 'half', label: 'Half the table' },
      { value: 'wide', label: 'Three fifths' },
      { value: 'widest', label: 'Seven tenths' },
    ] },
    showOurSku: { type: 'select' as const, label: 'Your own product code', options: yesNo },
    showSupplierSku: { type: 'select' as const, label: 'The supplier’s code', options: yesNo },
    showOrdered: { type: 'select' as const, label: 'How many were ordered in total', options: yesNo },
    itemLabel: { type: 'text' as const, label: '"Item" column heading' },
    codeLabel: { type: 'text' as const, label: '"Code" column heading' },
    qtyLabel: { type: 'text' as const, label: '"In this delivery" column heading' },
    orderedLabel: { type: 'text' as const, label: '"Ordered" column heading' },
    showPartialNote: { type: 'select' as const, label: 'Say when the rest is still to come', options: yesNo },
    partialNote: { type: 'text' as const, label: 'What that says' },
    headPt: sizeField('Column heading size'),
    rowPt: sizeField('Row text size'),
    skuPt: sizeField('Product code size'),
    headRadius: radiusField('Heading band corners'),
    headRadiusEdges: { type: 'select' as const, label: 'Rounded corners on the heading band', options: [
      { value: 'ends', label: 'The two ends only' },
      { value: 'every', label: 'Every heading' },
    ] },
    headPadX: spaceField('Space either side of a heading'),
    headPadY: spaceField('Space above and below a heading'),
    rowPadY: spaceField('Space above and below a row'),
    rowRadius: radiusField('Shaded row corners'),
  },
  defaultProps: {
    fontFamily: '', headStyle: 'rule', headCase: 'caps', rowRules: 'every', zebra: 'no',
    descWidth: 'wide', showOurSku: 'yes', showSupplierSku: 'no', showOrdered: 'yes',
    itemLabel: 'Item', codeLabel: 'Code', qtyLabel: 'In this delivery', orderedLabel: 'Ordered',
    showPartialNote: 'yes', partialNote: '',
    headRadius: '', headRadiusEdges: 'ends', headPadX: '', headPadY: '', rowPadY: '', rowRadius: '',
  },
  render: PoPsLines,
}
export const poPsLinesPuckRscComponent = { ...poPsLinesPuckComponent, render: PoPsLines }

// ---------------------------------------------------------------------------
// How it travelled
// ---------------------------------------------------------------------------

type PsTrackingProps = PsProps & {
  heading?: string; showHeading?: string; capsHeading?: string; look?: string
  carrierLabel?: string; trackingLabel?: string; dateLabel?: string
  showDate?: string
  headingPt?: number | string; bodyPt?: number | string
  radius?: string; padding?: string
}

export function PoPsTracking(props: PsTrackingProps) {
  const ctx = usePs(props)
  const { slip } = ctx
  const font = fontStyle(props)

  const rows: { label: string; value: string }[] = []
  if (slip.carrier.trim()) rows.push({ label: props.carrierLabel?.trim() || 'Carrier', value: slip.carrier })
  if (slip.trackingRef.trim()) rows.push({ label: props.trackingLabel?.trim() || 'Tracking', value: slip.trackingRef })
  if (props.showDate !== 'no' && slip.despatchedDate) {
    rows.push({ label: props.dateLabel?.trim() || 'Sent', value: formatDate(slip.despatchedDate) })
  }
  // Nothing to say is nothing to print. A heading over an empty box is worse
  // than no box.
  if (rows.length === 0) return null

  const look = props.look === 'plain' ? 'quiet' : props.look === 'outline' ? 'outline' : 'panel'

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-shipto po-doc-shipto-${look === 'quiet' ? 'plain' : look}`}
        style={{
          ...font,
          ...sizeVars({ '--po-doc-h2-size': props.headingPt, '--po-doc-party-size': props.bodyPt }),
          ...(cssLength(props.radius) ? { '--po-doc-radius': cssLength(props.radius)! } : {}),
          ...(cssLength(props.padding) ? { '--po-doc-notice-pad': cssLength(props.padding)! } : {}),
        }}
      >
        {props.showHeading !== 'no' && (
          <h2 className={`po-doc-h2${props.capsHeading !== 'no' ? ' po-doc-h2-caps' : ''}`} style={font}>
            {props.heading?.trim() || 'How it travelled'}
          </h2>
        )}
        <dl className="po-doc-facts po-doc-facts-stack" style={{ justifyContent: 'start', textAlign: 'left' }}>
          {rows.map((row, i) => (
            <div className="po-doc-fact" key={`${row.label}-${i}`}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  )
}

export const poPsTrackingPuckComponent = {
  label: 'Packing slip: How it travelled',
  fields: {
    showHeading: { type: 'select' as const, label: 'Heading', options: yesNo },
    heading: { type: 'text' as const, label: 'Heading wording' },
    capsHeading: { type: 'select' as const, label: 'Heading in capitals', options: yesNo },
    fontFamily: fontField,
    look: { type: 'select' as const, label: 'Look', options: [
      { value: 'plain', label: 'Plain text' },
      { value: 'panel', label: 'Tinted panel' },
      { value: 'outline', label: 'Outlined box' },
    ] },
    carrierLabel: { type: 'text' as const, label: '"Carrier" label' },
    trackingLabel: { type: 'text' as const, label: '"Tracking" label' },
    showDate: { type: 'select' as const, label: 'The date it was sent', options: yesNo },
    dateLabel: { type: 'text' as const, label: '"Sent" label' },
    radius: radiusField('Corners'),
    padding: spaceField('Space inside the box'),
    headingPt: sizeField('Heading size'),
    bodyPt: sizeField('Text size'),
  },
  defaultProps: {
    showHeading: 'yes', heading: 'How it travelled', capsHeading: 'yes', fontFamily: '', look: 'plain',
    carrierLabel: 'Carrier', trackingLabel: 'Tracking', showDate: 'no', dateLabel: 'Sent',
    radius: '', padding: '',
  },
  render: PoPsTracking,
}
export const poPsTrackingPuckRscComponent = { ...poPsTrackingPuckComponent, render: PoPsTracking }

// ---------------------------------------------------------------------------
// Anything else worth saying
// ---------------------------------------------------------------------------

type PsNotesProps = PsProps & {
  showHeading?: string; heading?: string; capsHeading?: string
  showNotes?: string; showTerms?: string; termsHeading?: string
  extraHeading?: string; extra?: string
  columns?: string
  headingPt?: number | string; bodyPt?: number | string
}

export function PoPsNotes(props: PsNotesProps) {
  const ctx = usePs(props)
  const font = fontStyle(props)
  const tokens = psTokens(ctx)

  const notes = props.showNotes !== 'no' ? paragraphs(ctx.slip.notes ?? '') : []
  const terms = props.showTerms !== 'no' ? paragraphs(ctx.copy.terms ?? '') : []
  const extra = paragraphs(fillPsTokens(props.extra ?? '', tokens))
  if (notes.length === 0 && terms.length === 0 && extra.length === 0) return null

  const headingClass = `po-doc-h2${props.capsHeading !== 'no' ? ' po-doc-h2-caps' : ''}`
  const sizes = sizeVars({ '--po-doc-h2-size': props.headingPt, '--po-doc-notes-size': props.bodyPt })

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-notes${props.columns === '2' ? ' po-doc-cols-2' : ''}`}
        style={{ ...font, ...sizes }}
      >
        {notes.length > 0 && (
          <div>
            {props.showHeading !== 'no' && (
              <h2 className={headingClass} style={font}>{props.heading?.trim() || 'Notes'}</h2>
            )}
            {notes.map((text, i) => <p key={i}>{text}</p>)}
          </div>
        )}
        {terms.length > 0 && (
          <div>
            {props.showHeading !== 'no' && (
              <h2 className={headingClass} style={font}>{props.termsHeading?.trim() || 'If anything is wrong'}</h2>
            )}
            {terms.map((text, i) => <p key={i}>{text}</p>)}
          </div>
        )}
        {extra.length > 0 && (
          <div>
            {props.showHeading !== 'no' && props.extraHeading?.trim() && (
              <h2 className={headingClass} style={font}>{props.extraHeading.trim()}</h2>
            )}
            {extra.map((text, i) => <p key={i}>{text}</p>)}
          </div>
        )}
      </section>
    </>
  )
}

export const poPsNotesPuckComponent = {
  label: 'Packing slip: Notes',
  fields: {
    showHeading: { type: 'select' as const, label: 'Headings', options: yesNo },
    heading: { type: 'text' as const, label: '"Notes" heading' },
    capsHeading: { type: 'select' as const, label: 'Headings in capitals', options: yesNo },
    fontFamily: fontField,
    columns: { type: 'select' as const, label: 'Laid out in', options: [
      { value: '1', label: 'One column' },
      { value: '2', label: 'Two columns' },
    ] },
    showNotes: { type: 'select' as const, label: 'What the supplier typed on the despatch', options: yesNo },
    showTerms: { type: 'select' as const, label: 'The wording from Purchase Orders settings', options: yesNo },
    termsHeading: { type: 'text' as const, label: 'Heading over that wording' },
    extraHeading: { type: 'text' as const, label: 'Heading over your own wording' },
    extra: { type: 'textarea' as const, label: `Your own wording. ${PS_TOKEN_HINT}` },
    headingPt: sizeField('Heading size'),
    bodyPt: sizeField('Text size'),
  },
  defaultProps: {
    showHeading: 'yes', heading: 'Notes', capsHeading: 'yes', fontFamily: '', columns: '1',
    showNotes: 'yes', showTerms: 'yes', termsHeading: 'If anything is wrong',
    extraHeading: '', extra: '',
  },
  render: PoPsNotes,
}
export const poPsNotesPuckRscComponent = { ...poPsNotesPuckComponent, render: PoPsNotes }
