import { Search } from "lucide-react";

type OrderStage = string;

type StageDefinition = {
  key: OrderStage;
  label: string;
};

type OrderFiltersProps = {
  activeStage: OrderStage;
  stages: StageDefinition[];
  stageCounts: Record<string, number>;
  search: string;
  urgentUnuploadedCount: number;
  showUrgentUnuploadedOnly: boolean;
  onSearchChange: (value: string) => void;
  onStageChange: (stage: OrderStage) => void;
  onShowUrgentUnuploadedOnly: () => void;
};

export function OrderFilters({
  activeStage,
  stages,
  stageCounts,
  search,
  urgentUnuploadedCount,
  showUrgentUnuploadedOnly,
  onSearchChange,
  onStageChange,
  onShowUrgentUnuploadedOnly,
}: OrderFiltersProps) {
  return (
    <>
      {urgentUnuploadedCount > 0 && (
        <section className="surface-card p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-20 text-sm font-medium text-slate-700">待办任务</span>
            <button
              type="button"
              onClick={onShowUrgentUnuploadedOnly}
              className={`inline-flex h-10 min-w-60 items-center justify-center gap-2 rounded-md border px-4 text-sm font-semibold transition ${
                showUrgentUnuploadedOnly
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-line bg-white text-slate-900 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <span>即将逾期未发货</span>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-xs font-bold leading-none text-white">
                {urgentUnuploadedCount}
              </span>
            </button>
          </div>
        </section>
      )}

      <section className="surface-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {stages.map((stage) => {
              const active = activeStage === stage.key;
              return (
                <button
                  key={stage.key}
                  type="button"
                  onClick={() => onStageChange(stage.key)}
                  className={`inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold transition ${
                    active
                      ? "bg-slate-900 text-white shadow-soft"
                      : "bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                  }`}
                >
                  <span>{stage.label}</span>
                  <span
                    className={`rounded-md px-2 py-0.5 text-xs tabular-nums ${
                      active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {stageCounts[stage.key] ?? 0}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="relative w-full sm:w-[360px]">
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索订单号 / 收货人 / 地址 / 物流"
              className="h-10 w-full rounded-md border border-line bg-white pl-9 pr-3 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
          </div>
        </div>
      </section>
    </>
  );
}
