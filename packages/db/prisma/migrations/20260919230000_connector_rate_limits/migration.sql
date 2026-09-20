CREATE TABLE connector_rate_limits (
  key TEXT PRIMARY KEY,
  "availableAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX connector_rate_limits_available_at_idx ON connector_rate_limits ("availableAt");
