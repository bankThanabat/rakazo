-- Existing receipts keep their provider identity and remain terminal after upgrade.
ALTER TABLE "customer_alert_deliveries"
  DROP CONSTRAINT "customer_alert_deliveries_attentionId_stage_key",
  ADD CONSTRAINT "customer_alert_deliveries_attentionId_stage_provider_key"
    UNIQUE ("attentionId", "stage", "provider");
