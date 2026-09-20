import { describe, expect, it } from "vitest";
import { inspectAcceptance } from "../../../scripts/inspect-openconnector-acceptance.mjs";

describe("hosted acceptance preflight", () => {
  it("distinguishes missing actions, catalog entries and executable handlers without claiming acceptance", () => {
    const report = inspectAcceptance(
      [
        {
          service: "instagram",
          actions: [
            { id: "instagram.list_comment_replies", execution: { locallyExecutable: false } },
            { id: "instagram.get_current_user", execution: { locallyExecutable: true } },
            { id: "other.list_conversations", execution: { locallyExecutable: true } },
          ],
        },
      ],
      [
        {
          service: "instagram",
          configured: true,
          connectionName: "private-alias",
          id: "private-id",
        },
      ],
    );
    expect(report.providerAcceptance).toBe("not established by configuration or catalog presence");
    const instagram = report.providers.find(
      (provider: { service: string }) => provider.service === "instagram",
    )!;
    expect(instagram.configuredConnections).toBe(1);
    expect(instagram.actionChecks).toEqual(
      expect.arrayContaining([
        { id: "instagram.get_current_user", catalogPresent: true, locallyExecutable: true },
        { id: "instagram.list_comment_replies", catalogPresent: true, locallyExecutable: false },
        { id: "instagram.list_conversations", catalogPresent: false, locallyExecutable: false },
      ]),
    );
    const woo = report.providers.find(
      (provider: { service: string }) => provider.service === "woocommerce",
    )!;
    expect(woo).toMatchObject({ catalogPresent: false, actions: 0, configuredConnections: 0 });
    expect(
      woo.actionChecks.every(
        (action: { catalogPresent: boolean; locallyExecutable: boolean }) =>
          !action.catalogPresent && !action.locallyExecutable,
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private-alias");
    expect(JSON.stringify(report)).not.toContain("private-id");
  });
});
