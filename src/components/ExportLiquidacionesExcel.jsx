import React, { useState } from "react";
import {
  DEFAULT_TZ,
  buildStyles,
  buildRowsFromByCur,
  getLayoutConfig,
  writeSection,
  buildTitleAndFilename,
  rowHeights,
} from "./exportUtilsLiquidaciones";

export default function ExportLiquidacionesExcel({
  byCur,              // { ARS:[], USD:[] }
  fromISO,
  toISO,
  mode = "department", // 'department' (por depto) | 'property' (por propiedad completa)
  titleSuffix = "Departamento", // se usa en el título/archivo
  tz = DEFAULT_TZ,
}) {
  const [loading, setLoading] = useState(false);

  const includeDepartment = mode === "property"; // propiedad => agrega columna Departamento
  const { HEADERS, widths, moneyCols, netIdx } = getLayoutConfig({ includeDepartment });
  const styles = buildStyles();

  const handleExport = async () => {
    try {
      setLoading(true);
      const [{ default: ExcelJS }, { saveAs }] = await Promise.all([
        import("exceljs"),
        import("file-saver"),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Liquidación");

      // título/filename
      const { title, filename } = buildTitleAndFilename({
        fromISO, toISO, tz, titleSuffix,
      });

      // Fila 1: título
      const tRow = ws.addRow([title]);
      ws.mergeCells(1, 1, 1, HEADERS.length);
      ws.getCell(1, 1).font = { name: "Aptos Narrow", size: 13, bold: true };
      ws.getRow(1).height = rowHeights.title;

      // Fila 2: vacía
      ws.addRow([]);
      ws.getRow(2).height = rowHeights.spacer;

      // Fila 3: headers
      const hr = ws.addRow(HEADERS);
      hr.eachCell((cell) => {
        cell.font = styles.fontHeader;
        cell.fill = styles.fillBlack;
        cell.alignment = styles.alignCenter;
        cell.border = styles.borderThin;
      });
      ws.getRow(3).height = rowHeights.header;

      // Anchos
      ws.columns = widths.map((w) => ({ width: w }));

      // Secciones
      const rowsARS = buildRowsFromByCur({ ARS: byCur?.ARS || [] }, { includeDepartment });
      writeSection(ws, "LIQUIDACION EN $", rowsARS, styles, {
        HEADERS, moneyCols, netIdx, rowHeights,
      });

      const rowsUSD = buildRowsFromByCur({ USD: byCur?.USD || [] }, { includeDepartment });
      writeSection(ws, "LIQUIDACION EN USD", rowsUSD, styles, {
        HEADERS, moneyCols, netIdx, rowHeights,
      });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/octet-stream" });
      saveAs(blob, filename);
    } catch (e) {
      console.error("[ExportLiquidacionesExcel] Error exportando:", e);
      alert("No se pudo exportar el Excel. Revisá la consola.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button type="button" className="btn" onClick={handleExport} disabled={loading}>
      {loading ? "Exportando…" : (includeDepartment ? "Exportar Excel (Propiedad)" : "Exportar Excel")}
    </button>
  );
}





