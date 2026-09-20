import type { ComputerRef } from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "./fake-sandbox.js";

/** Managed-provider protocol emulator backed by deterministic local state. */
export class ManagedSandboxEmulator extends FakeSandboxProvider {
  constructor(
    private readonly emulator: { id: string; kind: ComputerRef["kind"] } = {
      id: "e2b-emulator",
      kind: "e2b",
    },
  ) {
    super(emulator.kind);
  }
  override describe() {
    return { ...super.describe(), id: this.emulator.id };
  }
}
