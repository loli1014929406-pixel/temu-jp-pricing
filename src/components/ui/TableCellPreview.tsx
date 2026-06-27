import { useMemo, useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { RecordDetailModal, type DetailModalRow } from "./RecordDetailModal";

type TableCellPreviewProps = {
  label: string;
  value?: string | number | null;
  children?: ReactNode;
  detailTitle?: string;
  detailSubtitle?: string;
  detailRows?: readonly DetailModalRow[];
  lines?: 1 | 2 | 3;
  className?: string;
  textClassName?: string;
  buttonLabel?: string;
  alwaysShowDetail?: boolean;
  detailThreshold?: number;
  monospace?: boolean;
};

function normalizePreviewText(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function TableCellPreview({
  label,
  value,
  children,
  detailTitle,
  detailSubtitle,
  detailRows,
  lines = 1,
  className = "",
  textClassName = "",
  buttonLabel = "查看详情",
  alwaysShowDetail = false,
  detailThreshold = 16,
  monospace = false,
}: TableCellPreviewProps) {
  const [open, setOpen] = useState(false);
  const text = normalizePreviewText(value);
  const hasCustomDetailRows = Boolean(detailRows?.length);
  const shouldShowDetail =
    alwaysShowDetail ||
    hasCustomDetailRows ||
    (text.length > detailThreshold);

  const rows = useMemo<readonly DetailModalRow[]>(
    () =>
      detailRows && detailRows.length > 0
        ? detailRows
        : [{ label, value: text || "--", wide: true }],
    [detailRows, label, text],
  );

  return (
    <>
      <div className={`table-cell-preview ${className}`}>
        <div
          className={`table-cell-clamp table-cell-clamp-${lines} ${monospace ? "font-mono" : ""} ${textClassName}`}
        >
          {children ?? (text || "--")}
        </div>
        {shouldShowDetail && (
          <button
            type="button"
            className="table-cell-detail-button"
            onClick={() => setOpen(true)}
          >
            <Eye size={12} />
            {buttonLabel}
          </button>
        )}
      </div>
      {open && (
        <RecordDetailModal
          title={detailTitle ?? label}
          subtitle={detailSubtitle}
          rows={rows}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
