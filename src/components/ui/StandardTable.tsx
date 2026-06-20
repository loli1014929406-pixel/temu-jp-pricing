import { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type StandardTableProps = {
  children: ReactNode;
  minWidth?: string;
  tableClassName?: string;
  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  
  // Pagination
  page: number;
  pageSize: number;
  totalPages: number;
  totalRecordCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: number[];
};

export function StandardTable({
  children,
  minWidth = "min-w-full",
  tableClassName = "",
  loading = false,
  empty = false,
  emptyMessage = "暂无数据",
  page,
  pageSize,
  totalPages,
  totalRecordCount,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100]
}: StandardTableProps) {
  return (
    <div className="table-card flex flex-col bg-panel">
      <div className="overflow-x-auto">
        <table className={`data-table ${minWidth} ${tableClassName}`}>
          {children}
          {(loading || empty) && (
            <tbody>
              <tr>
                <td colSpan={100} className="px-4 py-16 text-center text-sm text-slate-500">
                  {loading ? (
                    <div className="flex flex-col items-center gap-3">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-r-transparent" />
                      <span>正在加载数据...</span>
                    </div>
                  ) : (
                    emptyMessage
                  )}
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
      
      {/* Pagination Footer */}
      {totalRecordCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line bg-mist/30 px-6 py-3 text-xs text-slate-600">
          <div className="flex items-center gap-3">
            <span>共 {totalRecordCount} 条记录</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              disabled={loading}
              className="h-8 rounded-md border border-line bg-white px-2 text-xs outline-none transition focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
            >
              {pageSizeOptions.map(size => (
                <option key={size} value={size}>{size} 条 / 页</option>
              ))}
            </select>
          </div>
          
          <div className="flex items-center gap-2">
            <span className="mr-2 font-medium">第 {page} / {totalPages || 1} 页</span>
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1 || loading}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-white text-slate-600 transition hover:bg-slate-50 hover:text-accent disabled:opacity-50 disabled:hover:bg-white disabled:hover:text-slate-600"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages || loading}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-white text-slate-600 transition hover:bg-slate-50 hover:text-accent disabled:opacity-50 disabled:hover:bg-white disabled:hover:text-slate-600"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
