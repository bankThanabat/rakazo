import { z } from "zod";
import { Id } from "./ids.js";

const actionId = z.string().min(1).max(200);
const choices = z.record(actionId, z.boolean());

/** Accepted defaults are a snapshot: a catalog update cannot broaden customer access. */
export const ConnectorActionPolicySchema = z.object({
  defaults: choices.default({}),
  overrides: choices.default({}),
});
export type ConnectorActionPolicy = z.infer<typeof ConnectorActionPolicySchema>;

export const ConnectionActionSchema = z.object({
  name: actionId,
  description: z.string(),
  internal: z.boolean(),
  defaultInternal: z.boolean(),
  overridden: z.boolean(),
});
export type ConnectionAction = z.infer<typeof ConnectionActionSchema>;

export const ConfigureConnectionActionSchema = z.object({
  connectionId: Id,
  action: actionId,
  /** null explicitly accepts the current recommended default for this action. */
  internal: z.boolean().nullable(),
});

/** Server-derived scope, carried through the integration gateway, never model input. */
export const ConnectorActionAccessSchema = z.record(Id, z.array(actionId).max(5000));
