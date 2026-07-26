import { Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { TemuOrderRecord } from "../../types";

type SplitSourceLine = {
  orderId: string;
  subOrderNo: string;
  skuCode: string;
  productAttributes: string;
  quantity: number;
};

type SplitOrderModalProps = {
  orders: TemuOrderRecord[];
  saving: boolean;
  onClose: () => void;
  onSave: (
    packages: Array<{
      items: Array<{ orderId: string; quantity: number }>;
    }>,
  ) => void;
};

function buildSourceLines(orders: TemuOrderRecord[]) {
  const lines = new Map<string, SplitSourceLine>();
  orders.forEach((order) => {
    const orderId = order.source_order_id || order.id;
    const current = lines.get(orderId);
    lines.set(orderId, {
      orderId,
      subOrderNo: order.sub_order_no,
      skuCode: order.sku_code,
      productAttributes: order.product_attributes,
      quantity: (current?.quantity ?? 0) + order.fulfillment_quantity,
    });
  });
  return Array.from(lines.values()).sort((left, right) =>
    `${left.skuCode}\u0000${left.subOrderNo}`.localeCompare(
      `${right.skuCode}\u0000${right.subOrderNo}`,
    ),
  );
}

function buildInitialAllocations(
  orders: TemuOrderRecord[],
  sourceLines: SplitSourceLine[],
) {
  const currentPackageCount = Math.max(
    1,
    ...orders.map((order) => order.package_count || 1),
  );
  const packageCount = currentPackageCount > 1 ? currentPackageCount : 2;
  const allocations = Array.from({ length: packageCount }, () =>
    Object.fromEntries(sourceLines.map((line) => [line.orderId, 0])),
  );

  if (currentPackageCount > 1) {
    orders.forEach((order) => {
      const packageIndex = Math.max(0, order.package_sequence - 1);
      const orderId = order.source_order_id || order.id;
      const target = allocations[packageIndex];
      if (target) {
        target[orderId] = (target[orderId] ?? 0) + order.fulfillment_quantity;
      }
    });
    return allocations;
  }

  sourceLines.forEach((line) => {
    allocations[0][line.orderId] = line.quantity;
  });
  const donor = sourceLines.find((line) => line.quantity > 0);
  if (donor) {
    allocations[0][donor.orderId] -= 1;
    allocations[1][donor.orderId] = 1;
  }
  return allocations;
}

export function SplitOrderModal({
  orders,
  saving,
  onClose,
  onSave,
}: SplitOrderModalProps) {
  const sourceLines = useMemo(() => buildSourceLines(orders), [orders]);
  const [allocations, setAllocations] = useState<Array<Record<string, number>>>(
    () => buildInitialAllocations(orders, sourceLines),
  );
  const [errorMessage, setErrorMessage] = useState("");
  const orderNo = orders[0]?.order_no ?? "";
  const totalQuantity = sourceLines.reduce(
    (total, line) => total + line.quantity,
    0,
  );

  const packageTotals = allocations.map((shipmentPackage) =>
    Object.values(shipmentPackage).reduce(
      (total, quantity) => total + quantity,
      0,
    ),
  );
  const allocatedByOrderId = Object.fromEntries(
    sourceLines.map((line) => [
      line.orderId,
      allocations.reduce(
        (total, shipmentPackage) =>
          total + (shipmentPackage[line.orderId] ?? 0),
        0,
      ),
    ]),
  );

  function updateQuantity(
    packageIndex: number,
    orderId: string,
    rawValue: string,
  ) {
    const quantity = Math.max(0, Number.parseInt(rawValue, 10) || 0);
    const sourceQuantity =
      sourceLines.find((line) => line.orderId === orderId)?.quantity ?? 0;
    setAllocations((current) =>
      current.map((shipmentPackage, index) =>
        index === packageIndex
          ? {
              ...shipmentPackage,
              [orderId]: Math.min(sourceQuantity, quantity),
            }
          : shipmentPackage,
      ),
    );
    setErrorMessage("");
  }

  function addPackage() {
    if (allocations.length >= totalQuantity) {
      setErrorMessage(`包裹数不能超过商品总件数 ${totalQuantity}。`);
      return;
    }

    const donorPackageIndex = packageTotals.findIndex((total) => total > 1);
    if (donorPackageIndex < 0) {
      setErrorMessage("没有可继续拆出的商品数量。");
      return;
    }
    const donorLine = sourceLines.find(
      (line) => (allocations[donorPackageIndex][line.orderId] ?? 0) > 0,
    );
    if (!donorLine) return;

    setAllocations((current) => {
      const next = current.map((shipmentPackage) => ({ ...shipmentPackage }));
      next[donorPackageIndex][donorLine.orderId] -= 1;
      next.push(
        Object.fromEntries(
          sourceLines.map((line) => [
            line.orderId,
            line.orderId === donorLine.orderId ? 1 : 0,
          ]),
        ),
      );
      return next;
    });
    setErrorMessage("");
  }

  function removePackage(packageIndex: number) {
    if (allocations.length <= 2) {
      setErrorMessage("拆单后至少保留 2 个包裹。");
      return;
    }
    setAllocations((current) => {
      const targetIndex = packageIndex === 0 ? 1 : packageIndex - 1;
      const removed = current[packageIndex];
      return current
        .map((shipmentPackage, index) =>
          index === targetIndex
            ? Object.fromEntries(
                sourceLines.map((line) => [
                  line.orderId,
                  (shipmentPackage[line.orderId] ?? 0) +
                    (removed[line.orderId] ?? 0),
                ]),
              )
            : shipmentPackage,
        )
        .filter((_, index) => index !== packageIndex);
    });
    setErrorMessage("");
  }

  function submit() {
    if (allocations.length < 2) {
      setErrorMessage("拆单后至少需要 2 个包裹。");
      return;
    }
    if (packageTotals.some((total) => total <= 0)) {
      setErrorMessage("每个包裹都必须至少包含 1 件商品。");
      return;
    }
    const mismatchedLine = sourceLines.find(
      (line) => allocatedByOrderId[line.orderId] !== line.quantity,
    );
    if (mismatchedLine) {
      setErrorMessage(
        `${mismatchedLine.skuCode || mismatchedLine.subOrderNo || "订单商品"} 分配合计必须为 ${mismatchedLine.quantity}。`,
      );
      return;
    }

    onSave(
      allocations.map((shipmentPackage) => ({
        items: sourceLines
          .map((line) => ({
            orderId: line.orderId,
            quantity: shipmentPackage[line.orderId] ?? 0,
          }))
          .filter((item) => item.quantity > 0),
      })),
    );
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="split-order-title"
    >
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h2 id="split-order-title" className="text-lg font-bold text-slate-900">
              {orders[0]?.is_split ? "编辑拆单" : "拆分订单"}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {orderNo} · 共 {totalQuantity} 件 · {allocations.length} 个包裹
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭拆单窗口"
            className="text-slate-400 transition hover:text-slate-600"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600">
              这里只分配商品数量；保存后每个包裹仍在“待分配”，再分别选择仓库和尾程方式。
            </p>
            <button
              type="button"
              onClick={addPackage}
              disabled={saving || allocations.length >= totalQuantity}
              className="btn-secondary h-9 px-3"
            >
              <Plus size={16} />
              增加包裹
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full border-collapse text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
                <tr>
                  <th className="sticky left-0 z-10 min-w-64 border-b border-r border-slate-200 bg-slate-50 px-4 py-3">
                    商品
                  </th>
                  <th className="w-20 border-b border-slate-200 px-3 py-3 text-center">
                    原数量
                  </th>
                  {allocations.map((_, packageIndex) => (
                    <th
                      key={packageIndex}
                      className="min-w-32 border-b border-l border-slate-200 px-3 py-3 text-center"
                    >
                      <span>包裹 {packageIndex + 1}</span>
                      <span className="ml-1 text-slate-400">
                        ({packageTotals[packageIndex]}件)
                      </span>
                      {allocations.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removePackage(packageIndex)}
                          disabled={saving}
                          aria-label={`删除包裹 ${packageIndex + 1}`}
                          className="ml-2 text-slate-400 hover:text-rose-600"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sourceLines.map((line) => {
                  const allocated = allocatedByOrderId[line.orderId] ?? 0;
                  const balanced = allocated === line.quantity;
                  return (
                    <tr key={line.orderId} className="border-b border-slate-100 last:border-b-0">
                      <td className="sticky left-0 z-10 border-r border-slate-200 bg-white px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-slate-800">
                          {line.skuCode || "--"}
                        </p>
                        <p className="mt-1 max-w-64 truncate text-xs text-slate-500">
                          {line.productAttributes || line.subOrderNo || "无规格"}
                        </p>
                      </td>
                      <td className="px-3 py-3 text-center">
                        <span className="font-semibold text-slate-800">{line.quantity}</span>
                        <span
                          className={`mt-1 block text-[10px] ${balanced ? "text-emerald-600" : "text-rose-600"}`}
                        >
                          已分 {allocated}
                        </span>
                      </td>
                      {allocations.map((shipmentPackage, packageIndex) => (
                        <td
                          key={packageIndex}
                          className="border-l border-slate-100 px-3 py-3 text-center"
                        >
                          <input
                            type="number"
                            min={0}
                            max={line.quantity}
                            value={shipmentPackage[line.orderId] ?? 0}
                            onChange={(event) =>
                              updateQuantity(
                                packageIndex,
                                line.orderId,
                                event.target.value,
                              )
                            }
                            disabled={saving}
                            aria-label={`${line.skuCode || line.subOrderNo} 分配到包裹 ${packageIndex + 1} 的数量`}
                            className="h-9 w-20 rounded-lg border border-line px-2 text-center font-semibold outline-none focus:border-accent"
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {errorMessage && (
            <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 bg-slate-50 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn-secondary h-10 px-4"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="btn-primary h-10 px-5"
          >
            {saving ? "保存中..." : "保存拆单"}
          </button>
        </div>
      </div>
    </div>
  );
}
