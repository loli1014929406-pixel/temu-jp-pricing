import {
  ArrowRight,
  CheckCircle2,
  Download,
  Eye,
  Save,
  Sparkles,
  Trash2,
  Truck,
} from "lucide-react";
import type { Warehouse } from "../../types";

type OrderBulkActionsProps = {
  activeStage: string;
  busyKey: string;
  canDelete: boolean;
  canEdit: boolean;
  selectedOrderLineInViewCount: number;
  selectedInViewCount: number;
  selectedNewOrderRowCount: number;
  selectedPendingShippingRowCount: number;
  selectedShippedRowCount: number;
  selectedUploadedTemuRowCount: number;
  selectedNewOrdersInViewCount: number;
  selectedPendingShippingOrdersInViewCount: number;
  selectedCompletableOrdersInViewCount: number;
  selectedSingleOrderInView: boolean;
  canManageSelectedShippedOrders: boolean;
  hasSelectedCompletedOrders: boolean;
  bulkWarehouseId: string;
  bulkLogisticsMethod: string;
  bulkLogisticsMethodOptions: string[];
  warehouses: Warehouse[];
  filteredOrdersCount: number;
  onClearSelection: () => void;
  onShowSelectedDetail: () => void;
  onMoveNewOrdersToPendingShipping: () => void;
  onSaveSelectedOrders: () => void;
  onDownloadShippingTable: () => void;
  onDownloadTemuUploadTable: () => void;
  onMarkSelectedUploadedTemu: () => void;
  onMarkSelectedCompleted: () => void;
  onDeleteSelectedOrders: () => void;
  onBulkWarehouseChange: (warehouseId: string) => void;
  onBulkLogisticsMethodChange: (method: string) => void;
  onBulkAssign: () => void;
  onAutoMatchPendingOrders: () => void;
};

export function OrderBulkActions({
  activeStage,
  busyKey,
  canDelete,
  canEdit,
  selectedOrderLineInViewCount,
  selectedInViewCount,
  selectedNewOrderRowCount,
  selectedPendingShippingRowCount,
  selectedShippedRowCount,
  selectedUploadedTemuRowCount,
  selectedNewOrdersInViewCount,
  selectedPendingShippingOrdersInViewCount,
  selectedCompletableOrdersInViewCount,
  selectedSingleOrderInView,
  canManageSelectedShippedOrders,
  hasSelectedCompletedOrders,
  bulkWarehouseId,
  bulkLogisticsMethod,
  bulkLogisticsMethodOptions,
  warehouses,
  filteredOrdersCount,
  onClearSelection,
  onShowSelectedDetail,
  onMoveNewOrdersToPendingShipping,
  onSaveSelectedOrders,
  onDownloadShippingTable,
  onDownloadTemuUploadTable,
  onMarkSelectedUploadedTemu,
  onMarkSelectedCompleted,
  onDeleteSelectedOrders,
  onBulkWarehouseChange,
  onBulkLogisticsMethodChange,
  onBulkAssign,
  onAutoMatchPendingOrders,
}: OrderBulkActionsProps) {
  return (
    <>
      {selectedOrderLineInViewCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="text-sm font-semibold text-slate-900">
            已选 {selectedInViewCount || selectedOrderLineInViewCount}
            {selectedInViewCount > 0 ? " 行" : " 条明细"}
            {selectedInViewCount > 0 && selectedOrderLineInViewCount !== selectedInViewCount
              ? `（${selectedOrderLineInViewCount} 条明细）`
              : ""}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={Boolean(busyKey)}
              onClick={onClearSelection}
              className="text-sm font-medium text-slate-500 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              清空选中
            </button>
            {canEdit && activeStage === "new_order" && selectedNewOrdersInViewCount > 0 && (
              <button
                type="button"
                disabled={busyKey === "download-batch"}
                onClick={onMoveNewOrdersToPendingShipping}
                className="btn-secondary h-9 px-3"
              >
                <Truck size={16} />
                转到待发货（{selectedNewOrderRowCount}）
              </button>
            )}
            <button
              type="button"
              disabled={Boolean(busyKey) || !selectedSingleOrderInView}
              onClick={onShowSelectedDetail}
              title={selectedSingleOrderInView ? undefined : "详情只能查看单条订单"}
              className="btn-secondary h-9 px-3"
            >
              <Eye size={16} />
              详情
            </button>
            {canEdit && (
              <button
                type="button"
                disabled={busyKey === "save-selected"}
                onClick={onSaveSelectedOrders}
                className="btn-secondary h-9 px-3"
              >
                <Save size={16} />
                保存（{selectedInViewCount}）
              </button>
            )}
            {canEdit &&
              activeStage === "pending_shipping" &&
              selectedPendingShippingOrdersInViewCount > 0 && (
                <button
                  type="button"
                  disabled={busyKey === "download-shipping-table"}
                  onClick={onDownloadShippingTable}
                  className="btn-secondary h-9 px-3"
                >
                  <Download size={16} />
                  下载发货表格（{selectedPendingShippingRowCount}）
                </button>
              )}
            {canEdit && canManageSelectedShippedOrders && (
              <>
                <button
                  type="button"
                  disabled={busyKey === "download-temu-upload-table"}
                  onClick={onDownloadTemuUploadTable}
                  className="btn-secondary h-9 px-3"
                >
                  <Download size={16} />
                  下载上传Temu表格（{selectedShippedRowCount}）
                </button>
                <button
                  type="button"
                  disabled={busyKey === "uploaded-temu-selected"}
                  onClick={onMarkSelectedUploadedTemu}
                  className="btn-secondary h-9 px-3"
                >
                  <ArrowRight size={16} />
                  转到上传Temu（{selectedShippedRowCount}）
                </button>
              </>
            )}
            {canEdit &&
              activeStage === "uploaded_temu" &&
              selectedCompletableOrdersInViewCount > 0 && (
                <button
                  type="button"
                  disabled={busyKey === "complete-selected"}
                  onClick={onMarkSelectedCompleted}
                  className="btn-secondary h-9 px-3"
                >
                  <CheckCircle2 size={16} />
                  签收（{selectedUploadedTemuRowCount}）
                </button>
              )}
            {canDelete && (
              <button
                type="button"
                disabled={busyKey === "delete-selected" || hasSelectedCompletedOrders}
                onClick={onDeleteSelectedOrders}
                title={hasSelectedCompletedOrders ? "已完成订单不能删除" : undefined}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-600 shadow-sm transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 size={16} />
                删除（{selectedInViewCount}）
              </button>
            )}
          </div>
        </div>
      )}

      {canEdit && activeStage === "pending_assignment" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <span className="text-sm font-semibold text-slate-700">批量分配</span>
          <span className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
            已选 {selectedInViewCount}
          </span>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
            <span>仓库</span>
            <select
              value={bulkWarehouseId}
              disabled={busyKey === "bulk-assign"}
              onChange={(event) => onBulkWarehouseChange(event.target.value)}
              className="h-10 min-w-40 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
            >
              <option value="">不修改仓库</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
            <span>发货方式</span>
            <select
              value={bulkLogisticsMethod}
              disabled={busyKey === "bulk-assign"}
              onChange={(event) => onBulkLogisticsMethodChange(event.target.value)}
              className="h-10 min-w-44 rounded-md border border-line bg-white px-3 text-sm outline-none focus:border-accent"
            >
              <option value="">不修改发货方式</option>
              {bulkLogisticsMethodOptions.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={
              selectedOrderLineInViewCount === 0 ||
              busyKey === "bulk-assign" ||
              (!bulkWarehouseId && !bulkLogisticsMethod.trim())
            }
            onClick={onBulkAssign}
            className="btn-primary h-10 px-3"
          >
            批量分配
          </button>
          <button
            type="button"
            disabled={busyKey === "auto-match" || filteredOrdersCount === 0}
            onClick={onAutoMatchPendingOrders}
            className="btn-secondary h-10 px-3"
          >
            <Sparkles size={16} />
            自动匹配
          </button>
        </div>
      )}
    </>
  );
}
