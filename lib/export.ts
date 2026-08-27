import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { LINE_PROGRESS_SQL } from './progress'
import type { PoExportKind } from './types'

// The four spreadsheets purchasing will hand you.
//
// Every one of them is a flat file with no formatting, no symbols and no
// formulae: amounts go out as plain numbers (7.99, not £7.99) so a spreadsheet
// reads them as numbers, and dates as ISO days so they sort. The currency has a
// column of its own rather than being written into the figures - a purchasing
// history genuinely does hold several.
//
// The quantities on the lines file come through the one shared fragment in
// lib/progress.ts, so a file downloaded on Tuesday agrees with the order screen
// on Tuesday. Nothing here re-derives anything.

/** Rows are capped rather than streamed. Nobody reconciles a hundred thousand
 *  lines in a spreadsheet, and one click should never try to pull the whole
 *  history of a busy site into memory at once. The route says when it bit. */
export const EXPORT_ROW_CAP = 20_000

export type ExportFile = {
  columns: readonly string[]
  rows: string[][]
  truncated: boolean
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function num(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function day(value: unknown): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function when(value: unknown): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function cap<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, EXPORT_ROW_CAP), truncated: rows.length > EXPORT_ROW_CAP }
}

const ORDER_COLUMNS = [
  'order_number', 'revision', 'status', 'supplier', 'supplier_account',
  'raised_date', 'required_by_date', 'expected_date', 'sent_at', 'acknowledged_at', 'closed_at',
  'currency', 'fx_rate', 'base_currency', 'tax_mode',
  'subtotal', 'discount', 'carriage', 'tax', 'total',
  'lines', 'source', 'payment_terms', 'delivery_terms', 'ship_to_kind', 'notes_internal', 'created_at',
] as const

const LINE_COLUMNS = [
  'order_number', 'order_status', 'supplier', 'currency', 'position',
  'description', 'supplier_sku', 'our_sku', 'product_id',
  'qty_ordered', 'qty_cancelled', 'qty_received', 'qty_invoiced', 'qty_returned', 'qty_outstanding',
  'unit', 'unit_cost', 'discount_percent', 'tax_rate_percent', 'tax_rate_code', 'vat_treatment',
  'category_id', 'line_total', 'expected_date', 'service_name', 'service_cost',
] as const

const RECEIPT_COLUMNS = [
  'receipt_number', 'received_date', 'order_number', 'supplier', 'delivery_note_ref', 'carrier',
  'description', 'supplier_sku', 'unit', 'qty_accepted', 'qty_rejected', 'reject_reason',
  'stock_applied', 'received_by', 'created_at',
] as const

const BILL_COLUMNS = [
  'supplier_invoice_number', 'supplier', 'order_number', 'invoice_date', 'due_date',
  'status', 'match_status', 'variances',
  'currency', 'fx_rate', 'subtotal', 'carriage', 'tax', 'total',
  'approved_at', 'posted_at', 'has_attachment', 'lines', 'created_at',
] as const

/**
 * One export, over a window of days.
 *
 * The window is read against the date that matters to each file: when the order
 * was raised, when the goods turned up, when the supplier dated their invoice.
 * The lines file follows its own order's raised date, so an order and its lines
 * downloaded with the same dates are the same set of orders.
 */
export async function buildExport(
  kind: PoExportKind,
  from: string,
  to: string,
): Promise<ExportFile> {
  switch (kind) {
    case 'orders':
      return exportOrders(from, to)
    case 'lines':
      return exportLines(from, to)
    case 'receipts':
      return exportReceipts(from, to)
    case 'bills':
      return exportBills(from, to)
  }
}

/** An order's own day. `raised_date` is only set once it leaves draft, so the
 *  day it was typed stands in - otherwise every draft would be undateable and
 *  quietly absent from every export. */
const ORDER_DAY = Prisma.sql`COALESCE(o."raised_date", o."created_at"::date)`

async function exportOrders(from: string, to: string): Promise<ExportFile> {
  const all = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."number", o."revision", o."status", s."name" AS "supplier", s."account_number",
           o."raised_date", o."required_by_date", o."expected_date", o."sent_at",
           o."acknowledged_at", o."closed_at",
           o."currency", o."fx_rate", o."base_currency", o."tax_mode",
           o."subtotal", o."discount_amount", o."carriage_amount", o."tax_amount", o."total",
           o."source_kind", o."payment_terms", o."delivery_terms", o."ship_to_kind",
           o."notes_internal", o."created_at",
           (SELECT count(*) FROM "po_order_lines" l WHERE l."order_id" = o."id") AS "line_count"
      FROM "po_orders" o
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     WHERE ${ORDER_DAY} >= ${from}::date AND ${ORDER_DAY} <= ${to}::date
     ORDER BY o."number" ASC
  `
  const { rows, truncated } = cap(all)
  return {
    columns: ORDER_COLUMNS,
    truncated,
    rows: rows.map((r) => [
      text(r.number), num(r.revision), text(r.status), text(r.supplier), text(r.account_number),
      day(r.raised_date), day(r.required_by_date), day(r.expected_date), when(r.sent_at),
      when(r.acknowledged_at), when(r.closed_at),
      text(r.currency), num(r.fx_rate), text(r.base_currency), text(r.tax_mode),
      num(r.subtotal), num(r.discount_amount), num(r.carriage_amount), num(r.tax_amount), num(r.total),
      num(r.line_count), text(r.source_kind), text(r.payment_terms), text(r.delivery_terms),
      text(r.ship_to_kind), text(r.notes_internal), when(r.created_at),
    ]),
  }
}

async function exportLines(from: string, to: string): Promise<ExportFile> {
  const all = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT o."number" AS "order_number", o."status" AS "order_status", s."name" AS "supplier",
           o."currency", l."position", l."description", l."supplier_sku", l."our_sku", l."product_id",
           l."qty", l."qty_cancelled", l."unit", l."unit_cost", l."discount_percent",
           l."tax_rate_percent", l."tax_rate_code", l."vat_treatment", l."category_id",
           l."line_total", l."expected_date", l."service_name", l."service_cost",
           ${LINE_PROGRESS_SQL}
      FROM "po_order_lines" l
      JOIN "po_orders" o ON o."id" = l."order_id"
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
     WHERE ${ORDER_DAY} >= ${from}::date AND ${ORDER_DAY} <= ${to}::date
     ORDER BY o."number" ASC, l."position" ASC
  `
  const { rows, truncated } = cap(all)
  return {
    columns: LINE_COLUMNS,
    truncated,
    rows: rows.map((r) => {
      const outstanding = Math.max(
        0,
        Number(r.qty ?? 0) - Number(r.qty_cancelled ?? 0) - Number(r.qty_received ?? 0),
      )
      return [
        text(r.order_number), text(r.order_status), text(r.supplier), text(r.currency), num(r.position),
        text(r.description), text(r.supplier_sku), text(r.our_sku), text(r.product_id),
        num(r.qty), num(r.qty_cancelled), num(r.qty_received), num(r.qty_invoiced), num(r.qty_returned),
        outstanding.toFixed(3),
        text(r.unit), num(r.unit_cost), num(r.discount_percent), num(r.tax_rate_percent),
        text(r.tax_rate_code), text(r.vat_treatment), text(r.category_id),
        num(r.line_total), day(r.expected_date), text(r.service_name), num(r.service_cost),
      ]
    }),
  }
}

async function exportReceipts(from: string, to: string): Promise<ExportFile> {
  const all = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT g."number" AS "receipt_number", g."received_date", g."delivery_note_ref", g."carrier",
           g."stock_applied", g."created_at",
           o."number" AS "order_number", s."name" AS "supplier",
           l."description", l."supplier_sku", l."unit",
           rl."qty_accepted", rl."qty_rejected", rl."reject_reason",
           COALESCE(u."displayName", u."username") AS "received_by"
      FROM "po_receipt_lines" rl
      JOIN "po_receipts" g ON g."id" = rl."receipt_id"
      JOIN "po_orders" o ON o."id" = g."order_id"
      JOIN "po_suppliers" s ON s."id" = o."supplier_id"
      JOIN "po_order_lines" l ON l."id" = rl."order_line_id"
      LEFT JOIN "User" u ON u."id" = g."received_by_user_id"
     WHERE g."received_date" >= ${from}::date AND g."received_date" <= ${to}::date
     ORDER BY g."received_date" DESC, g."number" ASC, l."position" ASC
  `
  const { rows, truncated } = cap(all)
  return {
    columns: RECEIPT_COLUMNS,
    truncated,
    rows: rows.map((r) => [
      text(r.receipt_number), day(r.received_date), text(r.order_number), text(r.supplier),
      text(r.delivery_note_ref), text(r.carrier),
      text(r.description), text(r.supplier_sku), text(r.unit),
      num(r.qty_accepted), num(r.qty_rejected), text(r.reject_reason),
      r.stock_applied ? 'yes' : 'no', text(r.received_by), when(r.created_at),
    ]),
  }
}

async function exportBills(from: string, to: string): Promise<ExportFile> {
  const all = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT b."supplier_invoice_number", s."name" AS "supplier", o."number" AS "order_number",
           b."invoice_date", b."due_date", b."status", b."match_status",
           jsonb_array_length(b."variance") AS "variances",
           b."currency", b."fx_rate", b."subtotal", b."carriage_amount", b."tax_amount", b."total",
           b."approved_at", b."posted_at", b."attachment_media_id", b."created_at",
           (SELECT count(*) FROM "po_bill_lines" bl WHERE bl."bill_id" = b."id") AS "line_count"
      FROM "po_bills" b
      JOIN "po_suppliers" s ON s."id" = b."supplier_id"
      LEFT JOIN "po_orders" o ON o."id" = b."order_id"
     WHERE b."invoice_date" >= ${from}::date AND b."invoice_date" <= ${to}::date
     ORDER BY b."invoice_date" DESC, b."supplier_invoice_number" ASC
  `
  const { rows, truncated } = cap(all)
  return {
    columns: BILL_COLUMNS,
    truncated,
    rows: rows.map((r) => [
      text(r.supplier_invoice_number), text(r.supplier), text(r.order_number),
      day(r.invoice_date), day(r.due_date), text(r.status), text(r.match_status), num(r.variances),
      text(r.currency), num(r.fx_rate), num(r.subtotal), num(r.carriage_amount), num(r.tax_amount), num(r.total),
      when(r.approved_at), when(r.posted_at), r.attachment_media_id ? 'yes' : 'no',
      num(r.line_count), when(r.created_at),
    ]),
  }
}
