import { useEffect, useState } from "react";
import { RecordDetailModal } from "./RecordDetailModal";

type CellDetail = {
  title: string;
  text: string;
};

const interactiveSelector = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role='button']",
  "[contenteditable='true']",
  "[data-table-cell-ignore]",
].join(",");

function normalizeCellText(value: string | null | undefined) {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

function removeNonContentElements(root: HTMLElement) {
  root
    .querySelectorAll(
      [
        "button",
        "input",
        "select",
        "textarea",
        "svg",
        ".table-cell-detail-button",
        "[data-table-cell-ignore]",
      ].join(","),
    )
    .forEach((element) => element.remove());
}

function getCellFullText(cell: HTMLTableCellElement) {
  const explicitText = cell.getAttribute("data-full-text");
  if (explicitText !== null) return normalizeCellText(explicitText);

  const clone = cell.cloneNode(true) as HTMLElement;
  removeNonContentElements(clone);
  return normalizeCellText(clone.textContent);
}

function getCellVisibleText(cell: HTMLTableCellElement) {
  const clone = cell.cloneNode(true) as HTMLElement;
  removeNonContentElements(clone);
  return normalizeCellText(clone.textContent);
}

function getHeaderText(cell: HTMLTableCellElement) {
  const table = cell.closest("table");
  const headerRows = table?.tHead?.rows;
  if (!headerRows || headerRows.length === 0) return "";

  const headerCell = headerRows[headerRows.length - 1]?.cells[cell.cellIndex];
  return normalizeCellText(headerCell?.textContent);
}

function isOverflowing(cell: HTMLTableCellElement, fullText: string) {
  const explicitText = cell.getAttribute("data-full-text");
  if (explicitText !== null && normalizeCellText(explicitText) !== getCellVisibleText(cell)) {
    return true;
  }

  if (!fullText || fullText === "--") return false;

  return (
    cell.scrollWidth > cell.clientWidth + 1 ||
    cell.scrollHeight > cell.clientHeight + 1
  );
}

export function DataTableCellFullText() {
  const [detail, setDetail] = useState<CellDetail | null>(null);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(interactiveSelector)) return;

      const cell = target.closest("td");
      if (!(cell instanceof HTMLTableCellElement)) return;
      if (!cell.closest("table.data-table")) return;
      if (cell.closest("thead")) return;
      if (cell.colSpan > 1) return;
      if (cell.matches("[data-cell-detail-disabled='true']")) return;

      const fullText = getCellFullText(cell);
      if (!isOverflowing(cell, fullText)) return;

      setDetail({
        title: getHeaderText(cell) || "完整信息",
        text: fullText,
      });
    }

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  if (!detail) return null;

  return (
    <RecordDetailModal
      title={detail.title}
      rows={[{ label: "完整显示文本", value: detail.text || "--", wide: true }]}
      onClose={() => setDetail(null)}
      maxWidthClassName="max-w-2xl"
    />
  );
}
