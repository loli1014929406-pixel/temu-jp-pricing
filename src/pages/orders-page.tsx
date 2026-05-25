import type { User } from "@supabase/supabase-js";
import { FileSpreadsheet, Save, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../components/ui";
import { usePermissions } from "../hooks/use-permissions";
import {
  deleteTemuOrder,
  fetchTemuOrders,
  importTemuOrders,
  updateTemuOrder,
  type TemuOrderImportRow,
} from "../lib/orders";
import type { TemuOrderRecord } from "../types";
import { getErrorMessage } from "../utils/errors";

type OrdersPageProps = {
  user: User;
};

type OrderDraft = Pick<
  TemuOrderRecord,
  "order_status" | "actual_ship_time"
>;

const importColumns = [
  "订单号",
  "子订单号",
  "订单状态",
  "应履约件数",
  "商品属性",
  "收货人姓名",
  "收货人联系方式",
  "邮箱",
  "省份",
  "城市",
  "区县",
  "详细地址1",
  "详细地址2",
  "收货地址邮编",
  "要求最晚发货时间",
  "实际发货时间",
  "预计送达时间",
] as const;

const visibleColumns = [
  { label: "订单号", className: "order-no-col" },
  { label: "发货状态" },
  { label: "应履约件数" },
  { label: "商品属性", className: "order-attr-col" },
  { label: "收货人姓名" },
  { label: "收货人联系方式", className: "order-phone-col" },
  { label: "地址", className: "order-address-col" },
  { label: "收货地址邮编" },
  { label: "要求最晚发货时间", className: "order-time-col" },
  { label: "实际发货时间", className: "order-time-col" },
  { label: "预计送达时间", className: "order-time-col" },
  { label: "操作" },
] satisfies Array<{ label: string; className?: string }>;

function cleanCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text === "--" ? "" : text;
}

function readCell(row: Record<string, unknown>, column: (typeof importColumns)[number]) {
  return cleanCell(row[column]);
}

function parseFulfillmentQuantity(value: string) {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? Math.trunc(quantity) : 0;
}

function toDraft(order: TemuOrderRecord): OrderDraft {
  return {
    order_status: order.order_status,
    actual_ship_time: order.actual_ship_time,
  };
}

function getFullAddress(order: TemuOrderRecord) {
  return [
    order.province,
    order.city,
    order.district,
    order.address_line1,
    order.address_line2,
  ].filter(Boolean).join(" ");
}

function getOrdersErrorMessage(error: unknown, fallback: string) {
  const message = getErrorMessage(error, fallback);
  return message.includes("public.temu_orders")
    ? "订单管理数据库还没有初始化，请先执行最新的订单表迁移"
    : message;
}

export function OrdersPage({ user }: OrdersPageProps) {
  const { canEdit, canDelete } = usePermissions();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [orders, setOrders] = useState<TemuOrderRecord[]>([]);
  const [drafts, setDrafts] = useState<Record<string, OrderDraft>>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setErrorMessage("");
      try {
        const nextOrders = await fetchTemuOrders();
        if (!active) return;
        setOrders(nextOrders);
        setDrafts(Object.fromEntries(nextOrders.map((order) => [order.id, toDraft(order)])));
      } catch (error) {
        if (active) setErrorMessage(getOrdersErrorMessage(error, "加载订单失败"));
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [user.id]);

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return orders;
    return orders.filter((order) =>
      [
        order.order_no,
        order.order_status,
        order.product_attributes,
        order.recipient_name,
        order.recipient_phone,
        order.email,
        order.province,
        order.city,
        order.district,
        order.address_line1,
        order.address_line2,
        order.postal_code,
      ].some((value) => value.toLowerCase().includes(term)),
    );
  }, [orders, search]);

  const pendingCount = orders.filter((order) => order.order_status.includes("待")).length;
  const shippedCount = orders.filter((order) => order.actual_ship_time.trim()).length;

  async function handleFileChange(file: File | undefined) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能导入订单。");
      return;
    }
    if (!file) return;

    setBusyKey("import");
    setErrorMessage("");
    setNoticeMessage("");

    try {
      const XLSX = await import("xlsx");
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
      if (!sheet) throw new Error("Excel 文件里没有可读取的工作表");

      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
        raw: false,
      });
      const missingColumns = importColumns.filter(
        (column) => column !== "子订单号" && !Object.prototype.hasOwnProperty.call(rows[0] ?? {}, column),
      );
      if (missingColumns.length > 0) {
        throw new Error(`缺少必要列：${missingColumns.join("、")}`);
      }

      const importRows: TemuOrderImportRow[] = rows.flatMap((row, index) => {
        const orderNo = readCell(row, "订单号");
        if (!orderNo) return [];
        return [
          {
            order_no: orderNo,
            sub_order_no: readCell(row, "子订单号") || String(index + 2),
            order_status: readCell(row, "订单状态"),
            fulfillment_quantity: parseFulfillmentQuantity(readCell(row, "应履约件数")),
            product_attributes: readCell(row, "商品属性"),
            recipient_name: readCell(row, "收货人姓名"),
            recipient_phone: readCell(row, "收货人联系方式"),
            email: readCell(row, "邮箱"),
            province: readCell(row, "省份"),
            city: readCell(row, "城市"),
            district: readCell(row, "区县"),
            address_line1: readCell(row, "详细地址1"),
            address_line2: readCell(row, "详细地址2"),
            postal_code: readCell(row, "收货地址邮编"),
            latest_ship_time: readCell(row, "要求最晚发货时间"),
            actual_ship_time: readCell(row, "实际发货时间"),
            estimated_delivery_time: readCell(row, "预计送达时间"),
          },
        ];
      });
      if (importRows.length === 0) throw new Error("没有读取到可导入的订单行");

      await importTemuOrders(importRows);
      const nextOrders = await fetchTemuOrders();
      setOrders(nextOrders);
      setDrafts(Object.fromEntries(nextOrders.map((order) => [order.id, toDraft(order)])));
      setNoticeMessage(`已导入 ${importRows.length} 条订单数据`);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "导入订单失败"));
    } finally {
      setBusyKey("");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleSave(order: TemuOrderRecord) {
    if (!canEdit) {
      setErrorMessage("当前账号没有编辑权限，不能更新订单。");
      return;
    }

    const draft = drafts[order.id] ?? toDraft(order);
    setBusyKey(`save-${order.id}`);
    setErrorMessage("");
    setNoticeMessage("");
    try {
      const nextOrder = await updateTemuOrder(order.id, draft);
      setOrders((current) => current.map((item) => (item.id === order.id ? nextOrder : item)));
      setDrafts((current) => ({ ...current, [order.id]: toDraft(nextOrder) }));
      setNoticeMessage(`已保存订单 ${order.order_no}`);
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "保存订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  async function handleDelete(order: TemuOrderRecord) {
    if (!canDelete) {
      setErrorMessage("当前账号没有删除权限。");
      return;
    }
    const confirmed = window.confirm(`确认删除订单“${order.order_no}”吗？`);
    if (!confirmed) return;

    setBusyKey(`delete-${order.id}`);
    setErrorMessage("");
    setNoticeMessage("");
    try {
      await deleteTemuOrder(order.id);
      setOrders((current) => current.filter((item) => item.id !== order.id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[order.id];
        return next;
      });
    } catch (error) {
      setErrorMessage(getOrdersErrorMessage(error, "删除订单失败"));
    } finally {
      setBusyKey("");
    }
  }

  function updateDraft(orderId: string, field: keyof OrderDraft, value: string) {
    setDrafts((current) => ({
      ...current,
      [orderId]: {
        ...(current[orderId] ?? { order_status: "", actual_ship_time: "" }),
        [field]: value,
      },
    }));
  }

  return (
    <section className="grid gap-5">
      <PageHeader
        title="订单管理"
        description="上传 Temu 导出的订单表，并维护发货进度"
        actions={
          canEdit ? (
            <>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(event) => void handleFileChange(event.target.files?.[0])}
              />
              <button
                type="button"
                disabled={busyKey === "import"}
                onClick={() => inputRef.current?.click()}
                className="btn-primary"
              >
                <Upload size={18} />
                上传订单表
              </button>
            </>
          ) : null
        }
      />

      {errorMessage && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {noticeMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
          {noticeMessage}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="surface-card p-4">
          <p className="text-sm text-slate-500">订单行数</p>
          <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{orders.length}</p>
        </div>
        <div className="surface-card p-4">
          <p className="text-sm text-slate-500">待处理状态</p>
          <p className="mt-2 text-2xl font-semibold text-amber-700 tabular-nums">{pendingCount}</p>
        </div>
        <div className="surface-card p-4">
          <p className="text-sm text-slate-500">已发货</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-700 tabular-nums">{shippedCount}</p>
        </div>
      </section>

      <section className="surface-card grid gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <FileSpreadsheet size={18} />
            Temu 订单数据
          </div>
          <div className="relative w-full sm:w-[360px]">
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索订单号 / 收货人 / 地址"
              className="h-10 w-full rounded-xl border border-line bg-white pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="empty-state">暂无订单数据</div>
        ) : (
          <div className="table-card shadow-none">
            <div className="overflow-x-auto">
              <table className="data-table orders-table min-w-[1320px]">
                <thead>
                  <tr>
                    {visibleColumns.map((column) => (
                      <th key={column.label} className={column.className ?? ""}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((order) => {
                    const draft = drafts[order.id] ?? toDraft(order);
                    return (
                      <tr key={order.id}>
                        <td className="order-no-col">{order.order_no}</td>
                        <td>
                          <input
                            value={draft.order_status}
                            readOnly={!canEdit}
                            onChange={(event) =>
                              updateDraft(order.id, "order_status", event.target.value)
                            }
                            className="h-9 w-32 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
                          />
                        </td>
                        <td className="number-cell">{order.fulfillment_quantity}</td>
                        <td className="order-attr-col">{order.product_attributes || "--"}</td>
                        <td>{order.recipient_name || "--"}</td>
                        <td className="order-phone-col">{order.recipient_phone || "--"}</td>
                        <td className="order-address-col">{getFullAddress(order) || "--"}</td>
                        <td>{order.postal_code || "--"}</td>
                        <td className="order-time-col">{order.latest_ship_time || "--"}</td>
                        <td>
                          <input
                            value={draft.actual_ship_time}
                            readOnly={!canEdit}
                            onChange={(event) =>
                              updateDraft(order.id, "actual_ship_time", event.target.value)
                            }
                            placeholder="填写时间"
                            className="h-9 w-40 rounded-md border border-line bg-white px-2 text-sm outline-none focus:border-accent"
                          />
                        </td>
                        <td className="order-time-col">{order.estimated_delivery_time || "--"}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            {canEdit && (
                              <button
                                type="button"
                                disabled={busyKey === `save-${order.id}`}
                                onClick={() => void handleSave(order)}
                                className="btn-secondary h-9 px-3"
                              >
                                <Save size={16} />
                                保存
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                disabled={busyKey === `delete-${order.id}`}
                                onClick={() => void handleDelete(order)}
                                className="icon-btn-danger"
                                aria-label="删除订单"
                                title="删除订单"
                              >
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
