import { formatMoney, formatQty, formatQtyUnit } from '@/modules/purchase-orders/lib/money'
import {
  Style, FontLink, fontStyle, fontField, sizeField, radiusField, spaceField, sizeVars, cssLength,
  yesNo, formatDate, paragraphs,
} from '@/modules/purchase-orders/components/puck/po-shared'
import {
  PartyColumn, hasParty, partySizes, PARTY_ALIGN, PARTY_ALIGN_FIELD, PARTY_DETAIL_FIELDS,
  PARTY_SIZE_FIELDS, TITLE_SIZES, HEAD_RULES, TOTALS_WIDTHS, DESC_WIDTHS,
  type PartyDisplayProps, type PartySizeProps,
} from '@/modules/purchase-orders/components/puck/po-parts'
import { SAMPLE_PO_RET_CONTEXT, type PoRetDocContext } from '@/modules/purchase-orders/lib/return-doc-context'

// The returns note, as draggable blocks on the `purchaseReturnDocument` layout
// type: the heading, who it is between, what is going back, what it is worth,
// why, and anything else somebody wanted to say.
//
// A document of its own rather than a variant of the purchase order, because it
// is a different piece of paper doing a different job: the order asks a supplier
// to send goods, and this one tells them goods are coming back and asks for the
// money. Sharing blocks between the two would have meant every field labelled
// for the order and quietly meaning something else here.
//
// What IS shared is everything with no opinion about which document it is on:
// the stylesheet (`po-doc-*` classes throughout, so a site's document style block
// reaches this note as well), the address column, the size and colour fields, and
// the two chrome blocks - the Document style and the Divider are declared on both
// layout types in the manifest rather than written twice.
//
// Same contract as the order's blocks: one render path each, shared by the Puck
// editor and the published document, and nothing here is a client component.

export type RetProps = { _ctx?: PoRetDocContext; fontFamily?: string }

/** Context absent means the editor canvas, where a sample note is drawn instead
 *  of a column of empty boxes. */
function useRet(props: RetProps): PoRetDocContext {
  return props._ctx ?? SAMPLE_PO_RET_CONTEXT
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
//
// The written blocks - the notice panel and the terms - are sentences somebody
// types, and a sentence about this return needs this return's numbers in it. A
// fixed, small list rather than a path into the object, for the same reason the
// order has one: somebody writing "Credit {{RETURN_NUMBER}} against
// {{ORDER_NUMBER}}" is doing something they can hold in their head.

export function retTokens(ctx: PoRetDocContext): Record<string, string> {
  const { ret, buyer, supplier, site } = ctx
  const bareUrl = (site.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  return {
    RETURN_NUMBER: ret.number ?? '',
    RETURN_DATE: formatDate(ret.raisedDate),
    ORDER_NUMBER: ret.orderNumber ?? '',
    ORDER_DATE: formatDate(ret.orderDate),
    REASON: ret.reason ?? '',
    SUBTOTAL: formatMoney(ret.subtotal, ret.currency),
    CREDIT_EXPECTED: formatMoney(ret.creditExpected, ret.currency),
    CREDIT_REF: ret.creditRef ?? '',
    SUPPLIER_NAME: supplier.name ?? '',
    SUPPLIER_ACCOUNT: supplier.accountNumber ?? '',
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
 *  and the hole would otherwise show as a double space or a stranded comma. */
export function fillRetTokens(text: string, tokens: Record<string, string>): string {
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

const RET_TOKEN_HINT =
  'Placeholders: {{RETURN_NUMBER}} {{RETURN_DATE}} {{ORDER_NUMBER}} {{ORDER_DATE}} {{CREDIT_EXPECTED}} {{SUBTOTAL}} {{CREDIT_REF}} {{SUPPLIER_NAME}} {{SUPPLIER_ACCOUNT}} {{BUSINESS_NAME}} {{BUSINESS_EMAIL}} {{BUSINESS_PHONE}} {{BUSINESS_ADDRESS}} {{VAT_NUMBER}} {{COMPANY_NUMBER}} {{SITE_URL}}'

// ---------------------------------------------------------------------------
// Heading
// ---------------------------------------------------------------------------
//
// The order number is not optional on this document and has no "hide" switch. A
// returns desk with a box of desks and no order number to file it against has a
// box of desks and a mystery.

type RetHeaderProps = RetProps & {
  heading?: string
  titleSize?: string; sides?: string; rule?: string
  factsLayout?: string; numberStyle?: string
  returnLabel?: string; dateLabel?: string; orderLabel?: string; accountLabel?: string
  showDate?: string; showAccount?: string; showIntro?: string
  titlePt?: number | string; numberPt?: number | string; factsPt?: number | string; introPt?: number | string
}

export function PoRetHeader(props: RetHeaderProps) {
  const ctx = useRet(props)
  const { ret } = ctx
  const heading = props.heading?.trim() || ctx.copy.heading || 'Returns note'
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
  if (!leadNumber) facts.push({ label: props.returnLabel?.trim() || 'Return', value: ret.number ?? '' })
  if (props.showDate !== 'no') facts.push({ label: props.dateLabel?.trim() || 'Date', value: formatDate(ret.raisedDate) })
  facts.push({ label: props.orderLabel?.trim() || 'Against order', value: ret.orderNumber ?? '' })
  if (props.showAccount !== 'no') {
    facts.push({ label: props.accountLabel?.trim() || 'Account', value: ctx.supplier.accountNumber ?? '' })
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
          {leadNumber && ret.number && <p className="po-doc-lead">{ret.number}</p>}
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

export const poRetHeaderPuckComponent = {
  label: 'Returns note: Heading',
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
    numberStyle: { type: 'select' as const, label: 'The return number', options: [
      { value: 'row', label: 'As a row, with the rest' },
      { value: 'lead', label: 'On its own, above the dates' },
    ] },
    returnLabel: { type: 'text' as const, label: '"Return" row label' },
    showDate: { type: 'select' as const, label: 'Date row', options: yesNo },
    dateLabel: { type: 'text' as const, label: '"Date" row label' },
    // No switch for the order number. A return with nothing to file it against
    // is a box on a supplier's dock that nobody can credit.
    orderLabel: { type: 'text' as const, label: '"Against order" row label' },
    showAccount: { type: 'select' as const, label: 'Your account number with them', options: yesNo },
    accountLabel: { type: 'text' as const, label: '"Account" row label' },
    showIntro: { type: 'select' as const, label: 'The opening line from settings', options: yesNo },
    numberPt: sizeField('Return number size'),
    factsPt: sizeField('Dates and numbers size'),
    introPt: sizeField('Opening line size'),
  },
  defaultProps: {
    heading: '', fontFamily: '', titleSize: 'medium', sides: 'logo-left', rule: 'hairline',
    factsLayout: 'columns', numberStyle: 'row',
    returnLabel: 'Return', showDate: 'yes', dateLabel: 'Date',
    orderLabel: 'Against order', showAccount: 'yes', accountLabel: 'Account', showIntro: 'yes',
  },
  render: PoRetHeader,
}
export const poRetHeaderPuckRscComponent = { ...poRetHeaderPuckComponent, render: PoRetHeader }

// ---------------------------------------------------------------------------
// The two parties
// ---------------------------------------------------------------------------

type RetPartiesProps = RetProps & PartyDisplayProps & PartySizeProps & {
  fromLabel?: string; toLabel?: string; accountLabel?: string
  showFrom?: string; showTo?: string; order?: string; columns?: string
}

export function PoRetParties(props: RetPartiesProps) {
  const ctx = useRet(props)
  const font = fontStyle(props)
  const showFrom = props.showFrom !== 'no' && hasParty(ctx.buyer)
  const showTo = props.showTo !== 'no' && hasParty(ctx.supplier)

  const from = showFrom
    ? <PartyColumn key="from" party={ctx.buyer} heading={props.fromLabel?.trim() || 'Returned by'} props={props} />
    : null
  const to = showTo
    ? (
      <PartyColumn
        key="to"
        party={ctx.supplier}
        heading={props.toLabel?.trim() || 'Returned to'}
        props={props}
        accountLabel={props.accountLabel?.trim() || 'Account'}
      />
    )
    : null

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

export const poRetPartiesPuckComponent = {
  label: 'Returns note: Who it is between',
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
    toLabel: { type: 'text' as const, label: '"Returned to" heading' },
    showFrom: { type: 'select' as const, label: 'Your own details', options: yesNo },
    fromLabel: { type: 'text' as const, label: '"Returned by" heading' },
    showAccount: { type: 'select' as const, label: 'Your account number with them', options: yesNo },
    accountLabel: { type: 'text' as const, label: 'Account number wording' },
    ...PARTY_DETAIL_FIELDS,
    ...PARTY_SIZE_FIELDS,
  },
  defaultProps: {
    fontFamily: '', order: 'to-first', columns: '2',
    showTo: 'yes', toLabel: 'Returned to', showFrom: 'yes', fromLabel: 'Returned by',
    showAccount: 'yes', accountLabel: 'Account',
    showContact: 'yes', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no',
  },
  render: PoRetParties,
}
export const poRetPartiesPuckRscComponent = { ...poRetPartiesPuckComponent, render: PoRetParties }

type RetToProps = RetProps & PartyDisplayProps & PartySizeProps & {
  heading?: string; align?: string; accountLabel?: string
}

export function PoRetTo(props: RetToProps) {
  const ctx = useRet(props)
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
          heading={props.heading?.trim() || 'Returned to'}
          props={props}
          accountLabel={props.accountLabel?.trim() || 'Account'}
        />
      </section>
    </>
  )
}

export const poRetToPuckComponent = {
  label: 'Returns note: Returned to',
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
    heading: 'Returned to', fontFamily: '', showAccount: 'yes', accountLabel: 'Account',
    showContact: 'yes', showEmail: 'yes', showPhone: 'yes', showRegistration: 'no', align: 'left',
  },
  render: PoRetTo,
}
export const poRetToPuckRscComponent = { ...poRetToPuckComponent, render: PoRetTo }

// ---------------------------------------------------------------------------
// Lines: what is actually going back
// ---------------------------------------------------------------------------

type RetLinesProps = RetProps & {
  showSupplierSku?: string; showReceipt?: string
  itemLabel?: string; codeLabel?: string; qtyLabel?: string; costLabel?: string; totalLabel?: string
  headStyle?: string; rowRules?: string; zebra?: string; headCase?: string
  headPt?: number | string; rowPt?: number | string; skuPt?: number | string; detailPt?: number | string
  headRadius?: string; headRadiusEdges?: string; headPadX?: string; headPadY?: string
  rowPadY?: string; rowRadius?: string; descWidth?: string
}

export function PoRetLines(props: RetLinesProps) {
  const { ret } = useRet(props)
  const font = fontStyle(props)
  const codeColumn = props.showSupplierSku !== 'no'

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
            <th className="po-doc-num">{props.qtyLabel?.trim() || 'Going back'}</th>
            <th className="po-doc-num">{props.costLabel?.trim() || 'Unit cost'}</th>
            <th className="po-doc-num">{props.totalLabel?.trim() || 'Credit due'}</th>
          </tr>
        </thead>
        <tbody>
          {ret.lines.map((line, index) => {
            // Which delivery it came in on. The single most useful thing on the
            // sheet for a supplier's own goods-in desk, who file by their own
            // despatch note and not by our order.
            const detail = props.showReceipt !== 'no' && line.receiptNumber
              ? [`Delivered on ${line.receiptNumber}`]
              : []
            // Shading marked on the row rather than counted by nth-child, so it
            // stays in step with the order sheet, whose lines can run to two
            // rows when there is a delivery charged on one.
            return (
              <tr key={line.id} className={index % 2 === 1 ? 'po-doc-alt' : undefined}>
                <td>
                  <span className="po-doc-name">{line.description}</span>
                  {detail.length > 0 && (
                    <ul className="po-doc-detail">
                      {detail.map((row, i) => <li key={i}>{row}</li>)}
                    </ul>
                  )}
                </td>
                {codeColumn && <td className="po-doc-sku">{line.supplierSku ?? ''}</td>}
                <td className="po-doc-num">{formatQtyUnit(line.qty, line.unit)}</td>
                <td className="po-doc-num">{formatMoney(line.unitCost, ret.currency)}</td>
                <td className="po-doc-num">{formatMoney(line.lineTotal, ret.currency)}</td>
              </tr>
            )
          })}
          {ret.lines.length === 0 && (
            <tr>
              <td colSpan={columnCount} className="po-doc-empty">There is nothing on this return.</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
}

export const poRetLinesPuckComponent = {
  label: 'Returns note: Lines',
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
    showReceipt: { type: 'select' as const, label: 'Which delivery it came in on', options: yesNo },
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
    fontFamily: '', headStyle: 'rule', rowRules: 'every', zebra: 'no', headCase: 'caps',
    headRadius: '', headRadiusEdges: 'outer', headPadX: '', headPadY: '',
    rowPadY: '', rowRadius: '', descWidth: 'auto',
    showSupplierSku: 'yes', showReceipt: 'yes',
    itemLabel: 'Description', codeLabel: 'Your code', qtyLabel: 'Going back',
    costLabel: 'Unit cost', totalLabel: 'Credit due',
  },
  render: PoRetLines,
}
export const poRetLinesPuckRscComponent = { ...poRetLinesPuckComponent, render: PoRetLines }

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------
//
// The one figure that matters, and it is a figure the supplier owes rather than
// one we do. Printed as a positive number with a label saying what it is, never
// as a negative: "-£396.00" on a document headed "Returns note" invites the
// question of which way round it is meant, and that question costs a phone call.

type RetTotalsProps = RetProps & {
  subtotalLabel?: string; taxLabel?: string; totalLabel?: string; note?: string
  emphasis?: string; width?: string; showCurrency?: string; showTax?: string
  rowPt?: number | string; totalPt?: number | string; notePt?: number | string
}

export function PoRetTotals(props: RetTotalsProps) {
  const { ret } = useRet(props)
  const font = fontStyle(props)
  const note = props.note?.trim()
  const tax = Number(ret.taxAmount)
  const listClass = `po-doc-totals${props.emphasis === 'accent' ? ' po-doc-total-accent' : ''}`
  const totalLabel = props.totalLabel?.trim() || 'Credit due'
  const grandLabel = props.showCurrency === 'yes' ? `${totalLabel} (${ret.currency})` : totalLabel

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
        <dd>{formatMoney(ret.subtotal, ret.currency)}</dd>
        {props.showTax !== 'no' && tax !== 0 && (
          <div className="po-doc-row">
            <dt>{props.taxLabel?.trim() || 'VAT'}</dt>
            <dd>{formatMoney(tax, ret.currency)}</dd>
          </div>
        )}
        <dt className="po-doc-grand">{grandLabel}</dt>
        <dd className="po-doc-grand">{formatMoney(ret.creditExpected, ret.currency)}</dd>
      </dl>
      {note && (
        <p className="po-doc-note" style={{ ...font, ...sizeVars({ '--po-doc-note-size': props.notePt }) }}>
          {note}
        </p>
      )}
    </>
  )
}

export const poRetTotalsPuckComponent = {
  label: 'Returns note: Totals',
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
    showTax: { type: 'select' as const, label: 'Tax row', options: yesNo },
    taxLabel: { type: 'text' as const, label: 'Tax row wording' },
    totalLabel: { type: 'text' as const, label: 'Total row' },
    showCurrency: { type: 'select' as const, label: 'The currency code beside the total', options: yesNo },
    note: { type: 'textarea' as const, label: 'A line under the totals (blank prints nothing)' },
    rowPt: sizeField('Row size'),
    totalPt: sizeField('Total size'),
    notePt: sizeField('Note size'),
  },
  defaultProps: {
    fontFamily: '', emphasis: 'rule', width: 'normal',
    subtotalLabel: 'Goods', showTax: 'yes', taxLabel: 'VAT',
    totalLabel: 'Credit due', showCurrency: 'yes', note: '',
  },
  render: PoRetTotals,
}
export const poRetTotalsPuckRscComponent = { ...poRetTotalsPuckComponent, render: PoRetTotals }

// ---------------------------------------------------------------------------
// Why they are going back
// ---------------------------------------------------------------------------
//
// The block this document exists for. A supplier's returns desk decides whether
// to credit on this paragraph and nothing else, so it gets a block of its own
// rather than a line at the bottom of the notes.

type RetReasonProps = RetProps & {
  heading?: string; capsHeading?: string; showHeading?: string; look?: string
  headingPt?: number | string; bodyPt?: number | string
  radius?: string; padding?: string
}

const REASON_LOOKS = [
  { value: 'plain', label: 'Plain text' },
  { value: 'panel', label: 'Tinted panel' },
  { value: 'outline', label: 'Outlined box' },
]

export function PoRetReason(props: RetReasonProps) {
  const { ret } = useRet(props)
  const font = fontStyle(props)
  const reason = ret.reason?.trim() ?? ''
  // Nobody said why. A heading over an empty box is worse than no box, and
  // "Reason for return: " followed by white space reads as an accusation.
  if (!reason) return null
  const caps = props.capsHeading !== 'no' ? ' po-doc-h2-caps' : ''
  const look = REASON_LOOKS.some((l) => l.value === props.look) ? props.look : 'plain'

  return (
    <>
      <Style />
      <FontLink family={props.fontFamily} />
      <section
        className={`po-doc-shipto po-doc-shipto-${look}`}
        style={{
          ...font,
          ...sizeVars({ '--po-doc-h2-size': props.headingPt, '--po-doc-party-size': props.bodyPt }),
          ...(cssLength(props.radius) ? { '--po-doc-radius': cssLength(props.radius)! } : {}),
          ...(cssLength(props.padding) ? { '--po-doc-notice-pad': cssLength(props.padding)! } : {}),
        }}
      >
        {props.showHeading !== 'no' && (
          <h2 className={`po-doc-h2${caps}`} style={font}>{props.heading?.trim() || 'Why they are going back'}</h2>
        )}
        {paragraphs(reason).map((para, i) => <p key={i}>{para}</p>)}
      </section>
    </>
  )
}

export const poRetReasonPuckComponent = {
  label: 'Returns note: Why they are going back',
  fields: {
    showHeading: { type: 'select' as const, label: 'Heading', options: yesNo },
    heading: { type: 'text' as const, label: 'Heading wording' },
    capsHeading: { type: 'select' as const, label: 'Heading in small capitals', options: yesNo },
    look: { type: 'select' as const, label: 'Look', options: REASON_LOOKS },
    fontFamily: fontField,
    radius: radiusField('Corners'),
    padding: spaceField('Space inside the box'),
    headingPt: sizeField('Heading size'),
    bodyPt: sizeField('Text size'),
  },
  defaultProps: {
    showHeading: 'yes', heading: 'Why they are going back', capsHeading: 'yes',
    look: 'panel', fontFamily: '', radius: '', padding: '',
  },
  render: PoRetReason,
}
export const poRetReasonPuckRscComponent = { ...poRetReasonPuckComponent, render: PoRetReason }

// ---------------------------------------------------------------------------
// Notes, and the standing terms
// ---------------------------------------------------------------------------

type RetNotesProps = RetProps & {
  heading?: string; capsHeading?: string; showHeading?: string
  showTerms?: string; termsHeading?: string
  headingPt?: number | string; bodyPt?: number | string
}

export function PoRetNotes(props: RetNotesProps) {
  const ctx = useRet(props)
  const font = fontStyle(props)
  const note = ctx.ret.notes?.trim() ?? ''
  const terms = props.showTerms !== 'no' ? ctx.copy.terms?.trim() ?? '' : ''
  if (!note && !terms) return null
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
        {note && (
          <>
            {props.showHeading !== 'no' && (
              <h2 className={`po-doc-h2${caps}`} style={font}>{props.heading?.trim() || 'Notes'}</h2>
            )}
            {paragraphs(note).map((para, i) => <p key={i}>{para}</p>)}
          </>
        )}
        {terms && (
          <>
            <h2 className={`po-doc-h2${caps}`} style={font}>{props.termsHeading?.trim() || 'Terms'}</h2>
            {paragraphs(terms).map((para, i) => <p key={`t-${i}`}>{para}</p>)}
          </>
        )}
      </section>
    </>
  )
}

export const poRetNotesPuckComponent = {
  label: 'Returns note: Notes and terms',
  fields: {
    showHeading: { type: 'select' as const, label: 'Notes heading', options: yesNo },
    heading: { type: 'text' as const, label: 'Notes heading wording' },
    showTerms: { type: 'select' as const, label: 'The returns terms from settings', options: yesNo },
    termsHeading: { type: 'text' as const, label: 'Terms heading wording' },
    capsHeading: { type: 'select' as const, label: 'Headings in small capitals', options: yesNo },
    fontFamily: fontField,
    headingPt: sizeField('Heading size'),
    bodyPt: sizeField('Text size'),
  },
  defaultProps: {
    showHeading: 'yes', heading: 'Notes', showTerms: 'yes', termsHeading: 'Terms',
    capsHeading: 'yes', fontFamily: '',
  },
  render: PoRetNotes,
}
export const poRetNotesPuckRscComponent = { ...poRetNotesPuckComponent, render: PoRetNotes }

// ---------------------------------------------------------------------------
// Notice panel
// ---------------------------------------------------------------------------

const NOTICE_STYLES = [
  { value: 'panel', label: 'Tinted panel with an accent bar' },
  { value: 'outline', label: 'Outlined box' },
  { value: 'plain', label: 'Plain text' },
  { value: 'quiet', label: 'Small print' },
]

type RetNoticeProps = RetProps & {
  radius?: string; padding?: string
  lead?: string; body?: string; panelStyle?: string; hideWhenEmpty?: string
  bodyPt?: number | string
}

export function PoRetNotice(props: RetNoticeProps) {
  const ctx = useRet(props)
  const tokens = retTokens(ctx)
  const font = fontStyle(props)
  const lead = fillRetTokens(props.lead?.trim() ?? '', tokens)
  const body = fillRetTokens(props.body?.trim() ?? '', tokens)
  // Everything written was tokens, and every token was empty. An empty tinted
  // box is worse than no box.
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

export const poRetNoticePuckComponent = {
  label: 'Returns note: Notice panel',
  fields: {
    lead: { type: 'text' as const, label: 'Opening words, in bold' },
    body: { type: 'textarea' as const, label: `The rest of it. ${RET_TOKEN_HINT}` },
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
    lead: 'Please credit {{CREDIT_EXPECTED}} against order {{ORDER_NUMBER}}.',
    body: 'Quote {{RETURN_NUMBER}} on your credit note. Anything sent back to us against this return will be refused.',
    panelStyle: 'panel', hideWhenEmpty: 'yes', fontFamily: '', radius: '', padding: '',
  },
  render: PoRetNotice,
}
export const poRetNoticePuckRscComponent = { ...poRetNoticePuckComponent, render: PoRetNotice }
