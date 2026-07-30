import type { TemuOrderRecord } from "../types";

export type TrackingFileRecord = {
  sourceRowNumber: number;
  orderNo: string;
  subOrderNo: string;
  trackingNo: string;
};

export type TrackingImportRowStatus =
  | "importable"
  | "missing_order_no"
  | "missing_sub_order_no"
  | "missing_tracking_no"
  | "unmatched_order"
  | "unmatched_sub_order"
  | "ambiguous_package"
  | "duplicate_order_key"
  | "duplicate_tracking_no";

export type TrackingImportPreviewRow = TrackingFileRecord & {
  status: TrackingImportRowStatus;
  message: string;
  shipmentId: string;
  packageSequence: number | null;
};

export type TrackingImportMatch = {
  record: TrackingFileRecord;
  shipmentId: string;
  orders: TemuOrderRecord[];
};

export type TrackingImportPreview = {
  rows: TrackingImportPreviewRow[];
  matches: TrackingImportMatch[];
};

type ShipmentGroup = {
  shipmentId: string;
  orders: TemuOrderRecord[];
  packageSequence: number;
  packageCount: number;
  isSplit: boolean;
};

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function buildShipmentGroups(orders: TemuOrderRecord[]) {
  const groups = new Map<string, TemuOrderRecord[]>();
  orders.forEach((order) => {
    const key = order.shipment_id || order.id;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  });
  return [...groups.entries()].map(([shipmentId, shipmentOrders]) => {
    const primary = shipmentOrders[0];
    return {
      shipmentId,
      orders: shipmentOrders,
      packageSequence: Math.max(1, primary?.package_sequence ?? 1),
      packageCount: Math.max(1, primary?.package_count ?? 1),
      isSplit: Boolean(
        primary?.is_split ||
        (primary?.package_count ?? 1) > 1,
      ),
    } satisfies ShipmentGroup;
  });
}

function rowWithStatus(
  record: TrackingFileRecord,
  status: TrackingImportRowStatus,
  message: string,
  shipment?: ShipmentGroup,
): TrackingImportPreviewRow {
  return {
    ...record,
    status,
    message,
    shipmentId: shipment?.shipmentId ?? "",
    packageSequence: shipment?.packageSequence ?? null,
  };
}

export function buildTrackingImportPreview(
  records: TrackingFileRecord[],
  pendingShippingOrders: TemuOrderRecord[],
): TrackingImportPreview {
  const shipments = buildShipmentGroups(pendingShippingOrders);
  const shipmentsByOrderNo = shipments.reduce<Map<string, ShipmentGroup[]>>(
    (groups, shipment) => {
      const orderNo = normalizeKey(shipment.orders[0]?.order_no ?? "");
      if (orderNo) {
        groups.set(orderNo, [...(groups.get(orderNo) ?? []), shipment]);
      }
      return groups;
    },
    new Map(),
  );
  const orderKeyCounts = new Map<string, number>();
  const trackingCounts = new Map<string, number>();
  records.forEach((record) => {
    const orderNo = normalizeKey(record.orderNo);
    const subOrderNo = normalizeKey(record.subOrderNo);
    if (orderNo) {
      const key = `${orderNo}\u0000${subOrderNo}`;
      orderKeyCounts.set(key, (orderKeyCounts.get(key) ?? 0) + 1);
    }
    const trackingNo = normalizeKey(record.trackingNo);
    if (trackingNo) {
      trackingCounts.set(trackingNo, (trackingCounts.get(trackingNo) ?? 0) + 1);
    }
  });

  const firstPass = records.map((record) => {
    const orderNo = normalizeKey(record.orderNo);
    const subOrderNo = normalizeKey(record.subOrderNo);
    const trackingNo = normalizeKey(record.trackingNo);
    if (!orderNo) {
      return rowWithStatus(record, "missing_order_no", "订单号为空");
    }
    if (!trackingNo) {
      return rowWithStatus(record, "missing_tracking_no", "物流单号为空");
    }
    if ((trackingCounts.get(trackingNo) ?? 0) > 1) {
      return rowWithStatus(
        record,
        "duplicate_tracking_no",
        "同一文件中物流单号重复，已整组跳过",
      );
    }
    const orderKey = `${orderNo}\u0000${subOrderNo}`;
    if ((orderKeyCounts.get(orderKey) ?? 0) > 1) {
      return rowWithStatus(
        record,
        "duplicate_order_key",
        "同一文件中订单匹配键重复，已整组跳过",
      );
    }

    const orderShipments = shipmentsByOrderNo.get(orderNo) ?? [];
    if (orderShipments.length === 0) {
      return rowWithStatus(
        record,
        "unmatched_order",
        "未找到对应的待发货订单",
      );
    }
    const needsSubOrder =
      orderShipments.length > 1 ||
      orderShipments.some((shipment) => shipment.isSplit);
    if (!needsSubOrder) {
      return rowWithStatus(
        record,
        "importable",
        "订单号匹配成功",
        orderShipments[0],
      );
    }
    if (!subOrderNo) {
      return rowWithStatus(
        record,
        "missing_sub_order_no",
        "该订单已经拆包，必须提供子订单号",
      );
    }

    const packageMatches = orderShipments.filter((shipment) =>
      shipment.orders.some(
        (order) => normalizeKey(order.sub_order_no) === subOrderNo,
      ),
    );
    if (packageMatches.length === 0) {
      return rowWithStatus(
        record,
        "unmatched_sub_order",
        "订单号存在，但没有待发货包裹包含该子订单号",
      );
    }
    if (packageMatches.length > 1) {
      return rowWithStatus(
        record,
        "ambiguous_package",
        "同一子订单号存在于多个包裹，无法唯一匹配",
      );
    }
    return rowWithStatus(
      record,
      "importable",
      `订单号和子订单号匹配包裹 ${packageMatches[0].packageSequence}`,
      packageMatches[0],
    );
  });

  const matchedShipmentCounts = firstPass.reduce<Map<string, number>>(
    (counts, row) => {
      if (row.status === "importable" && row.shipmentId) {
        counts.set(
          row.shipmentId,
          (counts.get(row.shipmentId) ?? 0) + 1,
        );
      }
      return counts;
    },
    new Map(),
  );
  const rows = firstPass.map((row) =>
    row.status === "importable" &&
    (matchedShipmentCounts.get(row.shipmentId) ?? 0) > 1
      ? {
          ...row,
          status: "duplicate_order_key" as const,
          message: "多行数据匹配到同一包裹，已整组跳过",
          shipmentId: "",
          packageSequence: null,
        }
      : row,
  );
  const shipmentById = new Map(
    shipments.map((shipment) => [shipment.shipmentId, shipment]),
  );
  const matches = rows.flatMap((row) => {
    if (row.status !== "importable" || !row.shipmentId) return [];
    const shipment = shipmentById.get(row.shipmentId);
    if (!shipment) return [];
    return [{
      record: {
        sourceRowNumber: row.sourceRowNumber,
        orderNo: row.orderNo,
        subOrderNo: row.subOrderNo,
        trackingNo: row.trackingNo,
      },
      shipmentId: shipment.shipmentId,
      orders: shipment.orders,
    }];
  });

  return { rows, matches };
}
