import { describe, expect, it, vi } from "vitest";
import { withTransactionRetry } from "./transaction-retry.js";

describe("transaction retry", () => {
  it.each([
    { code: "P2034" },
    { name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict" } },
    { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "40001" } } } },
  ])("retries a known rolled-back conflict: %o", async (error) => {
    const operation = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("committed");
    expect(await withTransactionRetry(operation)).toBe("committed");
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it("bounds commit-time conflict attempts and does not retry uncertain failures", async () => {
    const conflict = { name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict" } };
    const operation = vi.fn().mockRejectedValue(conflict);
    await expect(withTransactionRetry(operation)).rejects.toBe(conflict);
    expect(operation).toHaveBeenCalledTimes(3);
    const unknown = new Error("Commit connection lost");
    const uncertain = vi.fn().mockRejectedValue(unknown);
    await expect(withTransactionRetry(uncertain)).rejects.toBe(unknown);
    expect(uncertain).toHaveBeenCalledOnce();
  });
});
