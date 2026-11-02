-- Purchase Orders - the day the money actually left
--
-- A proof of payment is filed against an order paid up front, and until now the
-- only date near it was proforma_paid_at: the moment somebody pressed a button,
-- which is often not the day the bank sent the money. That date matters more
-- than it looks. When a supplier is paid before they invoice, the payment is
-- the tax point for VAT, not the date printed on the VAT invoice that turns up
-- weeks later - so the bill raised against the order is dated to the day the
-- order was first paid when it is approved (lib/bills.ts
-- dateBillToFirstPayment), and that is the date the books are handed.
--
-- `proforma_proof_paid_on` is that day, as a plain calendar date. Typed in
-- beside the proof when it is filed, defaulting to the day it is filed, and
-- correctable afterwards from the order screen.
--
-- Orders still open on an install that predates this get the day their proof
-- of payment was first filed, read off the module's own audit log in the site's
-- own timezone (a proof filed at half past midnight in July belongs to that
-- day, not the UTC day before it). Where the log has nothing - it should always
-- have something, but a log is not a constraint - the day the payment was
-- marked stands in. Closed and cancelled orders are left alone: their bills
-- were approved long ago and nothing here re-dates them.
--
-- The timezone is checked against pg_timezone_names before it is used, so a
-- site with a nonsense zone in its settings gets UTC rather than a failed
-- deploy.
--
-- Additive, idempotent (the backfill only touches rows still NULL), and 001
-- carries the column for a fresh install.
ALTER TABLE "po_orders" ADD COLUMN IF NOT EXISTS "proforma_proof_paid_on" DATE;

UPDATE "po_orders" o
   SET "proforma_proof_paid_on" = COALESCE(
         (SELECT (min(a."created_at") AT TIME ZONE COALESCE(
                   (SELECT z."name" FROM pg_timezone_names z
                     WHERE z."name" = (SELECT c."timezone" FROM "SiteConfig" c LIMIT 1) LIMIT 1),
                   'UTC'))::date
            FROM "po_audit_log" a
           WHERE a."entity_type" = 'order'
             AND a."entity_id" = o."id"
             AND a."action" = 'order.payment-proof-filed'),
         (o."proforma_paid_at" AT TIME ZONE COALESCE(
            (SELECT z."name" FROM pg_timezone_names z
              WHERE z."name" = (SELECT c."timezone" FROM "SiteConfig" c LIMIT 1) LIMIT 1),
            'UTC'))::date
       )
 WHERE o."proforma_payment_proof_media_id" IS NOT NULL
   AND o."proforma_proof_paid_on" IS NULL
   AND o."status" NOT IN ('CLOSED', 'CANCELLED');
