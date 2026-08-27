-- Purchase Orders - returns that can take goods back off the shelf.
--
-- 001 gave po_returns everything except the three columns that make a stock
-- deduction safe to press twice. 001 has already run on every install that has
-- this module, and editing it there would never re-run - so the columns arrive
-- here, and 001 carries them as well for a site installing the module today.
-- Both are idempotent, which is what makes the overlap harmless.
--
-- Same shape as po_receipts, and for the same reason: the flag is CLAIMED in a
-- conditional UPDATE before a single unit moves. A read-then-write check would
-- let two people pressing the button at the same moment deduct the delivery
-- twice, and a stock figure that has quietly gone wrong twice is worse than one
-- that was never kept.

ALTER TABLE "po_returns" ADD COLUMN IF NOT EXISTS "stock_applied"    BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE "po_returns" ADD COLUMN IF NOT EXISTS "stock_applied_at" TIMESTAMPTZ;
ALTER TABLE "po_returns" ADD COLUMN IF NOT EXISTS "stock_result"     JSONB       NOT NULL DEFAULT '{}';
