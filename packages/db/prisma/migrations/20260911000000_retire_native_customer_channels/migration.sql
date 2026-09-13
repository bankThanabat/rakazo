-- Retire native transports without deleting customer transcripts or credentials.
UPDATE customer_channels
SET enabled = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE provider IN ('line', 'instagram', 'tiktok') AND enabled = true;

UPDATE customer_conversations AS conversation
SET owner = 'staff', "needsHuman" = false,
    generation = generation + 1, "leaseToken" = NULL, "leaseUntil" = NULL
FROM customer_channels AS channel
WHERE conversation."channelId" = channel.id
  AND channel.provider IN ('line', 'instagram', 'tiktok')
  AND (conversation.owner <> 'staff' OR conversation."needsHuman"
       OR conversation."leaseToken" IS NOT NULL OR conversation."leaseUntil" IS NOT NULL);

-- An in-flight request may already have reached the provider. Keep that outcome distinct.
UPDATE customer_messages AS message
SET status = CASE WHEN message.status = 'sending' THEN 'failed' ELSE 'cancelled' END,
    "nextAttemptAt" = NULL
FROM customer_conversations AS conversation
JOIN customer_channels AS channel ON channel.id = conversation."channelId"
WHERE message."conversationId" = conversation.id
  AND channel.provider IN ('line', 'instagram', 'tiktok')
  AND message.status IN ('queued', 'processing', 'sending');
