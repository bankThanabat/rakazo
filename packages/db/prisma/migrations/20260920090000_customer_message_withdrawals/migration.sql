CREATE TABLE customer_message_withdrawals (
  "channelId" TEXT NOT NULL REFERENCES customer_channels(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("channelId", key)
);

-- Upgrade only the built-in LINE event mapping; leave custom bindings alone.
UPDATE customer_channels
SET binding = jsonb_set(
  jsonb_set(binding, '{receive,fields,providerMessageId}', '["message","id"]'::jsonb),
  '{receive,withdrawal}', '{"event":{"path":["type"],"equals":"unsend"},"messageId":["unsend","messageId"]}'::jsonb
), "updatedAt" = CURRENT_TIMESTAMP
WHERE provider = 'line'
  AND binding #> '{receive,incoming}' = '{"path":["type"],"equals":"message"}'::jsonb
  AND binding #> '{receive,items}' = '["events"]'::jsonb
  AND binding #>> '{receive,timestampFormat}' = 'milliseconds'
  AND binding #> '{receive,withdrawal}' IS NULL
  AND binding #> '{receive,fields}' = '{"id":["webhookEventId"],"threadId":[["source","groupId"],["source","roomId"],["source","userId"]],"customerId":["source","userId"],"body":["message","text"],"timestamp":["timestamp"]}'::jsonb;
