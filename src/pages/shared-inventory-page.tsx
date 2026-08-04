import { useCallback, useEffect, useMemo, useState } from "react";
import { Field, TextInput } from "../components/form-controls";
import { PageHeader } from "../components/ui";
import { usePermissions } from "../hooks/use-permissions";
import { useTenantContext } from "../hooks/use-tenant-context";
import {
  createSharedInventoryGroup,
  fetchSharedInventoryReferenceData,
  joinSharedInventoryGroup,
  leaveSharedInventoryGroup,
  type SharedInventoryReferenceData,
} from "../lib/shared-inventory";
import { getErrorMessage } from "../utils/errors";

const emptyData: SharedInventoryReferenceData = {
  groups: [],
  members: [],
  balances: [],
  locations: [],
  shops: [],
  products: [],
  skus: [],
  warehouses: [],
  warehouseSkus: [],
};

function skuLabel(
  sku: SharedInventoryReferenceData["skus"][number] | undefined,
  data: SharedInventoryReferenceData,
) {
  if (!sku) return "未知 SKU";
  const product = data.products.find((item) => item.id === sku.product_id);
  return `${product?.product_code ?? "--"} / ${sku.sku_code}`;
}

export function SharedInventoryPage() {
  const tenant = useTenantContext();
  const { can } = usePermissions();
  const shopId = tenant.currentShop?.id ?? null;
  const canAdjust = can("inventory", "adjust");
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [groupCode, setGroupCode] = useState("");
  const [groupName, setGroupName] = useState("");
  const [baseUnitName, setBaseUnitName] = useState("件");
  const [joinGroupId, setJoinGroupId] = useState("");
  const [joinSkuId, setJoinSkuId] = useState("");
  const [ratio, setRatio] = useState("1");
  const [joinQuantities, setJoinQuantities] = useState<Record<string, string>>({});
  const [leaveMemberId, setLeaveMemberId] = useState("");
  const [leaveQuantities, setLeaveQuantities] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!shopId) {
      setData(emptyData);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setData(await fetchSharedInventoryReferenceData(shopId));
    } catch (loadError) {
      setError(getErrorMessage(loadError, "加载共享库存失败"));
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeSkuIds = useMemo(
    () => new Set(data.members.map((member) => member.sku_id)),
    [data.members],
  );
  const availableSkus = data.skus.filter((sku) => !activeSkuIds.has(sku.id));
  const joinStocks = data.warehouseSkus.filter((stock) => stock.sku_id === joinSkuId);
  const currentShopMembers = data.members.filter((member) => member.shop_id === shopId);
  const leaveMember = data.members.find((member) => member.id === leaveMemberId);
  const leaveStocks = data.warehouseSkus.filter(
    (stock) => stock.sku_id === leaveMember?.sku_id,
  );

  async function handleCreateGroup() {
    if (!canAdjust || !groupCode.trim() || !groupName.trim() || !baseUnitName.trim()) return;
    setBusy(true);
    setError("");
    try {
      await createSharedInventoryGroup({
        code: groupCode.trim(),
        name: groupName.trim(),
        baseUnitName: baseUnitName.trim(),
      });
      setGroupCode("");
      setGroupName("");
      setNotice("共享库存组已创建。");
      await load();
    } catch (submitError) {
      setError(getErrorMessage(submitError, "创建共享库存组失败"));
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    const parsedRatio = Number(ratio);
    if (!canAdjust || !joinGroupId || !joinSkuId || !(parsedRatio > 0)) return;
    const transfers = joinStocks.map((stock) => ({
      warehouse_sku_id: stock.id,
      quantity: Math.trunc(Number(joinQuantities[stock.id]) || 0),
    }));
    setBusy(true);
    setError("");
    try {
      await joinSharedInventoryGroup({
        groupId: joinGroupId,
        skuId: joinSkuId,
        baseUnitsPerSaleUnit: parsedRatio,
        transfers,
        reason: "网站确认加入共享库存组",
        requestKey: crypto.randomUUID(),
      });
      setJoinSkuId("");
      setJoinQuantities({});
      setNotice("SKU 已加入共享库存组，独立库存已按填写数量转入共享余额。");
      await load();
    } catch (submitError) {
      setError(getErrorMessage(submitError, "加入共享库存组失败"));
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    if (!canAdjust || !leaveMember) return;
    const transfers = leaveStocks.map((stock) => ({
      warehouse_sku_id: stock.id,
      quantity: Math.trunc(Number(leaveQuantities[stock.id]) || 0),
    }));
    setBusy(true);
    setError("");
    try {
      await leaveSharedInventoryGroup({
        memberId: leaveMember.id,
        transfers,
        reason: "网站确认退出共享库存组",
        requestKey: crypto.randomUUID(),
      });
      setLeaveMemberId("");
      setLeaveQuantities({});
      setNotice("SKU 已退出共享库存组，共享余额已按填写数量拆回独立库存。");
      await load();
    } catch (submitError) {
      setError(getErrorMessage(submitError, "退出共享库存组失败"));
    } finally {
      setBusy(false);
    }
  }

  if (!shopId) {
    return (
      <section className="page-stack">
        <PageHeader title="共享库存" description="请先从左侧选择一个具体店铺。" />
      </section>
    );
  }

  return (
    <section className="page-stack">
      <PageHeader
        title="共享库存"
        description="默认 SKU 仍使用店铺独立库存；只有手动加入的 SKU 才共用物理库存余额。"
      />

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-bold text-slate-900">新建共享组</h2>
          <div className="grid gap-3">
            <Field label="组编号"><TextInput value={groupCode} onChange={(event) => setGroupCode(event.target.value)} /></Field>
            <Field label="组名称"><TextInput value={groupName} onChange={(event) => setGroupName(event.target.value)} /></Field>
            <Field label="基础单位"><TextInput value={baseUnitName} onChange={(event) => setBaseUnitName(event.target.value)} /></Field>
            <button type="button" disabled={!canAdjust || busy} onClick={() => void handleCreateGroup()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">创建共享组</button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-bold text-slate-900">SKU 加入共享组</h2>
          <div className="grid gap-3">
            <Field label="共享组">
              <select value={joinGroupId} onChange={(event) => setJoinGroupId(event.target.value)} className="h-10 rounded-lg border border-slate-200 px-3 text-sm">
                <option value="">请选择</option>
                {data.groups.map((group) => <option key={group.id} value={group.id}>{group.code} · {group.name}</option>)}
              </select>
            </Field>
            <Field label="当前店铺 SKU">
              <select value={joinSkuId} onChange={(event) => {
                const skuId = event.target.value;
                setJoinSkuId(skuId);
                setJoinQuantities(Object.fromEntries(data.warehouseSkus.filter((stock) => stock.sku_id === skuId).map((stock) => [stock.id, String(stock.stock_quantity)])));
              }} className="h-10 rounded-lg border border-slate-200 px-3 text-sm">
                <option value="">请选择</option>
                {availableSkus.map((sku) => <option key={sku.id} value={sku.id}>{skuLabel(sku, data)}</option>)}
              </select>
            </Field>
            <Field label="每销售 1 件对应基础单位数"><TextInput type="number" min="0.000001" step="0.000001" value={ratio} onChange={(event) => setRatio(event.target.value)} /></Field>
            {joinStocks.map((stock) => (
              <Field key={stock.id} label={`${data.warehouses.find((warehouse) => warehouse.id === stock.warehouse_id)?.name ?? "仓库"} 转入数量（当前 ${stock.stock_quantity}）`}>
                <TextInput type="number" min="0" step="1" value={joinQuantities[stock.id] ?? "0"} onChange={(event) => setJoinQuantities((current) => ({ ...current, [stock.id]: event.target.value }))} />
              </Field>
            ))}
            <button type="button" disabled={!canAdjust || busy || !joinSkuId || joinStocks.length === 0} onClick={() => void handleJoin()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">确认数量并加入</button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-bold text-slate-900">SKU 退出共享组</h2>
          <div className="grid gap-3">
            <Field label="当前店铺共享 SKU">
              <select value={leaveMemberId} onChange={(event) => {
                setLeaveMemberId(event.target.value);
                setLeaveQuantities({});
              }} className="h-10 rounded-lg border border-slate-200 px-3 text-sm">
                <option value="">请选择</option>
                {currentShopMembers.map((member) => <option key={member.id} value={member.id}>{skuLabel(data.skus.find((sku) => sku.id === member.sku_id), data)}</option>)}
              </select>
            </Field>
            {leaveStocks.map((stock) => (
              <Field key={stock.id} label={`${data.warehouses.find((warehouse) => warehouse.id === stock.warehouse_id)?.name ?? "仓库"} 拆回数量`}>
                <TextInput type="number" min="0" step="1" value={leaveQuantities[stock.id] ?? "0"} onChange={(event) => setLeaveQuantities((current) => ({ ...current, [stock.id]: event.target.value }))} />
              </Field>
            ))}
            <p className="text-xs text-slate-500">退出不会猜测库存去向；如果这是组内最后一个 SKU，必须把剩余共享库存全部明确拆回。</p>
            <button type="button" disabled={!canAdjust || busy || !leaveMemberId} onClick={() => void handleLeave()} className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 disabled:opacity-40">确认数量并退出</button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3 text-sm font-bold text-slate-900">共享组余额与关联店铺</div>
        {loading ? <p className="p-4 text-sm text-slate-500">加载中...</p> : data.groups.map((group) => {
          const members = data.members.filter((member) => member.group_id === group.id);
          const balances = data.balances.filter((balance) => balance.group_id === group.id);
          return (
            <div key={group.id} className="border-b border-slate-100 p-4 last:border-b-0">
              <div className="font-semibold text-slate-900">{group.code} · {group.name}</div>
              <div className="mt-1 text-xs text-slate-500">关联：{members.map((member) => `${data.shops.find((shop) => shop.id === member.shop_id)?.name ?? "店铺"} / ${skuLabel(data.skus.find((sku) => sku.id === member.sku_id), data)} × ${member.base_units_per_sale_unit}`).join("；") || "暂无 SKU"}</div>
              <div className="mt-2 flex flex-wrap gap-2">{balances.map((balance) => <span key={balance.id} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{data.locations.find((location) => location.id === balance.stock_location_id)?.name ?? "库存地点"}：{balance.quantity_base_units} {group.base_unit_name}</span>)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
