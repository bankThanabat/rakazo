/** Acceptance by the notification service is not proof of delivery to a device. */
export type NotificationResult = { status: "accepted"; reference?: string } | { status: "skipped" };

/** Only a confirmed rejection may be retried without provider idempotency. */
export class NotificationDeliveryError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "uncertain",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "NotificationDeliveryError";
  }
}
