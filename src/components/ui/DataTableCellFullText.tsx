import { useEffect, useState } from "react";

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

const expandedRows = new Map<string, Set<number>>();

function getTableId(table: HTMLTableElement): string {
  const existingId = table.dataset.expandId;
  if (existingId) return existingId;

  const nextId = String(Math.random());
  table.dataset.expandId = nextId;
  return nextId;
}

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

function hasOverflowingBox(element: HTMLElement) {
  return (
    element.scrollWidth > element.clientWidth + 1 ||
    element.scrollHeight > element.clientHeight + 1
  );
}

function isOverflowing(cell: HTMLTableCellElement, fullText: string) {
  const explicitText = cell.getAttribute("data-full-text");
  if (
    explicitText !== null &&
    normalizeCellText(explicitText) !== getCellVisibleText(cell)
  ) {
    return true;
  }

  if (!fullText || fullText === "--") return false;
  if (hasOverflowingBox(cell)) return true;

  return Array.from(
    cell.querySelectorAll<HTMLElement>(
      ".cell-truncate, .table-cell-preview, .table-cell-clamp",
    ),
  ).some(hasOverflowingBox);
}

function collapseCell(cell: HTMLTableCellElement) {
  cell.classList.remove("cell-expanded");
  cell.style.whiteSpace = "";
  cell.style.wordBreak = "";
}

function expandCell(cell: HTMLTableCellElement) {
  cell.classList.add("cell-expanded");
  cell.style.whiteSpace = "normal";
  cell.style.wordBreak = "break-word";
}

export function DataTableCellFullText() {
  const [, forceUpdate] = useState(0);

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

      const row = cell.closest("tr");
      const tbody = row?.closest("tbody");
      const table = cell.closest("table") as HTMLTableElement | null;
      if (!row || !tbody || !table) return;

      const rowIndex = Array.from(tbody.rows).indexOf(row as HTMLTableRowElement);
      if (rowIndex < 0) return;

      const tableId = getTableId(table);
      const colIndex = cell.cellIndex;
      const rowKey = `${tableId}:${rowIndex}:${colIndex}`;

      if (expandedRows.has(rowKey)) {
        collapseCell(cell);
        expandedRows.delete(rowKey);
        forceUpdate((n) => n + 1);
        return;
      }

      const fullText = getCellFullText(cell);
      if (!isOverflowing(cell, fullText)) return;

      expandCell(cell);
      expandedRows.set(rowKey, new Set([colIndex]));
      forceUpdate((n) => n + 1);
    }

    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  return null;
}
