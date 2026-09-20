import type { Prisma, PrismaClient } from "@rakazo/db";

/** Unit lifecycle fixtures exercise CAS/rollback; real receipts have PostgreSQL coverage. */
export async function beginComputerProvision(
  prisma: PrismaClient,
  _computer: unknown,
  _context: unknown,
  claim: Prisma.ComputerUpdateManyArgs,
) {
  if (!(await prisma.computer.updateMany(claim)).count) return null;
  return {
    record: async () => undefined,
    activate: (update: Prisma.ComputerUpdateManyArgs) => prisma.computer.updateMany(update),
    finish: async () => undefined,
  };
}
