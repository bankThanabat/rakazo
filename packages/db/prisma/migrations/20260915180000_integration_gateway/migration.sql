-- AlterTable
ALTER TABLE "customer_channels" ADD COLUMN     "autoReplies" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "relayId" TEXT,
ADD COLUMN     "webhookUrl" TEXT;

-- CreateTable
CREATE TABLE "gateway_runtimes" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_runtimes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_accounts" (
    "id" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "gateway_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_routes" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "sourceId" TEXT,
    "endpointId" TEXT,
    "subscriptionId" TEXT,
    "webhookUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "gateway_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_deliveries" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "payload" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),

    CONSTRAINT "gateway_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_connector_attempts" (
    "previousAccountId" TEXT,
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "open_connector_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_runtimes_tokenHash_key" ON "gateway_runtimes"("tokenHash");

-- CreateIndex
CREATE INDEX "gateway_runtimes_spaceId_userId_idx" ON "gateway_runtimes"("spaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_accounts_providerRef_key" ON "gateway_accounts"("providerRef");

-- CreateIndex
CREATE INDEX "gateway_accounts_runtimeId_idx" ON "gateway_accounts"("runtimeId");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_routes_accountId_channelId_key" ON "gateway_routes"("accountId", "channelId");

-- CreateIndex
CREATE INDEX "gateway_deliveries_routeId_ackedAt_receivedAt_idx" ON "gateway_deliveries"("routeId", "ackedAt", "receivedAt");

-- CreateIndex
CREATE INDEX "open_connector_attempts_endpoint_createdAt_idx" ON "open_connector_attempts"("endpoint", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_channels_relayId_key" ON "customer_channels"("relayId");

-- AddForeignKey
ALTER TABLE "gateway_accounts" ADD CONSTRAINT "gateway_accounts_runtimeId_fkey" FOREIGN KEY ("runtimeId") REFERENCES "gateway_runtimes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_routes" ADD CONSTRAINT "gateway_routes_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "gateway_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_deliveries" ADD CONSTRAINT "gateway_deliveries_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "gateway_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
