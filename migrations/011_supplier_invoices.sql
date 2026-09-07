-- Purchase Orders - the supplier's own VAT invoice, and Pending close
--
-- Three changes, all additive, all idempotent, and 001 carries the same for a
-- fresh install.
--
-- 1. A new order status. PENDING_CLOSE is where an order lands when the SUPPLIER
--    says they have invoiced the lot: everything delivered, everything invoiced,
--    nothing owed back - but the invoices themselves are drafts nobody here has
--    read yet. Closing it is a decision somebody in this building makes after
--    checking them, which is the whole reason it is not simply CLOSED.
--
-- 2. Two columns on a bill. `stated_total` is what the supplier's document says
--    it comes to, kept apart from `total`, which is our own arithmetic over the
--    order's prices: the two disagreeing is a fact worth a flag, and overwriting
--    one with the other would be how the disagreement disappears. `source` says
--    who filed it, because a draft that arrived through a link with nobody's
--    login behind it is not the same object as one somebody here typed.
--
-- 3. A sixth thing a supplier can tell us through their link.
--
-- The status CHECK is dropped and recreated rather than added to, because
-- Postgres has no ALTER CONSTRAINT for a CHECK. Both halves run in one
-- statement each, so an install that has already had this cannot end up with
-- the constraint missing.
ALTER TABLE "po_orders" DROP CONSTRAINT IF EXISTS "po_orders_status_check";
ALTER TABLE "po_orders" ADD CONSTRAINT "po_orders_status_check"
    CHECK ("status" IN ('DRAFT','AWAITING_APPROVAL','APPROVED','SENT','ACKNOWLEDGED',
                        'PART_RECEIVED','RECEIVED','PENDING_CLOSE','CLOSED','CANCELLED','ON_HOLD'));

-- What their invoice says it comes to, as printed on it. NULL where nobody has
-- said - a bill typed in from a phone call has no document to read.
ALTER TABLE "po_bills" ADD COLUMN IF NOT EXISTS "stated_total" NUMERIC(12,2);

-- Who filed it. ADMIN for everything that existed before this, which is true:
-- there was no other way to file one.
ALTER TABLE "po_bills" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'ADMIN';
ALTER TABLE "po_bills" DROP CONSTRAINT IF EXISTS "po_bills_source_check";
ALTER TABLE "po_bills" ADD CONSTRAINT "po_bills_source_check"
    CHECK ("source" IN ('ADMIN','PORTAL'));

ALTER TABLE "po_portal_events" DROP CONSTRAINT IF EXISTS "po_portal_events_kind_check";
ALTER TABLE "po_portal_events" ADD CONSTRAINT "po_portal_events_kind_check"
    CHECK ("kind" IN ('ACKNOWLEDGED','DATE_PROPOSED','SHORTAGE','MESSAGE','PROFORMA','DESPATCHED','INVOICED'));
