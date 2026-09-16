-- New connector channels start with automatic replies off; the schema default now matches.
ALTER TABLE "customer_channels" ALTER COLUMN "autoReplies" SET DEFAULT false;
