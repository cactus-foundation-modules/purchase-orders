// Styling for the purchase order document, in one place because two surfaces
// render the same markup: the /purchase-order/<number> page an admin opens, and
// the PDF a headless browser prints from that same page.
//
// Colours are semantic tokens, never hex, so the document sits inside the site's
// own theme in light and dark alike - with one exception, marked below: the print
// rules force ink on paper, because a dark-mode PDF is a sheet of black toner.
//
// Typefaces are tokens for the same reason. Core styles the site's fonts with
// `main …` rules and this document does not always sit inside `main`, so each
// part binds itself to the same variables Appearance > Styles emits. A block
// whose own Font field is set overrides these inline, which is why they are
// plain class rules and not !important.
//
// ---------------------------------------------------------------------------
// The --po-doc-* custom properties
// ---------------------------------------------------------------------------
//
// Every rule an owner can influence reads a --po-doc-* property with a fallback,
// and every fallback is what the document looks like with no Document style
// block on it at all. Two reasons, and the second is the one that bites: the
// print rules below say !important to force a dark page back to ink, and
// !important beats an inline style property - so an owner's accent colour set as
// `border-color` inline would come out grey in the PDF, which is the one place
// the colour was the whole point. Set through a property, it survives.
//
// The style block sets those properties on the part classes themselves rather
// than on :root, so nothing escapes the document - which matters in the Puck
// editor, where the canvas shares a document with the admin UI.
export const PO_DOC_CSS = `
.po-doc-head, .po-doc-intro, .po-doc-lead, .po-doc-parties, .po-doc-shipto,
.po-doc-lines, .po-doc-totals, .po-doc-note, .po-doc-terms, .po-doc-notes,
.po-doc-notice, .po-doc-approval, .po-doc-rule { font-family: var(--po-doc-body-font, var(--font-body, var(--font-sans, inherit))); }
.po-doc-h1 { font-family: var(--po-doc-head-font, var(--h1-family, var(--font-heading, var(--font-body, inherit)))); font-weight: var(--h1-weight, 700); letter-spacing: var(--h1-letter-spacing, normal); text-transform: var(--h1-transform, none); }
.po-doc-h2 { font-family: var(--po-doc-head-font, var(--h2-family, var(--font-heading, var(--font-body, inherit)))); font-weight: var(--h2-weight, 700); letter-spacing: var(--h2-letter-spacing, normal); text-transform: var(--h2-transform, none); }

/* Leading, stated by the document rather than inherited from the page it is
   sitting on.

   A site's body typography is written for a web page, and Appearance > Styles
   lets an owner set it as an exact line height in PIXELS - "16px text, 24px
   leading", which is how a type scale is normally written. A px line-height is
   inherited as a LENGTH, so it arrives unchanged on a run of text an owner has
   set to 11px here, and the document prints with two lines of air between every
   address line. The small headings are worse: 'main h2' carries the site's own
   h2 leading (36px, under a 13px label) and an INHERITED value cannot beat a
   rule that matches, so the parts had to say it themselves.

   Unitless on purpose. That is the whole fix: every size field on every block
   now gets leading in proportion to the size an owner picked, on screen and on
   paper alike. --po-doc-leading is the Document style block's Line spacing field;
   the fallbacks below are what each part reads best at, and the parts that want
   a little more air (the notice, the small print) keep it. */
.po-doc-head, .po-doc-intro, .po-doc-lead, .po-doc-parties, .po-doc-shipto,
.po-doc-lines, .po-doc-totals, .po-doc-note, .po-doc-terms, .po-doc-notes,
.po-doc-notice, .po-doc-approval, .po-doc-rule,
.po-doc-h1, .po-doc-h2 { line-height: var(--po-doc-leading, 1.4); }

/* ---------------------------------------------------------------------------
   Heading
   --------------------------------------------------------------------------- */
.po-doc-head { display: flex; flex-wrap: wrap; gap: 1.5rem; justify-content: space-between; align-items: flex-start; padding-bottom: 1rem; border-bottom: 1px solid var(--color-border); }
.po-doc-head.po-doc-head-accent { padding-bottom: 1.25rem; border-bottom: var(--po-doc-rule-w, 3px) solid var(--po-doc-accent, var(--color-border)); }
.po-doc-head.po-doc-head-flat { padding-bottom: 0.5rem; border-bottom: 0; }
.po-doc-head.po-doc-swap { flex-direction: row-reverse; }
.po-doc-head.po-doc-swap .po-doc-meta { text-align: left; margin-left: 0; margin-right: auto; }
.po-doc-head.po-doc-swap .po-doc-facts { justify-content: start; }
.po-doc-meta { text-align: right; margin-left: auto; }
.po-doc-h1 { font-size: var(--po-doc-title-size, 1.5rem); line-height: 1.1; margin: 0 0 0.5rem; color: var(--po-doc-title-ink, var(--color-text)); }
.po-doc-h1.po-doc-title-sm { font-size: var(--po-doc-title-size, 1.25rem); }
.po-doc-h1.po-doc-title-lg { font-size: var(--po-doc-title-size, 2rem); }
.po-doc-h1.po-doc-title-xl { font-size: var(--po-doc-title-size, 2.75rem); }
.po-doc-h2 { font-size: var(--po-doc-h2-size, 0.9375rem); margin: 0 0 0.375rem; color: var(--po-doc-label, var(--color-text)); }
.po-doc-h2.po-doc-h2-caps { font-size: var(--po-doc-h2-size, 0.8125rem); text-transform: uppercase; letter-spacing: 0.04em; color: var(--po-doc-label, var(--color-text-muted)); }
.po-doc-facts { display: grid; grid-template-columns: auto auto; gap: 0.125rem 0.75rem; margin: 0; font-size: var(--po-doc-facts-size, 0.875rem); justify-content: end; }
/* Each label-and-value pair is wrapped so a row with no value can be dropped
   whole rather than as two loose children of the grid - which is what leaves a
   gap on the page. display: contents keeps the pair as two grid cells. */
.po-doc-facts .po-doc-fact { display: contents; }
.po-doc-facts dt { color: var(--color-text-muted); }
.po-doc-facts dd { margin: 0; color: var(--color-text); font-variant-numeric: tabular-nums; }
.po-doc-facts.po-doc-facts-stack { display: block; text-align: right; line-height: var(--po-doc-leading, 1.5); }
.po-doc-facts.po-doc-facts-stack .po-doc-fact { display: block; }
.po-doc-facts.po-doc-facts-stack dt { display: inline; }
.po-doc-facts.po-doc-facts-stack dd { display: inline; }
.po-doc-facts.po-doc-facts-stack dt::after { content: ' '; white-space: pre; }
.po-doc-lead { margin: 0 0 0.375rem; font-weight: 700; font-size: var(--po-doc-lead-size, 1rem); color: var(--po-doc-title-ink, var(--color-text)); font-variant-numeric: tabular-nums; }
/* The revision flag. An amended order and the one it replaces carry the same
   number, so this is the only thing on the page telling a goods-in desk which
   sheet is the live one. */
.po-doc-rev { display: inline-block; margin-left: 0.5rem; padding: 0.0625rem 0.375rem; border: 1px solid var(--po-doc-accent, var(--color-border)); border-radius: var(--po-doc-radius, 0); font-size: 0.75em; font-weight: 600; vertical-align: middle; color: var(--po-doc-accent, var(--color-text)); }
.po-doc-intro { margin: 1rem 0 0; font-size: var(--po-doc-intro-size, inherit); color: var(--color-text); }

/* ---------------------------------------------------------------------------
   Who it is between, and where it is going
   --------------------------------------------------------------------------- */
.po-doc-parties { margin: var(--po-doc-gap, 1.5rem) 0 0; display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.po-doc-parties.po-doc-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.po-doc-parties.po-doc-party-one { display: block; }
.po-doc-parties.po-doc-party-centre { text-align: center; }
.po-doc-parties.po-doc-party-right { text-align: right; }
.po-doc-party address { font-style: normal; display: grid; gap: 0.125rem; color: var(--color-text); font-size: var(--po-doc-party-size, 0.9375rem); }
.po-doc-party .po-doc-strong { font-weight: 600; }
.po-doc-reg { margin: 0.5rem 0 0; display: grid; gap: 0.125rem; font-size: var(--po-doc-reg-size, 0.8125rem); color: var(--color-text-muted); }
/* Where the goods actually go, which on a drop-shipped order is neither party's
   own address and is the single most misread line on a purchase order. */
.po-doc-shipto { margin: var(--po-doc-gap, 1.5rem) 0 0; font-size: var(--po-doc-party-size, 0.9375rem); color: var(--color-text); }
.po-doc-shipto.po-doc-shipto-panel { padding: var(--po-doc-notice-pad, 0.875rem) calc(var(--po-doc-notice-pad, 0.875rem) * 1.3); background: var(--po-doc-panel-bg, var(--color-bg-subtle)); border-radius: var(--po-doc-radius, 0); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.po-doc-shipto.po-doc-shipto-outline { padding: var(--po-doc-notice-pad, 0.875rem) calc(var(--po-doc-notice-pad, 0.875rem) * 1.3); border: 1px solid var(--po-doc-accent, var(--color-border)); border-radius: var(--po-doc-radius, 0); }
.po-doc-shipto address { font-style: normal; display: grid; gap: 0.125rem; }
.po-doc-shipto .po-doc-strong { font-weight: 600; }
.po-doc-instructions { margin: 0.5rem 0 0; font-size: var(--po-doc-instructions-size, 0.8125rem); color: var(--color-text-muted); }

/* ---------------------------------------------------------------------------
   The lines
   --------------------------------------------------------------------------- */
/* 'font-size: inherit' on the cells is load-bearing, not tidying. globals.css
   styles bare 'td' for the site's own tables, font size included, and an element
   selector beats a size INHERITED from the table above it - so the items block's
   row size moved the <table> and every cell on the page carried on at the site's
   table size. It looked exactly like a field that did nothing. */
.po-doc-lines { width: 100%; border-collapse: collapse; margin: var(--po-doc-gap, 1.5rem) 0 0; font-size: var(--po-doc-row-size, 0.9375rem); }
.po-doc-lines th { background: transparent; text-align: left; padding: 0.5rem 0.5rem 0.5rem 0; border-bottom: 1px solid var(--color-border); color: var(--po-doc-thead-ink, var(--color-text-muted)); font-weight: 600; font-size: var(--po-doc-thead-size, 0.8125rem); text-transform: uppercase; letter-spacing: 0.02em; }
.po-doc-lines td { padding: var(--po-doc-row-y, 0.625rem) 0.5rem var(--po-doc-row-y, 0.625rem) 0; border-bottom: 1px solid var(--color-border-subtle, var(--color-border)); vertical-align: top; color: var(--color-text); font-size: inherit; }
.po-doc-lines th:last-child, .po-doc-lines td:last-child { padding-right: 0; }
.po-doc-lines.po-doc-thead-fill th { background: var(--po-doc-thead-bg, var(--color-bg-subtle)); padding: var(--po-doc-thead-pad-y, 0.625rem) var(--po-doc-thead-pad-x, 0.75rem); border-bottom: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.po-doc-lines.po-doc-thead-fill th:first-child { padding-left: var(--po-doc-thead-pad-x, 0.75rem); border-radius: var(--po-doc-thead-radius, var(--po-doc-radius, 0)) 0 0 var(--po-doc-thead-radius, var(--po-doc-radius, 0)); }
.po-doc-lines.po-doc-thead-fill th:last-child { padding-right: var(--po-doc-thead-pad-x, 0.75rem); border-radius: 0 var(--po-doc-thead-radius, var(--po-doc-radius, 0)) var(--po-doc-thead-radius, var(--po-doc-radius, 0)) 0; }
.po-doc-lines.po-doc-thead-fill.po-doc-thead-round-all th { border-radius: var(--po-doc-thead-radius, var(--po-doc-radius, 0)); }
.po-doc-lines.po-doc-thead-fill td:first-child { padding-left: var(--po-doc-thead-pad-x, 0.75rem); }
.po-doc-lines.po-doc-thead-fill td:last-child { padding-right: var(--po-doc-thead-pad-x, 0.75rem); }
.po-doc-lines.po-doc-thead-plain th { text-transform: none; letter-spacing: normal; }
/* Shaded off a class the renderer counts off the LINE, not off nth-child: a
   line that charges for delivery prints as two rows, and counting rows would
   flip the stripe halfway down it and leave every line after it inverted. */
.po-doc-lines.po-doc-zebra tbody tr.po-doc-alt td { background: var(--po-doc-zebra-bg, var(--color-bg-subtle)); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.po-doc-lines.po-doc-zebra tbody tr td:first-child { border-radius: var(--po-doc-row-radius, 0) 0 0 var(--po-doc-row-radius, 0); }
.po-doc-lines.po-doc-zebra tbody tr td:last-child { border-radius: 0 var(--po-doc-row-radius, 0) var(--po-doc-row-radius, 0) 0; }
/* The two rows of one line are one shaded block: the goods row keeps the top
   corners and loses the bottom ones, the delivery row the other way about. */
.po-doc-lines.po-doc-zebra tbody tr.po-doc-row-open td:first-child { border-radius: var(--po-doc-row-radius, 0) 0 0 0; }
.po-doc-lines.po-doc-zebra tbody tr.po-doc-row-open td:last-child { border-radius: 0 var(--po-doc-row-radius, 0) 0 0; }
.po-doc-lines.po-doc-zebra tbody tr.po-doc-row-cont td:first-child { border-radius: 0 0 0 var(--po-doc-row-radius, 0); }
.po-doc-lines.po-doc-zebra tbody tr.po-doc-row-cont td:last-child { border-radius: 0 0 var(--po-doc-row-radius, 0) 0; }
/* A line and its delivery are one line on the sheet: no rule between them, and
   the delivery sits tight under the goods rather than a full row's air away. */
.po-doc-lines tbody tr.po-doc-row-open td { border-bottom: 0; padding-bottom: 0; }
.po-doc-lines tbody tr.po-doc-row-cont td { padding-top: 0.25rem; }
.po-doc-lines.po-doc-rows-none td { border-bottom: 0; }
.po-doc-lines.po-doc-rows-none tbody tr:last-child td { border-bottom: 1px solid var(--color-border); }
/* Three of the site's own table rules reach into the document and beat what the
   rules above say, because a bare element selector still outranks a value that
   was merely INHERITED, and app/globals.css styles tables for the site's own
   content:

    - 'tr:last-child td { border-bottom: none }' outranks '.po-doc-lines td'
      (two elements and a pseudo-class against one class and an element), so the
      rule that closes the table never printed at all.
    - bare 'th' carries the site's subtle fill, and nothing above says anything
      about a heading's background, so a head set to "Ruled underneath" came out
      on a grey band anyway.
    - 'tbody tr:hover' lit the rows up under the pointer on the document page. A
      printed document is not a data table somebody is picking a row out of.

   Each is answered at the specificity it takes to win and no more, so the items
   block's own filled band, its zebra shading and its "rules under the last row
   only" all still outrank these. */
.po-doc-lines tbody tr:last-child td { border-bottom: 1px solid var(--color-border-subtle, var(--color-border)); }
.po-doc-lines tbody tr:hover { background: transparent; }
.po-doc-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.po-doc-name { display: block; font-weight: 500; }
/* NO display here. This is a TABLE CELL - it was a span under the description
   before it earned a column of its own - and display:block takes a cell out
   of its row, which prints as a stray white box sitting under the codes rather
   than as a column of them. */
.po-doc-sku { font-size: var(--po-doc-sku-size, 0.8125rem); color: var(--color-text-muted); }
/* The delivery figures sit in a ROW of their own with the service name, so they
   line up with it whatever the description above did - a name that wrapped onto
   a second line used to leave its own money stranded a line above it. */
.po-doc-num-sub { display: block; font-size: var(--po-doc-detail-size, 0.8125rem); font-weight: 400; color: var(--color-text-muted); }
/* Qualified with the cell, because the td rule above colours every cell and
   would otherwise out-specify this and print the delivery in full goods black. */
.po-doc-lines td.po-doc-service { font-size: var(--po-doc-detail-size, 0.8125rem); color: var(--color-text-muted); }
.po-doc-detail { list-style: none; margin: 0.25rem 0 0; padding: 0; display: grid; gap: 0.125rem; font-size: var(--po-doc-detail-size, 0.8125rem); color: var(--color-text-muted); }
.po-doc-detail span { font-weight: 500; }
/* A cancelled quantity is struck through rather than removed: the line still has
   receipts and invoices hanging off it, and a supplier holding the earlier
   revision needs to see which line changed. */
.po-doc-cancelled { display: block; font-size: var(--po-doc-sku-size, 0.8125rem); color: var(--color-text-muted); text-decoration: line-through; }
.po-doc-empty { color: var(--color-text-muted); padding: 1.25rem 0; }

/* ---------------------------------------------------------------------------
   Totals
   --------------------------------------------------------------------------- */
.po-doc-totals { display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 1.5rem; margin: 1.25rem 0 0; margin-left: auto; max-width: 22rem; font-size: var(--po-doc-totals-size, 0.9375rem); }
.po-doc-totals dt { color: var(--color-text-muted); }
.po-doc-totals dd { margin: 0; text-align: right; color: var(--color-text); font-variant-numeric: tabular-nums; }
.po-doc-row { display: contents; }
.po-doc-grand { font-weight: 700; font-size: var(--po-doc-grand-size, 1.0625rem); color: var(--color-text); padding-top: 0.375rem; border-top: 1px solid var(--color-border); }
/* The rule is drawn on the label and on the figure, so the column gap would
   otherwise break it in two with a notch in the middle. The gap moves into the
   figure's own padding instead: same spacing, one continuous rule. */
.po-doc-totals.po-doc-total-accent { column-gap: 0; }
.po-doc-totals.po-doc-total-accent dd { padding-left: 1.5rem; }
.po-doc-totals.po-doc-total-accent .po-doc-grand { font-family: var(--po-doc-head-font, var(--h1-family, var(--font-heading, var(--font-body, inherit)))); font-size: var(--po-doc-grand-size, 1.5rem); padding-top: 0.75rem; margin-top: 0.375rem; border-top: var(--po-doc-rule-w, 2px) solid var(--po-doc-accent, var(--color-border)); color: var(--po-doc-title-ink, var(--color-text)); }
.po-doc-note { margin: 0.625rem 0 0; text-align: right; font-size: var(--po-doc-note-size, 0.8125rem); color: var(--color-text-muted); }

/* ---------------------------------------------------------------------------
   Written blocks
   --------------------------------------------------------------------------- */
.po-doc-terms, .po-doc-notes { margin: var(--po-doc-gap-lg, 1.75rem) 0 0; display: grid; gap: 0.75rem; }
.po-doc-terms.po-doc-cols-2, .po-doc-notes.po-doc-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.5rem; align-items: start; }
.po-doc-terms p { margin: 0 0 0.5rem; font-size: var(--po-doc-smallprint-size, 0.8125rem); color: var(--color-text-muted); }
.po-doc-notes p { margin: 0 0 0.5rem; font-size: var(--po-doc-notes-size, inherit); color: var(--color-text); }

.po-doc-notice { margin: var(--po-doc-gap, 1.5rem) 0 0; font-size: var(--po-doc-notice-size, 0.9375rem); line-height: var(--po-doc-leading, 1.55); color: var(--po-doc-panel-ink, var(--color-text)); }
.po-doc-notice p { margin: 0 0 0.5rem; }
.po-doc-notice p:last-child { margin-bottom: 0; }
.po-doc-notice .po-doc-notice-lead { font-weight: 700; }
.po-doc-notice.po-doc-notice-panel { padding: var(--po-doc-notice-pad, 0.875rem) calc(var(--po-doc-notice-pad, 0.875rem) * 1.3); background: var(--po-doc-panel-bg, var(--color-bg-subtle)); border-left: var(--po-doc-rule-w, 3px) solid var(--po-doc-accent, var(--color-border)); border-radius: 0 var(--po-doc-radius, 0) var(--po-doc-radius, 0) 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.po-doc-notice.po-doc-notice-outline { padding: var(--po-doc-notice-pad, 0.875rem) calc(var(--po-doc-notice-pad, 0.875rem) * 1.3); border: 1px solid var(--po-doc-accent, var(--color-border)); border-radius: var(--po-doc-radius, 0); }
.po-doc-notice.po-doc-notice-quiet { padding: 0; color: var(--color-text-muted); font-size: var(--po-doc-notice-size, 0.875rem); }

/* Authorised by, and the space to sign it. A purchase order is an instruction to
   spend somebody's money, and a supplier's credit control asks who said so. */
.po-doc-approval { margin: var(--po-doc-gap-lg, 1.75rem) 0 0; display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); font-size: var(--po-doc-approval-size, 0.875rem); color: var(--color-text); }
.po-doc-approval .po-doc-signed { font-weight: 600; }
.po-doc-approval .po-doc-signline { margin-top: 1.75rem; border-top: 1px solid var(--color-border); padding-top: 0.25rem; color: var(--color-text-muted); font-size: 0.8125rem; }

.po-doc-rule { border: 0; border-top: 1px solid var(--po-doc-rule-ink, var(--color-border)); }
.po-doc-rule.po-doc-rule-short { max-width: 6rem; margin-right: auto; }
.po-doc-rule.po-doc-rule-centre { max-width: 6rem; margin-left: auto; margin-right: auto; }

@media (max-width: 560px) {
  .po-doc-meta, .po-doc-head.po-doc-swap .po-doc-meta { text-align: left; margin-left: 0; }
  .po-doc-facts, .po-doc-head.po-doc-swap .po-doc-facts { justify-content: start; }
  .po-doc-facts.po-doc-facts-stack { text-align: left; }
  .po-doc-totals { max-width: none; }
  .po-doc-parties.po-doc-cols-2, .po-doc-terms.po-doc-cols-2, .po-doc-notes.po-doc-cols-2 { grid-template-columns: minmax(0, 1fr); }
}

/* Print and PDF. The renderer opens this page in a headless browser and prints
   it, so these rules are what the PDF actually looks like. Ink on paper: the
   token colours are overridden outright, because a viewer in dark mode would
   otherwise be handed a black page.

   Anything an owner can colour is forced through its own custom property with
   the old print colour as the fallback, so an untouched document prints exactly
   as it always did while a designed one keeps its accent rather than having it
   flattened to grey. */
@media print {
  .po-doc-head, .po-doc-parties, .po-doc-shipto, .po-doc-lines, .po-doc-totals,
  .po-doc-terms, .po-doc-notes, .po-doc-notice, .po-doc-approval { color: #111 !important; }
  .po-doc-name, .po-doc-grand, .po-doc-strong, .po-doc-facts dd, .po-doc-lines td,
  .po-doc-totals dd, .po-doc-signed { color: #111 !important; }
  .po-doc-facts dt, .po-doc-sku, .po-doc-detail, .po-doc-num-sub, .po-doc-service, .po-doc-empty, .po-doc-note, .po-doc-reg,
  .po-doc-cancelled, .po-doc-instructions, .po-doc-terms p, .po-doc-totals dt,
  .po-doc-lines th, .po-doc-signline { color: #444 !important; }
  .po-doc-h1, .po-doc-lead, .po-doc-totals.po-doc-total-accent .po-doc-grand { color: var(--po-doc-title-ink, #111) !important; }
  .po-doc-h2 { color: var(--po-doc-label, #111) !important; }
  .po-doc-h2.po-doc-h2-caps { color: var(--po-doc-label, #444) !important; }
  .po-doc-rev { color: var(--po-doc-accent, #111) !important; border-color: var(--po-doc-accent, #ccc) !important; }
  .po-doc-lines.po-doc-thead-fill th { color: var(--po-doc-thead-ink, #444) !important; background: var(--po-doc-thead-bg, transparent) !important; }
  .po-doc-notice { color: var(--po-doc-panel-ink, #111) !important; }
  .po-doc-notice.po-doc-notice-panel, .po-doc-shipto.po-doc-shipto-panel { background: var(--po-doc-panel-bg, transparent) !important; }
  .po-doc-notice.po-doc-notice-quiet { color: #444 !important; }
  .po-doc-head, .po-doc-lines th, .po-doc-lines td, .po-doc-grand, .po-doc-rule,
  .po-doc-approval .po-doc-signline { border-color: #ccc !important; }
  .po-doc-head.po-doc-head-accent,
  .po-doc-totals.po-doc-total-accent .po-doc-grand,
  .po-doc-notice.po-doc-notice-panel, .po-doc-notice.po-doc-notice-outline,
  .po-doc-shipto.po-doc-shipto-outline { border-color: var(--po-doc-accent, #ccc) !important; }
  /* After the grouped border reset above, so a divider given a colour of its own
     keeps it on paper instead of being flattened to grey. */
  .po-doc-rule { border-top-color: var(--po-doc-rule-ink, #ccc) !important; }
  .po-doc-lines { page-break-inside: auto; }
  .po-doc-lines tr { page-break-inside: avoid; page-break-after: auto; }
  /* A line and the delivery charged on it never break apart across a page. */
  .po-doc-lines tr.po-doc-row-open { page-break-after: avoid; break-after: avoid; }
  .po-doc-totals, .po-doc-terms, .po-doc-notes, .po-doc-notice, .po-doc-parties,
  .po-doc-shipto, .po-doc-approval { page-break-inside: avoid; }
}
`
