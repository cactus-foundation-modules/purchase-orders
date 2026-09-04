-- Purchase Orders - the supplier's accounts department
--
-- The ordering desk and the accounts desk are rarely the same inbox, and on a
-- proforma invoice they are rarely even the same domain: "once payment has been
-- made please send proof of payment to accounts@..." is printed on the invoice
-- itself. Sending the payment note to the sales contact means somebody there has
-- to forward it, which is a day, and on proforma terms a day is the whole order
-- standing still.
--
-- Two columns rather than one, because they answer different questions. The
-- address is worth recording whether or not anything is sent to it; the switch
-- is a decision about ONE email - the proforma-paid note - and nothing else. The
-- order itself, the amendment, the chase and the cancellation still go to the
-- people who take orders, which is where they belong.
--
-- Defaulted false, so every existing supplier behaves exactly as it did.
--
-- Idempotent, and 001 carries the same columns for a fresh install.
ALTER TABLE "po_suppliers" ADD COLUMN IF NOT EXISTS "accounts_email" TEXT;
ALTER TABLE "po_suppliers" ADD COLUMN IF NOT EXISTS "proforma_paid_to_accounts" BOOLEAN NOT NULL DEFAULT false;
