-- CreateTable
CREATE TABLE "customer_channels" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "ciphertext" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_conversations" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "externalThreadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL DEFAULT 'bot',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "nextSeq" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "externalId" TEXT,
    "role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "providerHandle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_channels_spaceId_userId_idx" ON "customer_channels"("spaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_channels_provider_accountId_key" ON "customer_channels"("provider", "accountId");

-- CreateIndex
CREATE INDEX "customer_conversations_channelId_updatedAt_idx" ON "customer_conversations"("channelId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_conversations_channelId_externalThreadId_key" ON "customer_conversations"("channelId", "externalThreadId");

-- CreateIndex
CREATE INDEX "customer_messages_status_createdAt_idx" ON "customer_messages"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_messages_conversationId_externalId_key" ON "customer_messages"("conversationId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_messages_conversationId_seq_key" ON "customer_messages"("conversationId", "seq");

-- AddForeignKey
ALTER TABLE "customer_channels" ADD CONSTRAINT "customer_channels_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_channels" ADD CONSTRAINT "customer_channels_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_conversations" ADD CONSTRAINT "customer_conversations_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "customer_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_messages" ADD CONSTRAINT "customer_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "customer_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE customer_conversations ADD COLUMN "needsHuman" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customer_messages ADD COLUMN "sendAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_messages ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
