ALTER TABLE "customer_purchases" ADD COLUMN "providerOrderId" TEXT;
UPDATE "customer_purchases" SET "providerOrderId" = "summary"->'order'->>'id'
WHERE "summary"->'order'->>'id' IS NOT NULL;
CREATE UNIQUE INDEX "customer_purchases_connectionId_providerRef_providerOrderId_key"
ON "customer_purchases"("connectionId", "providerRef", "providerOrderId");
