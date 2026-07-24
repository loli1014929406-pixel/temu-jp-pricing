export type TrackingCarrier = "japan_post" | "yamato";

export type TrackingCategory =
  | "pending"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "available_for_pickup"
  | "failed_attempt"
  | "exception";

export type ParsedTrackingResult = {
  status: string;
  detail: string;
  eventTime: string;
  category: TrackingCategory;
  isException: boolean;
  exceptionReason: string;
};

const deliveredKeywords = [
  "お届け済み",
  "配達完了",
  "配達済み",
  "投函完了",
  "delivered",
] as const;

const availableForPickupKeywords = [
  "ご来店予定",
  "保管中",
  "郵便局で保管",
  "受取場所",
  "available for pickup",
] as const;

const failedAttemptKeywords = [
  "ご不在",
  "不在",
  "持ち戻り",
  "持戻",
  "持ち帰り",
  "配達店へ持ち帰り",
  "再配達",
  "delivery attempted",
  "attempt fail",
] as const;

const exceptionKeywords = [
  "差出人に返送",
  "差出人へ返送",
  "返送済み",
  "返品",
  "あて所",
  "宛所",
  "宛先不明",
  "住所不明",
  "受取拒否",
  "配達不能",
  "調査中",
  "紛失",
  "破損",
  "事故",
  "異常",
  "遅延",
  "returned to sender",
  "returning to sender",
  "damaged",
  "lost",
  "exception",
] as const;

const outForDeliveryKeywords = [
  "持ち出し中",
  "配達中",
  "out for delivery",
] as const;

function includesAny(value: string, keywords: readonly string[]) {
  const normalized = value.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

export function cleanTrackingText(value: string) {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/▶/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyTrackingStatus(
  status: string,
  detail = "",
): Pick<
  ParsedTrackingResult,
  "category" | "isException" | "exceptionReason"
> {
  const normalizedStatus = cleanTrackingText(status);
  const normalizedDetail = cleanTrackingText(detail);
  const combined = `${normalizedStatus} ${normalizedDetail}`.trim();

  if (includesAny(combined, deliveredKeywords)) {
    return {
      category: "delivered",
      isException: false,
      exceptionReason: "",
    };
  }

  const exceptionReason = normalizedDetail
    ? `${normalizedStatus}：${normalizedDetail}`
    : normalizedStatus;

  if (includesAny(combined, exceptionKeywords)) {
    return {
      category: "exception",
      isException: true,
      exceptionReason,
    };
  }

  if (includesAny(combined, failedAttemptKeywords)) {
    return {
      category: "failed_attempt",
      isException: true,
      exceptionReason,
    };
  }

  if (includesAny(combined, availableForPickupKeywords)) {
    return {
      category: "available_for_pickup",
      isException: true,
      exceptionReason,
    };
  }

  if (includesAny(combined, outForDeliveryKeywords)) {
    return {
      category: "out_for_delivery",
      isException: false,
      exceptionReason: "",
    };
  }

  if (
    !normalizedStatus ||
    includesAny(normalizedStatus, [
      "待查询",
      "暂无轨迹",
      "伝票番号未登録",
      "お問い合わせ番号が見つかりません",
    ])
  ) {
    return {
      category: "pending",
      isException: false,
      exceptionReason: "",
    };
  }

  return {
    category: "in_transit",
    isException: false,
    exceptionReason: "",
  };
}

export function parseJapanPostTrackingHtml(html: string): ParsedTrackingResult {
  const bodyText = cleanTrackingText(html);
  if (
    bodyText.includes("お問い合わせ番号が見つかりません") ||
    bodyText.includes("お問い合わせ番号をご確認ください")
  ) {
    return buildTrackingResult("暂无轨迹");
  }

  const historyTable = extractTableBySummary(html, "履歴情報");
  const events = extractRows(historyTable)
    .map((row, index) => {
      const cells = extractCells(row);
      if (cells.length < 2) return null;
      const status = getTrackingStatusLabel(cells[1]);
      if (!status) return null;
      const eventTime = formatJapanCarrierDateTime(cells[0]);
      return {
        status,
        detail: cells[2] ?? "",
        eventTime,
        timestamp: eventTime ? Date.parse(eventTime) : Number.NaN,
        index,
      };
    })
    .filter((event): event is NonNullable<typeof event> => Boolean(event));

  const latestEvent = events.sort((left, right) => {
    const leftTimestamp = Number.isNaN(left.timestamp)
      ? Number.NEGATIVE_INFINITY
      : left.timestamp;
    const rightTimestamp = Number.isNaN(right.timestamp)
      ? Number.NEGATIVE_INFINITY
      : right.timestamp;
    return rightTimestamp - leftTimestamp || right.index - left.index;
  })[0];

  if (latestEvent) {
    return buildTrackingResult(
      latestEvent.status,
      latestEvent.detail,
      latestEvent.eventTime,
    );
  }

  const resultTable = extractTableBySummary(html, "照会結果");
  for (const row of extractRows(resultTable)) {
    for (const cell of extractCells(row)) {
      const status = getTrackingStatusLabel(cell);
      if (status) return buildTrackingResult(status);
    }
  }

  return buildTrackingResult("暂无轨迹");
}

export function parseYamatoTrackingHtml(html: string): ParsedTrackingResult {
  const statusTitle = extractFirstClassText(
    html,
    "tracking-invoice-block-state-title",
  );
  const detailRows = extractListItemsByAncestorClass(
    html,
    "tracking-invoice-block-detail",
  );
  const latestDetailRow = detailRows.at(-1) ?? "";
  const latestStatus = extractFirstClassText(latestDetailRow, "item");
  const latestDate = extractFirstClassText(latestDetailRow, "date");
  const listStatus = extractTextByAllClasses(html, ["data", "state"]);
  const status =
    getTrackingStatusLabel(statusTitle) ||
    getTrackingStatusLabel(latestStatus) ||
    getTrackingStatusLabel(listStatus) ||
    "暂无轨迹";
  const detail =
    latestStatus && cleanTrackingText(latestStatus) !== status
      ? latestStatus
      : "";

  return buildTrackingResult(
    status,
    detail,
    formatJapanCarrierDateTime(latestDate),
  );
}

export function getTrackingStatusLabel(status: string) {
  const cleaned = cleanTrackingText(status);
  return cleaned.split("/")[0]?.trim() ?? "";
}

export function buildTrackingEventIdentity(
  carrier: TrackingCarrier,
  trackingNo: string,
  result: ParsedTrackingResult,
) {
  return [
    carrier,
    trackingNo.trim(),
    result.status,
    result.detail,
    result.eventTime,
    result.category,
  ]
    .map((value) => cleanTrackingText(value).toLowerCase())
    .join("\u001f");
}

function buildTrackingResult(
  status: string,
  detail = "",
  eventTime = "",
): ParsedTrackingResult {
  const normalizedStatus = getTrackingStatusLabel(status) || "暂无轨迹";
  const normalizedDetail = cleanTrackingText(detail);
  return {
    status: normalizedStatus,
    detail: normalizedDetail,
    eventTime,
    ...classifyTrackingStatus(normalizedStatus, normalizedDetail),
  };
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (entity, code: string) => {
      if (code.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return namedEntities[code.toLowerCase()] ?? entity;
    },
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTableBySummary(html: string, summary: string) {
  const pattern = new RegExp(
    `<table\\b[^>]*summary\\s*=\\s*["']${escapeRegExp(summary)}["'][^>]*>([\\s\\S]*?)<\\/table>`,
    "i",
  );
  return html.match(pattern)?.[1] ?? "";
}

function extractRows(html: string) {
  return Array.from(html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), (match) =>
    match[1],
  );
}

function extractCells(html: string) {
  return Array.from(
    html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
    (match) => cleanTrackingText(match[1]),
  );
}

function extractFirstClassText(html: string, className: string) {
  const pattern = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*class\\s*=\\s*["'][^"']*(?:^|\\s)${escapeRegExp(className)}(?:\\s|$)[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  const direct = html.match(pattern)?.[2];
  if (direct) return cleanTrackingText(direct);

  const loosePattern = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*class\\s*=\\s*["'][^"']*${escapeRegExp(className)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  return cleanTrackingText(html.match(loosePattern)?.[2] ?? "");
}

function extractTextByAllClasses(html: string, classNames: string[]) {
  const elements = Array.from(
    html.matchAll(
      /<([a-z][\w:-]*)\b[^>]*class\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/\1>/gi,
    ),
  );
  const match = elements.find((element) => {
    const classes = element[2].split(/\s+/);
    return classNames.every((className) => classes.includes(className));
  });
  return cleanTrackingText(match?.[3] ?? "");
}

function extractListItemsByAncestorClass(html: string, className: string) {
  const ancestorPattern = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*class\\s*=\\s*["'][^"']*${escapeRegExp(className)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  const body = html.match(ancestorPattern)?.[2] ?? "";
  return Array.from(
    body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi),
    (match) => match[1],
  );
}

function formatJapanCarrierDateTime(value: string) {
  const cleaned = cleanTrackingText(value);
  const match = cleaned.match(
    /(\d{4})[/年](\d{1,2})[/月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/,
  );
  if (!match) return "";

  const [, year, month, day, hour = "0", minute = "0"] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00+09:00`;
}
