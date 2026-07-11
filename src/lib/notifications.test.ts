import { describe, expect, it, vi } from "vitest";
import {
  notify,
  notifyError,
  notifySuccess,
  subscribeNotifications,
} from "./notifications";

describe("notifications", () => {
  it("delivers typed notifications to active subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotifications(listener);

    notifySuccess("保存成功");
    notifyError("保存失败");

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0]).toMatchObject({
      message: "保存成功",
      tone: "success",
      durationMs: 5000,
    });
    expect(listener.mock.calls[1][0]).toMatchObject({
      message: "保存失败",
      tone: "error",
      durationMs: 7000,
    });

    unsubscribe();
  });

  it("stops delivery after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotifications(listener);
    unsubscribe();

    notify({ message: "ignored" });

    expect(listener).not.toHaveBeenCalled();
  });
});
