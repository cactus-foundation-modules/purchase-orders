-- Purchase Orders - filing a supplier's emailed paperwork by itself
--
-- The unified inbox tells this module when an email arrives
-- (`unified-inbox.message-received`). When it is from a supplier and carries a
-- PDF, the file is queued here, read on the half-hourly job, and each document
-- in it - a proforma, their acknowledgement, a VAT invoice - is filed on the
-- purchase order it quotes, or left on the Paperwork list with a sentence
-- saying why it was not.
--
-- Five changes, all additive, all idempotent, and 001 carries the same for a
-- fresh install.
--
-- 1. `po_suppliers.inbound_senders`: extra addresses or domains a supplier's
--    paperwork comes from, beyond the email and copy-to on the record. Their
--    staff write from several addresses at their own domain, and the domain is
--    already worked out from the supplier's email - this list is for the rest:
--    an accounts system on a different domain, a second trading name.
--
-- 2. A third source of bill, INBOX: a draft written from their emailed invoice.
--    The CHECK is dropped and recreated because Postgres has no ALTER
--    CONSTRAINT for one. Both halves are one statement each, so an install that
--    has already had this cannot end up without the constraint.
--
-- 3. `po_bills.attachment_note`: one line about the attached file, for the case
--    where it is the supplier's whole daily batch rather than their invoice on
--    its own - "page 2 of 3 in the attached file".
--
-- 4. The queue, `po_inbound_documents`. One row per PDF attachment with
--    page_from 0 (the file, as it arrived), and once it has been read one row
--    per document found in it, keyed by the page it starts on. The unique key
--    on (attachment_id, page_from) IS the idempotency: the inbox may offer the
--    same email twice, even twice at once, and every insert here is
--    INSERT ... ON CONFLICT DO NOTHING, so the second offer files nothing.
--
-- No foreign keys to the inbox: that is another module's table, and this one
-- must install and run on a site without it. Media ids are plain ids, as
-- everywhere else in this module.
ALTER TABLE "po_suppliers" ADD COLUMN IF NOT EXISTS "inbound_senders" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "po_bills" DROP CONSTRAINT IF EXISTS "po_bills_source_check";
ALTER TABLE "po_bills" ADD CONSTRAINT "po_bills_source_check"
    CHECK ("source" IN ('ADMIN','PORTAL','INBOX'));

ALTER TABLE "po_bills" ADD COLUMN IF NOT EXISTS "attachment_note" TEXT;

-- 5. When somebody said they had checked the bank details on a proforma that
--    arrived by email with a warning on it (revised, a second one, or not the
--    order's total). A warning filed before it is answered; one filed after it
--    is live again, and marking the proforma paid is refused until it is.
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_warning_cleared_at" TIMESTAMPTZ;
-- The same kind of warning when the replacement came through the supplier's
-- own link rather than by email, answered by the same check.
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_warning" TEXT;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_warning_at" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "po_inbound_documents" (
    "id"                 TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
    -- The inbox's own ids, kept as plain text: the message, its conversation
    -- (for a link back to it) and the attachment.
    "message_id"         TEXT        NOT NULL,
    "thread_id"          TEXT,
    "attachment_id"      TEXT        NOT NULL,
    -- The file as the inbox stored it. NULL when the inbox could not fetch it
    -- from the mail server, which is said on the Paperwork list rather than
    -- guessed round.
    "source_media_id"    TEXT,
    "filename"           TEXT        NOT NULL DEFAULT '',
    "subject"            TEXT        NOT NULL DEFAULT '',
    "from_address"       TEXT        NOT NULL DEFAULT '',
    -- The date on the email.
    "received_at"        TIMESTAMPTZ,
    -- Every supplier the sender could be. Usually one; two where two suppliers
    -- share a domain, and the purchase order number on the document decides.
    "supplier_ids"       TEXT[]      NOT NULL DEFAULT '{}',
    -- 0 for the file as a whole, else the first page of the document this row
    -- is about (1-based).
    "page_from"          INTEGER     NOT NULL DEFAULT 0,
    "page_to"            INTEGER,
    "page_count"         INTEGER,
    -- What was read off it. Kind is proforma, acknowledgement, invoice,
    -- credit-note or unknown, as lib/supplier-document.ts names them.
    "kind"               TEXT,
    "supplier_ref"       TEXT,
    "our_po_numbers"     TEXT[]      NOT NULL DEFAULT '{}',
    "total"              NUMERIC(12,2),
    "doc_date"           DATE,
    -- The file could not be read page by page, so this document is all of it.
    "whole_file"         BOOLEAN     NOT NULL DEFAULT false,
    -- Where it went.
    "order_id"           TEXT,
    "filed_as"           TEXT,
    "filed_media_id"     TEXT,
    "bill_id"            TEXT,
    -- Something about a filed document worth a person's eye: their proforma
    -- comes to more than the order does, or its total could not be read.
    "flag"               TEXT,
    -- Whether that flag is worth an email: a total that disagrees, a revised
    -- proforma replacing one already on the order, a bill with nothing
    -- attached. A total that merely could not be read is said on the order and
    -- is not.
    "flag_alert"         BOOLEAN     NOT NULL DEFAULT false,
    -- For a proforma: what the order held BEFORE this one replaced it, taken
    -- once, before the replacing write. A retry after a failure part way
    -- through compares with this rather than with the order - which by then
    -- holds this very document and would find nothing to warn about.
    "prior_captured_at"      TIMESTAMPTZ,
    "prior_proforma_media_id" TEXT,
    "prior_proforma_ref"     TEXT,
    "prior_proforma_amount"  NUMERIC(12,2),
    -- QUEUED waiting to be read or filed; READ for a file whose documents now
    -- have rows of their own; FILED; NEEDS_EYES with `reason` the sentence
    -- saying why; IGNORED by a person, with `reason` saying which way.
    "outcome"            TEXT        NOT NULL DEFAULT 'QUEUED',
    "reason"             TEXT,
    -- Who is working on it, so two runs never file one document twice, and how
    -- often it has been tried, so a file that breaks the reader stops being
    -- tried.
    "claimed_at"         TIMESTAMPTZ,
    "attempts"           INTEGER     NOT NULL DEFAULT 0,
    -- When the problem report email mentioned it, so it is mentioned once.
    "reported_at"        TIMESTAMPTZ,
    "handled_by_user_id" TEXT,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "handled_at"         TIMESTAMPTZ,
    CONSTRAINT "po_inbound_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "po_inbound_documents_outcome_check"
        CHECK ("outcome" IN ('QUEUED','READ','FILED','NEEDS_EYES','IGNORED')),
    CONSTRAINT "po_inbound_documents_order_fk" FOREIGN KEY ("order_id") REFERENCES "po_orders" ("id") ON DELETE SET NULL,
    CONSTRAINT "po_inbound_documents_bill_fk" FOREIGN KEY ("bill_id") REFERENCES "po_bills" ("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "po_inbound_documents_attachment_page_unique"
    ON "po_inbound_documents" ("attachment_id", "page_from");
CREATE INDEX IF NOT EXISTS "po_inbound_documents_message_idx" ON "po_inbound_documents" ("message_id");
CREATE INDEX IF NOT EXISTS "po_inbound_documents_order_idx" ON "po_inbound_documents" ("order_id");
-- The cron's first question, answered off this alone: is anything waiting?
CREATE INDEX IF NOT EXISTS "po_inbound_documents_queued_idx"
    ON "po_inbound_documents" ("created_at") WHERE "outcome" = 'QUEUED';
CREATE INDEX IF NOT EXISTS "po_inbound_documents_needs_eyes_idx"
    ON "po_inbound_documents" ("created_at") WHERE "outcome" = 'NEEDS_EYES';
-- The problem report's question, so it is not a whole-table UPDATE every
-- half hour: what is worth telling somebody and has not been told yet.
CREATE INDEX IF NOT EXISTS "po_inbound_documents_unreported_idx"
    ON "po_inbound_documents" ("created_at")
    WHERE "reported_at" IS NULL AND ("outcome" = 'NEEDS_EYES' OR "flag_alert");
