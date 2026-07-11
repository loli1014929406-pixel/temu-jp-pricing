import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { createReshipmentOrder } from "../../lib/orders";
import { notifyWarning } from "../../lib/notifications";
import type { Product, ProductSku, TemuOrderRecord } from "../../types";
import { getErrorMessage } from "../../utils/errors";

type ReshipOrderModalProps = {
  originalOrder: TemuOrderRecord;
  relatedOrders: TemuOrderRecord[];
  productSkus: ProductSku[];
  products: Product[];
  onClose: () => void;
  onSuccess: (newOrders: TemuOrderRecord[]) => void;
  setErrorMessage: (message: string) => void;
};

type ReshipOrderItem = {
  skuCode: string;
  productAttributes: string;
  quantity: number;
  isOriginal: boolean;
  checked: boolean;
};

function formatSkuSalesSpec(sku: ProductSku) {
  const entries = Object.entries(sku.attributes)
    .map(([name, value]) => [name.trim(), String(value).trim()] as const)
    .filter(([name, value]) => name && value);
  return entries.length > 0
    ? entries.map(([name, value]) => `${name}：${value}`).join(" / ")
    : "无规格";
}

export function ReshipOrderModal({
  originalOrder,
  relatedOrders,
  productSkus,
  products,
  onClose,
  onSuccess,
  setErrorMessage,
}: ReshipOrderModalProps) {
  const [suffix, setSuffix] = useState("");
  const [items, setItems] = useState<ReshipOrderItem[]>(() =>
    relatedOrders.map((order) => ({
      skuCode: order.sku_code,
      productAttributes: order.product_attributes,
      quantity: order.fulfillment_quantity,
      isOriginal: true,
      checked: true,
    })),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [showSkuDropdown, setShowSkuDropdown] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const productsMap = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );
  const filteredSkus = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return productSkus.slice(0, 50);
    return productSkus
      .filter((sku) => {
        const product = productsMap.get(sku.product_id ?? "");
        return (
          sku.sku_code.toLowerCase().includes(query) ||
          (product?.product_name_cn ?? "").toLowerCase().includes(query)
        );
      })
      .slice(0, 10);
  }, [productSkus, productsMap, searchQuery]);

  function addSku(sku: ProductSku) {
    if (items.some((item) => item.skuCode === sku.sku_code)) {
      notifyWarning("该 SKU 已经在列表中了！");
      return;
    }
    const product = productsMap.get(sku.product_id ?? "");
    setItems((current) => [
      ...current,
      {
        skuCode: sku.sku_code,
        productAttributes: `${product?.product_name_cn ?? ""} ${formatSkuSalesSpec(sku)}`.trim(),
        quantity: 1,
        isOriginal: false,
        checked: true,
      },
    ]);
    setSearchQuery("");
    setShowSkuDropdown(false);
  }

  function updateItem<K extends "quantity" | "productAttributes" | "checked">(
    index: number,
    field: K,
    value: ReshipOrderItem[K],
  ) {
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  }

  async function submit() {
    const cleanSuffix = suffix.trim().replace(/^-+/, "");
    const selectedItems = items.filter((item) => item.checked);
    if (!cleanSuffix) return notifyWarning("请输入有效的补发单号后缀");
    if (selectedItems.length === 0) return notifyWarning("请至少选择或添加一项补发商品");
    if (selectedItems.some((item) => item.quantity <= 0 || !Number.isInteger(item.quantity))) {
      return notifyWarning("请输入有效的补发数量（正整数）");
    }

    setIsSaving(true);
    try {
      const createdOrders = await createReshipmentOrder(
        relatedOrders,
        cleanSuffix,
        selectedItems.map((item) => ({
          skuCode: item.skuCode,
          productAttributes: item.productAttributes,
          quantity: item.quantity,
        })),
      );
      onSuccess(createdOrders);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "创建补发订单失败"));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-labelledby="reship-order-title">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 id="reship-order-title" className="text-lg font-bold text-slate-900">创建补发订单</h2>
          <button type="button" onClick={onClose} aria-label="关闭补发订单窗口" className="text-slate-400 transition hover:text-slate-600">
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <div className="space-y-2 rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm">
            <div className="flex justify-between gap-4"><span className="font-semibold text-slate-500">原订单号</span><span className="font-mono font-medium text-slate-800">{originalOrder.order_no}</span></div>
            <div className="flex justify-between gap-4"><span className="font-semibold text-slate-500">收件人</span><span className="font-medium text-slate-800">{originalOrder.recipient_name}</span></div>
            <div className="flex justify-between gap-4"><span className="font-semibold text-slate-500">收件地址</span><span className="max-w-[20rem] truncate text-right font-medium text-slate-800">{originalOrder.province} {originalOrder.city} {originalOrder.district} {originalOrder.address_line1}</span></div>
          </div>

          <label className="grid gap-2 text-sm font-bold text-slate-700">
            补发订单号后缀
            <span className="flex items-center overflow-hidden rounded-xl border border-line bg-slate-50 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10">
              <span className="shrink-0 select-none pl-4 pr-1 font-mono text-sm font-normal text-slate-400">{originalOrder.order_no}-</span>
              <input value={suffix} onChange={(event) => setSuffix(event.target.value.replace(/[^a-zA-Z0-9-]/g, ""))} placeholder="例如: reship1, bufa" className="h-11 w-full bg-transparent px-2 font-mono text-sm font-normal text-slate-800 outline-none" />
            </span>
            <span className="text-xs font-medium text-slate-400">后缀只能包含英文字母、数字和横杠</span>
          </label>

          <div className="space-y-3">
            <p className="text-sm font-bold text-slate-700">选择或增加补发商品（SKU）</p>
            <div className="max-h-[220px] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-100">
              {items.map((item, index) => (
                <div key={`${item.skuCode}-${index}`} className={`flex items-center gap-3 p-3 text-xs ${item.checked ? "bg-accentSoft/10" : "bg-white"}`}>
                  <input type="checkbox" checked={item.checked} onChange={(event) => updateItem(index, "checked", event.target.checked)} aria-label={`选择补发商品 ${item.skuCode}`} className="h-4 w-4 rounded border-slate-300 text-sky-700 focus:ring-sky-500" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate font-mono font-medium text-slate-800">{item.skuCode}</p>
                    <input value={item.productAttributes} onChange={(event) => updateItem(index, "productAttributes", event.target.value)} aria-label={`${item.skuCode} 商品属性`} className="h-8 w-full rounded-lg border border-line bg-white/70 px-2 text-xs font-medium text-slate-600 outline-none focus:border-accent" />
                  </div>
                  <input type="number" min={1} value={item.quantity} onChange={(event) => updateItem(index, "quantity", Math.max(1, Number.parseInt(event.target.value, 10) || 1))} aria-label={`${item.skuCode} 补发数量`} className="h-8 w-16 rounded-lg border border-line px-2 text-center outline-none focus:border-accent" />
                  {!item.isOriginal && <button type="button" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除补发商品 ${item.skuCode}`} className="p-1 text-slate-400 transition hover:text-rose-600"><X size={16} aria-hidden="true" /></button>}
                </div>
              ))}
              {items.length === 0 && <div className="p-6 text-center text-xs font-medium text-slate-400">请至少添加一项商品</div>}
            </div>

            <div className="relative">
              <div className="flex gap-2">
                <input value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setShowSkuDropdown(true); }} onFocus={() => setShowSkuDropdown(true)} aria-label="搜索补发商品 SKU" placeholder="搜索并添加其他商品 SKU 号/商品名" className="h-10 flex-1 rounded-xl border border-line px-3 text-xs outline-none focus:border-accent" />
                <button type="button" onClick={() => setShowSkuDropdown((current) => !current)} className="btn-secondary h-10 shrink-0 px-3 text-xs">{showSkuDropdown ? "隐藏" : "显示全部"}</button>
              </div>
              {showSkuDropdown && (
                <div className="absolute left-0 right-0 z-50 mt-1 max-h-[180px] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                  {filteredSkus.map((sku) => {
                    const product = productsMap.get(sku.product_id ?? "");
                    return <button key={sku.id} type="button" onClick={() => addSku(sku)} className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-xs transition hover:bg-slate-50"><span className="min-w-0 flex-1"><span className="block truncate font-mono font-semibold text-slate-800">{sku.sku_code}</span><span className="block truncate text-slate-500">{product?.product_name_cn || "未知商品"}（{formatSkuSalesSpec(sku)}）</span></span><span className="shrink-0 text-[10px] text-slate-400">点击选择</span></button>;
                  })}
                  {filteredSkus.length === 0 && <div className="p-4 text-center text-xs font-medium text-slate-400">未找到匹配的 SKU</div>}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 bg-slate-50 px-6 py-4">
          <button type="button" onClick={onClose} className="btn-secondary h-10 px-4 text-xs font-semibold">取消</button>
          <button type="button" disabled={isSaving} onClick={() => void submit()} className="btn-primary inline-flex h-10 items-center gap-1.5 px-5 text-xs font-semibold">{isSaving && <span className="h-3 w-3 animate-spin rounded-full border border-white border-r-transparent" />}确认创建</button>
        </div>
      </div>
    </div>
  );
}
