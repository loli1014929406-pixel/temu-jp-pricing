import { describe, expect, it } from "vitest";
import {
  classifyTrackingStatus,
  parseJapanPostTrackingHtml,
  parseYamatoTrackingHtml,
} from "../../supabase/functions/_shared/order-tracking";

describe("Japan Post tracking parsing", () => {
  it("keeps a newer date-only return event instead of an older timed event", () => {
    const result = parseJapanPostTrackingHtml(`
      <table summary="履歴情報">
        <tr>
          <td>2026/07/20 13:57</td>
          <td>引受</td>
          <td></td>
          <td>筑紫郵便局</td>
        </tr>
        <tr>
          <td>2026/07/23</td>
          <td>差出人に返送</td>
          <td>あて所が不明のため</td>
          <td>高田郵便局</td>
        </tr>
      </table>
    `);

    expect(result).toMatchObject({
      status: "差出人に返送",
      detail: "あて所が不明のため",
      eventTime: "2026-07-23T00:00:00+09:00",
      category: "exception",
      isException: true,
      exceptionReason: "差出人に返送：あて所が不明のため",
    });
  });

  it("recognizes delivery without creating an exception", () => {
    const result = parseJapanPostTrackingHtml(`
      <table summary="履歴情報">
        <tr>
          <td>2026/07/24 09:15</td>
          <td>お届け先にお届け済み</td>
          <td></td>
        </tr>
      </table>
    `);

    expect(result.category).toBe("delivered");
    expect(result.isException).toBe(false);
  });
});

describe("Yamato tracking parsing", () => {
  it("treats customer pickup storage as an actionable reminder", () => {
    const result = parseYamatoTrackingHtml(`
      <div class="tracking-invoice-block-state-title">ご来店予定（保管中）</div>
      <div class="tracking-invoice-block-detail">
        <ol>
          <li>
            <div class="date">2026/07/22 12:40</div>
            <div class="item">ご来店予定（保管中）</div>
          </li>
        </ol>
      </div>
    `);

    expect(result).toMatchObject({
      status: "ご来店予定（保管中）",
      category: "available_for_pickup",
      isException: true,
    });
  });
});

describe("tracking status classification", () => {
  it("does not classify missing tracking data as a carrier exception", () => {
    expect(classifyTrackingStatus("伝票番号未登録")).toEqual({
      category: "pending",
      isException: false,
      exceptionReason: "",
    });
  });
});
