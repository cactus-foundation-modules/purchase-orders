import { formatMoney, formatQty } from '@/modules/purchase-orders/lib/money'
import {
  Style, FontLink, fontStyle, fontField, sizeField, radiusField, spaceField, sizeVars, cssLength,
  yesNo, formatDate, paragraphs, useCtx,
  type DocProps,
} from '@/modules/purchase-orders/components/puck/po-shared'

// The purchase order document, as draggable blocks on the `purchaseOrderDocument`
// layout type: the heading, who it is between, where the goods go, the lines, the
// money, the terms, the notes and who authorised it. Three more - the document
// style, a notice panel and a rule - live in po-chrome.tsx.
//
// There is deliberately NO footer block. The strip at the foot of every page is
// core's global `documentFooter` layout, shared with the invoice, the credit note
// and the quote, so a business designs its registration line once and it appears
// on all of its paperwork.
//
// One render path each, shared by the Puck editor and the published document (the
// manifest points both `component` and `rscComponent` at the same export), so the
// document can never look one way in the editor and another on the page - which
// matters more here than anywhere else, because this layout is also what the PDF
// is made of. Nothing in this file is a client component: there is nothing to
// click on a purchase order.
//
// Context arrives as `_ctx` (see lib/doc-context.ts). Absent means the editor
// canvas, where a sample order is drawn instead of a column of empty boxes.
//
// Every look-and-feel field follows one rule: the value a layout saved before the
// field existed carries - which is `undefined` - must render what it rendered
// then. So the defaults read as `!== 'no'`, never `=== 'yes'` for something that
// used to be on.

// ---------------------------------------------------------------------------
// Header: which order this is, and when it is wanted
// ---------------------------------------------------------------------------
//
// The letterhead is NOT here. The picture at the top of the document is core's
// own Site Logo block, dropped on the layout above this one, so it can be sized,
// nudged and moved without going through a field on the heading - and so the
// purchase order and the invoice draw the same logo the same way.

type HeaderProps = DocProps & {
  heading?: string
  titleSize?: string; sides?: string; rule?: string
  factsLayout?: string; numberStyle?: string; showRevision?: string
  orderLabel?: string; dateLabel?: string; requiredLabel?: string; expectedLabel?: string
  accountLabel?: string; termsLabel?: string
  showDate?: string; showRequired?: string; showExpected?: string
  showAccount?: string; showTerms?: string; showIntro?: string
  titlePt?: number | string; numberPt?: number | string; factsPt?: number | string; introPt?: number | string
}

const TITLE_SIZES: Record<string, string> = {
  small: ' po-doc-title-sm',
  medium: '',
  large: ' po-doc-title-lg',
  display: ' po-doc-title-xl',
}

const HEAD_RULES: Record<string, string> = {
  hairline: '',
  accent: ' po-doc-head-accent',
  none: ' po-doc-head-flat',
}

export function PoDocHeader(props: HeaderProps) {
  const ctx = useCtx(props)
  const { order } = ctx
  const heading = props.heading?.trim() || ctx.copy.heading || 'Purchase order'
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
  // An amended order carries the SAME number as the one it replaces, so the
  // revision is the only thing on the page telling a goods-in desk which sheet is
  // the live one. Never printed on revision 1, where it would only puzzle.
  const revision = props.showRevision !== 'no' && order.revision > 1 ? `Rev ${order.revision}` : ''

  // Built as a list and then filtered, rather than as six conditionals inside the
  // <dl>. A row whose value is empty would otherwise reach the markup as a label
  // with nothing beside it, and on paper that is a line of white space under a
  // heading that says nothing. A row with no value is not a row.
  const facts: { label: string; value: string }[] = []
  if (!leadNumber) facts.push({ label: props.orderLabel?.trim() || 'Order', value: order.number ?? '' })
  if (props.showDate !== 'no') facts.push({ label: props.dateLabel?.trim() || 'Date', value: formatDate(order.raisedDate) })
  if (props.showRequired !== 'no') facts.push({ label: props.requiredLabel?.trim() || 'Wanted by', value: formatDate(order.requiredByDate) })
  if (props.showExpected === 'yes') facts.push({ label: props.expectedLabel?.trim() || 'Expected', value: formatDate(order.expectedDate) })
  // Our account with them. Quoted on the order, it is what gets the paperwork
  // through a supplier's own system without a phone call.
  if (props.showAccount !== 'no') facts.push({ label: props.accountLabel?.trim() || 'Account', value: ctx.supplier.accountNumber ?? '' })
  if (props.showTerms === 'yes') facts.push({ label: props.termsLabel?.trim() || 'Payment terms', value: order.paymentTerms ?? '' })
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
            {revision && !leadNumber && <span className="po-doc-rev">{revision}</span>}
          </h1>
          {leadNumber && order.number && (
            <p className="po-doc-lead">
              {order.number}
              {revision && <span className="po-doc-rev">{revision}</span>}
            </p>
          )}
          {/* No rows at all means no list at all: an empty <dl> still carries the
              grid's own row gap, and that gap is white space on paper. */}
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
      {/* A sibling of the header rather than a child of it, so it carries its own
          size property - a custom property reaches its own subtree and nothing
          else. */}
      {intro && (
        <p className="po-doc-intro" style={{ ...font, ...sizeVars({ '--po-doc-intro-size': props.introPt }) }}>
          {intro}
        </p>
      )}
    </>
  )
}

export const poDocHeaderPuckComponent = {
  label: 'Purchase order: Heading',
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
    numberStyle: { type: 'select' as const, label: 'The order number', options: [
      { value: 'row', label: 'As a row, with the rest' },
      { value: 'lead', label: 'On its own, above the dates' },
    ] },
    showRevision: { type: 'select' as const, label: 'The revision flag on an amended order', options: yesNo },
    orderLabel: { type: 'text' as const, label: '"Order" row label' },
    showDate: { type: 'select' as const, label: 'Date row', options: yesNo },
    dateLabel: { type: 'text' as const, label: '"Date" row label' },
    showRequired: { type: 'select' as const, label: '"Wanted by" row', options: yesNo },
    requiredLabel: { type: 'text' as const, label: '"Wanted by" row label' },
    showExpected: { type: 'select' as const, label: '"Expected" row', options: yesNo },
    expectedLabel: { type: 'text' as const, label: '"Expected" row label' },
    showAccount: { type: 'select' as const, label: 'Your account number with them', options: yesNo },
    accountLabel: { type: 'text' as const, label: '"Account" row label' },
    showTerms: { type: 'select' as const, label: 'Payment terms row', options: yesNo },
    termsLabel: { type: 'text' as const, label: '"Payment terms" row label' },
    showIntro: { type: 'select' as const, label: 'The opening line from settings', options: yesNo },
    numberPt: sizeField('Order number size'),
    factsPt: sizeField('Dates and numbers size'),
    introPt: sizeField('Opening line size'),
  },
  // No defaults for the sizes on purpose: blank is "leave it as it is", and a
  // default would set every document's sizes the moment the field shipped.
  defaultProps: {
    heading: '', fontFamily: '', titleSize: 'medium', sides: 'logo-left', rule: 'hairline',
    factsLayout: 'columns', numberStyle: 'row', showRevision: 'yes',
    orderLabel: 'Order', showDate: 'yes', dateLabel: 'Date',
    showRequired: 'yes', requiredLabel: 'Wanted by',
    showExpected: 'no', expectedLabel: 'Expected',
    showAccount: 'yes', accountLabel: 'Account',
    showTerms: 'no', termsLabel: 'Payment terms',
    showIntro: 'yes',
  },
  render: PoDocHeader,
}
export const poDocHeaderPuckRscComponent = { ...poDocHeaderPuckComponent, render: PoDocHeader }

// ---------------------------------------------------------------------------
// The two parties, together and one at a time
// ---------------------------------------------------------------------------
//
// Three blocks over the same two addresses, for the same reason the shop's
// invoice has three: one block that draws both is right until somebody wants
// them anywhere other than side by side and equal - the buyer at the top under
// the letterhead, the supplier down beside the dates, different sizes on each.

type PartyProps = DocProps & {
  heading?: string; align?: string
  showContact?: string; showEmail?: string; showPhone?: string
  showAccount?: string; showRegistration?: string
  headingPt?: number | string; addressPt?: number | string; registrationPt?: number | string
}

const PARTY_ALIGN: Record<string, string> = {
  left: '',
  centre: ' po-doc-party-centre',
  right: ' po-doc-party-right',
}

function partySizes(props: PartyProps) {
  return sizeVars({
    '--po-doc-h2-size': props.headingPt,
    '--po-doc-party-size': props.addressPt,
    '--po-doc-reg-size': props.registrationPt,
  })
}

type PartyData = {
  name: string; addressLines: string[]; contactName: string; email: string; phone: string
  vatNumber: string; companyNumber: string; accountNumber: string
}

/** One address column, drawn identically wherever it appears - inside the
 *  combined block or on its own. A field with nothing in it is left off rather
 *  than printed as a blank line. */
function PartyColumn({
  party, heading, props, accountLabel,
}: {
  party: PartyData
  heading: string
  props: PartyProps
  accountLabel?: string
}) {
  const font = fontStyle(props)
  return (
    <div className="po-doc-party">
      <h2 className="po-doc-h2 po-doc-h2-caps" style={font}>{heading}</h2>
      <address>
        {party.name && <span className="po-doc-strong">{party.name}</span>}
        {party.addressLines.map((line, i) => <span key={i}>{line}</span>)}
        {props.showContact !== 'no' && party.contactName && <span>{party.contactName}</span>}
        {props.showEmail !== 'no' && party.email && <span>{party.email}</span>}
        {props.showPhone !== 'no' && party.phone && <span>{party.phone}</span>}
      </address>
      {props.showAccount !== 'no' && accountLabel && party.accountNumber && (
        <div className="po-doc-reg">
          <span>{accountLabel} {party.accountNumber}</span>
        </div>
      )}
      {props.showRegistration === 'yes' && (party.vatNumber || party.companyNumber) && (
        <div className="po-doc-reg">
          {party.vatNumber && <span>VAT registration {party.vatNumber}</span>}
          {party.companyNumber && <span>Company number {party.companyNumber}</span>}
        </div>
      )}
    </div>
  )
}

function hasParty(party: PartyData): boolean {
  return Boolean(party.name || party.addressLines.length > 0)
}

type PartiesProps = PartyProps & {
  fromLabel?: string; toLabel?: string
  showFrom?: string; showTo?: string; order?: string; columns?: string
  accountLabel?: string
}

export function PoDocParties(props: PartiesProps) {
  const ctx = useCtx(props)
  const font = fontStyle(props)
  const showFrom = props.showFrom !== 'no' && hasParty(ctx.buyer)
  const showTo = props.showTo !== 'no' && hasParty(ctx.supplier)

  const from = showFrom
    ? <PartyColumn key="from" party={ctx.buyer} heading={props.fromLabel?.trim() || 'From'} props={props} />
    : null
  const to = showTo
    ? (
      <PartyColumn
        key="to"
        party={ctx.supplier}
        heading={props.toLabel?.trim() || 'To'}
        props={props}
        accountLabel={props.accountLabel?.trim() || 'Account'}
      />
    )
    : null

  // A block with nothing in it should take up no room on the page.
  if (!from && !to) return null
  const columns = props.order === 'from-first' ? [from, to] : [to, from]
  const width = props.columns === '2' ? ' po-doc-cols-2' : ''

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section className={`po-doc-parties${width}`} style={{ ...font, ...partySizes(props) }}>
        {columns.filter(Boolean)}
      </section>
    </>
  )
}

const PARTY_DETAIL_FIELDS = {
  showContact: { type: 'select' as const, label: 'Contact name', options: yesNo },
  showEmail: { type: 'select' as const, label: 'Email address', options: yesNo },
  showPhone: { type: 'select' as const, label: 'Telephone number', options: yesNo },
  showRegistration: { type: 'select' as const, label: 'VAT and company numbers', options: yesNo },
}

const PARTY_SIZE_FIELDS = {
  headingPt: sizeField('Heading size'),
  addressPt: sizeField('Address size'),
  registrationPt: sizeField('Registration and account number size'),
}

const PARTY_ALIGN_FIELD = {
  type: 'select' as const,
  label: 'Sits',
  options: [
    { value: 'left', label: 'Left' },
    { value: 'centre', label: 'Centred' },
    { value: 'right', label: 'Right' },
  ],
}

export const poDocPartiesPuckComponent = {
  label: 'Purchase order: Who it is between',
  fields: {
    fontFamily: fontField,
    order: { type: 'select' as const, label: 'Which comes first', options: [
      { value: 'to-first', label: 'The supplier, then you' },
      { value: 'from-first', label: 'You, then the supplier' },
    ] },
    columns: { type: 'select' as const, label: 'Columns', options: [
      { value: 'auto', label: 'As many as fit' },
      { value: '2', label: 'Always two' },
    ] },
    showTo: { type: 'select' as const, label: 'The supplier', options: yesNo },
    toLabel: { type: 'text' as const, label: '"To" heading' },
    showFrom: { type: 'select' as const, label: 'Your own details', options: yesNo },
    fromLabel: { type: 'text' as const, label: '"From" heading' },
    showAccount: { type: 'select' as const, label: 'Your account number with them', options: yesNo },
    accountLabel: { type: 'text' as const, label: 'Account number wording' },
    ...PARTY_DETAIL_FIELDS,
    ...PARTY_SIZE_FIELDS,
  },
  defaultProps: {
    fontFamily: '', order: 'to-first', columns: '2',
    showTo: 'yes', toLabel: 'To', showFrom: 'yes', fromLabel: 'From',
    showAccount: 'yes', accountLabel: 'Account',
    showContact: 'yes', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
  },
  render: PoDocParties,
}
export const poDocPartiesPuckRscComponent = { ...poDocPartiesPuckComponent, render: PoDocParties }

export function PoDocFrom(props: PartyProps) {
  const ctx = useCtx(props)
  const font = fontStyle(props)
  if (!hasParty(ctx.buyer)) return null
  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-parties po-doc-party-one${PARTY_ALIGN[props.align ?? 'left'] ?? ''}`}
        style={{ ...font, ...partySizes(props) }}
      >
        <PartyColumn party={ctx.buyer} heading={props.heading?.trim() || 'From'} props={props} />
      </section>
    </>
  )
}

export const poDocFromPuckComponent = {
  label: 'Purchase order: From',
  fields: {
    heading: { type: 'text' as const, label: 'Heading' },
    fontFamily: fontField,
    ...PARTY_DETAIL_FIELDS,
    align: PARTY_ALIGN_FIELD,
    ...PARTY_SIZE_FIELDS,
  },
  defaultProps: {
    heading: 'From', fontFamily: '', showContact: 'yes', showEmail: 'yes', showPhone: 'yes',
    showRegistration: 'yes', align: 'left',
  },
  render: PoDocFrom,
}
export const poDocFromPuckRscComponent = { ...poDocFromPuckComponent, render: PoDocFrom }

type ToProps = PartyProps & { accountLabel?: string }

export function PoDocTo(props: ToProps) {
  const ctx = useCtx(props)
  const font = fontStyle(props)
  if (!hasParty(ctx.supplier)) return null
  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-parties po-doc-party-one${PARTY_ALIGN[props.align ?? 'left'] ?? ''}`}
        style={{ ...font, ...partySizes(props) }}
      >
        <PartyColumn
          party={ctx.supplier}
          heading={props.heading?.trim() || 'To'}
          props={props}
          accountLabel={props.accountLabel?.trim() || 'Account'}
        />
      </section>
    </>
  )
}

export const poDocToPuckComponent = {
  label: 'Purchase order: To',
  fields: {
    heading: { type: 'text' as const, label: 'Heading' },
    fontFamily: fontField,
    showAccount: { type: 'select' as const, label: 'Your account number with them', options: yesNo },
    accountLabel: { type: 'text' as const, label: 'Account number wording' },
    ...PARTY_DETAIL_FIELDS,
    align: PARTY_ALIGN_FIELD,
    ...PARTY_SIZE_FIELDS,
  },
  defaultProps: {
    heading: 'To', fontFamily: '', showAccount: 'yes', accountLabel: 'Account',
    showContact: 'yes', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no', align: 'left',
  },
  render: PoDocTo,
}
export const poDocToPuckRscComponent = { ...poDocToPuckComponent, render: PoDocTo }

// ---------------------------------------------------------------------------
// Deliver to
// ---------------------------------------------------------------------------
//
// The most misread line on a purchase order, and the reason it gets a block of
// its own rather than a third column on the one above. A drop-shipped order goes
// to neither party's address: not the buyer's yard and not the supplier's, but a
// customer's site, on a date, with instructions about the lorry.

type ShipToProps = DocProps & {
  heading?: string; look?: string; showInstructions?: string; showDate?: string; dateLabel?: string
  headingPt?: number | string; addressPt?: number | string; instructionsPt?: number | string
  radius?: string; padding?: string
}

const SHIPTO_LOOKS = [
  { value: 'plain', label: 'Plain text' },
  { value: 'panel', label: 'Tinted panel' },
  { value: 'outline', label: 'Outlined box' },
]

export function PoDocShipTo(props: ShipToProps) {
  const ctx = useCtx(props)
  const { shipTo } = ctx.order
  const font = fontStyle(props)
  const lines = [shipTo.name, ...shipTo.addressLines].filter(Boolean)
  const contact = [shipTo.contact, shipTo.phone].filter(Boolean).join(' · ')
  const instructions = props.showInstructions !== 'no' ? shipTo.instructions?.trim() ?? '' : ''
  // Nothing recorded at all - a collection, or an order raised before anybody
  // filled the address in. A heading over an empty box is worse than no box.
  if (lines.length === 0 && !contact && !instructions) return null
  const look = SHIPTO_LOOKS.some((l) => l.value === props.look) ? props.look : 'plain'

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
        <h2 className="po-doc-h2 po-doc-h2-caps" style={font}>{props.heading?.trim() || 'Deliver to'}</h2>
        <address>
          {lines.map((line, i) => (
            <span key={i} className={i === 0 ? 'po-doc-strong' : undefined}>{line}</span>
          ))}
          {contact && <span>{contact}</span>}
        </address>
        {props.showDate !== 'no' && ctx.order.requiredByDate && (
          <p className="po-doc-instructions">
            {props.dateLabel?.trim() || 'Wanted by'} {formatDate(ctx.order.requiredByDate)}
          </p>
        )}
        {instructions && <p className="po-doc-instructions">{instructions}</p>}
      </section>
    </>
  )
}

export const poDocShipToPuckComponent = {
  label: 'Purchase order: Deliver to',
  fields: {
    heading: { type: 'text' as const, label: 'Heading' },
    fontFamily: fontField,
    look: { type: 'select' as const, label: 'Look', options: SHIPTO_LOOKS },
    showDate: { type: 'select' as const, label: 'The date it is wanted by', options: yesNo },
    dateLabel: { type: 'text' as const, label: '"Wanted by" wording' },
    showInstructions: { type: 'select' as const, label: 'Delivery instructions', options: yesNo },
    radius: radiusField('Corners'),
    padding: spaceField('Space inside the box'),
    headingPt: sizeField('Heading size'),
    addressPt: sizeField('Address size'),
    instructionsPt: sizeField('Instructions size'),
  },
  defaultProps: {
    heading: 'Deliver to', fontFamily: '', look: 'panel',
    showDate: 'yes', dateLabel: 'Wanted by', showInstructions: 'yes', radius: '', padding: '',
  },
  render: PoDocShipTo,
}
export const poDocShipToPuckRscComponent = { ...poDocShipToPuckComponent, render: PoDocShipTo }

// ---------------------------------------------------------------------------
// Lines: what is actually being bought
// ---------------------------------------------------------------------------

type LinesProps = DocProps & {
  showSupplierSku?: string; showOurSku?: string; showLineDates?: string; showDiscount?: string
  itemLabel?: string; codeLabel?: string; qtyLabel?: string; costLabel?: string; totalLabel?: string
  headStyle?: string; rowRules?: string; zebra?: string; headCase?: string
  headPt?: number | string; rowPt?: number | string; skuPt?: number | string; detailPt?: number | string
  headRadius?: string; headRadiusEdges?: string; headPadX?: string; headPadY?: string
  rowPadY?: string; rowRadius?: string; descWidth?: string
}

/** How much of the table the description column takes, leaving the money columns
 *  whatever is left. `auto` is the browser's own guess. */
const DESC_WIDTHS: Record<string, string> = {
  auto: '',
  half: '50%',
  wide: '60%',
  widest: '70%',
}

export function PoDocLines(props: LinesProps) {
  const { order } = useCtx(props)
  const font = fontStyle(props)
  const showSupplierSku = props.showSupplierSku !== 'no'
  const showOurSku = props.showOurSku === 'yes'
  // A supplier code column of its own, rather than a second line under the
  // description. A goods-in desk reads down a column; it does not read prose.
  const codeColumn = showSupplierSku

  const tableClass = [
    'po-doc-lines',
    props.headStyle === 'filled' ? 'po-doc-thead-fill' : '',
    props.zebra === 'yes' ? 'po-doc-zebra' : '',
    props.rowRules === 'none' ? 'po-doc-rows-none' : '',
    props.headRadiusEdges === 'every' ? 'po-doc-thead-round-all' : '',
    props.headCase === 'plain' ? 'po-doc-thead-plain' : '',
  ].filter(Boolean).join(' ')

  // Shape as properties rather than classes: somebody picking 6px means 6px, not
  // "slightly rounded". Blank leaves the Document style block's own setting
  // standing, which is what a layout carrying neither had.
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
  const descWidth = DESC_WIDTHS[props.descWidth ?? 'auto'] ?? ''
  const columnCount = 4 + (codeColumn ? 1 : 0)

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
            '--po-doc-detail-size': props.detailPt,
          }),
          ...shape,
        }}
      >
        <thead>
          <tr>
            <th style={descWidth ? { width: descWidth } : undefined}>{props.itemLabel?.trim() || 'Description'}</th>
            {codeColumn && <th>{props.codeLabel?.trim() || 'Your code'}</th>}
            <th className="po-doc-num">{props.qtyLabel?.trim() || 'Qty'}</th>
            <th className="po-doc-num">{props.costLabel?.trim() || 'Unit cost'}</th>
            <th className="po-doc-num">{props.totalLabel?.trim() || 'Line total'}</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => {
            const cancelled = Number(line.qtyCancelled)
            const discount = Number(line.discountPercent ?? 0)
            const detail: string[] = []
            if (showOurSku && line.ourSku) detail.push(`Our code ${line.ourSku}`)
            if (props.showLineDates !== 'no' && line.expectedDate) detail.push(`Expected ${formatDate(line.expectedDate)}`)
            if (props.showDiscount !== 'no' && discount > 0) detail.push(`Less ${formatQty(discount)}%`)
            return (
              <tr key={line.id}>
                <td>
                  <span className="po-doc-name">{line.description}</span>
                  {detail.length > 0 && (
                    <ul className="po-doc-detail">
                      {detail.map((row, i) => <li key={i}>{row}</li>)}
                    </ul>
                  )}
                  {/* A cancelled quantity stays on the sheet rather than being
                      deleted: the supplier is holding an earlier revision, and
                      what they need to see is which line changed. */}
                  {cancelled > 0 && (
                    <span className="po-doc-cancelled">{formatQty(cancelled)} {line.unit} cancelled</span>
                  )}
                </td>
                {codeColumn && <td className="po-doc-sku">{line.supplierSku ?? ''}</td>}
                <td className="po-doc-num">{formatQty(Number(line.qty) - cancelled)} {line.unit}</td>
                <td className="po-doc-num">{formatMoney(line.unitCost, order.currency)}</td>
                <td className="po-doc-num">{formatMoney(line.lineTotal, order.currency)}</td>
              </tr>
            )
          })}
          {order.lines.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="po-doc-empty">There is nothing on this order.</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
}

export const poDocLinesPuckComponent = {
  label: 'Purchase order: Lines',
  fields: {
    fontFamily: fontField,
    headStyle: { type: 'select' as const, label: 'Column headings', options: [
      { value: 'rule', label: 'Ruled underneath' },
      { value: 'filled', label: 'On a filled band' },
    ] },
    rowRules: { type: 'select' as const, label: 'Rules between rows', options: [
      { value: 'every', label: 'Under every row' },
      { value: 'none', label: 'Only under the last one' },
    ] },
    zebra: { type: 'select' as const, label: 'Shade alternate rows', options: yesNo },
    headRadius: radiusField('Column heading corners (needs a filled band)'),
    headRadiusEdges: { type: 'select' as const, label: 'Those corners go on', options: [
      { value: 'outer', label: 'The outer ends of the band' },
      { value: 'every', label: 'Every heading cell' },
    ] },
    headPadX: spaceField('Space either side of a column heading'),
    headPadY: spaceField('Space above and below a column heading'),
    headCase: { type: 'select' as const, label: 'Column headings read', options: [
      { value: 'caps', label: 'IN SMALL CAPITALS' },
      { value: 'plain', label: 'As you typed them' },
    ] },
    rowPadY: spaceField('Space above and below a line'),
    rowRadius: radiusField('Shaded row corners'),
    descWidth: { type: 'select' as const, label: 'Description column takes', options: [
      { value: 'auto', label: 'As much as it needs' },
      { value: 'half', label: 'Half the table' },
      { value: 'wide', label: 'Three fifths' },
      { value: 'widest', label: 'Seven tenths' },
    ] },
    showSupplierSku: { type: 'select' as const, label: "The supplier's own product codes", options: yesNo },
    showOurSku: { type: 'select' as const, label: 'Your own product codes', options: yesNo },
    showLineDates: { type: 'select' as const, label: 'A date against a line that has one', options: yesNo },
    showDiscount: { type: 'select' as const, label: 'A line discount where there is one', options: yesNo },
    itemLabel: { type: 'text' as const, label: 'Description column' },
    codeLabel: { type: 'text' as const, label: 'Supplier code column' },
    qtyLabel: { type: 'text' as const, label: 'Quantity column' },
    costLabel: { type: 'text' as const, label: 'Unit cost column' },
    totalLabel: { type: 'text' as const, label: 'Line total column' },
    headPt: sizeField('Column heading size'),
    rowPt: sizeField('Line size'),
    skuPt: sizeField('Product code size'),
    detailPt: sizeField('Line detail size'),
  },
  defaultProps: {
    fontFamily: '', headStyle: 'rule', rowRules: 'every', zebra: 'no',
    headRadius: '', headRadiusEdges: 'outer', headPadX: '', headPadY: '',
    headCase: 'caps', rowPadY: '', rowRadius: '', descWidth: 'auto',
    showSupplierSku: 'yes', showOurSku: 'no', showLineDates: 'yes', showDiscount: 'yes',
    itemLabel: 'Description', codeLabel: 'Your code', qtyLabel: 'Qty',
    costLabel: 'Unit cost', totalLabel: 'Line total',
  },
  render: PoDocLines,
}
export const poDocLinesPuckRscComponent = { ...poDocLinesPuckComponent, render: PoDocLines }

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

type TotalsProps = DocProps & {
  subtotalLabel?: string; discountLabel?: string; carriageLabel?: string
  taxLabel?: string; totalLabel?: string; note?: string
  emphasis?: string; width?: string; showCarriageRow?: string; showCurrency?: string
  rowPt?: number | string; totalPt?: number | string; notePt?: number | string
}

const TOTALS_WIDTHS: Record<string, string> = { narrow: '18rem', normal: '22rem', wide: '28rem' }

export function PoDocTotals(props: TotalsProps) {
  const { order } = useCtx(props)
  const font = fontStyle(props)
  const note = props.note?.trim()
  const discount = Number(order.discountAmount)
  const carriage = Number(order.carriageAmount)
  const tax = Number(order.taxAmount)
  // Carriage printed even at nothing, for an order where "carriage paid" is the
  // deal and a blank would read as "not agreed yet".
  const showCarriage = props.showCarriageRow === 'always' || carriage !== 0
  const listClass = `po-doc-totals${props.emphasis === 'accent' ? ' po-doc-total-accent' : ''}`
  // Which currency the figures are in. Obvious on a domestic order and the whole
  // question on one placed abroad, where a supplier reading "1,240.00" needs to
  // know we mean euros.
  const totalLabel = props.totalLabel?.trim() || 'Order total'
  const grandLabel = props.showCurrency === 'yes' ? `${totalLabel} (${order.currency})` : totalLabel

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <dl
        className={listClass}
        style={{
          ...font,
          maxWidth: TOTALS_WIDTHS[props.width ?? 'normal'],
          ...sizeVars({ '--po-doc-totals-size': props.rowPt, '--po-doc-grand-size': props.totalPt }),
        }}
      >
        <dt>{props.subtotalLabel?.trim() || 'Goods'}</dt>
        <dd>{formatMoney(order.subtotal, order.currency)}</dd>
        {discount > 0 && (
          <div className="po-doc-row">
            <dt>{props.discountLabel?.trim() || 'Discount'}</dt>
            <dd>-{formatMoney(discount, order.currency)}</dd>
          </div>
        )}
        {showCarriage && (
          <div className="po-doc-row">
            <dt>{props.carriageLabel?.trim() || 'Carriage'}</dt>
            <dd>{formatMoney(carriage, order.currency)}</dd>
          </div>
        )}
        {tax !== 0 && (
          <div className="po-doc-row">
            <dt>{props.taxLabel?.trim() || 'VAT'}{order.taxMode === 'INCLUSIVE' ? ' (included)' : ''}</dt>
            <dd>{formatMoney(tax, order.currency)}</dd>
          </div>
        )}
        <dt className="po-doc-grand">{grandLabel}</dt>
        <dd className="po-doc-grand">{formatMoney(order.total, order.currency)}</dd>
      </dl>
      {note && (
        <p className="po-doc-note" style={{ ...font, ...sizeVars({ '--po-doc-note-size': props.notePt }) }}>
          {note}
        </p>
      )}
    </>
  )
}

export const poDocTotalsPuckComponent = {
  label: 'Purchase order: Totals',
  fields: {
    fontFamily: fontField,
    emphasis: { type: 'select' as const, label: 'The total', options: [
      { value: 'rule', label: 'Bold, above a hairline' },
      { value: 'accent', label: 'Large, above an accent rule' },
    ] },
    width: { type: 'select' as const, label: 'How wide', options: [
      { value: 'narrow', label: 'Narrow' },
      { value: 'normal', label: 'Normal' },
      { value: 'wide', label: 'Wide' },
    ] },
    subtotalLabel: { type: 'text' as const, label: 'Goods row' },
    discountLabel: { type: 'text' as const, label: 'Discount row' },
    carriageLabel: { type: 'text' as const, label: 'Carriage row' },
    showCarriageRow: { type: 'select' as const, label: 'Carriage row when there is no charge', options: [
      { value: 'charged', label: 'Leave it off' },
      { value: 'always', label: 'Print it anyway' },
    ] },
    taxLabel: { type: 'text' as const, label: 'Tax row' },
    totalLabel: { type: 'text' as const, label: 'Total row' },
    showCurrency: { type: 'select' as const, label: 'The currency code beside the total', options: yesNo },
    note: { type: 'textarea' as const, label: 'A line under the totals (blank prints nothing)' },
    rowPt: sizeField('Row size'),
    totalPt: sizeField('Total size'),
    notePt: sizeField('Note size'),
  },
  defaultProps: {
    fontFamily: '', emphasis: 'rule', width: 'normal',
    subtotalLabel: 'Goods', discountLabel: 'Discount', carriageLabel: 'Carriage',
    showCarriageRow: 'charged', taxLabel: 'VAT', totalLabel: 'Order total', showCurrency: 'yes',
    note: '',
  },
  render: PoDocTotals,
}
export const poDocTotalsPuckRscComponent = { ...poDocTotalsPuckComponent, render: PoDocTotals }

// ---------------------------------------------------------------------------
// Terms, and the notes typed onto this particular order
// ---------------------------------------------------------------------------
//
// Two blocks, because they are two different things. Terms are the same on every
// order and live in settings; the note is what somebody typed onto THIS one, and
// it is usually the reason the supplier reads any of it.

type TermsProps = DocProps & {
  heading?: string; columns?: string; capsHeading?: string; extra?: string; extraHeading?: string
  showPaymentTerms?: string; showDeliveryTerms?: string
  paymentLabel?: string; deliveryLabel?: string
  headingPt?: number | string; bodyPt?: number | string
}

export function PoDocTerms(props: TermsProps) {
  const ctx = useCtx(props)
  const font = fontStyle(props)
  const terms = ctx.copy.terms?.trim() ?? ''
  const extra = props.extra?.trim() ?? ''
  const payment = props.showPaymentTerms !== 'no' ? ctx.order.paymentTerms?.trim() ?? '' : ''
  const delivery = props.showDeliveryTerms !== 'no' ? ctx.order.deliveryTerms?.trim() ?? '' : ''
  if (!terms && !extra && !payment && !delivery) return null
  const cols = props.columns === '2' ? ' po-doc-cols-2' : ''
  const caps = props.capsHeading !== 'no' ? ' po-doc-h2-caps' : ''

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-terms${cols}`}
        style={{
          ...font,
          ...sizeVars({ '--po-doc-h2-size': props.headingPt, '--po-doc-smallprint-size': props.bodyPt }),
        }}
      >
        {(terms || payment || delivery) && (
          <div>
            <h2 className={`po-doc-h2${caps}`} style={font}>{props.heading?.trim() || 'Terms'}</h2>
            {payment && <p>{props.paymentLabel?.trim() || 'Payment terms'}: {payment}</p>}
            {delivery && <p>{props.deliveryLabel?.trim() || 'Delivery terms'}: {delivery}</p>}
            {/* Plain text, split on blank lines - the terms box in settings is a
                textarea, not a rich-text field, so paragraphs are all it can mean. */}
            {paragraphs(terms).map((para, i) => <p key={i}>{para}</p>)}
          </div>
        )}
        {extra && (
          <div>
            <h2 className={`po-doc-h2${caps}`} style={font}>{props.extraHeading?.trim() || 'Also'}</h2>
            {paragraphs(extra).map((para, i) => <p key={i}>{para}</p>)}
          </div>
        )}
      </section>
    </>
  )
}

export const poDocTermsPuckComponent = {
  label: 'Purchase order: Terms',
  fields: {
    heading: { type: 'text' as const, label: 'Heading' },
    fontFamily: fontField,
    columns: { type: 'select' as const, label: 'Laid out', options: [
      { value: '1', label: 'One under the other' },
      { value: '2', label: 'Side by side' },
    ] },
    capsHeading: { type: 'select' as const, label: 'Headings in small capitals', options: yesNo },
    showPaymentTerms: { type: 'select' as const, label: "This order's payment terms", options: yesNo },
    paymentLabel: { type: 'text' as const, label: 'Payment terms wording' },
    showDeliveryTerms: { type: 'select' as const, label: "This order's delivery terms", options: yesNo },
    deliveryLabel: { type: 'text' as const, label: 'Delivery terms wording' },
    extraHeading: { type: 'text' as const, label: 'Second column heading' },
    extra: { type: 'textarea' as const, label: 'A second column of small print, on this layout only' },
    headingPt: sizeField('Heading size'),
    bodyPt: sizeField('Small print size'),
  },
  defaultProps: {
    heading: 'Terms', fontFamily: '', columns: '1', capsHeading: 'yes',
    showPaymentTerms: 'yes', paymentLabel: 'Payment terms',
    showDeliveryTerms: 'yes', deliveryLabel: 'Delivery terms',
    extraHeading: 'Also', extra: '',
  },
  render: PoDocTerms,
}
export const poDocTermsPuckRscComponent = { ...poDocTermsPuckComponent, render: PoDocTerms }

type NotesProps = DocProps & {
  heading?: string; capsHeading?: string; showHeading?: string
  headingPt?: number | string; bodyPt?: number | string
}

export function PoDocNotes(props: NotesProps) {
  const ctx = useCtx(props)
  const font = fontStyle(props)
  // Only what was written FOR the supplier. `notesInternal` is deliberately not
  // in the document context at all: a note reading "check they have not stitched
  // us up on carriage again" must not be one careless block away from the page
  // that gets emailed to them.
  const note = ctx.order.notesSupplier?.trim() ?? ''
  if (!note) return null
  const caps = props.capsHeading !== 'no' ? ' po-doc-h2-caps' : ''

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className="po-doc-notes"
        style={{
          ...font,
          ...sizeVars({ '--po-doc-h2-size': props.headingPt, '--po-doc-notes-size': props.bodyPt }),
        }}
      >
        {props.showHeading !== 'no' && (
          <h2 className={`po-doc-h2${caps}`} style={font}>{props.heading?.trim() || 'Notes'}</h2>
        )}
        {paragraphs(note).map((para, i) => <p key={i}>{para}</p>)}
      </section>
    </>
  )
}

export const poDocNotesPuckComponent = {
  label: 'Purchase order: Notes',
  fields: {
    showHeading: { type: 'select' as const, label: 'Heading', options: yesNo },
    heading: { type: 'text' as const, label: 'Heading wording' },
    capsHeading: { type: 'select' as const, label: 'Heading in small capitals', options: yesNo },
    fontFamily: fontField,
    headingPt: sizeField('Heading size'),
    bodyPt: sizeField('Note size'),
  },
  defaultProps: { showHeading: 'yes', heading: 'Notes', capsHeading: 'yes', fontFamily: '' },
  render: PoDocNotes,
}
export const poDocNotesPuckRscComponent = { ...poDocNotesPuckComponent, render: PoDocNotes }

// ---------------------------------------------------------------------------
// Authorised by
// ---------------------------------------------------------------------------
//
// A purchase order is an instruction to spend somebody's money, and a supplier's
// credit control asks who said so. Where the site runs approvals, the name and
// the date come off the order itself; where it does not, the block can still draw
// a ruled line for somebody to sign, which is what a paper order has always had.

type ApprovalProps = DocProps & {
  raisedLabel?: string; approvedLabel?: string; signatureLabel?: string
  showRaised?: string; showApproved?: string; showSignature?: string; showDate?: string
  bodyPt?: number | string
}

export function PoDocApproval(props: ApprovalProps) {
  const { order } = useCtx(props)
  const font = fontStyle(props)
  const raised = props.showRaised !== 'no' ? order.raisedByName?.trim() ?? '' : ''
  const approved = props.showApproved !== 'no' ? order.approvedByName?.trim() ?? '' : ''
  const signature = props.showSignature === 'yes'
  if (!raised && !approved && !signature) return null

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section className="po-doc-approval" style={{ ...font, ...sizeVars({ '--po-doc-approval-size': props.bodyPt }) }}>
        {raised && (
          <div>
            <h2 className="po-doc-h2 po-doc-h2-caps" style={font}>{props.raisedLabel?.trim() || 'Raised by'}</h2>
            <div className="po-doc-signed">{raised}</div>
            {props.showDate !== 'no' && order.raisedDate && (
              <div className="po-doc-instructions">{formatDate(order.raisedDate)}</div>
            )}
          </div>
        )}
        {approved && (
          <div>
            <h2 className="po-doc-h2 po-doc-h2-caps" style={font}>{props.approvedLabel?.trim() || 'Authorised by'}</h2>
            <div className="po-doc-signed">{approved}</div>
            {props.showDate !== 'no' && order.approvedAt && (
              <div className="po-doc-instructions">{formatDate(order.approvedAt)}</div>
            )}
          </div>
        )}
        {signature && (
          <div>
            <h2 className="po-doc-h2 po-doc-h2-caps" style={font}>{props.signatureLabel?.trim() || 'Signature'}</h2>
            <div className="po-doc-signline">Signed and dated</div>
          </div>
        )}
      </section>
    </>
  )
}

export const poDocApprovalPuckComponent = {
  label: 'Purchase order: Authorised by',
  fields: {
    fontFamily: fontField,
    showRaised: { type: 'select' as const, label: 'Who raised it', options: yesNo },
    raisedLabel: { type: 'text' as const, label: '"Raised by" wording' },
    showApproved: { type: 'select' as const, label: 'Who approved it', options: yesNo },
    approvedLabel: { type: 'text' as const, label: '"Authorised by" wording' },
    showSignature: { type: 'select' as const, label: 'A line to sign by hand', options: yesNo },
    signatureLabel: { type: 'text' as const, label: 'Signature wording' },
    showDate: { type: 'select' as const, label: 'The dates underneath', options: yesNo },
    bodyPt: sizeField('Text size'),
  },
  defaultProps: {
    fontFamily: '', showRaised: 'yes', raisedLabel: 'Raised by',
    showApproved: 'yes', approvedLabel: 'Authorised by',
    showSignature: 'no', signatureLabel: 'Signature', showDate: 'yes',
  },
  render: PoDocApproval,
}
export const poDocApprovalPuckRscComponent = { ...poDocApprovalPuckComponent, render: PoDocApproval }
