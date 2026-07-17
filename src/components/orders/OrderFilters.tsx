import { ChevronDown, Search, Truck, Warehouse } from "lucide-react";

type OrderStage = string;

type StageDefinition = {
  key: OrderStage;
  label: string;
};

type WarehouseFilterOption = {
  id: string;
  name: string;
};

type OrderFiltersProps = {
  activeStage: OrderStage;
  stages: StageDefinition[];
  stageCounts: Record<string, number>;
  search: string;
  warehouseFilter: string;
  warehouseOptions: WarehouseFilterOption[];
  logisticsMethodFilter: string;
  logisticsMethodOptions: string[];
  urgentUnuploadedCount: number;
  showUrgentUnuploadedOnly: boolean;
  loading?: boolean;
  onSearchChange: (value: string) => void;
  onStageChange: (stage: OrderStage) => void;
  onWarehouseFilterChange: (warehouseId: string) => void;
  onLogisticsMethodFilterChange: (method: string) => void;
  onShowUrgentUnuploadedOnly: () => void;
};

export function OrderFilters({
  activeStage,
  stages,
  stageCounts,
  search,
  warehouseFilter,
  warehouseOptions,
  logisticsMethodFilter,
  logisticsMethodOptions,
  urgentUnuploadedCount,
  showUrgentUnuploadedOnly,
  loading = false,
  onSearchChange,
  onStageChange,
  onWarehouseFilterChange,
  onLogisticsMethodFilterChange,
  onShowUrgentUnuploadedOnly,
}: OrderFiltersProps) {
  return (
    <section className="grid gap-3">
      {urgentUnuploadedCount > 0 && (
        <section className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm font-semibold text-rose-700">待办任务</span>
            <button
              type="button"
              onClick={onShowUrgentUnuploadedOnly}
              className={`inline-flex h-9 min-w-60 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-semibold transition-colors duration-150 ${
                showUrgentUnuploadedOnly
                  ? "border-rose-600 bg-rose-600 text-white shadow-sm shadow-rose-600/10"
                  : "border-rose-200 bg-rose-50/50 text-rose-700 hover:border-rose-350 hover:bg-rose-100/50"
              }`}
            >
              <span>即将逾期未发货</span>
              <span
                className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold leading-none transition-colors ${
                  showUrgentUnuploadedOnly ? "bg-white text-rose-600" : "bg-rose-600 text-white"
                }`}
              >
                {urgentUnuploadedCount}
              </span>
            </button>
          </div>
        </section>
      )}

      <section className="surface-card grid gap-3 p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(520px,720px)] xl:items-end">
          <div className="min-w-0">
            <div>
              <p className="text-xs font-semibold uppercase text-slate-400">订单视图</p>
              <h2 className="mt-1 text-base font-semibold text-slate-900">按流程筛选订单</h2>
            </div>

            <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {stages.map((stage) => {
                const active = activeStage === stage.key;
                return (
                  <button
                    key={stage.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onStageChange(stage.key)}
                    className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors duration-150 ${
                      active
                        ? "border-[#303030] bg-[#303030] text-white shadow-sm"
                        : "border-transparent bg-[#f1f1f1] text-[#4a4a4a] hover:border-[#d4d4d4] hover:bg-[#e9e9e9] hover:text-[#1a1a1a]"
                    }`}
                  >
                    <span>{stage.label}</span>
                    <span
                      className={`rounded-lg px-2 py-0.5 text-xs tabular-nums font-semibold transition-colors ${
                        active
                          ? "bg-white/20 text-white"
                          : "bg-white text-slate-500 ring-1 ring-slate-200"
                      }`}
                    >
                      {loading ? "--" : (stageCounts[stage.key] ?? 0)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-slate-500">发货仓库</span>
              <div className="relative">
                <Warehouse size={16} className="absolute left-3 top-3 text-slate-400" />
                <select
                  value={warehouseFilter}
                  onChange={(event) => onWarehouseFilterChange(event.target.value)}
                  className="h-10 w-full appearance-none rounded-lg border border-line bg-white pl-9 pr-8 text-sm font-medium text-slate-700 outline-none transition focus:border-accent focus:ring-2 focus:ring-black/10"
                >
                  <option value="">全部仓库</option>
                  {warehouseOptions.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} className="pointer-events-none absolute right-3 top-3 text-slate-400" />
              </div>
            </label>

            <label className="grid gap-2">
              <span className="text-xs font-semibold text-slate-500">发货方式</span>
              <div className="relative">
                <Truck size={16} className="absolute left-3 top-3 text-slate-400" />
                <select
                  value={logisticsMethodFilter}
                  onChange={(event) => onLogisticsMethodFilterChange(event.target.value)}
                  className="h-10 w-full appearance-none rounded-lg border border-line bg-white pl-9 pr-8 text-sm font-medium text-slate-700 outline-none transition focus:border-accent focus:ring-2 focus:ring-black/10"
                >
                  <option value="">全部方式</option>
                  {logisticsMethodOptions.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} className="pointer-events-none absolute right-3 top-3 text-slate-400" />
              </div>
            </label>

            <label className="grid gap-2">
              <span className="text-xs font-semibold text-slate-500">快速搜索</span>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-3 text-slate-400" />
                <input
                  value={search}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder="订单号 / 收货人 / 地址 / 物流"
                  className="h-10 w-full rounded-lg border border-line bg-white pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-black/10"
                />
              </div>
            </label>
          </div>
        </div>
      </section>
    </section>
  );
}
