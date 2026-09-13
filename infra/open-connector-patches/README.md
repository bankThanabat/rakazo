# OpenConnector compatibility

Rakazo uses the standard catalog, credential connection, action and runtime-token APIs. OAuth additionally requires independent connection-request scopes and cancellation, advertised by `GET /v1/connection-capabilities`.

`scoped-oauth-requests.patch` adds those capabilities to the OpenConnector 1.5.0 source snapshot. It keeps the default unscoped behavior and all provider implementations intact. Scope headers are administrator-only; Rakazo derives them from its opaque account reference. Cancellation and completion are fenced in the request store transaction.

Apply the patch in an OpenConnector source checkout before building its Docker image:

```sh
git apply --check /path/to/scoped-oauth-requests.patch
git apply /path/to/scoped-oauth-requests.patch
npm ci
npm exec -- vitest run src/server/api/connection-routes.test.ts
npm run fix-check
docker build -f docker/Dockerfile -t open-connector:rakazo .
```

Do not reapply to a checkout that already contains the changes. An upstream version advertising both capabilities can be used without the patch after the conformance tests pass. Rakazo refuses OAuth if those capabilities are absent; credential-based providers remain independent of this extension.

Configure the OpenConnector public origin for its OAuth callback. Configure a public Rakazo origin separately for incoming channel webhooks. Tokens and provider credentials belong in deployment secret configuration, never tracked files.
