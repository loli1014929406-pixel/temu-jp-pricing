import { PackagePlus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { TemuOrderRecord } from "../../types";

type MergeShipmentModalProps = {
  orders: TemuOrderRecord[];
  saving: boolean;
  onClose: () => void;
  onSave: (primaryShipmentId: string) => void;
};

type MergeOrderOption = {
  shipmentId: string;
  orderNo: string;
  createdAt: string;
  quantity: number;
  productLabels: string[];
};

function buildOptions(orders: TemuOrderRecord[]) {
  const groups = new Map<string, MergeOrderOption>();
  orders.forEach((order) => {
    const shipmentId = order.shipment_id;
    const current = groups.get(shipmentId);
    groups.set(shipmentId, {
      shipmentId,
      orderNo: current?.orderNo ?? order.order_no,
      createdAt: current?.createdAt ?? order.created_at,
      quantity: (current?.quantity ?? 0) + order.fulfillment_quantity,
      productLabels: Array.from(
        new Set([
          ...(current?.productLabels ?? []),
          [order.sku_code, order.product_attributes].filter(Boolean).join(" / "),
        ].filter(Boolean)),
      ),
    });
  });
  return Array.from(groups.values()).sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.orderNo.localeCompare(right.orderNo),
  );
}

export function MergeShipmentModal({
  orders,
  saving,
  onClose,
  onSave,
}: MergeShipmentModalProps) {
  const options = useMemo(() => buildOptions(orders), [orders]);
  const [primaryShipmentId, setPrimaryShipmentId] = useState(
    () => options[0]?.shipmentId ?? "",
  );
  const recipient = orders[0];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merge-shipment-title"
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="merge-shipment-title" className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <PackagePlus size={20} />
              确认合并发货
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              将 {options.length} 个原始订单确认为一个物理包裹。订单号和子订单号不会改变。
            </p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="text-slate-400 transition hover:text-slate-600 disabled:opacity-50"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            <p className="font-semibold">收件信息已一致</p>
            <p className="mt-1 break-words">
              {recipient?.recipient_name || "--"} · {recipient?.recipient_phone || "--"} · {recipient?.postal_code || "--"}
            </p>
            <p className="mt-1 break-words">
              {[
                recipient?.province,
                recipient?.city,
                recipient?.district,
                recipient?.address_line1,
                recipient?.address_line2,
              ].filter(Boolean).join("") || "--"}
            </p>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-bold text-slate-800">
              选择主订单
            </legend>
            <p className="mb-3 text-xs text-slate-500">
              运费只记在主订单；其他订单运费为 0。默认选择最早创建的订单。
            </p>
            {options.map((option) => (
              <label
                key={option.shipmentId}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                  primaryShipmentId === option.shipmentId
                    ? "border-sky-400 bg-sky-50"
                    : "border-line bg-white hover:border-slate-300"
                }`}
              >
                <input
                  type="radio"
                  name="primary-shipment"
                  value={option.shipmentId}
                  checked={primaryShipmentId === option.shipmentId}
                  onChange={() => setPrimaryShipmentId(option.shipmentId)}
                  className="mt-1 h-4 w-4 border-slate-300 text-sky-700 focus:ring-sky-500"
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-all text-sm font-bold text-slate-900">
                    {option.orderNo}
                  </span>
                  <span className="mt-1 block text-xs text-slate-500">
                    {option.quantity} 件 · {option.productLabels.join("；") || "未识别商品"}
                  </span>
                </span>
                {primaryShipmentId === option.shipmentId && (
                  <span className="shrink-0 rounded-full bg-sky-700 px-2 py-1 text-[11px] font-bold text-white">
                    主订单
                  </span>
                )}
              </label>
            ))}
          </fieldset>

          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">
            确认后，该包裹统一选择仓库和物流方式、统一占用库存并共用一个物流单号。只有全部成员仍在待分配阶段时才能取消合并。
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button type="button" disabled={saving} onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button
            type="button"
            disabled={saving || !primaryShipmentId}
            onClick={() => onSave(primaryShipmentId)}
            className="btn-primary"
          >
            {saving ? "正在合并..." : `确认合并 ${options.length} 个订单`}
          </button>
        </div>
      </div>
    </div>
  );
}
