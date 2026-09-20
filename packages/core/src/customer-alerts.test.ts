import { CustomerNotificationSettingsInput, CustomerQuietHoursSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { customerAlertResumeAt } from "./customer-alerts.js";

describe("customer quiet hours", () => {
  const hours = { start: "22:00", end: "08:00", timezone: "Asia/Bangkok" };
  it.each([
    ["2026-01-01T14:59:59Z", null],
    ["2026-01-01T15:00:00Z", "2026-01-02T01:00:00.000Z"],
    ["2026-01-02T00:59:59Z", "2026-01-02T01:00:00.000Z"],
    ["2026-01-02T01:00:00Z", null],
  ])("applies local overnight boundaries at %s", (now, expected) => {
    expect(customerAlertResumeAt(hours, new Date(now))?.toISOString() ?? null).toBe(expected);
  });
  it("supports a daytime interval and a fractional timezone offset", () => {
    expect(
      customerAlertResumeAt(
        { start: "12:00", end: "13:00", timezone: "Asia/Kathmandu" },
        new Date("2026-01-01T06:15:00Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T07:15:00.000Z");
  });
  it.each([
    ["2026-03-08T06:30:00Z", "02:30", "2026-03-08T07:00:00.000Z"],
    ["2026-11-01T04:30:00Z", "02:30", "2026-11-01T07:30:00.000Z"],
    ["2026-11-01T06:15:00Z", "01:30", "2026-11-01T06:30:00.000Z"],
  ])("handles daylight-saving gaps and repeated hours at %s", (now, end, expected) => {
    expect(
      customerAlertResumeAt(
        { start: "22:00", end, timezone: "America/New_York" },
        new Date(now),
      )?.toISOString(),
    ).toBe(expected);
  });
  it.each([
    { ...hours, timezone: "Not/A_Timezone" },
    { ...hours, start: "24:00" },
    { ...hours, end: "08:60" },
    { ...hours, end: "22:00" },
  ])("rejects unusable quiet hours %j", (input) => {
    expect(CustomerQuietHoursSchema.safeParse(input).success).toBe(false);
  });
  it("accepts clearing quiet hours but rejects another recipient in preference input", () => {
    expect(CustomerNotificationSettingsInput.parse({ quietHours: null })).toEqual({
      quietHours: null,
    });
    expect(
      CustomerNotificationSettingsInput.safeParse({ help: false, userId: "someone-else" }).success,
    ).toBe(false);
  });
});
