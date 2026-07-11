import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  subscribeNotifications,
  type AppNotification,
  type AppNotificationTone,
} from "../../lib/notifications";

const toneClasses: Record<AppNotificationTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  error: "border-rose-200 bg-rose-50 text-rose-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-sky-200 bg-sky-50 text-sky-900",
};

const toneIcons = {
  success: CheckCircle2,
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
} satisfies Record<AppNotificationTone, typeof Info>;

export function NotificationCenter() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  useEffect(
    () =>
      subscribeNotifications((notification) => {
        setNotifications((current) => [...current.slice(-3), notification]);
        window.setTimeout(() => {
          setNotifications((current) =>
            current.filter((item) => item.id !== notification.id),
          );
        }, notification.durationMs);
      }),
    [],
  );

  function dismiss(id: number) {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }

  return (
    <div
      className="pointer-events-none fixed right-4 top-4 z-[100] grid w-[min(26rem,calc(100vw-2rem))] gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {notifications.map((notification) => {
        const Icon = toneIcons[notification.tone];
        return (
          <div
            key={notification.id}
            role={notification.tone === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border p-3 shadow-lg ${toneClasses[notification.tone]}`}
          >
            <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 whitespace-pre-line text-sm font-medium leading-5">
              {notification.message}
            </p>
            <button
              type="button"
              onClick={() => dismiss(notification.id)}
              aria-label="关闭提示"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-current/60 hover:bg-black/5 hover:text-current"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
