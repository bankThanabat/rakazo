# Customer messaging archive

Native LINE, Instagram, and TikTok integrations have been removed. Their connection screens, webhooks, automatic replies, and staff sending controls are no longer available on web, desktop, or mobile.

Apply the database migrations when upgrading. The retirement migration disables saved native channels, releases conversation leases, and cancels queued work. Sends with an unknown outcome are marked failed. Existing transcripts remain readable in the Customer inbox, with the same owner and Space access checks. Channel records and encrypted credentials are retained; nothing is transferred to OpenConnector automatically.

Remove the old Rakazo webhook URLs from the provider consoles. Configure OpenConnector separately through Rakazo's existing MCP integration. Removing the native channels does not install OpenConnector or provide incoming-message routing through it.

Run `bash scripts/verify-retired-customer-channels.sh` to check transport removal and retired RPC/job behavior. Archive access and migration tests also run when `VERIFY_DATABASE=1` and `DATABASE_URL` point to an isolated test database. Run `pnpm check` for types and `pnpm test:e2e` for browser journeys; browser tests require Docker and Playwright Chromium.
