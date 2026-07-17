import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
};

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

type BackToParentActionProps = {
  fallbackTo: string;
  label?: string;
  className?: string;
};

export function BackToParentAction({
  fallbackTo,
  label = "返回上一级",
  className = "btn-secondary",
}: BackToParentActionProps) {
  const navigate = useNavigate();

  function handleBack() {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate(fallbackTo);
  }

  return (
    <button type="button" className={className} onClick={handleBack}>
      <ArrowLeft size={18} />
      {label}
    </button>
  );
}

type BadgeProps = {
  tone?: "success" | "warning" | "danger" | "neutral" | "info";
  children: ReactNode;
};

export function Badge({ tone = "neutral", children }: BadgeProps) {
  const tones = {
    success: "bg-[#cdfee1] text-[#0c5132] ring-[#b4e8cc]",
    warning: "bg-[#fff5c2] text-[#5e4200] ring-[#f1df8a]",
    danger: "bg-[#fee1e1] text-[#8e1f0b] ring-[#f6c7c7]",
    neutral: "bg-[#e3e3e3] text-[#4a4a4a] ring-[#d4d4d4]",
    info: "bg-[#eaf4ff] text-[#0b4f80] ring-[#c9e3f8]",
  };

  return (
    <span className={`inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ${tones[tone]}`}>
      {children}
    </span>
  );
}

type StatCardProps = {
  label: string;
  value: string;
  tone?: "default" | "success" | "danger";
};

export function StatCard({ label, value, tone = "default" }: StatCardProps) {
  const valueTone =
    tone === "success"
      ? "text-emerald-700"
      : tone === "danger"
        ? "text-rose-700"
        : "text-slate-950";
  const toneClass =
    tone === "success"
      ? "erp-kpi-success"
      : tone === "danger"
        ? "erp-kpi-danger"
        : "";

  return (
    <div className={`erp-kpi-card ${toneClass}`}>
      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-3 text-3xl font-semibold tabular-nums ${valueTone}`}>{value}</p>
    </div>
  );
}

export * from "./ui/StandardTable";
export * from "./ui/RecordDetailModal";
export * from "./ui/TableCellPreview";
export * from "./ui/DataTableCellFullText";
export * from "./ui/DataTableColumnAlignment";
export * from "./ui/table-layout";
