# OpenConnector upstream tenancy

Checked 2026-09-15 against official OOMOL documentation and upstream commit `493def090c95a92ee312b95594c489c9856a16af`.

## Conclusion

Upstream has connection restrictions for runtime tokens that can support a shared deployment. It does not provide the complete end-user ownership and self-service connection-management system needed by a public SaaS. This distinction follows from the runtime policy, admin routes, and tests below, rather than an assumption that multiple connections imply multiple tenants.

## Documented behavior

- Persistent runtime tokens can have independent action, proxy, and connection grants. A nonempty `allowedConnections` list permits exact connection IDs. Omission or `[]` permits unrestricted connection access; the bootstrap runtime token is also unrestricted. JWT verification does not map claims to action or proxy policy. The configuration documentation explicitly discusses shared or multi-tenant deployments and requires private-network access to remain disabled there. [Upstream configuration](https://github.com/oomol-lab/open-connector/blob/493def090c95a92ee312b95594c489c9856a16af/docs/configuration.md)
- OOMOL documents self-hosted OpenConnector as a runtime operated for oneself or one's organization. Its product comparison directs products connecting end-user accounts to hosted Connector for SaaS. This is product positioning, not proof that self-hosted multi-tenancy is impossible. [Choose an integration path](https://oomol.com/en/docs/choose-a-path/)
- The self-hosted SDK selects configured connections and consumes runtime configuration. Its guide places connection creation, OAuth configuration, runtime-token generation, and policy management in the administrator's web console. [Self-hosted SDK guide](https://oomol.com/en/docs/openconnector-sdk/)
- Hosted `ProjectConnector` accepts `externalUserId` for authorization and execution, including `forUser`. The product must still authenticate users, keep the project API key on its backend, and associate account IDs with product users. These hosted APIs should not be assumed to exist in the self-hosted runtime. [ProjectConnector guide](https://oomol.com/en/docs/project-connector/)

## Source evidence at the checked commit

- The connection-management routes declare one administrator principal with owner `local-admin`; `listManagedConnections` has no tenant filter. [Connection routes, lines 25 onward](https://github.com/oomol-lab/open-connector/blob/493def090c95a92ee312b95594c489c9856a16af/src/server/api/connection-routes.ts#L25)
- Connection-management paths require administrator authentication. [Authentication](https://github.com/oomol-lab/open-connector/blob/493def090c95a92ee312b95594c489c9856a16af/src/server/api/auth.ts)
- Runtime `/v1/apps` listing filters connections through `policy.evaluateConnection`. Scoped runtime access is therefore more than an action-only restriction. [Runtime connection listing, lines 745 onward](https://github.com/oomol-lab/open-connector/blob/493def090c95a92ee312b95594c489c9856a16af/src/server/connect-server.ts#L745)
- Tests cover scoped actions, proxies, and runtime connection listing, while retaining full access for admin, bootstrap, JWT, and unrestricted tokens. [Connection grant tests, lines 1820 onward](https://github.com/oomol-lab/open-connector/blob/493def090c95a92ee312b95594c489c9856a16af/src/server/connect-server.test.ts#L1820)

These are source and test inspections. The tests were not executed for this research note.

## Implication for Rakazo

Reuse upstream's connection grants. A trusted backend must authenticate the product user, assign and enforce connection ownership during creation, listing, reconnection, and deletion, and issue correctly restricted runtime access. Do not give end users the shared admin credential. A user with no connections must not receive an unrestricted token via `allowedConnections: []`.

This is an architectural inference from the documented and inspected behavior, not a claim that upstream cannot be used in a multi-tenant system.
