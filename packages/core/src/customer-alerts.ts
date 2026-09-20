import type { CustomerQuietHours } from "@rakazo/contracts";

/** First allowed notification minute. Walk UTC minutes to handle skipped/repeated local DST hours. */
export function customerAlertResumeAt(hours: CustomerQuietHours, now: Date): Date | null {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const quiet = (date: Date) => {
    const time = clock.format(date);
    return hours.start < hours.end
      ? time >= hours.start && time < hours.end
      : time >= hours.start || time < hours.end;
  };
  if (!quiet(now)) return null;
  const nextMinute = Math.floor(now.getTime() / 60000) * 60000 + 60000;
  for (let minute = 0; minute < 48 * 60; minute++) {
    const candidate = new Date(nextMinute + minute * 60000);
    if (!quiet(candidate)) return candidate;
  }
  throw new Error("Quiet hours have no notification window in the next two days");
}
