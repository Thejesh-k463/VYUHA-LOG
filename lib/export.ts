import * as XLSX from "xlsx";

export interface ExportColumn<T> {
  key: keyof T | string;
  label: string;
  value?: (row: T) => string | number | null;
}

function toMatrix<T>(columns: ExportColumn<T>[], rows: T[]) {
  return rows.map((row) => {
    const o: Record<string, string | number | null> = {};
    const rec = row as Record<string, unknown>;
    for (const c of columns) {
      o[c.label] = c.value ? c.value(row) : ((rec[c.key as string] as unknown) as string | number | null) ?? "";
    }
    return o;
  });
}

/** Download the rows as CSV or XLSX (respects whatever filtered rows you pass). */
export function exportRows<T>(
  filename: string,
  columns: ExportColumn<T>[],
  rows: T[],
  format: "csv" | "xlsx",
) {
  const data = toMatrix(columns, rows);
  const ws = XLSX.utils.json_to_sheet(data, { header: columns.map((c) => c.label) });
  if (format === "csv") {
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, `${filename}.csv`);
  } else {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Vyuha");
    XLSX.writeFile(wb, `${filename}.xlsx`);
  }
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
