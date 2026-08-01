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
  | "duplicate_tracking_no"
  | "conflicting_tracking_no";

export type TrackingImportPreviewRow = TrackingFileRecord & {
  status: TrackingImportRowStatus;
  message: string;
  shipmentId: string;
  physicalGroupKey: string;
  packageSequence: number | null;
};

export type TrackingImportMatch = {
  record: TrackingFileRecord;
  shipmentId: string;
  physicalGroupKey: string;
  orders: TemuOrderRecord[];
};

export type TrackingImportPreview = {
  rows: TrackingImportPreviewRow[];
  matches: TrackingImportMatch[];
};

type ShipmentGroup = {
  physicalGroupKey: string;
  shipmentId: string;
  orders: TemuOrderRecord[];
  packageSequence: number;
  packageCount: number;
  isSplit: boolean;
  isCombined: boolean;
};

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function buildShipmentGroups(orders: TemuOrderRecord[]) {
  const groups = new Map<string, TemuOrderRecord[]>();
  orders.forEach((order) => {
    const key = order.combined_shipment_id || order.shipment_id || order.id;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  });
  return [...groups.entries()].map(([physicalGroupKey, shipmentOrders]) => {
    const sortedOrders = [...shipmentOrders].sort((left, right) => {
      const byPrimary = Number(right.combined_is_primary) - Number(left.combined_is_primary);
      return byPrimary || left.id.localeCompare(right.id);
    });
    const primary = sortedOrders[0];
    return {
      physicalGroupKey,
      shipmentId:
        primary?.combined_primary_shipment_id || primary?.shipment_id || physicalGroupKey,
      orders: sortedOrders,
      packageSequence: Math.max(1, primary?.package_sequence ?? 1),
      packageCount: Math.max(1, primary?.package_count ?? 1),
      isSplit: sortedOrders.some(
        (order) => order.is_split || (order.package_count ?? 1) > 1,
      ),
      isCombined: sortedOrders.some((order) => order.is_combined_shipment),
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
    physicalGroupKey: shipment?.physicalGroupKey ?? "",
    packageSequence: shipment?.packageSequence ?? null,
  };
}

function rejectRow(
  row: TrackingImportPreviewRow,
  status: TrackingImportRowStatus,
  message: string,
) {
  return {
    ...row,
    status,
    message,
    shipmentId: "",
    physicalGroupKey: "",
    packageSequence: null,
  };
}

export function buildTrackingImportPreview(
  records: TrackingFileRecord[],
  pendingShippingOrders: TemuOrderRecord[],
): TrackingImportPreview {
  const shipments = buildShipmentGroups(pendingShippingOrders);
  const shipmentsByOrderNo = shipments.reduce<Map<string, ShipmentGroup[]>>(
    (groups, shipment) => {
      const orderNos = new Set(
        shipment.orders
          .map((order) => normalizeKey(order.order_no))
          .filter(Boolean),
      );
      orderNos.forEach((orderNo) => {
        const current = groups.get(orderNo) ?? [];
        if (!current.some((candidate) => candidate.physicalGroupKey === shipment.physicalGroupKey)) {
          groups.set(orderNo, [...current, shipment]);
        }
      });
      return groups;
    },
    new Map(),
  );
  const orderKeyCounts = new Map<string, number>();
  records.forEach((record) => {
    const orderNo = normalizeKey(record.orderNo);
    if (!orderNo) return;
    const key = `${orderNo}\u0000${normalizeKey(record.subOrderNo)}`;
    orderKeyCounts.set(key, (orderKeyCounts.get(key) ?? 0) + 1);
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
      return rowWithStatus(record, "unmatched_order", "未找到对应的待发货订单");
    }
    const needsSubOrder =
      orderShipments.length > 1 || orderShipments.some((shipment) => shipment.isSplit);
    if (!needsSubOrder) {
      const shipment = orderShipments[0];
      return rowWithStatus(
        record,
        "importable",
        shipment.isCombined ? "订单号匹配已确认的合并包裹" : "订单号匹配成功",
        shipment,
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
        (order) =>
          normalizeKey(order.order_no) === orderNo &&
          normalizeKey(order.sub_order_no) === subOrderNo,
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

  const physicalTrackingSets = new Map<string, Set<string>>();
  firstPass.forEach((row) => {
    if (row.status !== "importable" || !row.physicalGroupKey) return;
    const values = physicalTrackingSets.get(row.physicalGroupKey) ?? new Set<string>();
    values.add(normalizeKey(row.trackingNo));
    physicalTrackingSets.set(row.physicalGroupKey, values);
  });
  let rows = firstPass.map((row) =>
    row.status === "importable" &&
    (physicalTrackingSets.get(row.physicalGroupKey)?.size ?? 0) > 1
      ? rejectRow(
          row,
          "conflicting_tracking_no",
          "同一包裹对应多个物流单号，已整组跳过",
        )
      : row,
  );

  const indexesByTracking = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const trackingNo = normalizeKey(row.trackingNo);
    if (!trackingNo) return;
    indexesByTracking.set(trackingNo, [...(indexesByTracking.get(trackingNo) ?? []), index]);
  });
  const rejectedTrackingNumbers = new Set<string>();
  indexesByTracking.forEach((indexes, trackingNo) => {
    if (indexes.length < 2) return;
    const matchedPhysicalGroups = new Set(
      indexes
        .map((index) => rows[index])
        .filter((row) => row.status === "importable" && row.physicalGroupKey)
        .map((row) => row.physicalGroupKey),
    );
    const allImportable = indexes.every((index) => rows[index].status === "importable");
    if (!allImportable || matchedPhysicalGroups.size !== 1) {
      rejectedTrackingNumbers.add(trackingNo);
    }
  });
  rows = rows.map((row) =>
    rejectedTrackingNumbers.has(normalizeKey(row.trackingNo))
      ? rejectRow(
          row,
          "duplicate_tracking_no",
          "相同物流单号匹配到不同或未确认的包裹，已整组跳过",
        )
      : row,
  );

  const shipmentByPhysicalKey = new Map(
    shipments.map((shipment) => [shipment.physicalGroupKey, shipment]),
  );
  const matchedPhysicalGroups = new Set<string>();
  const matches = rows.flatMap((row) => {
    if (row.status !== "importable" || !row.physicalGroupKey) return [];
    if (matchedPhysicalGroups.has(row.physicalGroupKey)) return [];
    const shipment = shipmentByPhysicalKey.get(row.physicalGroupKey);
    if (!shipment) return [];
    matchedPhysicalGroups.add(row.physicalGroupKey);
    return [{
      record: {
        sourceRowNumber: row.sourceRowNumber,
        orderNo: row.orderNo,
        subOrderNo: row.subOrderNo,
        trackingNo: row.trackingNo,
      },
      shipmentId: shipment.shipmentId,
      physicalGroupKey: shipment.physicalGroupKey,
      orders: shipment.orders,
    }];
  });

  return { rows, matches };
}
