ALTER TABLE "customer_operations"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt" >= 0),
  DROP CONSTRAINT "customer_operations_status_check",
  ADD CONSTRAINT "customer_operations_status_check"
    CHECK ("status" IN ('executing', 'completed', 'uncertain', 'retry_ready'));

ALTER TABLE "customer_operation_receipts"
  ADD COLUMN "reviewHistory" JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof("reviewHistory") = 'array' AND jsonb_array_length("reviewHistory") <= 32);

-- Keep earlier confirmations in the same ordered audit as future decisions.
UPDATE "customer_operation_receipts"
SET "reviewHistory" = jsonb_build_array(jsonb_build_object(
  'decision', 'confirmed', 'attempt', 0, 'userId', "reviewedByUserId",
  'at', to_char("reviewedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'reason', "reviewReason", 'providerReference', "providerReference",
  'receipt', "result"
))
WHERE "reviewedAt" IS NOT NULL;
