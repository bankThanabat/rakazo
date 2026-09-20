import { z } from "zod";

const id = z.string().min(1).max(200);
export const ConnectorAccountIdentitySchema = z
  .object({ provider: id, id: z.string().min(1).max(500) })
  .strict();
export type ConnectorAccountIdentity = z.infer<typeof ConnectorAccountIdentitySchema>;
export const ConnectorReceiptQuerySchema = z
  .object({
    connectionId: id,
    action: id,
    executionKey: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ConnectorReceiptQuery = z.infer<typeof ConnectorReceiptQuerySchema>;
export const ConnectorReceiptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), data: z.json() }).strict(),
  z.object({ status: z.literal("uncertain") }).strict(),
  z.object({ status: z.literal("missing") }).strict(),
]);
export type ConnectorReceipt = z.infer<typeof ConnectorReceiptSchema>;
export const InstagramSendListInput = z
  .object({ connectionId: id, cursor: id.optional() })
  .strict();
export const InstagramSendReconcileInput = z.object({ connectionId: id, id }).strict();
