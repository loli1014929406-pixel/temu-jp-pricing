export type AppNotificationTone = "success" | "error" | "warning" | "info";

export type AppNotification = {
  id: number;
  message: string;
  tone: AppNotificationTone;
  durationMs: number;
};

type NotificationInput = {
  message: string;
  tone?: AppNotificationTone;
  durationMs?: number;
};

const listeners = new Set<(notification: AppNotification) => void>();
let nextNotificationId = 1;

export function notify({
  message,
  tone = "info",
  durationMs = 5000,
}: NotificationInput) {
  const notification: AppNotification = {
    id: nextNotificationId,
    message,
    tone,
    durationMs,
  };
  nextNotificationId += 1;
  listeners.forEach((listener) => listener(notification));
  return notification.id;
}

export function subscribeNotifications(
  listener: (notification: AppNotification) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifySuccess(message: string) {
  return notify({ message, tone: "success" });
}

export function notifyError(message: string) {
  return notify({ message, tone: "error", durationMs: 7000 });
}

export function notifyWarning(message: string) {
  return notify({ message, tone: "warning" });
}
