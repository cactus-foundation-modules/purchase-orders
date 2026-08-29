'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

// The chrome the supplier's panel is drawn with: one stylesheet and one dialog.
//
// STYLESHEET, not style attributes. The panel used to be built entirely out of
// inline styles, and inline styles cannot hold a media query, a hover state or a
// ::backdrop - so on a phone in a warehouse yard the whole thing was a desktop
// table squeezed sideways. Every colour here is still one of the site's own
// tokens with a fallback behind it, because this renders inside whatever theme
// the site is wearing and the theme is not ours to assume.
//
// DIALOG, the real element. A supplier only ever needs one form at a time, so
// the line items live in modals and the page itself stays down to a row of
// buttons. It has to be <dialog> rather than a floating div: the page this
// panel sits on hides every child of <body> that is not <main> (see the public
// purchase order page), so a modal rendered through a portal into document.body
// would be styled out of existence. The top layer sidesteps that, and brings
// Escape, focus and an inert background with it.

export const PORTAL_CSS = `
.pop{box-sizing:border-box;border:1px solid var(--color-border,#ddd);border-radius:14px;background:var(--color-surface,#fff);color:var(--color-text,#111);padding:1.25rem;margin:0 0 2rem}
.pop *{box-sizing:border-box}
.pop-title{margin:0;font-size:1.25rem;line-height:1.25}
.pop-status{margin:.375rem 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:.375rem .5rem;font-size:.8125rem;color:var(--color-text-secondary,#666)}
.pop-status li{display:inline-flex;align-items:center;gap:.375rem;border:1px solid var(--color-border,#ddd);border-radius:999px;padding:.125rem .625rem}
.pop-dot{width:.5rem;height:.5rem;border-radius:50%;background:currentColor;flex:none}
.pop-dot--good{color:var(--color-success,#2f6f4f)}
.pop-dot--wait{color:var(--color-text-secondary,#666)}
.pop-intro{margin:.875rem 0 0;font-size:.875rem;color:var(--color-text-secondary,#666)}

.pop-note{margin:1rem 0 0;padding:.625rem .875rem;border:1px solid;border-radius:8px;font-size:.9375rem}
.pop-note--bad{color:var(--color-error,#b3261e);border-color:var(--color-error,#b3261e)}
.pop-note--good{color:var(--color-success,#2f6f4f);border-color:var(--color-success,#2f6f4f)}
.pop-note--quiet{color:var(--color-text-secondary,#666);border-color:var(--color-border,#ddd)}
/* Something a person here wrote to this supplier, so it reads as text rather
   than as a system message: full-strength colour, and their own line breaks. */
.pop-note--said{color:var(--color-text,#111);border-color:var(--color-primary,#2f6f4f);white-space:pre-wrap;overflow-wrap:anywhere}
.pop-note:first-child{margin-top:0}

.pop-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.75rem;margin:1.25rem 0 0;padding:0;list-style:none}
.pop-actions li{display:flex}
.pop-action{display:flex;flex-direction:column;gap:.1875rem;width:100%;height:100%;text-align:left;padding:.875rem 1rem;border:1px solid var(--color-border,#ddd);border-radius:10px;background:var(--color-bg,#fff);color:inherit;font:inherit;cursor:pointer;text-decoration:none}
.pop-action:hover{border-color:var(--color-primary,#2f6f4f);background:var(--color-primary-subtle,#eef4f1)}
.pop-action:focus-visible{outline:2px solid var(--color-primary,#2f6f4f);outline-offset:2px}
.pop-action--primary{border-color:var(--color-primary,#2f6f4f);background:var(--color-primary,#2f6f4f);color:var(--color-on-primary,#fff)}
/* The filled one keeps its fill and brightens instead. Tinting it like the
   others would drop white text onto a near-white background. */
.pop-action--primary:hover{background:var(--color-primary,#2f6f4f);filter:brightness(1.08)}
.pop-action-name{font-weight:600}
.pop-action-hint{font-size:.8125rem;color:var(--color-text-secondary,#666)}
.pop-action--primary .pop-action-hint{color:inherit;opacity:.85}

.pop-quiet{display:flex;flex-wrap:wrap;gap:.5rem;margin:1.25rem 0 0;padding:1rem 0 0;border-top:1px solid var(--color-border,#ddd)}

.pop-btn{display:inline-flex;align-items:center;justify-content:center;gap:.375rem;padding:.5625rem 1.125rem;border-radius:8px;border:1px solid var(--color-primary,#2f6f4f);background:var(--color-primary,#2f6f4f);color:var(--color-on-primary,#fff);font:inherit;font-weight:600;line-height:1.35;text-decoration:none;cursor:pointer}
.pop-btn:hover:not(:disabled){filter:brightness(1.08)}
.pop-btn:disabled{opacity:.45;cursor:not-allowed}
.pop-btn:focus-visible{outline:2px solid var(--color-primary,#2f6f4f);outline-offset:2px}
.pop-btn--quiet{background:transparent;color:var(--color-text,#111);border-color:var(--color-border,#ddd);font-weight:500}
.pop-btn--quiet:hover:not(:disabled){background:var(--color-primary-subtle,#eef4f1);border-color:var(--color-primary,#2f6f4f);filter:none}
.pop-btn--small{padding:.375rem .8125rem;font-size:.875rem}

.pop-field{margin:0 0 1rem}
.pop-field:last-child{margin-bottom:0}
.pop-label{display:block;font-size:.8125rem;font-weight:600;margin:0 0 .3125rem}
.pop-input,.pop-textarea,.pop-file{display:block;width:100%;padding:.5rem .625rem;border:1px solid var(--color-border,#ddd);border-radius:8px;background:var(--color-bg,#fff);color:var(--color-text,#111);font:inherit}
.pop-textarea{resize:vertical;min-height:6.5rem}
.pop-file{padding:.4375rem;border-style:dashed;cursor:pointer}
.pop-hint{margin:.3125rem 0 0;font-size:.75rem;color:var(--color-text-secondary,#666)}

/* The drop box. A supplier with a PDF of their acknowledgement open in another
   window drags it here; everyone else presses the picker sitting in the middle
   of it. Big on purpose - a 2rem file input is a target nobody finds in a
   warehouse yard, and it is the one thing on this dialog we actually want. */
.pop-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.625rem;text-align:center;min-height:11rem;padding:1.5rem 1rem;border:2px dashed var(--color-border,#ddd);border-radius:12px;background:var(--color-bg,#fff);cursor:pointer}
.pop-drop:hover{border-color:var(--color-primary,#2f6f4f);background:var(--color-primary-subtle,#eef4f1)}
.pop-drop--over{border-color:var(--color-primary,#2f6f4f);background:var(--color-primary-subtle,#eef4f1)}
.pop-drop:focus-within{outline:2px solid var(--color-primary,#2f6f4f);outline-offset:2px}
.pop-drop-icon{color:var(--color-text-secondary,#666)}
.pop-drop-say{margin:0;font-size:.9375rem;font-weight:600}
.pop-drop-hint{margin:0;font-size:.75rem;color:var(--color-text-secondary,#666)}
/* The picker itself, in the middle of the box rather than stretched across it. */
.pop-drop .pop-file{width:auto;max-width:100%;border-style:solid;background:var(--color-surface,#fff)}
.pop-drop-name{margin:0;font-size:.875rem;font-weight:600;overflow-wrap:anywhere;color:var(--color-success,#2f6f4f)}
.pop-row{display:flex;flex-wrap:wrap;gap:1rem;margin:0 0 1rem;align-items:flex-start}
.pop-row .pop-field{flex:1 1 11rem;margin:0}

.pop-lines{list-style:none;margin:0;padding:0;border-top:1px solid var(--color-border,#ddd)}
/* A floor under the description column, not minmax(0,1fr): with a tick in
   front of it, a long product name in a narrow dialog was shrinking to one
   character per line rather than wrapping at words. Below 520px the whole row
   stacks anyway, so the floor can never overflow. */
.pop-line{display:grid;grid-template-columns:minmax(7rem,1fr) auto;gap:.5rem 1rem;align-items:center;padding:.75rem 0;border-bottom:1px solid var(--color-border,#ddd)}
.pop-line--stack{grid-template-columns:minmax(0,1fr)}
.pop-line-name{font-weight:500;overflow-wrap:anywhere}
.pop-line-meta{margin:.125rem 0 0;font-size:.8125rem;color:var(--color-text-secondary,#666);overflow-wrap:anywhere}
.pop-tick{display:flex;align-items:flex-start;gap:.625rem;cursor:pointer;min-width:0}
/* The same tick outside a line row, where it has to bring its own spacing. */
.pop-tick--own{align-items:center;padding:.25rem 0}
.pop-picker{margin:.625rem 0 0;border:1px solid var(--color-border,#ddd);border-radius:8px}
.pop-picker>summary{padding:.5rem .75rem;cursor:pointer;font-size:.875rem;font-weight:600;border-radius:8px}
.pop-picker>summary:focus-visible{outline:2px solid var(--color-primary,#2f6f4f);outline-offset:2px}
.pop-lines--picker{max-height:15rem;overflow-y:auto;padding:0 .75rem;border-top:0}
.pop-lines--picker .pop-line:last-child{border-bottom:0}
.pop-tick input{flex:none;width:1.125rem;height:1.125rem;margin:.0625rem 0 0;accent-color:var(--color-primary,#2f6f4f)}
.pop-input--qty{width:6rem;text-align:right}
/* A box that has been told it is wrong, and the line under it that says so.
   The quantity column is right-aligned, so the sentence hangs off the same
   edge - and it wraps rather than widening the column, which on a phone is the
   difference between a readable row and a horizontal scrollbar. */
.pop-input--wrong{border-color:var(--color-error,#b3261e)}
.pop-qty{display:flex;flex-direction:column;align-items:flex-end;gap:.25rem;max-width:14rem}
.pop-qty-say{font-size:.75rem;line-height:1.3;text-align:right;color:var(--color-text-secondary,#666)}
.pop-qty-say--wrong{color:var(--color-error,#b3261e)}
.pop-input--date{width:10.5rem}
.pop-tools{display:flex;flex-wrap:wrap;gap:.5rem;margin:.875rem 0 1.25rem}
.pop-empty{margin:0;color:var(--color-text-secondary,#666)}
/* Who a history line came from, said before the line says anything else. Two
   tints rather than one, because "we paid your proforma" and "you sent your
   proforma" sit a day apart in the same list. */
.pop-who{display:inline-block;margin:0 .5rem .125rem 0;padding:.0625rem .5rem;border-radius:999px;font-size:.6875rem;font-weight:700;letter-spacing:.02em;text-transform:uppercase;vertical-align:.05em;border:1px solid}
.pop-who--us{color:var(--color-primary,#2f6f4f);border-color:var(--color-primary,#2f6f4f);background:var(--color-primary-subtle,#eef4f1)}
.pop-who--them{color:var(--color-text-secondary,#666);border-color:var(--color-border,#ddd);background:var(--color-bg,#fff)}

.pop-dialog{box-sizing:border-box;width:min(46rem,calc(100vw - 2rem));max-height:calc(100vh - 2rem);max-height:calc(100dvh - 2rem);padding:0;overflow:hidden;border:1px solid var(--color-border,#ddd);border-radius:14px;background:var(--color-surface,#fff);color:var(--color-text,#111);font:inherit}
.pop-dialog *{box-sizing:border-box}
.pop-dialog[open]{display:flex;flex-direction:column}
.pop-dialog::backdrop{background:rgb(0 0 0 / .62)}
.pop-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1.125rem 1.25rem;border-bottom:1px solid var(--color-border,#ddd)}
.pop-dialog-title{margin:0;font-size:1.125rem;line-height:1.3}
.pop-dialog-intro{margin:.375rem 0 0;font-size:.875rem;color:var(--color-text-secondary,#666)}
.pop-dialog-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:1.25rem}
.pop-dialog-body .pop-note{margin:0 0 1.25rem}
.pop-dialog-foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.5rem;padding:1rem 1.25rem;border-top:1px solid var(--color-border,#ddd)}
.pop-x{flex:none;padding:.375rem;margin:-.375rem;border:0;border-radius:6px;background:none;color:var(--color-text-secondary,#666);line-height:0;cursor:pointer}
.pop-x:focus-visible{outline:2px solid var(--color-primary,#2f6f4f);outline-offset:2px}

@media (max-width:600px){
  .pop{padding:1rem;border-radius:12px}
  .pop-dialog{width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:100dvh;margin:0;border:0;border-radius:0}
  .pop-dialog-foot .pop-btn{flex:1 1 9rem}
}
@media (max-width:520px){
  .pop-line{grid-template-columns:minmax(0,1fr)}
  .pop-input--date{width:100%}
  /* Stacked, the quantity box and its sentence read left to right like the rest
     of the row rather than hugging an edge that is no longer there. */
  .pop-qty{align-items:flex-start;max-width:none}
  .pop-qty-say{text-align:left}
}
/* Nobody needs a printed page with a "yes, we can supply this" button on it. */
@media print{.pop{display:none}}
`

export function PortalStyles() {
  return <style dangerouslySetInnerHTML={{ __html: PORTAL_CSS }} />
}

function PaperclipIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17V3M12 3l-4 4M12 3l4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  )
}

/** A big box to drop a file into, with the ordinary file picker sat in the
 *  middle of it.
 *
 *  The picker is still a plain <input type="file"> with the caller's own ref on
 *  it, because everything that reads the chosen file - the preflight, the
 *  upload - reads it off that input. Dropping a file assigns dataTransfer.files
 *  straight onto it, so the two routes in are the same route out. */
export function PortalDrop({ id, inputRef, accept, say, hint }: {
  id: string
  inputRef: React.RefObject<HTMLInputElement | null>
  accept: string
  /** The line above the picker, in the supplier's words. */
  say: string
  /** The small print under it: which file types, usually. */
  hint?: ReactNode
}) {
  const [name, setName] = useState<string | null>(null)
  const [over, setOver] = useState(false)

  return (
    <div
      className={over ? 'pop-drop pop-drop--over' : 'pop-drop'}
      // Anywhere on the box opens the picker, EXCEPT the picker itself - it
      // opens on its own, and clicking it through here would ask twice.
      onClick={(e) => {
        if (e.target !== inputRef.current) inputRef.current?.click()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const dropped = e.dataTransfer?.files?.[0]
        const input = inputRef.current
        if (!dropped || !input) return
        // One file, whatever they dragged: the server takes one, and a supplier
        // dragging a folder's worth of PDFs meant the first of them either way.
        const one = new DataTransfer()
        one.items.add(dropped)
        input.files = one.files
        setName(dropped.name)
      }}
    >
      <span className="pop-drop-icon">
        <PaperclipIcon />
      </span>
      <p className="pop-drop-say">{say}</p>
      <input
        id={id}
        ref={inputRef}
        type="file"
        className="pop-file"
        accept={accept}
        onChange={(e) => setName(e.target.files?.[0]?.name ?? null)}
      />
      {name ? <p className="pop-drop-name">{name}</p> : hint ? <p className="pop-drop-hint">{hint}</p> : null}
    </div>
  )
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

type DialogProps = {
  title: string
  intro?: ReactNode
  onClose: () => void
  children: ReactNode
  /** The buttons along the bottom. Cancel is drawn here, so a caller only passes
   *  the one that does something. */
  footer?: ReactNode
  closeLabel?: string
}

export function PortalDialog({ title, intro, onClose, children, footer, closeLabel = 'Close' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  // The close callback through a ref, so the effect can run exactly once. Tied
  // to the callback itself it would re-run on every parent render, and each run
  // would shut and reopen the dialog - which loses whatever the supplier had
  // focused mid-sentence.
  const closer = useRef(onClose)
  useEffect(() => {
    closer.current = onClose
  })

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    const shut = () => closer.current()
    dialog.addEventListener('close', shut)
    // A modal dialog does not stop the page behind it scrolling, and a form on a
    // phone that scrolls the order underneath it is a form nobody finishes.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      dialog.removeEventListener('close', shut)
      if (dialog.open) dialog.close()
      document.body.style.overflow = previous
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className="pop-dialog"
      aria-labelledby={titleId}
      // A click that lands on the dialog element itself landed on the backdrop -
      // everything inside it is a child. Same as clicking away from any panel.
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close()
      }}
    >
      <div className="pop-dialog-head">
        <div>
          <h3 className="pop-dialog-title" id={titleId}>
            {title}
          </h3>
          {intro && <p className="pop-dialog-intro">{intro}</p>}
        </div>
        {/* First in the DOM on purpose: showModal() focuses the first thing it
            can, and a text box would open the keyboard on every phone. */}
        <button type="button" className="pop-x" aria-label={closeLabel} onClick={() => ref.current?.close()}>
          <CloseIcon />
        </button>
      </div>

      <div className="pop-dialog-body">{children}</div>

      <div className="pop-dialog-foot">
        <button type="button" className="pop-btn pop-btn--quiet" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        {footer}
      </div>
    </dialog>
  )
}

/** One row of an order in a dialog: what it is on the left, the one box they
 *  have to fill on the right, and both stacked once the screen is a phone. */
export function PortalLine({ name, meta, control, tick }: {
  name: ReactNode
  meta?: ReactNode
  control?: ReactNode
  /** A checkbox that turns the line on. Given one, the name and the meta become
   *  part of its <label>, so the whole description is a tap target - which is
   *  what a warehouse on a phone actually presses at. */
  tick?: ReactNode
}) {
  const body = (
    <div>
      <div className="pop-line-name">{name}</div>
      {meta && <div className="pop-line-meta">{meta}</div>}
    </div>
  )
  return (
    <li className={control ? 'pop-line' : 'pop-line pop-line--stack'}>
      {tick ? (
        <label className="pop-tick">
          {tick}
          {body}
        </label>
      ) : (
        body
      )}
      {control}
    </li>
  )
}
