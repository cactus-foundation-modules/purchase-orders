-- Purchase Orders - sending the automatic drafts by themselves
--
-- A draft raised when a customer pays (the paid-order hook, or the nightly
-- catch-up) can now be emailed to its supplier by the half-hourly job, after a
-- hold, exactly as if somebody had pressed Send - but only for a supplier the
-- owner has switched on, and only while the site-wide switch is on as well.
-- See lib/auto-send.ts and lib/auto-send-run.ts.
--
-- Additive, idempotent, and 001 carries the same for a fresh install.
--
-- 1. The supplier's switch. A plain one, off by default: the owner decides,
--    with the record of how often that supplier's automatic drafts were
--    changed by hand shown beside it.
--
-- 2. Where an order stands in the automatic queue. NULL for every order that
--    was never in it, which is every order on every install today:
--      QUEUED   waiting for its hold to run out
--      SENT     gone, by the job or by a person pressing Send first
--      HELD     a person changed it, so a person sends it (for good)
--      REFUSED  the job would not send it, and said why
--    with the sentence in `auto_send_note`. `auto_send_claimed_at` is the
--    job's claim on a row while it sends, so two runs at once can never both
--    email one order - and a person cannot change or send a draft while it
--    is on (they are told to look again in a minute); `auto_send_attempts`
--    counts mail that would not go, so a mail server that is down is tried a
--    few times rather than for ever; and
--    `auto_send_reported_at` is when the owner was told about a refusal, so
--    nobody is told twice.
--
-- 3. Who authorised it. Sending approves an order nobody formally approved
--    (013), and the approver is whoever sent it - but the job is nobody.
--    `approved_by_user_id` stays empty and this says why, so the document
--    prints "Sent automatically" rather than the blank line 013 got rid of.
--
-- 4. Three partial indexes for the job's first questions: is anything queued
--    and due, is any refusal still to be reported, and did a run die part way
--    through a send (a claim left on).
--
-- No DO blocks, no dollar quoting: every statement is plain DDL that can run
-- any number of times. The CHECK is dropped and re-added, because Postgres has
-- no ADD CONSTRAINT IF NOT EXISTS; the column is new, so no stored row fails it.
ALTER TABLE "po_suppliers" ADD COLUMN IF NOT EXISTS "auto_send" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "auto_send_state" TEXT;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "auto_send_note" TEXT;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "auto_send_claimed_at" TIMESTAMPTZ;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "auto_send_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "auto_send_reported_at" TIMESTAMPTZ;
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "approved_automatically" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "po_orders" DROP CONSTRAINT IF EXISTS "po_orders_auto_send_state_check";
ALTER TABLE "po_orders" ADD CONSTRAINT "po_orders_auto_send_state_check"
    CHECK ("auto_send_state" IS NULL OR "auto_send_state" IN ('QUEUED','SENT','HELD','REFUSED'));

CREATE INDEX IF NOT EXISTS "po_orders_auto_send_queued_idx"
    ON "po_orders" ("created_at") WHERE "auto_send_state" = 'QUEUED';
CREATE INDEX IF NOT EXISTS "po_orders_auto_send_unreported_idx"
    ON "po_orders" ("updated_at") WHERE "auto_send_state" = 'REFUSED' AND "auto_send_reported_at" IS NULL;
CREATE INDEX IF NOT EXISTS "po_orders_auto_send_claimed_idx"
    ON "po_orders" ("auto_send_claimed_at") WHERE "auto_send_claimed_at" IS NOT NULL;
