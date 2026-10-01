'use client'

import { muted } from '../ui'

/**
 * The warnings standing on a proforma that arrived by email, and the tick that
 * answers them.
 *
 * Shown wherever a proforma can be marked paid - the proforma card and the
 * payment step - because a "revised" proforma with new bank details is the
 * commonest invoice fraud there is, and an email cannot prove who sent it. The
 * server refuses the payment until the box is ticked, and records who ticked
 * it; this only makes the question impossible to miss.
 */
export function BankDetailsCheck({
  warnings,
  checked,
  onChange,
  disabled = false,
}: {
  warnings: readonly string[]
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  if (warnings.length === 0) return null
  return (
    <div className="alert alert-warning" role="alert" style={{ marginBottom: '0.75rem' }}>
      {warnings.map((warning) => (
        <p key={warning} style={{ margin: '0 0 0.5rem' }}>
          {warning}
        </p>
      ))}
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          style={{ marginTop: '0.2rem' }}
        />
        <span>
          I have checked the bank details on this proforma with the supplier, on a number we already hold
          <span style={{ ...muted, display: 'block', fontWeight: 400 }}>
            Needed before it can be marked paid. Your name goes in the order&apos;s history against it.
          </span>
        </span>
      </label>
    </div>
  )
}
