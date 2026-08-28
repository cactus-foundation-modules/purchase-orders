'use client'

import { useCallback, useEffect, useState } from 'react'
import type {
  PoCatalogueImportPreview,
  PoCatalogueItem,
  PoCatalogueReconciliation,
  PoPriceBasis,
  PoSupplier,
  PoSupplierCatalogue,
} from '@/modules/purchase-orders/lib/types'
import { card, Field, formatWhen, input, linkButton, Money, muted, table, td, tdRight, th, thRight } from './ui'

// Suppliers' own price lists: what is on file, what a spreadsheet would change,
// and where the shop and the supplier disagree.
//
// The import always previews first. A price list REPLACES what was there - that
// is the point of it - so the one thing this screen must never do is swap a
// supplier's prices for whatever was in the last file somebody clicked.

type ShopCatalogue = { id: string; supplierId: string; name: string; sheetUrl: string | null }

/** Which row the headings are on and which column is which, as the screen sends
 *  it: positions, because two columns can be headed the same thing and a
 *  position never is. -1 says the file has no such column. Null for the whole
 *  thing leaves the list to be read the way it always was. */
type MappingChoice = { headerRow: number | null; columns: Record<string, number> }

/** The fields a price list can carry, in the order somebody would fill them in,
 *  and in words rather than in field names. The code is the only one an import
 *  cannot do without - everything else is a column plenty of suppliers simply
 *  do not send. */
const FIELD_LABELS: { field: string; label: string; hint?: string }[] = [
  { field: 'supplierSku', label: 'Their product code', hint: 'The one that goes on the order. Required.' },
  { field: 'description', label: 'Description' },
  { field: 'unitCost', label: 'Price' },
  { field: 'packSize', label: 'Pack size' },
  { field: 'minimumOrderQty', label: 'Smallest order' },
  { field: 'leadTimeDays', label: 'Lead time in days' },
  { field: 'discountGroup', label: 'Discount group' },
  { field: 'discontinued', label: 'No longer sold' },
]

type Form = {
  supplierId: string
  name: string
  sourceUrl: string
  shopCatalogueId: string
  currency: string
  priceBasis: PoPriceBasis
  effectiveFrom: string
  notes: string
}

const EMPTY_FORM: Form = {
  supplierId: '',
  name: '',
  sourceUrl: '',
  shopCatalogueId: '',
  currency: 'GBP',
  priceBasis: 'NET',
  effectiveFrom: '',
  notes: '',
}

/** What the basis field means for THIS supplier, rather than in the abstract.
 *  A discount nobody has recorded is the case worth naming: the setting would
 *  otherwise look like it was doing something and quietly not be. */
function basisHint(supplier: PoSupplier | undefined): string {
  const discount = supplier?.discountPercent
  if (discount == null || Number(discount) <= 0) {
    return 'Pick "retail" where the list quotes the price a customer would pay. Nothing comes off until you record a discount against the supplier - there is no figure to take off yet.'
  }
  return `Pick "retail" where the list quotes the price a customer would pay: ${Number(discount)}% comes off every price as it is imported. Pick "what you pay" for a trade list that is already net.`
}

const FINDING_LABELS: Record<PoCatalogueReconciliation['findings'][number]['kind'], string> = {
  UNKNOWN_CODE: 'Not in the list',
  DISCONTINUED: 'No longer sold',
  PRICE_MOVED: 'Price has moved',
}

export function CataloguesScreen({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const [catalogues, setCatalogues] = useState<PoSupplierCatalogue[]>([])
  const [suppliers, setSuppliers] = useState<PoSupplier[]>([])
  const [shopCatalogues, setShopCatalogues] = useState<ShopCatalogue[]>([])
  const [hasCatalogue, setHasCatalogue] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState<Form | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [openId, setOpenId] = useState<string | null>(null)
  const [items, setItems] = useState<PoCatalogueItem[]>([])
  const [itemTerm, setItemTerm] = useState('')

  const [preview, setPreview] = useState<PoCatalogueImportPreview | null>(null)
  const [previewFor, setPreviewFor] = useState<string | null>(null)
  /** The file somebody chose, kept so the same text can be read again with
   *  different columns and then imported. A list fetched from its address is
   *  never held here - the server reads it again, and the fingerprint on the
   *  preview is what proves it read the same thing. */
  const [previewCsv, setPreviewCsv] = useState<string | null>(null)
  const [previewFromLink, setPreviewFromLink] = useState(false)
  /** The columns this preview was worked out with, so importing repeats it. */
  const [previewMapping, setPreviewMapping] = useState<MappingChoice | null>(null)
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<string | null>(null)

  const [checkSupplierId, setCheckSupplierId] = useState('')
  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState<PoCatalogueReconciliation | null>(null)

  const refresh = useCallback(
    (supplierId?: string) =>
      fetch(`/api/m/purchase-orders/admin/catalogues${supplierId ? `?supplierId=${encodeURIComponent(supplierId)}` : ''}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) {
            setCatalogues(data.catalogues ?? [])
            setSuppliers(data.suppliers ?? [])
            setShopCatalogues(data.shopCatalogues ?? [])
            setHasCatalogue(Boolean(data.capabilities?.hasCatalogue))
          }
          setLoaded(true)
        })
        .catch(() => setLoaded(true)),
    [],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  function startEdit(catalogue?: PoSupplierCatalogue) {
    setError(null)
    setPreview(null)
    if (!catalogue) {
      setEditingId(null)
      setForm({ ...EMPTY_FORM, supplierId: suppliers[0]?.id ?? '' })
      void refresh(suppliers[0]?.id)
      return
    }
    setEditingId(catalogue.id)
    setForm({
      supplierId: catalogue.supplierId,
      name: catalogue.name,
      sourceUrl: catalogue.sourceUrl ?? '',
      shopCatalogueId: catalogue.shopCatalogueId ?? '',
      currency: catalogue.currency,
      priceBasis: catalogue.priceBasis,
      effectiveFrom: catalogue.effectiveFrom ?? '',
      notes: catalogue.notes ?? '',
    })
    void refresh(catalogue.supplierId)
  }

  async function save() {
    if (!form || saving) return
    setSaving(true)
    setError(null)
    try {
      const picked = shopCatalogues.find((c) => c.id === form.shopCatalogueId) ?? null
      const body = {
        supplierId: form.supplierId,
        name: form.name,
        // Picking one of shop's catalogues brings its address across, so nobody
        // keeps the same link in two places and then keeps them in step by hand.
        sourceUrl: (form.sourceUrl.trim() || picked?.sheetUrl || '') || null,
        shopCatalogueId: form.shopCatalogueId || null,
        shopCatalogueName: picked?.name ?? null,
        currency: form.currency,
        priceBasis: form.priceBasis,
        effectiveFrom: form.effectiveFrom || null,
        notes: form.notes.trim() || null,
      }
      const url = editingId
        ? `/api/m/purchase-orders/admin/catalogues/${editingId}`
        : '/api/m/purchase-orders/admin/catalogues'
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not save that list.')
        return
      }
      setForm(null)
      setEditingId(null)
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  async function remove(catalogue: PoSupplierCatalogue) {
    setError(null)
    const res = await fetch(`/api/m/purchase-orders/admin/catalogues/${catalogue.id}`, { method: 'DELETE' })
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Could not delete that list.')
      return
    }
    if (openId === catalogue.id) setOpenId(null)
    await refresh()
  }

  const openItems = useCallback(
    (catalogueId: string, term: string) =>
      fetch(`/api/m/purchase-orders/admin/catalogues/${catalogueId}?q=${encodeURIComponent(term)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => setItems(data?.items ?? []))
        .catch(() => setItems([])),
    [],
  )

  useEffect(() => {
    if (!openId) return
    const timer = setTimeout(() => void openItems(openId, itemTerm), 250)
    return () => clearTimeout(timer)
  }, [openId, itemTerm, openItems])

  async function chooseFile(catalogueId: string, file: File | null) {
    if (!file) return
    await askFirst(catalogueId, { csv: await file.text(), fromLink: false }, null)
  }

  /**
   * Fetch the list from the address on it rather than taking an upload.
   *
   * The server hands the text back with the comparison, and that same text is
   * what gets applied - so the prices somebody agreed to are the prices they
   * read about, even if the supplier edits the sheet in between.
   */
  async function importFromLink(catalogueId: string) {
    await askFirst(catalogueId, { fromLink: true }, null)
  }

  async function askFirst(
    catalogueId: string,
    body: { csv?: string; fromLink: boolean },
    mapping: MappingChoice | null,
  ) {
    setError(null)
    setImported(null)
    setPreview(null)
    setImporting(true)
    try {
      const res = await fetch(`/api/m/purchase-orders/admin/catalogues/${catalogueId}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, apply: false, mapping }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Could not read that price list.')
        return
      }
      setPreview(data.preview ?? null)
      setPreviewFor(catalogueId)
      setPreviewCsv(body.csv ?? null)
      setPreviewFromLink(body.fromLink)
      setPreviewMapping(mapping)
      if (data.refused) setError(data.refused)
    } finally {
      setImporting(false)
    }
  }

  /** Read the same list again with different columns. The file somebody chose is
   *  read from what the browser still has; a list from an address is fetched
   *  again, which is what happens on the import as well. */
  async function readAgain(mapping: MappingChoice | null) {
    if (!previewFor || importing) return
    if (!previewFromLink && previewCsv == null) return
    await askFirst(previewFor, previewFromLink ? { fromLink: true } : { csv: previewCsv!, fromLink: false }, mapping)
  }

  async function applyImport() {
    if (!previewFor || importing) return
    if (!previewFromLink && previewCsv == null) return
    setImporting(true)
    setError(null)
    try {
      const res = await fetch(`/api/m/purchase-orders/admin/catalogues/${previewFor}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csv: previewFromLink ? undefined : previewCsv,
          fromLink: previewFromLink,
          apply: true,
          mapping: previewMapping,
          // The version of the list this comparison was worked out from. A list
          // read from its address is read again to import it, and a supplier who
          // has edited it in between gets a fresh comparison rather than a swap.
          expectFingerprint: preview?.fingerprint ?? null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.refused) {
        setError(data.error ?? data.refused ?? 'Could not import that file.')
        if (data.preview) setPreview(data.preview)
        return
      }
      setImported(`${data.preview?.itemCount ?? 0} prices are now on file.`)
      setPreview(null)
      setPreviewCsv(null)
      setPreviewFor(null)
      setPreviewFromLink(false)
      setPreviewMapping(null)
      await refresh()
      if (openId) await openItems(openId, itemTerm)
    } finally {
      setImporting(false)
    }
  }

  async function check() {
    if (!checkSupplierId || checking) return
    setChecking(true)
    setError(null)
    setReport(null)
    try {
      const res = await fetch(
        `/api/m/purchase-orders/admin/catalogues/reconcile?supplierId=${encodeURIComponent(checkSupplierId)}`,
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error ?? 'Could not run that comparison.')
        return
      }
      setReport(data.reconciliation ?? null)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Catalogues</h1>
        {canEdit && suppliers.length > 0 && (
          <button onClick={() => startEdit()} className="btn btn-primary">
            New price list
          </button>
        )}
      </div>

      {!enabled && (
        <div style={{ ...card, borderColor: 'var(--color-warning)' }}>
          <strong>Price lists are switched off.</strong>
          <p style={{ margin: '0.5rem 0 0', color: 'var(--color-text-secondary)' }}>
            Everything here still works, and you can get a supplier&apos;s list on file ready. Nothing will be priced off
            it until you turn &ldquo;Price orders off suppliers&apos; own price lists&rdquo; on in Settings &rsaquo;
            Purchase Orders. Until then an order line is drafted at what the product says it costs, exactly as before.
          </p>
        </div>
      )}

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}
      {imported && (
        <div className="alert alert-success" style={{ marginBottom: '1rem' }}>
          {imported}
        </div>
      )}

      {loaded && suppliers.length === 0 && (
        <p style={{ color: 'var(--color-text-secondary)' }}>
          Add a supplier first. A price list belongs to somebody you buy from.
        </p>
      )}

      {catalogues.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Supplier</th>
                <th style={th}>List</th>
                <th style={thRight}>Prices</th>
                <th style={th}>Last imported</th>
                <th style={th}>From</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {catalogues.map((c) => (
                <tr key={c.id}>
                  <td style={td}>{c.supplierName}</td>
                  <td style={td}>
                    {c.name}
                    {c.priceBasis === 'RETAIL' && <div style={muted}>Retail prices, less your discount</div>}
                    {c.effectiveFrom && <div style={muted}>Applies from {c.effectiveFrom}</div>}
                    {c.notes && <div style={muted}>{c.notes}</div>}
                  </td>
                  <td style={tdRight}>{c.itemCount.toLocaleString('en-GB')}</td>
                  <td style={td}>
                    {c.lastImportedAt ? formatWhen(c.lastImportedAt) : <span style={muted}>Never</span>}
                  </td>
                  <td style={td}>
                    {c.shopCatalogueName ? (
                      <span>
                        {c.shopCatalogueName}
                        <div style={muted}>Your shop&apos;s catalogue list</div>
                      </span>
                    ) : c.sourceUrl ? (
                      <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener">
                        Where it came from
                      </a>
                    ) : (
                      <span style={muted}>Uploaded</span>
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => {
                        setOpenId(openId === c.id ? null : c.id)
                        setItemTerm('')
                      }}
                      style={linkButton}
                    >
                      {openId === c.id ? 'Hide prices' : 'Prices'}
                    </button>
                    {canEdit && (
                      <>
                        {c.sourceUrl && (
                          <button
                            onClick={() => void importFromLink(c.id)}
                            style={{ ...linkButton, marginLeft: '0.75rem' }}
                            disabled={importing}
                            title={`Read the list straight from ${c.shopCatalogueName ?? 'the address on file'}`}
                          >
                            Import
                          </button>
                        )}
                        <label style={{ ...linkButton, marginLeft: '0.75rem' }}>
                          {c.sourceUrl ? 'Upload instead' : 'Import'}
                          <input
                            type="file"
                            accept=".csv,text/csv,text/plain"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              void chooseFile(c.id, e.target.files?.[0] ?? null)
                              e.target.value = ''
                            }}
                          />
                        </label>
                        <button onClick={() => startEdit(c)} style={{ ...linkButton, marginLeft: '0.75rem' }}>
                          Edit
                        </button>
                        <button
                          onClick={() => remove(c)}
                          style={{ ...linkButton, marginLeft: '0.75rem', color: 'var(--color-danger)' }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loaded && catalogues.length === 0 && suppliers.length > 0 && (
        <p style={{ color: 'var(--color-text-secondary)' }}>
          No price lists on file. Add one, then import the supplier&apos;s spreadsheet against it - from the address it
          lives at, or a file you have. A column of codes and a column of prices is enough, and the headers can say
          whatever they already say.
        </p>
      )}

      {preview && (
        <ImportPreview
          preview={preview}
          busy={importing}
          onApply={applyImport}
          onReadAgain={readAgain}
          onCancel={() => setPreview(null)}
        />
      )}

      {openId && (
        <div style={{ ...card, marginTop: '1rem' }}>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Prices</h2>
            <input
              style={{ ...input, maxWidth: 260 }}
              value={itemTerm}
              onChange={(e) => setItemTerm(e.target.value)}
              placeholder="Find a code or a description"
              aria-label="Search this price list"
            />
          </div>
          {items.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>Nothing to show.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Code</th>
                    <th style={th}>Description</th>
                    <th style={thRight}>Cost</th>
                    <th style={thRight}>Pack</th>
                    <th style={thRight}>Min order</th>
                    <th style={thRight}>Lead time</th>
                    <th style={th}>Group</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td style={td}>
                        {item.supplierSku}
                        {item.discontinued && <div style={{ ...muted, color: 'var(--color-warning)' }}>No longer sold</div>}
                      </td>
                      <td style={td}>{item.description || <span style={muted}>—</span>}</td>
                      <td style={tdRight}>{item.unitCost == null ? '—' : <Money value={item.unitCost} />}</td>
                      <td style={tdRight}>{item.packSize == null ? '—' : Number(item.packSize)}</td>
                      <td style={tdRight}>{item.minimumOrderQty == null ? '—' : Number(item.minimumOrderQty)}</td>
                      <td style={tdRight}>{item.leadTimeDays == null ? '—' : `${item.leadTimeDays} days`}</td>
                      <td style={td}>{item.discountGroup ?? <span style={muted}>—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ ...muted, marginTop: '0.5rem' }}>
                The first two hundred that match. Search to narrow it down.
              </p>
            </div>
          )}
        </div>
      )}

      {form && (
        <div style={{ ...card, marginTop: '1rem', maxWidth: 720 }}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>
            {editingId ? 'Edit price list' : 'New price list'}
          </h2>
          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <Field label="Supplier">
              <select
                style={input}
                value={form.supplierId}
                onChange={(e) => {
                  setForm({ ...form, supplierId: e.target.value, shopCatalogueId: '' })
                  void refresh(e.target.value)
                }}
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name" hint='What the supplier calls it - "Seating 2026", "Trade price list".'>
              <input style={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            {hasCatalogue && (
              <Field
                label="One of your shop's catalogues"
                hint="Optional. Your shop already keeps a list of each supplier's catalogues; picking one here brings its address across, so Import can read that list rather than asking you for a file."
              >
                <select
                  style={input}
                  value={form.shopCatalogueId}
                  onChange={(e) => setForm({ ...form, shopCatalogueId: e.target.value })}
                >
                  <option value="">Not from one</option>
                  {shopCatalogues.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field
              label="Where it lives"
              hint="A web address. Import will read the list straight from here, so it wants to point at the spreadsheet itself - a Google Sheet has to be shared so that anyone with the link can view it."
            >
              <input
                style={input}
                value={form.sourceUrl}
                onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
                placeholder="https://…"
              />
            </Field>
            <Field label="Currency">
              <input
                style={input}
                maxLength={3}
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="The prices on it are" hint={basisHint(suppliers.find((s) => s.id === form.supplierId))}>
              <select
                style={input}
                value={form.priceBasis}
                onChange={(e) => setForm({ ...form, priceBasis: e.target.value as PoPriceBasis })}
              >
                <option value="NET">What you pay</option>
                <option value="RETAIL">Retail, less your discount</option>
              </select>
            </Field>
            <Field label="Applies from">
              <input
                type="date"
                style={input}
                value={form.effectiveFrom}
                onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              />
            </Field>
          </div>
          <div style={{ marginTop: '0.75rem' }}>
            <Field label="Notes" hint="For you. Nothing here goes to the supplier.">
              <textarea rows={2} style={input} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button onClick={save} className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save price list'}
            </button>
            <button
              onClick={() => {
                setForm(null)
                setEditingId(null)
              }}
              className="btn btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ ...card, marginTop: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: 'var(--text-lg)' }}>Check the shop against a supplier&apos;s list</h2>
        <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
          Every product your shop files under that supplier, matched against the codes on their current lists. It changes
          nothing - it tells you which codes have gone, which they have stopped selling, and where their price and yours
          have drifted apart.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 240 }}>
            <Field label="Supplier">
              <select style={input} value={checkSupplierId} onChange={(e) => setCheckSupplierId(e.target.value)}>
                <option value="">Pick one</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button className="btn btn-secondary" onClick={check} disabled={!checkSupplierId || checking}>
            {checking ? 'Checking…' : 'Check'}
          </button>
        </div>

        {report && (
          <div style={{ marginTop: '1rem' }}>
            <p style={{ margin: '0 0 0.75rem' }}>
              {report.productCount.toLocaleString('en-GB')} products under {report.supplierName},{' '}
              {report.matchedCount.toLocaleString('en-GB')} of them on a price list.{' '}
              {report.unsoldCodeCount > 0 &&
                `${report.unsoldCodeCount.toLocaleString('en-GB')} codes on their lists that you do not sell.`}
            </p>
            {report.findings.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--color-success)' }}>Nothing to look at.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={table}>
                  <thead>
                    <tr>
                      <th style={th}>What</th>
                      <th style={th}>Product</th>
                      <th style={th}>Code</th>
                      <th style={thRight}>Ours</th>
                      <th style={thRight}>Theirs</th>
                      <th style={th}>Says</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.findings.slice(0, 200).map((finding) => (
                      <tr key={`${finding.kind}-${finding.productId}`}>
                        <td style={td}>{FINDING_LABELS[finding.kind]}</td>
                        <td style={td}>{finding.productName}</td>
                        <td style={td}>{finding.code}</td>
                        <td style={tdRight}>{finding.ourCost == null ? '—' : <Money value={finding.ourCost} />}</td>
                        <td style={tdRight}>{finding.theirCost == null ? '—' : <Money value={finding.theirCost} />}</td>
                        <td style={td}>{finding.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.findings.length > 200 && (
                  <p style={{ ...muted, marginTop: '0.5rem' }}>
                    {report.findings.length.toLocaleString('en-GB')} things to look at. The first two hundred are shown.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * What the file would do, before it does it.
 *
 * Counts first and the lines underneath, because a range refresh routinely runs
 * to hundreds of changes and the useful question is "how many, of what kind"
 * rather than "which four hundred".
 */
function ImportPreview({
  preview,
  busy,
  onApply,
  onReadAgain,
  onCancel,
}: {
  preview: PoCatalogueImportPreview
  busy: boolean
  onApply: () => void
  onReadAgain: (mapping: MappingChoice | null) => void
  onCancel: () => void
}) {
  const counts = preview.changeCounts
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const columns = Object.entries(preview.columns).filter(([, header]) => header)

  return (
    <div style={{ ...card, marginTop: '1rem', borderColor: 'var(--color-primary)' }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: 'var(--text-lg)' }}>
        {preview.itemCount.toLocaleString('en-GB')} prices for {preview.catalogueName}
      </h2>

      <p style={{ margin: '0 0 0.75rem', color: 'var(--color-text-secondary)' }}>
        Importing replaces this list entirely. Anything on it that is not in what has just been read goes.
      </p>

      <p style={{ ...muted, marginBottom: '0.75rem' }}>
        {preview.source === 'LINK' ? (
          <>
            Read from{' '}
            {preview.sourceUrl ? (
              <a href={preview.sourceUrl} target="_blank" rel="noreferrer noopener">
                the address on this list
              </a>
            ) : (
              'the address on this list'
            )}
            .
          </>
        ) : (
          'Read from the file you chose.'
        )}{' '}
        {preview.priceBasis === 'RETAIL' &&
          (preview.discountApplied
            ? `These are retail prices, so ${Number(preview.discountApplied)}% has come off every one of them. The figures below are what you pay.`
            : 'This list is marked as retail, but there is no discount on file for this supplier - the prices below are exactly as they arrived.')}
      </p>

      {columns.length > 0 && (
        <p style={{ ...muted, marginBottom: '0.75rem' }}>
          {preview.headerRow > 1 && `Headings taken from row ${preview.headerRow}. `}
          Read as:{' '}
          {columns
            .map(([field, header]) => `${header} → ${FIELD_LABELS.find((f) => f.field === field)?.label ?? field}`)
            .join(', ')}
          .
        </p>
      )}

      <ColumnPicker
        key={`${preview.fingerprint}-${preview.headerRow}`}
        preview={preview}
        busy={busy}
        onReadAgain={onReadAgain}
      />

      {total > 0 && (
        <ul style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem' }}>
          {counts.RENAMED > 0 && (
            <li>
              <strong>{counts.RENAMED} renamed</strong> - the same thing has arrived under a new code. Anything you sell
              under the old one needs pointing at the new one.
            </li>
          )}
          {counts.DISCONTINUED > 0 && <li>{counts.DISCONTINUED} marked as no longer sold</li>}
          {counts.REPRICED > 0 && <li>{counts.REPRICED} at a different price</li>}
          {counts.ADDED > 0 && <li>{counts.ADDED} new</li>}
          {counts.REMOVED > 0 && <li>{counts.REMOVED} not in the new file at all</li>}
          {counts.RESTORED > 0 && <li>{counts.RESTORED} being sold again</li>}
        </ul>
      )}

      {(preview.blankRows > 0 || preview.duplicateRows > 0) && (
        <p style={{ ...muted, marginBottom: '0.75rem' }}>
          {preview.blankRows > 0 && `${preview.blankRows} blank rows skipped. `}
          {preview.duplicateRows > 0 && `${preview.duplicateRows} rows repeated a code and said the same thing.`}
        </p>
      )}

      {preview.problemCount > 0 && (
        <div style={{ marginBottom: '0.75rem' }}>
          <strong>{preview.problemCount.toLocaleString('en-GB')} rows could not be read:</strong>
          <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem' }}>
            {preview.problems.slice(0, 20).map((problem) => (
              <li key={`${problem.row}-${problem.message}`} style={muted}>
                Row {problem.row}: {problem.message}
              </li>
            ))}
          </ul>
          {preview.problemCount > preview.problems.slice(0, 20).length && (
            <p style={muted}>
              …and {(preview.problemCount - preview.problems.slice(0, 20).length).toLocaleString('en-GB')} more. If that
              is most of the file, the columns below are pointing at the wrong things.
            </p>
          )}
        </div>
      )}

      {preview.changes.length > 0 && (
        <details style={{ marginBottom: '0.75rem' }}>
          <summary style={{ cursor: 'pointer' }}>See the changes one by one</summary>
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
            {preview.changes.map((change) => (
              <li key={`${change.kind}-${change.supplierSku}`} style={muted}>
                {change.message}
              </li>
            ))}
          </ul>
          {total > preview.changes.length && (
            <p style={muted}>…and {total - preview.changes.length} more, all of them counted above.</p>
          )}
        </details>
      )}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="btn btn-primary" onClick={onApply} disabled={busy || preview.itemCount === 0}>
          {busy ? 'Importing…' : 'Import these prices'}
        </button>
        <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Leave it alone
        </button>
      </div>
    </div>
  )
}

/**
 * Saying which row the headings are on, and which column is which.
 *
 * A supplier's spreadsheet is an export from something else, and exports are not
 * tidy: a title, a blank line, a row of merged group headings, and then the real
 * headings on row four with eighty-nine columns after them, three of which are
 * any use. The import works that out for itself and is right most of the time.
 * This is for the rest of the time, and for the case it cannot possibly get
 * right - a sheet carrying both "SKU" and "Catalogue Code", where which one goes
 * on the purchase order is a matter of fact about the supplier and not about the
 * file.
 *
 * Remounted whenever a new preview arrives - see the `key` on it - so what is in
 * the dropdowns is always what was actually read, rather than what somebody was
 * in the middle of picking two previews ago.
 */
function ColumnPicker({
  preview,
  busy,
  onReadAgain,
}: {
  preview: PoCatalogueImportPreview
  busy: boolean
  onReadAgain: (mapping: MappingChoice | null) => void
}) {
  const rows = preview.topRows ?? []
  const [headerRow, setHeaderRow] = useState(preview.headerRow > 0 ? preview.headerRow : 1)
  const [columns, setColumns] = useState<Record<string, number>>(() => {
    const start: Record<string, number> = {}
    for (const { field } of FIELD_LABELS) start[field] = preview.columnIndexes?.[field] ?? -1
    return start
  })

  if (rows.length === 0) return null

  const header = rows[headerRow - 1] ?? []
  // The columns to offer, which is the widest row rather than the header row:
  // a spreadsheet whose last few headings are blank still has data under them.
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  // The first row under the headings with anything in it, purely so each column
  // can be shown with an example of what is in it.
  const sample = rows.slice(headerRow).find((row) => row.some((cell) => cell !== '')) ?? []

  const columnLabel = (at: number) => {
    const name = (header[at] ?? '').trim()
    const example = (sample[at] ?? '').trim()
    const shown = name || `Column ${at + 1}`
    return example ? `${shown} — ${example}` : shown
  }

  const rowLabel = (at: number) => {
    const filled = (rows[at] ?? []).filter((cell) => cell !== '').slice(0, 4).join(', ')
    return `Row ${at + 1}${filled ? `: ${filled}` : ' (blank)'}`
  }

  return (
    <details
      // Open where the reading has plainly gone wrong - nothing came out, or
      // more rows failed than succeeded - because that is the moment somebody
      // needs this rather than the moment they go looking for it.
      open={preview.itemCount === 0 || preview.problemCount > preview.itemCount}
      style={{ marginBottom: '0.75rem' }}
    >
      <summary style={{ cursor: 'pointer' }}>Not read the way you wanted? Say which column is which</summary>
      <p style={{ ...muted, margin: '0.5rem 0 0.75rem' }}>
        Pick the row the headings are on, then point each thing at the column it lives in. Plenty of suppliers send a
        title and a row of group headings above the real ones, and plenty send two columns that could both be a code -
        this is where you say which. What you pick is kept on this list, so next month it reads itself.
      </p>

      <div style={{ maxWidth: 520, marginBottom: '0.75rem' }}>
        <Field label="The headings are on">
          <select
            style={input}
            value={headerRow}
            onChange={(e) => setHeaderRow(Number(e.target.value))}
            disabled={busy}
          >
            {rows.map((_, at) => (
              <option key={at} value={at + 1}>
                {rowLabel(at)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
        {FIELD_LABELS.map(({ field, label, hint }) => (
          <Field key={field} label={label} hint={hint}>
            <select
              style={input}
              value={columns[field] ?? -1}
              onChange={(e) => setColumns({ ...columns, [field]: Number(e.target.value) })}
              disabled={busy}
            >
              <option value={-1}>Not in this file</option>
              {Array.from({ length: width }, (_, at) => (
                <option key={at} value={at}>
                  {columnLabel(at)}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => onReadAgain({ headerRow, columns })}
        >
          {busy ? 'Reading…' : 'Read it again like this'}
        </button>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => onReadAgain({ headerRow: null, columns: {} })}
          title="Forget what this list remembers and go by the headings again"
        >
          Work it out for me
        </button>
      </div>
    </details>
  )
}
