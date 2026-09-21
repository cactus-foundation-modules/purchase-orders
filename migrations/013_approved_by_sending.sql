-- Purchase Orders - orders that went out with nobody's name against them
--
-- An order under the approval threshold never visits "awaiting approval", so
-- nobody ever pressed Approve on it. It was read, and sent, and recorded as
-- approved by no one - with an empty "Authorised by" on the document the
-- supplier was holding. Sending an order nobody formally approved now stamps
-- whoever sent it as the approver (`sendingApproves`, lib/lifecycle.ts).
--
-- This does the same for the orders that went out before that: the approver is
-- whoever the history says first sent the order - by email (`order.sent`) or by
-- marking it as sent by hand (`order.send`) - and the date is the day it went.
--
-- Deliberately narrow. Only an order that HAS been sent, has no approver, and
-- has a named person against that first send: an order with no such entry is
-- left as it is rather than given a guess. An order somebody did approve is
-- never touched.
--
-- No schema change, nothing for 001 to carry, and idempotent: a second run finds
-- no sent order without an approver that it could name one for.
UPDATE "po_orders" o
   SET "approved_by_user_id" = s."user_id",
       "approved_at"         = COALESCE(o."sent_at", s."created_at")
  FROM (
        SELECT DISTINCT ON (a."entity_id") a."entity_id", a."user_id", a."created_at"
          FROM "po_audit_log" a
         WHERE a."entity_type" = 'order'
           AND a."action" IN ('order.sent', 'order.send')
           AND a."user_id" IS NOT NULL
         ORDER BY a."entity_id", a."created_at" ASC
       ) s
 WHERE s."entity_id" = o."id"
   AND o."sent_at" IS NOT NULL
   AND o."approved_at" IS NULL
   AND o."approved_by_user_id" IS NULL;
