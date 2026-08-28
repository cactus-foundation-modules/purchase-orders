-- Purchase Orders - the discount a supplier gives, and the lists it comes off.
--
-- A trade supplier publishes one price list and sells it to everybody at a
-- different number: their printed figure is retail, and what you actually pay is
-- that less whatever percentage you have negotiated. Until now importing such a
-- list put retail into unit_cost, which then drafted every purchase order at the
-- price the customer pays. The discount belongs on the supplier, because it is
-- an agreement with them and not a property of any one spreadsheet.
--
-- price_basis says which kind of list each one is. Some suppliers send trade net
-- and some send retail, the same supplier does both in the same year, and a
-- single per-supplier flag would silently take 25% off a list that was already
-- net. Default 'NET', which is exactly how every list imported before today was
-- read - so nothing already on file changes meaning.
--
-- 001 has already run on every install that has this module, and 004 has already
-- run wherever price lists exist, so editing either in place would never re-run.
-- The columns arrive here, and both files carry them as well for a site
-- installing today. All of it is idempotent, which is what makes the overlap
-- harmless - the same reasoning 002 and 003 set out.
--
-- Column types stay inside the set the backup serialiser has a branch for:
-- numeric and text.

ALTER TABLE "po_suppliers" ADD COLUMN IF NOT EXISTS "discount_percent" NUMERIC(5,2);

ALTER TABLE "po_supplier_catalogues" ADD COLUMN IF NOT EXISTS "price_basis" TEXT NOT NULL DEFAULT 'NET';

-- ADD CONSTRAINT has no IF NOT EXISTS, and the obvious guard - a DO block - is
-- not available here. The backup round-trip harness splits these files on
-- semicolons and skips any module whose migrations contain a dollar-quoted body,
-- which would quietly drop this whole module out of the one test that proves a
-- restore actually works. DROP IF EXISTS then ADD is idempotent without any of
-- that, and lands a fresh install and an updated one on the same constraint.
-- (Do not write the dollar-quote marker even in a comment: the check is a plain
-- substring match on the file.)
ALTER TABLE "po_suppliers" DROP CONSTRAINT IF EXISTS "po_suppliers_discount_percent_check";
ALTER TABLE "po_suppliers"
    ADD CONSTRAINT "po_suppliers_discount_percent_check"
    CHECK ("discount_percent" IS NULL OR ("discount_percent" >= 0 AND "discount_percent" <= 100));

ALTER TABLE "po_supplier_catalogues" DROP CONSTRAINT IF EXISTS "po_supplier_catalogues_price_basis_check";
ALTER TABLE "po_supplier_catalogues"
    ADD CONSTRAINT "po_supplier_catalogues_price_basis_check"
    CHECK ("price_basis" IN ('NET','RETAIL'));
