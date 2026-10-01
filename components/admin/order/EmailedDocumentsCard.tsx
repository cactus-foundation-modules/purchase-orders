'use client'

import Link from 'next/link'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { card, formatDay, muted, table, td } from '../ui'
import type { EmailedDocument } from './shared'

const KIND_LABELS: Record<EmailedDocument['filedAs'], string> = {
  proforma: 'Their proforma',
  acknowledgement: 'Their acknowledgement',
  invoice: 'Their invoice',
}

/**
 * What was filed on this order from a supplier's email, and where it came from.
 *
 * A document a machine filed has to be able to answer "where did this come
 * from?" without anybody going hunting: each row says which email, on what
 * day, links straight to the conversation, and says so when something about it
 * wants a look - their proforma coming to a different figure from the order,
 * most of all.
 */
export function EmailedDocumentsCard({ documents, billsBase }: { documents: EmailedDocument[]; billsBase: string }) {
  const adminPath = useAdminPath()
  if (documents.length === 0) return null

  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>Filed from their email</h2>
      <table style={table}>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id}>
              <td style={td}>
                {KIND_LABELS[doc.filedAs]}
                {doc.supplierRef && <div style={muted}>Their reference {doc.supplierRef}</div>}
              </td>
              <td style={td}>
                {doc.file ? (
                  <a href={doc.file.url} target="_blank" rel="noreferrer">
                    {doc.file.originalName ?? 'Open it'}
                  </a>
                ) : doc.billId ? (
                  <span style={muted}>No file kept</span>
                ) : (
                  <span style={muted}>The file is not in the library any more</span>
                )}
                {doc.billId && (
                  <div>
                    <Link href={`${billsBase}/${doc.billId}`} style={{ color: 'var(--color-primary)' }}>
                      The draft bill
                    </Link>
                  </div>
                )}
                <div style={muted}>
                  {doc.threadId ? (
                    <a
                      href={`/${adminPath}/inbox?tab=unified-inbox&id=${encodeURIComponent(doc.threadId)}`}
                      style={{ color: 'var(--color-primary)' }}
                    >
                      From an email{doc.receivedAt ? ` on ${formatDay(doc.receivedAt)}` : ''}
                    </a>
                  ) : (
                    <>From an email{doc.receivedAt ? ` on ${formatDay(doc.receivedAt)}` : ''}</>
                  )}
                  {doc.fromAddress ? ` from ${doc.fromAddress}` : ''}
                  {doc.byPerson ? ', filed by hand' : ''}
                </div>
                {doc.flag && (
                  <div style={{ marginTop: '0.25rem', color: 'var(--color-warning)', fontWeight: 600 }}>
                    {doc.flag}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
