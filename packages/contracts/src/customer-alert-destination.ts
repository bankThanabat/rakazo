import * as z from "zod";
import { Id } from "./ids.js";

const recipient = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), recipientId: z.string().regex(/^U[0-9a-f]{32}$/) }),
  z.object({ kind: z.literal("private_group"), recipientId: z.string().regex(/^C[0-9a-f]{32}$/) }),
]);
export const CustomerAlertLineTestInput = z
  .object({
    connectionId: Id,
    recipient,
    expectedId: z.uuid().nullable(),
    nonce: z.uuid(),
  })
  .strict();
export const CustomerAlertLineVerifyInput = z
  .object({
    id: z.uuid(),
    connectionId: Id,
    recipient,
    code: z.string().regex(/^[0-9a-f]{12}$/),
    staffOnly: z.literal(true),
  })
  .strict();
export const CustomerAlertLineDisableInput = z.object({ id: z.uuid() }).strict();
