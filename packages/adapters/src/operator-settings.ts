import type { PrismaClient } from "@rakazo/db";
import type { EncryptedSecretStore } from "./secrets.js";

export type OperatorSettingsDeps = { prisma: PrismaClient; secrets: EncryptedSecretStore };

/** Operator-owned settings sealed under their own id; never readable by account owners. */
export async function loadOperatorSettings(
  deps: OperatorSettingsDeps,
  id: string,
): Promise<unknown | null> {
  const row = await deps.prisma.integrationProviderConfig.findUnique({ where: { id } });
  return row ? JSON.parse(deps.secrets.load(row.ciphertext, id)) : null;
}

export async function saveOperatorSettings(deps: OperatorSettingsDeps, id: string, value: unknown) {
  const ciphertext = deps.secrets.seal(JSON.stringify(value), id);
  await deps.prisma.integrationProviderConfig.upsert({
    where: { id },
    create: { id, ciphertext },
    update: { ciphertext },
  });
}
