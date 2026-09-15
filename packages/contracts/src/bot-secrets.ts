import { z } from "zod";
import { isPlainHttpUrl } from "./http-url.js";
import { isLocalMcpHost } from "./mcp.js";

export const BotSecretName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const SecretHeaderName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/)
  .refine(
    (name) =>
      !/^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|proxy-.*|sec-.*|.*forwarded.*)$/i.test(
        name,
      ),
    "Unsupported credential header",
  );

export const BotSecretAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer") }),
  z.object({ type: z.literal("header"), name: SecretHeaderName }),
  z.object({
    type: z.literal("basic"),
    username: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^:\r\n]+$/),
  }),
]);

export const BotSecretDestination = z.object({
  name: BotSecretName,
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      if (!isPlainHttpUrl(value, { originOnly: true })) return false;
      const url = new URL(value);
      return (
        url.protocol === "https:" ||
        isLocalMcpHost(url.hostname) ||
        url.hostname === "host.docker.internal" ||
        url.hostname.endsWith(".localhost")
      );
    }, "Expected an HTTPS origin or local HTTP service origin without a path, credentials, query, or fragment"),
  auth: BotSecretAuth,
});
export type BotSecretDestination = z.infer<typeof BotSecretDestination>;

/** Written atomically with the protected value, distinct from action approval. */
export const BotSecretSubmission = z.object({ credentialSaved: BotSecretDestination });

export const SecretHttpRequest = z
  .object({
    name: BotSecretName,
    url: z.string().max(8192),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    body: z.string().max(100_000).optional(),
    contentType: z
      .enum(["application/json", "application/x-www-form-urlencoded", "text/plain"])
      .default("application/json"),
  })
  .refine(
    (request) => request.body === undefined || !["GET", "HEAD"].includes(request.method),
    "This method cannot have a body",
  );
