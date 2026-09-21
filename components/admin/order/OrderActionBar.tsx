'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { Field, input, linkButton, muted } from '../ui'

/**
 * Everything that can be DONE to an order, in one bar that stays at the top of
 * the screen.
 *
 * It replaced buttons on seven different cards: Edit at the foot of the page,
 * Email halfway down, Book goods in on one card and Enter a bill on another.
 * Nobody could say what an order's next move was without scrolling the length
 * of it. Now the screen builds ONE list of actions and this draws it - the one
 * thing to do next as the solid button, the everyday ones beside it, and the
 * rare or drastic ones under More.
 *
 * What stays on the cards is what cannot leave them: a file picker beside the
 * document it files, a reference box beside its Save, "Stop it" on the row of
 * the link it stops. Those are fields with a button attached, not actions on the
 * order.
 */
export type BarAction = {
  key: string
  label: string
  /** `primary` is the one thing to do next - the screen passes at most one.
   *  `secondary` is a button beside it. `menu` lives under More. */
  placement: 'primary' | 'secondary' | 'menu'
  danger?: boolean
  disabled?: boolean
  /** Why it is disabled, or what it does where the label cannot say. */
  title?: string
  onClick?: () => void
  /** A link instead of a button: a page to go to, or a file to fetch. */
  href?: string
  /** Opens beside the order rather than over it. */
  newTab?: boolean
  /** A plain anchor rather than a router link - for a download, which is not a
   *  page and must not be prefetched as one. */
  external?: boolean
}

export type BarNote = {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  /** Always showing, and said to be needed. Otherwise it hides behind a link
   *  until somebody wants it. */
  required?: boolean
}

type Props = {
  backHref: string
  backLabel: string
  title: string
  /** Sits after the title: the revision, where there has been more than one. */
  titleSuffix?: string | null
  badge?: ReactNode
  /** Supplier and total - enough to know which order this is without scrolling
   *  back up to find out. */
  subtitle?: ReactNode
  actions: BarAction[]
  note?: BarNote | null
  error: string | null
  success: string | null
  onDismiss: () => void
}

// The only stylesheet in this module's admin, and only because inline styles
// cannot do either of the two things it is for: a hover, and a breakpoint. On a
// phone the everyday buttons fold into More, or a sticky bar four rows deep
// would be most of the screen.
const BAR_CSS = [
  '.po-bar-item { display: block; width: 100%; text-align: left; padding: 0.5rem 0.75rem; border: none;',
  '  background: none; color: var(--color-text); font: inherit; font-size: var(--text-sm); cursor: pointer;',
  '  text-decoration: none; border-radius: 6px; }',
  '.po-bar-item:hover:not(:disabled), .po-bar-item:focus-visible { background: var(--color-bg-subtle); text-decoration: none; }',
  '.po-bar-item:disabled { opacity: 0.5; cursor: not-allowed; }',
  '.po-bar-item--danger { color: var(--color-danger); }',
  '.po-bar-narrow { display: none; }',
  '@media (max-width: 720px) {',
  '  .po-bar-wide { display: none !important; }',
  '  .po-bar-narrow { display: block; }',
  '}',
].join('\n')

function BarButton({ action, className }: { action: BarAction; className: string }) {
  if (action.href && !action.disabled) {
    const shared = {
      className,
      title: action.title,
      ...(action.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
    }
    return action.external || action.newTab ? (
      <a href={action.href} {...shared}>
        {action.label}
      </a>
    ) : (
      <Link href={action.href} {...shared}>
        {action.label}
      </Link>
    )
  }
  return (
    <button type="button" className={className} title={action.title} disabled={action.disabled} onClick={action.onClick}>
      {action.label}
    </button>
  )
}

export function OrderActionBar({
  backHref, backLabel, title, titleSuffix, badge, subtitle, actions, note, error, success, onDismiss,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Closed by a click anywhere else and by Escape, which is what every menu on
  // every other screen does and therefore what a hand expects of this one.
  useEffect(() => {
    if (!menuOpen) return
    function onDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const primary = actions.filter((a) => a.placement === 'primary')
  const secondary = actions.filter((a) => a.placement === 'secondary')
  const menu = actions.filter((a) => a.placement === 'menu')
  const showNote = Boolean(note) && (note!.required || noteOpen || note!.value !== '')

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        // The same expression the page itself is painted with, so the bar is
        // opaque over whatever scrolls under it and invisible against the page.
        background: 'var(--color-page-bg, var(--color-bg))',
        borderBottom: '1px solid var(--color-border)',
        padding: '0.75rem 0',
        marginBottom: '1rem',
      }}
    >
      <style>{BAR_CSS}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <Link href={backHref} style={{ ...muted, textDecoration: 'none' }}>
            ← {backLabel}
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            {/* Smaller than a page title usually is: this one stays on screen. */}
            <h1 className="page-title" style={{ margin: 0, fontSize: 'var(--text-xl)', lineHeight: 1.3 }}>
              {title}
            </h1>
            {titleSuffix && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{titleSuffix}</span>}
            {badge}
          </div>
          {subtitle && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{subtitle}</div>}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
          {note && !showNote && (
            <button type="button" style={{ ...linkButton, fontSize: 'var(--text-sm)' }} onClick={() => setNoteOpen(true)}>
              Add a note
            </button>
          )}
          {secondary.map((action) => (
            <BarButton key={action.key} action={action} className="btn btn-secondary po-bar-wide" />
          ))}
          {primary.map((action) => (
            <BarButton key={action.key} action={action} className="btn btn-primary" />
          ))}
          {(menu.length > 0 || secondary.length > 0) && (
            // With nothing of its own to hold, More exists only to catch the
            // everyday buttons when they fold away on a phone.
            <div ref={menuRef} style={{ position: 'relative' }} className={menu.length === 0 ? 'po-bar-narrow' : undefined}>
              <button
                type="button"
                className="btn btn-secondary"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                More ▾
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 0.25rem)',
                    minWidth: 260,
                    padding: '0.25rem',
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 10,
                    boxShadow: 'var(--shadow-md)',
                  }}
                  // Any choice closes it. On the container rather than on each
                  // item so a link, which has no onClick of ours, closes it too.
                  onClick={() => setMenuOpen(false)}
                >
                  {secondary.map((action) => (
                    <div key={action.key} role="none" className="po-bar-narrow">
                      <BarButton action={action} className="po-bar-item" />
                    </div>
                  ))}
                  {menu.map((action) => (
                    <div key={action.key} role="none">
                      <BarButton action={action} className={action.danger ? 'po-bar-item po-bar-item--danger' : 'po-bar-item'} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showNote && note && (
        <div style={{ marginTop: '0.75rem', maxWidth: 720 }}>
          <Field label={note.required ? `${note.label} (needed)` : note.label} hint={note.hint}>
            <input style={input} value={note.value} onChange={(e) => note.onChange(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      )}

      {/* In the bar rather than under it: whatever went wrong was caused by a
          button up here, and the person who pressed it may be looking at a card
          a long way down the page. */}
      {(error || success) && (
        <div
          className={error ? 'alert alert-danger' : 'alert alert-success'}
          role={error ? 'alert' : 'status'}
          style={{ margin: '0.75rem 0 0', display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start' }}
        >
          <span>{error ?? success}</span>
          <button type="button" style={{ ...linkButton, color: 'inherit', flexShrink: 0 }} onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
