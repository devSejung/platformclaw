// Keep core admission errors separate from system-events: its legacy SDK barrel
// must not promote internal retry handling into a public plugin contract.
export class SystemEventQueueFullError extends Error {
  constructor(capacity: number) {
    super(
      `System event queue is full (${capacity} pending). Let the session process pending events before retrying the notification.`,
    );
    this.name = "SystemEventQueueFullError";
  }
}
