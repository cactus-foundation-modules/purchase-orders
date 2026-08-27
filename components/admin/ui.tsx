'use client'

import type { CSSProperties, ReactNode } from 'react'
import {
  PO_BILL_STATUS_LABELS, PO_MATCH_STATUS_LABELS, PO_RETURN_STATUS_LABELS, PO_STATUS_LABELS,
  type PoBillStatus, type PoMatchStatus, type PoReturnStatus, type PoStatus,
} from '@/modules/purchase-orders/lib/types'

// The chrome every purchasing screen shares. Colours are semantic tokens
// throughout: a hardcoded hex in module chrome is a defect on this platform, and
// all of this is read in both light and dark mode.

export const card: CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  background: 'var(--color-surface)',
  padding: '1rem',
  marginBottom: '1rem',
}

export const input: CSSProperties = {
  padding: '0.375rem 0.625rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  font: 'inherit',
  width: '100%',
}

export const table: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--text-sm)',
}

export const th: CSSProperties = {
  padding: '0.625rem 0.75rem',
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  borderBottom: '1px solid var(--color-border)',
  whiteSpace: 'nowrap',
}

export const thRight: CSSProperties = { ...th, textAlign: 'right' }

export const td: CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid var(--color-border)',
  verticalAlign: 'top',
}

/** Money columns are tabular so the digits line up down the page. */
export const tdRight: CSSProperties = {
  ...td,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

export const muted: CSSProperties = {
  color: 'var(--color-text-secondary)',
  fontSize: 'var(--text-xs)',
}

export const linkButton: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-primary)',
  padding: 0,
  font: 'inherit',
}

/**
 * Which badge a status wears.
 *
 * Only the two that genuinely want attention get a colour of their own -
 * awaiting approval, and anything that has stopped. Colouring all ten trains
 * people to ignore the colour by the time it means something.
 */
const STATUS_TONE: Record<PoStatus, 'default' | 'primary' | 'success' | 'warning' | 'error'> = {
  DRAFT: 'default',
  AWAITING_APPROVAL: 'warning',
  APPROVED: 'primary',
  SENT: 'primary',
  ACKNOWLEDGED: 'primary',
  PART_RECEIVED: 'warning',
  RECEIVED: 'success',
  CLOSED: 'default',
  CANCELLED: 'error',
  ON_HOLD: 'warning',
}

const TONE_STYLE: Record<string, CSSProperties> = {
  default: { background: 'var(--color-bg-subtle)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' },
  primary: { background: 'var(--color-primary-subtle)', color: 'var(--color-primary)', border: '1px solid var(--color-primary-border)' },
  success: { background: 'var(--color-success-bg)', color: 'var(--color-success)' },
  warning: { background: 'var(--color-warning-bg)', color: 'var(--color-warning)' },
  error: { background: 'var(--color-error-bg)', color: 'var(--color-error)' },
}

export function StatusBadge({ status }: { status: PoStatus }) {
  return (
    <span
      style={{
        ...TONE_STYLE[STATUS_TONE[status]],
        display: 'inline-block',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 'var(--text-xs)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {PO_STATUS_LABELS[status]}
    </span>
  )
}

/**
 * The same badge for a return, off its own shorter list.
 *
 * Only two get a colour: the one waiting for money that has not arrived, and the
 * one that has been dropped. A return sitting at "credit promised" for a month is
 * the state this whole tab exists to make visible, so it wears the warning.
 */
const RETURN_TONE: Record<PoReturnStatus, 'default' | 'primary' | 'success' | 'warning' | 'error'> = {
  DRAFT: 'default',
  SENT: 'primary',
  CREDIT_EXPECTED: 'warning',
  CREDITED: 'success',
  CLOSED: 'default',
  CANCELLED: 'error',
}

export function ReturnStatusBadge({ status }: { status: PoReturnStatus }) {
  return (
    <span
      style={{
        ...TONE_STYLE[RETURN_TONE[status]],
        display: 'inline-block',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 'var(--text-xs)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {PO_RETURN_STATUS_LABELS[status]}
    </span>
  )
}

/**
 * The same badge for a supplier's invoice.
 *
 * Queried is the one that wants the eye: a bill somebody has asked a question
 * about and then forgotten is money sitting on the wrong side of an argument.
 * Approved is a good thing that has happened, and a void one is simply gone.
 */
const BILL_TONE: Record<PoBillStatus, 'default' | 'primary' | 'success' | 'warning' | 'error'> = {
  DRAFT: 'default',
  QUERIED: 'warning',
  APPROVED: 'success',
  POSTED: 'primary',
  VOID: 'error',
}

export function BillStatusBadge({ status }: { status: PoBillStatus }) {
  return (
    <span
      style={{
        ...TONE_STYLE[BILL_TONE[status]],
        display: 'inline-block',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 'var(--text-xs)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {PO_BILL_STATUS_LABELS[status]}
    </span>
  )
}

/**
 * What the three-way match made of a bill.
 *
 * "Nothing to check against" is deliberately not a warning colour. A bill with
 * no purchase order behind it is perfectly ordinary - the electricity does not
 * arrive on a PO - and painting it amber would train everybody to ignore amber
 * by the time it means something.
 */
const MATCH_TONE: Record<PoMatchStatus, 'default' | 'primary' | 'success' | 'warning' | 'error'> = {
  NOT_MATCHED: 'default',
  MATCHED: 'success',
  VARIANCE: 'warning',
}

export function MatchBadge({ status, count = 0 }: { status: PoMatchStatus; count?: number }) {
  const label =
    status === 'VARIANCE' && count > 0
      ? `${count === 1 ? 'One thing' : `${count} things`} to look at`
      : PO_MATCH_STATUS_LABELS[status]
  return (
    <span
      style={{
        ...TONE_STYLE[MATCH_TONE[status]],
        display: 'inline-block',
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 'var(--text-xs)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

/** An amount with its currency, formatted for whoever is reading it. */
export function Money({ value, currency = 'GBP' }: { value: string | null | undefined; currency?: string }) {
  const n = Number(value ?? 0)
  const text = Number.isFinite(n)
    ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(n)
    : String(value ?? '')
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</span>
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function formatWhen(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Today on the reader's wall clock, not UTC. */
export function localToday(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', marginBottom: '0.25rem', fontSize: 'var(--text-sm)' }}>{label}</span>
      {children}
      {hint && <span style={{ display: 'block', marginTop: '0.25rem', ...muted }}>{hint}</span>}
    </label>
  )
}

/**
 * The honest empty state for a tab that is switched off.
 *
 * Never a silent absence and never an error: the tab is there, it says what it
 * would do, and it names the thing that would switch it on.
 */
export function NotYet({ title, message }: { title: string; message: string }) {
  return (
    <div style={{ ...card, textAlign: 'center', padding: '2.5rem 1.25rem' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: 'var(--text-lg)' }}>{title}</h2>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 480, marginInline: 'auto' }}>{message}</p>
    </div>
  )
}
