import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TestDatabase, TestRole, VpsConfig } from '@/lib/backup/vps-database'
import { splitStatements } from '@/modules/purchase-orders/lib/sql-statements.test-support'
import { buildPdf } from '@/modules/purchase-orders/lib/pdf-fixtures.test-support'
import {
  acknowledgementPage, creditNotePage, invoicePage, proformaPage,
} from '@/modules/purchase-orders/lib/inbound-fixtures.test-support'
import type { InboundDeps } from '@/modules/purchase-orders/lib/inbound-run'

// Filing supplier paperwork from email, ACTUALLY EXECUTED against Postgres.
//
// Every statement in lib/inbound-run.ts is raw SQL - the claim with FOR UPDATE
// SKIP LOCKED, the ON CONFLICT upserts, the self-joining UPDATE that takes the
// problem report - and no other gate runs any of it. So this does, end to end:
// migration 017 applied more than once, the queue under concurrent offers of
// one email, a proforma, an acknowledgement on an unpaid proforma order, a
// daily batch of two invoices cut into two bills, one of them moving its order
// to PENDING_CLOSE, the same invoice arriving again, a run that died after
// writing a bill, and the Paperwork list's own buttons.
//
// The documents are synthetic PDFs (lib/inbound-fixtures.test-support.ts),
// RC4-encrypted like the real ones, so the splitter runs for real. The media
// library is the one thing stood in for: the database here has no storage
// behind it, so the two calls out to it (fetch the bytes, file a copy) are
// handed in, exactly as InboundDeps allows.
//
// Its own throwaway database on the self-hosted Postgres VPS (`cactus_rt_*`,
// a throwaway role, both dropped afterwards). Opt-in, same switch as the
// module's other live suites:
//
//   RUN_PO_SQL=1 vitest run modules/purchase-orders/lib/inbound-filing.live.test.ts --testTimeout 300000
const shouldRun = process.env.RUN_PO_SQL === '1'
if (shouldRun) {
  try {
    ;(process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - the guard below fails the suite loudly rather than skipping.
  }
}

const suite = shouldRun ? describe : describe.skip

// Every test here is several round trips to a database across the internet,
// and the migrations test runs every module migration twice more. The 5s
// default is for code, not for this.
if (shouldRun) vi.setConfig({ testTimeout: 120_000 })

const CORE_SQL = readFileSync(path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql'), 'utf8')
const MIGRATIONS = path.join(process.cwd(), 'modules', 'purchase-orders', 'migrations')

function migrationSql(only?: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql') && (!only || file === only))
    .sort()
    .flatMap((file) => splitStatements(readFileSync(path.join(MIGRATIONS, file), 'utf8')))
}

suite('filing supplier paperwork from email, against a real Postgres', () => {
  let cfg: VpsConfig
  let role: TestRole
  let database: TestDatabase
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const dbName = `cactus_rt_po_${stamp}`
  const roleName = `cactus_rt_role_po_${stamp}`

  type Loaded = {
    prisma: typeof import('@/lib/db/prisma')
    db: typeof import('@/modules/purchase-orders/lib/db')
    run: typeof import('@/modules/purchase-orders/lib/inbound-run')
    handler: typeof import('@/modules/purchase-orders/lib/inbound-handler')
    bills: typeof import('@/modules/purchase-orders/lib/bills')
    stage: typeof import('@/modules/purchase-orders/lib/proforma-stage')
    mediaUsage: typeof import('@/modules/purchase-orders/lib/media-usage-provider')
    proforma: typeof import('@/modules/purchase-orders/lib/proforma')
    settle: typeof import('@/modules/purchase-orders/lib/order-settle')
  }
  let mod: Loaded
  let vps: typeof import('@/lib/backup/vps-database')

  // The media library, stood in for: what the inbox "stored", and what this
  // module filed.
  const library = new Map<string, Buffer>()
  const filed: Array<{ id: string; filename: string; kind: string; orderNumber: string; bytes: Buffer }> = []
  const deps: InboundDeps = {
    download: async (mediaId) => library.get(mediaId) ?? null,
    store: async (bytes, filename, kind, orderNumber) => {
      const id = `filed-${filed.length + 1}`
      filed.push({ id, filename, kind, orderNumber, bytes })
      return id
    },
  }
  const farOff = () => Date.now() + 120_000

  const ids: Record<string, string> = {}

  async function sql<T = Record<string, unknown>>(text: string, ...values: unknown[]): Promise<T[]> {
    return mod.prisma.prisma.$queryRawUnsafe<T[]>(text, ...values)
  }

  async function row(attachmentId: string, pageFrom: number) {
    const rows = await sql(
      `SELECT * FROM "po_inbound_documents" WHERE "attachment_id" = $1 AND "page_from" = $2`,
      attachmentId,
      pageFrom,
    )
    return rows[0]
  }

  function message(id: string) {
    return {
      messageId: id,
      threadId: `thread-${id}`,
      fromAddress: 'accounts@acme.example',
      subject: `Documents ${id}`,
      sentAt: '2026-09-28T09:00:00.000Z',
    }
  }

  beforeAll(async () => {
    vps = await import('@/lib/backup/vps-database')
    cfg = vps.vpsConfigFromEnv()
    role = await vps.createTestRole(cfg, roleName)
    database = await vps.createTestDatabase(cfg, dbName, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.DIRECT_URL = database.connectionUri

    mod = {
      prisma: await import('@/lib/db/prisma'),
      db: await import('@/modules/purchase-orders/lib/db'),
      run: await import('@/modules/purchase-orders/lib/inbound-run'),
      handler: await import('@/modules/purchase-orders/lib/inbound-handler'),
      bills: await import('@/modules/purchase-orders/lib/bills'),
      stage: await import('@/modules/purchase-orders/lib/proforma-stage'),
      mediaUsage: await import('@/modules/purchase-orders/lib/media-usage-provider'),
      proforma: await import('@/modules/purchase-orders/lib/proforma'),
      settle: await import('@/modules/purchase-orders/lib/order-settle'),
    }

    for (let attempt = 0; ; attempt++) {
      try {
        await mod.prisma.prisma.$queryRawUnsafe('SELECT 1')
        break
      } catch (err) {
        if (attempt >= 15) throw err
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    for (const statement of splitStatements(CORE_SQL)) await mod.prisma.prisma.$executeRawUnsafe(statement)
    for (const statement of migrationSql()) await mod.prisma.prisma.$executeRawUnsafe(statement)
  }, 300_000)

  afterAll(async () => {
    await mod?.prisma.prisma.$disconnect().catch(() => {})
    if (!cfg) return
    if (database) await vps.dropTestDatabase(cfg, database.name).catch(() => {})
    if (role) await vps.dropTestRole(cfg, role.name).catch(() => {})
  }, 300_000)

  it('takes migration 017, and every migration, a second and third time without complaint', async () => {
    for (const statement of migrationSql('017_inbound_filing.sql')) await mod.prisma.prisma.$executeRawUnsafe(statement)
    for (const statement of migrationSql()) await mod.prisma.prisma.$executeRawUnsafe(statement)
    const check = await sql<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'po_bills_source_check'`,
    )
    expect(check).toHaveLength(1)
    expect(check[0]!.def).toContain('INBOX')
  })

  it('sets up a supplier, its extra senders, and four orders', async () => {
    const base = {
      shopSupplierId: null, shopSupplierName: null, accountNumber: null, contactName: null, phone: null,
      emailCc: null, accountsEmail: null, proformaPaidToAccounts: false, dropships: false,
      address: { line1: '', line2: '', city: '', region: '', postcode: '', country: '' },
      currency: 'GBP', paymentTerms: null, paymentTermsDays: 30, accountTerms: 'PROFORMA' as const,
      leadTimeDays: null, minimumOrderValue: null, carriagePaidOver: null, carriageCharge: null,
      surchargeThreshold: null, surchargeRates: [], discountPercent: null, defaultCategoryId: null,
      defaultVatTreatment: null, defaultVatRateCode: null, taxRegistrationNumber: null,
      deliveryInstructions: null, portalNote: null, status: 'ENABLED' as const, notes: null,
    }
    ids.acme = await mod.db.createSupplier({ ...base, name: 'Acme Supplies', email: 'orders@acme.example', inboundSenders: ['acme-billing.example'] })
    ids.other = await mod.db.createSupplier({ ...base, name: 'Other Ltd', email: 'sales@other.example', inboundSenders: [] })

    const acme = await mod.db.getSupplier(ids.acme)
    expect(acme?.inboundSenders).toEqual(['acme-billing.example'])
    await mod.db.updateSupplier(ids.acme, { ...acme!, inboundSenders: ['acme-billing.example', 'ar@books.example'] })
    expect((await mod.db.getSupplier(ids.acme))?.inboundSenders).toEqual(['acme-billing.example', 'ar@books.example'])

    const senders = await mod.run.senderSuppliers()
    expect(senders.find((s) => s.id === ids.acme)?.inboundSenders).toContain('ar@books.example')

    async function order(number: string, status: string, supplierId: string, proforma: boolean, total: string, lines: Array<[string, number, string]>) {
      const rows = await sql<{ id: string }>(
        `INSERT INTO "po_orders" ("number", "supplier_id", "status", "proforma_required", "total")
         VALUES ($1, $2, $3, $4, $5::numeric) RETURNING "id"`,
        number, supplierId, status, proforma, total,
      )
      const id = rows[0]!.id
      for (const [description, qty, cost] of lines) {
        await sql(
          `INSERT INTO "po_order_lines" ("order_id", "description", "qty", "unit_cost", "tax_rate_percent")
           VALUES ($1, $2, $3, $4::numeric, 20) RETURNING "id"`,
          id, description, qty, cost,
        )
      }
      return id
    }
    ids.po12 = await order('PO-00012', 'SENT', ids.acme, true, '150.00', [['Desk', 1, '125.00']])
    ids.po14 = await order('PO-00014', 'RECEIVED', ids.acme, false, '120.00', [['Chair', 2, '50.00']])
    ids.po15 = await order('PO-00015', 'ACKNOWLEDGED', ids.acme, false, '120.00', [['Lamp', 1, '100.00']])
    ids.po16 = await order('PO-00016', 'SENT', ids.acme, false, '60.00', [['Shelf', 1, '50.00']])
    ids.po90 = await order('PO-00090', 'SENT', ids.other, true, '99.00', [['Rug', 1, '82.50']])

    // PO-00014 has all of its goods in, so its invoice is the last thing it waits on.
    const receipt = await sql<{ id: string }>(
      `INSERT INTO "po_receipts" ("number", "order_id", "received_date") VALUES ('GRN-1', $1, '2026-09-27') RETURNING "id"`,
      ids.po14,
    )
    await sql(
      `INSERT INTO "po_receipt_lines" ("receipt_id", "order_line_id", "qty_accepted")
       SELECT $1, "id", 2 FROM "po_order_lines" WHERE "order_id" = $2`,
      receipt[0]!.id, ids.po14,
    )

    const known = await mod.run.knownOrders()
    expect(known.get('PO-00012')?.supplierId).toBe(ids.acme)
    expect(known.get('PO-00090')?.supplierName).toBe('Other Ltd')
  })

  it('queues one row per file however many offers of the email arrive at once', async () => {
    library.set('media-batch', buildPdf([invoicePage('0000900014', 'PO-00014'), invoicePage('0000900015', 'PO-00015')], { encrypt: true }))
    const offer = () =>
      mod.run.queueAttachments(message('m-batch'), [ids.acme!], [{ attachmentId: 'a-batch', filename: 'Invoices.pdf', mediaId: 'media-batch' }])
    await Promise.all([offer(), offer(), offer(), offer(), offer()])
    const rows = await sql(`SELECT * FROM "po_inbound_documents" WHERE "attachment_id" = 'a-batch'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.outcome).toBe('QUEUED')
    expect(await mod.run.anythingQueued()).toBe(true)
  })

  it('puts a file the inbox could not fetch on the list, and back in the queue when a later offer has it', async () => {
    await mod.run.queueAttachments(message('m-missing'), [ids.acme!], [{ attachmentId: 'a-missing', filename: 'Proforma.pdf', mediaId: null }])
    let missing = await row('a-missing', 0)
    expect(missing!.outcome).toBe('NEEDS_EYES')
    expect(missing!.reason).toMatch(/could not be fetched from the mail server/)

    library.set('media-proforma', buildPdf([proformaPage('PF-7701', 'PO-00012', '180.00')], { encrypt: true }))
    await mod.run.queueAttachments(message('m-missing'), [ids.acme!], [{ attachmentId: 'a-missing', filename: 'Proforma.pdf', mediaId: 'media-proforma' }])
    missing = await row('a-missing', 0)
    expect(missing!.outcome).toBe('QUEUED')
    expect(missing!.source_media_id).toBe('media-proforma')
  })

  it('queues the rest of the day’s post', async () => {
    library.set('media-ack', buildPdf([acknowledgementPage('0000123456', 'PO-00012')], { encrypt: true }))
    library.set('media-credit', buildPdf([creditNotePage('CN-55', 'PO-00015')], { encrypt: true }))
    library.set('media-theirs', buildPdf([proformaPage('PF-9', 'PO-00090')], { encrypt: true }))
    library.set('media-nopo', buildPdf([invoicePage('INV-4400', 'somebody else')], { encrypt: true }))
    await mod.run.queueAttachments(message('m-ack'), [ids.acme!], [{ attachmentId: 'a-ack', filename: 'SalesOrder.pdf', mediaId: 'media-ack' }])
    await mod.run.queueAttachments(message('m-credit'), [ids.acme!], [{ attachmentId: 'a-credit', filename: 'Credit.pdf', mediaId: 'media-credit' }])
    await mod.run.queueAttachments(message('m-theirs'), [ids.acme!], [{ attachmentId: 'a-theirs', filename: 'Proforma 9.pdf', mediaId: 'media-theirs' }])
    await mod.run.queueAttachments(message('m-nopo'), [ids.acme!], [{ attachmentId: 'a-nopo', filename: 'INV-4400.pdf', mediaId: 'media-nopo' }])
  })

  it('reads and files the lot', async () => {
    // One email's worth first, as the handler does it: the proforma, filed
    // before the acknowledgement that follows it.
    const first = await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-missing', deps })
    expect(first.filed).toBe(1)
    const result = await mod.run.runInboundQueue({ deadline: farOff(), deps })
    expect(result.waiting).toBe(false)
    expect(await mod.run.anythingQueued()).toBe(false)

    // The proforma: filed, for the amount on it, with the email's own date, and
    // flagged because it comes to more than the order.
    const proforma = await row('a-missing', 1)
    expect(proforma!.outcome).toBe('FILED')
    expect(proforma!.flag).toMatch(/£180\.00.*£150\.00/)
    const po12 = await mod.db.getOrder(ids.po12!)
    expect(po12?.proformaRef).toBe('PF-7701')
    expect(po12?.proformaAmount).toBe('180')
    expect(po12?.proformaReceivedAt?.slice(0, 10)).toBe('2026-09-28')
    expect(po12?.proformaMediaId).toBe(proforma!.filed_media_id)

    // Their sales order acknowledges it on the spot, proforma unpaid or not, and
    // the badge still says the money is owed.
    expect(po12?.status).toBe('ACKNOWLEDGED')
    expect(po12?.ackRef).toBe('0000123456')
    expect(po12?.proformaPaidAt).toBeNull()
    const listed = (await mod.db.listOrders({})).orders.find((o) => o.id === ids.po12)!
    expect(mod.stage.orderStatusLabel(listed)).toBe('Acknowledged, proforma to pay')
    expect(mod.stage.proformaWaitsOnUs(listed)).toBe(true)

    // The batch: cut into two, a DRAFT bill on each order, priced at the ORDER's
    // prices, their total beside it.
    const bills14 = await mod.bills.listBillsForOrder(ids.po14!)
    const bills15 = await mod.bills.listBillsForOrder(ids.po15!)
    expect(bills14).toHaveLength(1)
    expect(bills15).toHaveLength(1)
    const bill14 = await mod.bills.getBill(bills14[0]!.id)
    expect(bill14?.status).toBe('DRAFT')
    expect(bill14?.source).toBe('INBOX')
    expect(bill14?.supplierInvoiceNumber).toBe('0000900014')
    expect(bill14?.statedTotal).toBe('120')
    expect(bill14?.total).toBe('120')
    expect(bill14?.invoiceDate).toBe('2026-09-28')
    expect(bill14?.dueDate).toBe('2026-10-28')
    expect(bill14?.createdByUserId).toBeNull()
    expect(bill14?.attachmentNote).toBeNull()
    const cut = filed.find((f) => f.filename === 'Invoices (page 2).pdf')
    expect(cut?.orderNumber).toBe('PO-00015')

    // Nothing left to invoice on a fully received order: pending close, never closed.
    expect((await mod.db.getOrder(ids.po14!))?.status).toBe('PENDING_CLOSE')
    expect((await mod.db.getOrder(ids.po15!))?.status).toBe('ACKNOWLEDGED')

    // The ones for a person, each with its sentence.
    expect((await row('a-credit', 1))!.reason).toMatch(/credit note/i)
    expect((await row('a-theirs', 1))!.reason).toMatch(/an order to Other Ltd/)
    expect((await row('a-nopo', 1))!.reason).toMatch(/None of our purchase order numbers/)

    // And the audit names the email it came from.
    const audit = await sql<{ detail: Record<string, unknown> }>(
      `SELECT "detail" FROM "po_audit_log" WHERE "entity_id" = $1 AND "action" = 'order.invoice_from_email'`,
      ids.po14,
    )
    expect(audit[0]!.detail.message).toBe('m-batch')
  })

  it('tells the conversation where its documents went', async () => {
    expect(await mod.handler.outcomeFor('m-batch')).toEqual({
      links: [
        { moduleName: 'purchase-orders', recordType: 'purchase-order', recordId: ids.po14, label: 'Purchase order PO-00014' },
        { moduleName: 'purchase-orders', recordType: 'purchase-order', recordId: ids.po15, label: 'Purchase order PO-00015' },
      ],
      note: 'Filed on PO-00014 (invoice), PO-00015 (invoice)',
    })
    expect(await mod.handler.outcomeFor('m-credit')).toEqual({ note: 'one document is on the Paperwork list in Purchasing' })
  })

  it('never writes a second bill for one invoice', async () => {
    const before = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM "po_bills"`)

    // The same email offered again, read again: nothing new.
    await mod.run.queueAttachments(message('m-batch'), [ids.acme!], [{ attachmentId: 'a-batch', filename: 'Invoices.pdf', mediaId: 'media-batch' }])
    await mod.run.runInboundQueue({ deadline: farOff(), deps })

    // A run that died after writing the bill and before saying so, tried again.
    await sql(`UPDATE "po_inbound_documents" SET "outcome" = 'QUEUED', "handled_at" = NULL WHERE "attachment_id" = 'a-batch' AND "page_from" = 2`)
    await mod.run.runInboundQueue({ deadline: farOff(), deps })
    const retried = await row('a-batch', 2)
    expect(retried!.outcome).toBe('FILED')

    // The same invoice on a different email altogether.
    library.set('media-again', buildPdf([invoicePage('0000900015', 'PO-00015')], { encrypt: true }))
    await mod.run.queueAttachments(message('m-again'), [ids.acme!], [{ attachmentId: 'a-again', filename: 'Copy.pdf', mediaId: 'media-again' }])
    await mod.run.runInboundQueue({ deadline: farOff(), deps })
    expect((await row('a-again', 1))!.bill_id).toBe(retried!.bill_id)

    const after = await sql<{ n: bigint }>(`SELECT count(*) AS n FROM "po_bills"`)
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n))
  })

  it('lists what needs a person, with the sender’s own orders to choose from', async () => {
    const items = await mod.run.listPaperwork()
    expect(items.map((i) => i.attachmentId).sort()).toEqual(['a-credit', 'a-nopo', 'a-theirs'])
    const nopo = items.find((i) => i.attachmentId === 'a-nopo')!
    expect(nopo.supplierNames).toEqual(['Acme Supplies'])
    expect(nopo.choices.map((c) => c.number)).toContain('PO-00016')
    expect(nopo.choices.map((c) => c.number)).not.toContain('PO-00090')
    expect(await mod.run.paperworkCount()).toBe(3)
  })

  it('files by hand through the same rules, and dismisses once', async () => {
    const items = await mod.run.listPaperwork()
    const nopo = items.find((i) => i.attachmentId === 'a-nopo')!
    const credit = items.find((i) => i.attachmentId === 'a-credit')!

    // The rules still hold for a person: nothing goes on a PENDING_CLOSE order.
    const refused = await mod.run.fileManually(credit.id, { orderId: ids.po14!, kind: 'invoice', ref: 'CN-55' }, 'user-1', deps)
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/fully invoiced/) })

    const done = await mod.run.fileManually(nopo.id, { orderId: ids.po16!, kind: 'invoice', ref: null }, 'user-1', deps)
    expect(done).toEqual({ ok: true, orderNumber: 'PO-00016' })
    const bills16 = await mod.bills.listBillsForOrder(ids.po16!)
    expect(bills16).toHaveLength(1)
    expect(bills16[0]!.supplierInvoiceNumber).toBe('INV-4400')
    expect(bills16[0]!.createdByUserId).toBe('user-1')
    // Pressed twice: the second finds it already dealt with.
    expect(await mod.run.fileManually(nopo.id, { orderId: ids.po16!, kind: 'invoice', ref: null }, 'user-1', deps)).toMatchObject({ ok: false })

    expect(await mod.run.dismissPaperwork(credit.id, 'not-ours', 'user-1')).toBe(true)
    expect(await mod.run.dismissPaperwork(credit.id, 'ignore', 'user-1')).toBe(false)
    expect((await row('a-credit', 1))!.outcome).toBe('IGNORED')

    const onOrder = await mod.run.inboundForOrder(ids.po16!)
    expect(onOrder).toHaveLength(1)
    expect(onOrder[0]!.byPerson).toBe(true)
    expect(onOrder[0]!.threadId).toBe('thread-m-nopo')
  })

  it('reports each problem once, and only the real ones', async () => {
    // Acme's drafts go out by themselves: a total disagreeing with one of
    // their orders says so in the report (and nothing switches it off).
    await sql(`UPDATE "po_suppliers" SET "auto_send" = true WHERE "id" = $1`, ids.acme)
    const problems = await mod.run.takeUnreportedProblems()
    const text = problems.map((p) => `${p.what} | ${p.problem}`).join('\n')
    expect(text).toMatch(/PO-00012.*£180\.00/)
    expect(text).toMatch(/an order to Other Ltd/)
    expect(problems.find((p) => p.what.startsWith('PO-00012'))?.autoSendSupplier).toBe(true)
    expect(problems.filter((p) => !p.what.startsWith('PO-00012')).every((p) => !p.autoSendSupplier)).toBe(true)
    expect((await mod.db.getSupplier(ids.acme!))?.autoSend).toBe(true)
    await sql(`UPDATE "po_suppliers" SET "auto_send" = false WHERE "id" = $1`, ids.acme)
    expect(problems.some((p) => p.what.includes('PO-00014'))).toBe(false)
    expect(await mod.run.takeUnreportedProblems()).toEqual([])
  })

  it('vouches for every file it filed', async () => {
    const used = await mod.mediaUsage.purchaseOrdersMediaUsageProvider()
    for (const file of filed) {
      const referenced = await sql(`SELECT 1 FROM "po_inbound_documents" WHERE "filed_media_id" = $1`, file.id)
      if (referenced.length > 0) expect(used).toContain(file.id)
    }
    expect(used).toContain((await row('a-missing', 1))!.filed_media_id)
  })

  // -------------------------------------------------------------------------
  // Fix round 1
  // -------------------------------------------------------------------------

  async function newOrder(number: string, status: string, proforma: boolean, total: string, received = false) {
    const rows = await sql<{ id: string }>(
      `INSERT INTO "po_orders" ("number", "supplier_id", "status", "proforma_required", "total")
       VALUES ($1, $2, $3, $4, $5::numeric) RETURNING "id"`,
      number, ids.acme, status, proforma, total,
    )
    const id = rows[0]!.id
    await sql(
      `INSERT INTO "po_order_lines" ("order_id", "description", "qty", "unit_cost", "tax_rate_percent")
       VALUES ($1, 'Cabinet', 1, 100, 20)`,
      id,
    )
    if (received) {
      const receipt = await sql<{ id: string }>(
        `INSERT INTO "po_receipts" ("number", "order_id", "received_date") VALUES ($1, $2, '2026-09-27') RETURNING "id"`,
        `GRN-${number}`, id,
      )
      await sql(
        `INSERT INTO "po_receipt_lines" ("receipt_id", "order_line_id", "qty_accepted")
         SELECT $1, "id", 1 FROM "po_order_lines" WHERE "order_id" = $2`,
        receipt[0]!.id, id,
      )
    }
    return id
  }

  async function queueOne(messageId: string, attachmentId: string, filename: string, mediaId: string, bytes: Buffer) {
    library.set(mediaId, bytes)
    await mod.run.queueAttachments(message(messageId), [ids.acme!], [{ attachmentId, filename, mediaId }])
  }

  it('spaces its retries: a failed fetch is tried again by a later run, not three times at once', async () => {
    let fetches = 0
    const flaky: InboundDeps = {
      ...deps,
      download: async (mediaId) => {
        fetches++
        return mediaId === 'media-flaky' && fetches === 1 ? null : deps.download(mediaId)
      },
    }
    ids.po17 = await newOrder('PO-00017', 'SENT', true, '120.00')
    await queueOne('m-flaky', 'a-flaky', 'PF.pdf', 'media-flaky', buildPdf([proformaPage('PF-17', 'PO-00017')], { encrypt: true }))

    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-flaky', deps: flaky })
    let flakyRow = await row('a-flaky', 0)
    expect(flakyRow!.outcome).toBe('QUEUED')
    expect(flakyRow!.attempts).toBe(1)
    expect(flakyRow!.claimed_at).not.toBeNull()
    expect(fetches).toBe(1)

    // A second run straight away leaves it alone: the lease spaces the tries.
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-flaky', deps: flaky })
    expect((await row('a-flaky', 0))!.attempts).toBe(1)

    // Once the lease has run out, the next run reads and files it.
    await sql(`UPDATE "po_inbound_documents" SET "claimed_at" = now() - interval '11 minutes' WHERE "attachment_id" = 'a-flaky'`)
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-flaky', deps: flaky })
    flakyRow = await row('a-flaky', 0)
    expect(flakyRow!.outcome).toBe('READ')
    expect((await row('a-flaky', 1))!.outcome).toBe('FILED')
  })

  it('finishes a bill that a dead run wrote but never attached or settled', async () => {
    ids.po21 = await newOrder('PO-00021', 'RECEIVED', false, '120.00', true)
    const lines = await mod.bills.listBillableLines(ids.po21!)
    // The run that died: the bill is written, nothing after it happened.
    const billId = await mod.bills.createBill({
      supplierId: ids.acme!, orderId: ids.po21!, supplierInvoiceNumber: 'INV-99001', invoiceDate: '2026-09-28',
      dueDate: null, currency: 'GBP', fxRate: '1', subtotal: '100.00', carriageAmount: '0', surchargeAmount: '0',
      taxAmount: '20.00', total: '120.00', statedTotal: '120.00',
      lines: [{
        orderLineId: lines[0]!.orderLineId, description: 'Cabinet', qty: '1', unitCost: '100', taxRatePercent: '20',
        taxRateCode: null, vatTreatment: null, categoryId: null, lineTotal: '100.00',
      }],
    }, null, 'INBOX')
    expect((await mod.db.getOrder(ids.po21!))?.status).toBe('RECEIVED')

    await queueOne('m-crash', 'a-crash', 'INV-99001.pdf', 'media-crash', buildPdf([invoicePage('INV-99001', 'PO-00021')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-crash', deps })

    const done = await row('a-crash', 1)
    expect(done!.outcome).toBe('FILED')
    expect(done!.bill_id).toBe(billId)
    const attached = await sql<{ attachment_media_id: string | null }>(`SELECT "attachment_media_id" FROM "po_bills" WHERE "id" = $1`, billId)
    expect(attached[0]!.attachment_media_id).toBe(done!.filed_media_id)
    expect(attached[0]!.attachment_media_id).not.toBeNull()
    expect((await mod.db.getOrder(ids.po21!))?.status).toBe('PENDING_CLOSE')
    expect((await mod.bills.listBillsForOrder(ids.po21!))).toHaveLength(1)
  })

  it('will not bill from a filename when nothing could be read from the file itself', async () => {
    ids.po22 = await newOrder('PO-00022', 'SENT', false, '120.00')
    await queueOne('m-scan', 'a-scan', 'Invoice INV-7788 PO-00022.pdf', 'media-scan', Buffer.from('a scanned picture, not a readable PDF'))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-scan', deps })
    const scanned = await row('a-scan', 1)
    expect(scanned!.whole_file).toBe(true)
    expect(scanned!.outcome).toBe('NEEDS_EYES')
    expect(scanned!.reason).toMatch(/Nothing could be read from the invoice itself/)
    expect(await mod.bills.listBillsForOrder(ids.po22!)).toHaveLength(0)
  })

  it('files a revised proforma loudly, and never one over a proforma already paid', async () => {
    ids.po18 = await newOrder('PO-00018', 'SENT', true, '120.00')
    await queueOne('m-pf-a', 'a-pf-a', 'PF-A.pdf', 'media-pf-a', buildPdf([proformaPage('PF-2001', 'PO-00018')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-pf-a', deps })
    const firstRow = await row('a-pf-a', 1)
    expect(firstRow!.outcome).toBe('FILED')
    expect(firstRow!.flag_alert).toBe(false)

    // A "revised" one: new reference, same money - the shape of the fraud.
    await queueOne('m-pf-b', 'a-pf-b', 'PF-B.pdf', 'media-pf-b', buildPdf([proformaPage('PF-2002', 'PO-00018')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-pf-b', deps })
    const revised = await row('a-pf-b', 1)
    expect(revised!.outcome).toBe('FILED')
    expect(revised!.flag_alert).toBe(true)
    expect(revised!.flag).toMatch(/bank details/)
    expect((await mod.db.getOrder(ids.po18!))?.proformaRef).toBe('PF-2002')
    const onOrder = await mod.run.inboundForOrder(ids.po18!)
    expect(onOrder[0]!.flagAlert).toBe(true)

    const problems = await mod.run.takeUnreportedProblems()
    expect(problems.some((p) => p.what.startsWith('PO-00018') && /bank details/.test(p.problem))).toBe(true)

    // Paid. Another one arriving by email changes nothing on the order.
    await sql(`UPDATE "po_orders" SET "proforma_paid_at" = now() WHERE "id" = $1`, ids.po18)
    await queueOne('m-pf-c', 'a-pf-c', 'PF-C.pdf', 'media-pf-c', buildPdf([proformaPage('PF-2003', 'PO-00018', '999.00')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-pf-c', deps })
    const refused = await row('a-pf-c', 1)
    expect(refused!.outcome).toBe('NEEDS_EYES')
    expect(refused!.reason).toMatch(/already been paid/)
    const after = await mod.db.getOrder(ids.po18!)
    expect(after?.proformaRef).toBe('PF-2002')
    expect(after?.proformaAmount).toBe('120')
  })

  it('will not dismiss a row somebody is in the middle of filing', async () => {
    const waiting = await row('a-theirs', 1)
    expect(waiting!.outcome).toBe('NEEDS_EYES')
    await sql(`UPDATE "po_inbound_documents" SET "claimed_at" = now() WHERE "id" = $1`, waiting!.id)
    expect(await mod.run.dismissPaperwork(waiting!.id as string, 'ignore', 'user-2')).toBe(false)
    await sql(`UPDATE "po_inbound_documents" SET "claimed_at" = NULL WHERE "id" = $1`, waiting!.id)
    expect(await mod.run.dismissPaperwork(waiting!.id as string, 'ignore', 'user-2')).toBe(true)
  })

  it('offers no drafts to file on', async () => {
    await newOrder('PO-00030', 'DRAFT', false, '10.00')
    const items = await mod.run.listPaperwork()
    const choices = items.flatMap((item) => item.choices.map((c) => c.number))
    expect(choices.length).toBeGreaterThan(0)
    expect(choices).not.toContain('PO-00030')
  })

  // -------------------------------------------------------------------------
  // Fix round 2
  // -------------------------------------------------------------------------

  async function proformaOrder(number: string, total: string, unitCost: string) {
    const rows = await sql<{ id: string }>(
      `INSERT INTO "po_orders" ("number", "supplier_id", "status", "proforma_required", "total")
       VALUES ($1, $2, 'SENT', true, $3::numeric) RETURNING "id"`,
      number, ids.acme, total,
    )
    await sql(
      `INSERT INTO "po_order_lines" ("order_id", "description", "qty", "unit_cost", "tax_rate_percent")
       VALUES ($1, 'Goods', 1, $2::numeric, 20)`,
      rows[0]!.id, unitCost,
    )
    return rows[0]!.id
  }

  it('keeps a fraud warning standing through a second copy of the same "revised" proforma, until somebody checks', async () => {
    const id = await proformaOrder('PO-00040', '120.00', '100')
    await queueOne('m-40a', 'a-40a', 'PF-4001.pdf', 'media-40a', buildPdf([proformaPage('PF-4001', 'PO-00040')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-40a', deps })
    expect((await mod.run.liveProformaWarnings(id)).warnings).toEqual([])

    await queueOne('m-40b', 'a-40b', 'PF-4002.pdf', 'media-40b', buildPdf([proformaPage('PF-4002', 'PO-00040')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-40b', deps })
    expect((await mod.run.liveProformaWarnings(id)).warnings).toHaveLength(1)

    // The fraudster sends their own document again: it matches what is on the
    // order now, so it carries no warning of its own - and must not clear one.
    await queueOne('m-40c', 'a-40c', 'PF-4002 again.pdf', 'media-40c', buildPdf([proformaPage('PF-4002', 'PO-00040')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-40c', deps })
    expect((await row('a-40c', 1))!.flag_alert).toBe(false)
    const { warnings: standing, newestAt } = await mod.run.liveProformaWarnings(id)
    expect(standing).toHaveLength(1)
    expect(standing[0]).toMatch(/bank details/)

    // Somebody checks, by name.
    await mod.run.clearProformaWarnings(id, standing, newestAt!, 'user-checker')
    expect((await mod.run.liveProformaWarnings(id)).warnings).toEqual([])
    const audit = await sql<{ user_id: string }>(
      `SELECT "user_id" FROM "po_audit_log" WHERE "entity_id" = $1 AND "action" = 'order.proforma_warning_checked'`,
      id,
    )
    expect(audit.map((a) => a.user_id)).toEqual(['user-checker'])

    // A fresh warning after the check is live again.
    await queueOne('m-40d', 'a-40d', 'PF-4003.pdf', 'media-40d', buildPdf([proformaPage('PF-4003', 'PO-00040')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-40d', deps })
    expect((await mod.run.liveProformaWarnings(id)).warnings).toHaveLength(1)

    // Paid, and there is nothing left to warn about paying.
    await sql(`UPDATE "po_orders" SET "proforma_paid_at" = now() WHERE "id" = $1`, id)
    expect((await mod.run.liveProformaWarnings(id)).warnings).toEqual([])
  })

  it('never leaves the old reference and amount beside a new proforma, and flags what cannot be compared', async () => {
    // A proforma somebody typed in by hand, no file.
    const id = await proformaOrder('PO-00041', '120.00', '100')
    await sql(`UPDATE "po_orders" SET "proforma_ref" = 'PF-TYPED-1', "proforma_amount" = 120 WHERE "id" = $1`, id)
    await queueOne('m-41a', 'a-41a', 'PF-4101.pdf', 'media-41a', buildPdf([proformaPage('PF-4101', 'PO-00041')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-41a', deps })
    const first = await row('a-41a', 1)
    expect(first!.outcome).toBe('FILED')
    expect(first!.flag_alert).toBe(true)
    let order = await mod.db.getOrder(id)
    expect(order?.proformaRef).toBe('PF-4101')

    // One with no readable total: filed, flagged, and the order's amount is
    // now blank - never the old one beside the new file.
    await queueOne('m-41b', 'a-41b', 'PF-4102.pdf', 'media-41b', buildPdf([proformaPage('PF-4102', 'PO-00041', '')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-41b', deps })
    const unreadable = await row('a-41b', 1)
    expect(unreadable!.total).toBeNull()
    expect(unreadable!.outcome).toBe('FILED')
    expect(unreadable!.flag_alert).toBe(true)
    expect(unreadable!.flag).toMatch(/could not be shown to be the same/)
    order = await mod.db.getOrder(id)
    expect(order?.proformaRef).toBe('PF-4102')
    expect(order?.proformaAmount).toBeNull()
    expect(order?.proformaMediaId).toBe(unreadable!.filed_media_id)
  })

  it('sends a part invoice or an extra charge to a person, with the real figures', async () => {
    // One line at 141.95 plus VAT: 170.34 left to invoice.
    const id = await proformaOrder('PO-00031', '170.34', '141.95')
    await sql(`UPDATE "po_orders" SET "proforma_required" = false, "status" = 'ACKNOWLEDGED' WHERE "id" = $1`, id)
    await queueOne('m-31a', 'a-31a', 'INV-31001.pdf', 'media-31a', buildPdf([invoicePage('INV-31001', 'PO-00031', '46.80')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-31a', deps })
    const part = await row('a-31a', 1)
    expect(part!.outcome).toBe('NEEDS_EYES')
    expect(part!.reason).toBe('Their invoice says £46.80 but £170.34 is left to invoice on PO-00031 - a part invoice or an extra charge? File it by hand.')
    expect(await mod.bills.listBillsForOrder(id)).toHaveLength(0)

    // The one for the whole of it is filed.
    await queueOne('m-31b', 'a-31b', 'INV-31002.pdf', 'media-31b', buildPdf([invoicePage('INV-31002', 'PO-00031', '170.34')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-31b', deps })
    expect((await row('a-31b', 1))!.outcome).toBe('FILED')
    expect(await mod.bills.listBillsForOrder(id)).toHaveLength(1)
  })

  it('flags a second proforma for a different amount as an extra charge or a revision', async () => {
    const id = await proformaOrder('PO-00032', '170.34', '141.95')
    await queueOne('m-32a', 'a-32a', 'PF-3201.pdf', 'media-32a', buildPdf([proformaPage('PF-3201', 'PO-00032', '170.34')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-32a', deps })
    expect((await row('a-32a', 1))!.flag_alert).toBe(false)

    await queueOne('m-32b', 'a-32b', 'PF-3202.pdf', 'media-32b', buildPdf([proformaPage('PF-3202', 'PO-00032', '46.80')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-32b', deps })
    const second = await row('a-32b', 1)
    expect(second!.flag_alert).toBe(true)
    expect(second!.flag).toMatch(/A second proforma arrived by email for £46\.80 - the one before was for £170\.34\. An extra charge, or a revision\?/)
    expect((await mod.run.liveProformaWarnings(id)).warnings.join(' ')).toMatch(/extra charge/)
  })

  it('refuses the write when the proforma is paid between the rules looking and the write', async () => {
    const id = await proformaOrder('PO-00042', '120.00', '100')
    await queueOne('m-42', 'a-42', 'PF-4201.pdf', 'media-42', buildPdf([proformaPage('PF-4201', 'PO-00042')], { encrypt: true }))
    // Somebody marks it paid while the file is being stored.
    const payingMidway: InboundDeps = {
      ...deps,
      store: async (bytes, filename, kind, orderNumber) => {
        await sql(`UPDATE "po_orders" SET "proforma_paid_at" = now(), "proforma_ref" = 'PAID-REF' WHERE "id" = $1`, id)
        return deps.store(bytes, filename, kind, orderNumber)
      },
    }
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-42', deps: payingMidway })
    const refused = await row('a-42', 1)
    expect(refused!.outcome).toBe('NEEDS_EYES')
    expect(refused!.reason).toMatch(/already been paid/)
    const order = await mod.db.getOrder(id)
    expect(order?.proformaRef).toBe('PAID-REF')
    expect(order?.proformaMediaId).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Fix round 3
  // -------------------------------------------------------------------------

  it('keeps a revised proforma’s warning through a failure part way through filing it', async () => {
    const id = await proformaOrder('PO-00043', '120.00', '100')
    await queueOne('m-43a', 'a-43a', 'PF-4301.pdf', 'media-43a', buildPdf([proformaPage('PF-4301', 'PO-00043')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-43a', deps })

    // The revision fails straight after the order is replaced.
    await queueOne('m-43b', 'a-43b', 'PF-4302.pdf', 'media-43b', buildPdf([proformaPage('PF-4302', 'PO-00043')], { encrypt: true }))
    const failing: InboundDeps = { ...deps, afterProformaReplace: async () => { throw new Error('the lights went out') } }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-43b', deps: failing })
    quiet.mockRestore()
    // Nothing half done: the order still holds the first proforma, and the
    // row waits for another go.
    expect((await mod.db.getOrder(id))?.proformaRef).toBe('PF-4301')
    expect((await row('a-43b', 1))!.outcome).toBe('QUEUED')

    // The retry files it, and the warning is there.
    await sql(`UPDATE "po_inbound_documents" SET "claimed_at" = now() - interval '11 minutes' WHERE "attachment_id" = 'a-43b'`)
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-43b', deps })
    const filed = await row('a-43b', 1)
    expect(filed!.outcome).toBe('FILED')
    expect(filed!.flag_alert).toBe(true)
    expect((await mod.db.getOrder(id))?.proformaRef).toBe('PF-4302')
    expect((await mod.run.liveProformaWarnings(id)).warnings.join(' ')).toMatch(/bank details/)
  })

  it('compares a retry with what the order held before the first attempt, not with itself', async () => {
    // As if an earlier attempt took its snapshot and replaced the order, then
    // died before recording anything else.
    const id = await proformaOrder('PO-00044', '120.00', '100')
    await queueOne('m-44', 'a-44', 'PF-4402.pdf', 'media-44', buildPdf([proformaPage('PF-4402', 'PO-00044')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-44', deps: { ...deps, store: async () => null } })
    const waiting = await row('a-44', 1)
    await sql(
      `UPDATE "po_inbound_documents"
          SET "prior_captured_at" = now(), "prior_proforma_media_id" = 'media-first', "prior_proforma_ref" = 'PF-4401',
              "prior_proforma_amount" = 120, "claimed_at" = now() - interval '11 minutes'
        WHERE "id" = $1`,
      waiting!.id,
    )
    await sql(`UPDATE "po_orders" SET "proforma_media_id" = 'media-44-early', "proforma_ref" = 'PF-4402', "proforma_amount" = 120 WHERE "id" = $1`, id)
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-44', deps })
    const filed = await row('a-44', 1)
    expect(filed!.outcome).toBe('FILED')
    expect(filed!.flag_alert).toBe(true)
    expect(filed!.flag).toMatch(/revised proforma/)
  })

  it('stores nothing for a proforma on an order already paid', async () => {
    const id = await proformaOrder('PO-00045', '120.00', '100')
    await sql(`UPDATE "po_orders" SET "proforma_paid_at" = now() WHERE "id" = $1`, id)
    let stores = 0
    const counting: InboundDeps = { ...deps, store: async (...args) => { stores++; return deps.store(...args) } }
    await queueOne('m-45', 'a-45', 'PF-4501.pdf', 'media-45', buildPdf([proformaPage('PF-4501', 'PO-00045')], { encrypt: true }))
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-45', deps: counting })
    expect((await row('a-45', 1))!.outcome).toBe('NEEDS_EYES')
    // The rules refuse it before filing starts; filing by hand refuses it too,
    // before anything is stored.
    const refused = await mod.run.fileManually((await row('a-45', 1))!.id as string, { orderId: id, kind: 'proforma', ref: null }, 'user-1', counting)
    expect(refused.ok).toBe(false)
    expect(stores).toBe(0)
  })

  it('bills the order’s carriage and surcharge on its first invoice, to the penny of five real totals', async () => {
    const CASES = [
      { n: 60, total: '124.74', line: '88.95', carriage: '15.00', surcharge: '0' },
      { n: 61, total: '170.34', line: '121.95', carriage: '15.00', surcharge: '5.00' },
      { n: 62, total: '281.94', line: '214.95', carriage: '20.00', surcharge: '0' },
      { n: 63, total: '330.14', line: '250.12', carriage: '25.00', surcharge: '0' },
      { n: 64, total: '273.48', line: '202.90', carriage: '0', surcharge: '25.00' },
    ]
    for (const c of CASES) {
      const id = await proformaOrder(`PO-000${c.n}`, c.total, c.line)
      await sql(
        `UPDATE "po_orders" SET "proforma_required" = false, "status" = 'ACKNOWLEDGED',
                "carriage_amount" = $2::numeric, "surcharge_amount" = $3::numeric WHERE "id" = $1`,
        id, c.carriage, c.surcharge,
      )
      await queueOne(`m-${c.n}`, `a-${c.n}`, `INV-${c.n}001.pdf`, `media-${c.n}`,
        buildPdf([invoicePage(`INV-${c.n}001`, `PO-000${c.n}`, c.total)], { encrypt: true }))
      await mod.run.runInboundQueue({ deadline: farOff(), messageId: `m-${c.n}`, deps })
      const filed = await row(`a-${c.n}`, 1)
      expect(filed!.outcome, `${c.total}: ${String(filed!.reason)}`).toBe('FILED')
      const bill = await mod.bills.getBill(filed!.bill_id as string)
      expect(Number(bill!.total)).toBe(Number(c.total))
      expect(Number(bill!.carriageAmount)).toBe(Number(c.carriage))
      expect(Number(bill!.surchargeAmount)).toBe(Number(c.surcharge))
      expect(bill!.matchStatus === 'VARIANCE' && bill!.variance.some((v) => /total/i.test(JSON.stringify(v)))).toBe(false)
    }
  })

  it('raises the pay gate for a replacement through the supplier’s own link, and answers only what was seen', async () => {
    const id = await proformaOrder('PO-00046', '120.00', '100')
    await mod.proforma.setProformaWarning(id, 'A revised proforma came through the supplier link.')
    const first = await mod.run.liveProformaWarnings(id)
    expect(first.warnings).toEqual(['A revised proforma came through the supplier link.'])
    await mod.run.clearProformaWarnings(id, first.warnings, first.newestAt!, 'user-1')
    expect((await mod.run.liveProformaWarnings(id)).warnings).toEqual([])
    // A later one is live again.
    await new Promise((r) => setTimeout(r, 20))
    await mod.proforma.setProformaWarning(id, 'Another one.')
    expect((await mod.run.liveProformaWarnings(id)).warnings).toEqual(['Another one.'])
    // And replacing a paid proforma is refused at the write.
    await sql(`UPDATE "po_orders" SET "proforma_paid_at" = now() WHERE "id" = $1`, id)
    expect(await mod.proforma.replaceProformaDocument(id, 'media-x', 'PF-X', '1.00', null)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Final review: a drop-shipper's order is never booked in
  // -------------------------------------------------------------------------

  it('puts a fully invoiced drop-ship order at pending close without it ever being booked in', async () => {
    const acme = await mod.db.getSupplier(ids.acme!)
    const dropId = await mod.db.createSupplier({
      ...acme!, name: 'Direct Delivery Ltd', email: 'orders@direct-delivery.example', inboundSenders: [], dropships: true,
    })
    async function dropOrder(number: string) {
      const rows = await sql<{ id: string }>(
        `INSERT INTO "po_orders" ("number", "supplier_id", "status", "proforma_required", "total")
         VALUES ($1, $2, 'ACKNOWLEDGED', false, 120) RETURNING "id"`,
        number, dropId,
      )
      await sql(
        `INSERT INTO "po_order_lines" ("order_id", "description", "qty", "unit_cost", "tax_rate_percent")
         VALUES ($1, 'Desk', 2, 50, 20)`,
        rows[0]!.id,
      )
      return rows[0]!.id
    }

    // Their invoice for the lot, by email: pending close, straight from acknowledged.
    const whole = await dropOrder('PO-00070')
    library.set('media-70', buildPdf([invoicePage('INV-70001', 'PO-00070')], { encrypt: true }))
    await mod.run.queueAttachments(
      { ...message('m-70'), fromAddress: 'accounts@direct-delivery.example' },
      [dropId],
      [{ attachmentId: 'a-70', filename: 'INV-70001.pdf', mediaId: 'media-70' }],
    )
    await mod.run.runInboundQueue({ deadline: farOff(), messageId: 'm-70', deps })
    expect((await row('a-70', 1))!.outcome).toBe('FILED')
    expect((await mod.db.getOrder(whole))?.status).toBe('PENDING_CLOSE')

    // Part of it invoiced, by hand: left exactly where it was.
    const part = await dropOrder('PO-00071')
    const lines = await mod.bills.listBillableLines(part)
    await mod.bills.createBill({
      supplierId: dropId, orderId: part, supplierInvoiceNumber: 'INV-71001', invoiceDate: '2026-09-30',
      dueDate: null, currency: 'GBP', fxRate: '1', subtotal: '50.00', carriageAmount: '0', surchargeAmount: '0',
      taxAmount: '10.00', total: '60.00', statedTotal: '60.00',
      lines: [{
        orderLineId: lines[0]!.orderLineId, description: 'Desk', qty: '1', unitCost: '50', taxRatePercent: '20',
        taxRateCode: null, vatTreatment: null, categoryId: null, lineTotal: '50.00',
      }],
    }, 'user-1', 'ADMIN')
    expect(await mod.settle.settleOrder(part, 'user-1')).toBeNull()
    expect((await mod.db.getOrder(part))?.status).toBe('ACKNOWLEDGED')

    // A supplier who is booked in as normal: a full invoice on an acknowledged
    // order does not move it.
    expect((await mod.db.getOrder(ids.po15!))?.status).toBe('ACKNOWLEDGED')
    expect(await mod.settle.settleOrder(ids.po15!, 'user-1')).toBeNull()
  })

  it('writes one bill however many runs take the queue at once', async () => {
    ids.po19 = await newOrder('PO-00019', 'SENT', false, '120.00')
    await queueOne('m-race', 'a-race', 'INV-99002.pdf', 'media-race', buildPdf([invoicePage('INV-99002', 'PO-00019')], { encrypt: true }))
    await Promise.all([
      mod.run.runInboundQueue({ deadline: farOff(), deps }),
      mod.run.runInboundQueue({ deadline: farOff(), deps }),
      mod.run.runInboundQueue({ deadline: farOff(), deps }),
    ])
    expect(await mod.bills.listBillsForOrder(ids.po19!)).toHaveLength(1)
    const rows = await sql(`SELECT "outcome", "attempts" FROM "po_inbound_documents" WHERE "attachment_id" = 'a-race' ORDER BY "page_from"`)
    expect(rows.map((r) => r.outcome)).toEqual(['READ', 'FILED'])
    expect(rows.every((r) => Number(r.attempts) === 1)).toBe(true)
  })
})
