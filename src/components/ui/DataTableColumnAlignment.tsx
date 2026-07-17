import { useEffect } from "react";

const syncedRightClass = "table-column-align-right";
const syncedCenterClass = "table-column-align-center";
const alignmentClasses = [syncedRightClass, syncedCenterClass];

function getDeclaredAlignment(cell: HTMLTableCellElement) {
  if (
    cell.matches(
      ".money, .number-cell, .text-right-num, .text-right, .table-column-align-right",
    ) ||
    window.getComputedStyle(cell).textAlign === "right"
  ) {
    return "right" as const;
  }
  if (
    cell.matches(".text-center, .table-column-align-center") ||
    window.getComputedStyle(cell).textAlign === "center"
  ) {
    return "center" as const;
  }
  return "left" as const;
}

function syncTableAlignment(table: HTMLTableElement) {
  const tableHead = table.tHead;
  const headerRow = tableHead?.rows[tableHead.rows.length - 1];
  if (!headerRow) return;

  const bodyRows = Array.from(table.tBodies).flatMap((tbody) =>
    Array.from(tbody.rows).filter(
      (row) => row.cells.length === headerRow.cells.length && row.cells.length > 1,
    ),
  );
  if (bodyRows.length === 0) return;

  Array.from(headerRow.cells).forEach((headerCell, columnIndex) => {
    const columnCells = bodyRows
      .slice(0, 20)
      .map((row) => row.cells[columnIndex])
      .filter((cell): cell is HTMLTableCellElement => Boolean(cell));
    if (columnCells.length === 0) return;

    const headerAlignment = getDeclaredAlignment(headerCell);
    const rightCount = columnCells.filter(
      (cell) => getDeclaredAlignment(cell) === "right",
    ).length;
    const centerCount = columnCells.filter(
      (cell) => getDeclaredAlignment(cell) === "center",
    ).length;
    const majority = Math.ceil(columnCells.length / 2);
    const alignment =
      headerAlignment !== "left"
        ? headerAlignment
        : rightCount >= majority
          ? "right"
          : centerCount >= majority
            ? "center"
            : "left";

    [headerCell, ...bodyRows.map((row) => row.cells[columnIndex])].forEach((cell) => {
      if (!cell) return;
      cell.classList.remove(...alignmentClasses);
      if (alignment === "right") cell.classList.add(syncedRightClass);
      if (alignment === "center") cell.classList.add(syncedCenterClass);
    });
  });
}

function syncAllTableAlignments() {
  document
    .querySelectorAll<HTMLTableElement>("table.data-table")
    .forEach(syncTableAlignment);
}

export function DataTableColumnAlignment() {
  useEffect(() => {
    let frame = 0;
    const scheduleSync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncAllTableAlignments);
    };

    scheduleSync();
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return null;
}
