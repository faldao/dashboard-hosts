// components/ExportLiquidacionesExcel.jsx
import React, { useState } from "react";
import { DateTime } from "luxon";

const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

function formatDate(iso, tz = DEFAULT_TZ) {
  if (!iso) return "";
  const d = DateTime.fromISO(iso, { zone: tz });
  return d.isValid ? d.toFormat("dd/MM/yyyy") : "";
}

function buildRowsFromByCur(byCur) {
  const all = [...(byCur?.ARS || []), ...(byCur?.USD || [])];

  return all.map((r) => {
    const acc = r._res?.accounting || {};
    const fx = Number(r.fx_used || 0) || 0;
    const cur = String(r.pay_currency || "").toUpperCase();
    const bruto = Number(r.pay_amount ?? 0) || 0;

    let neto = 0;
    if (cur === "USD") {
      neto = +(
        bruto +
        (Number(acc.comisionCanalUSD) || 0) +
        (Number(acc.tasaLimpiezaUSD) || 0) +
        (Number(acc.costoFinancieroUSD) || 0)
      ).toFixed(2);
    } else {
      const H_ars = fx ? (Number(acc.comisionCanalUSD) || 0) * fx : 0;
      const I_ars = fx ? (Number(acc.tasaLimpiezaUSD) || 0) * fx : 0;
      const J_ars = fx ? (Number(acc.costoFinancieroUSD) || 0) * fx : 0;
      neto = +(bruto + H_ars + I_ars + J_ars).toFixed(2);
    }

    return {
      reserva: r.id_human || "",
      huesped: r.huesped || "",
      checkin: r.checkin || "",
      checkout: r.checkout || "",
      canal: r.canal || "",
      forma: [r.pay_method || "—", r.pay_concept || ""].filter(Boolean).join(" · "),
      bruto,
      comision: Number(acc.comisionCanalUSD || 0),
      tasa: Number(acc.tasaLimpiezaUSD || 0),
      costo: Number(acc.costoFinancieroUSD || 0),
      neto,
      observaciones: acc.observaciones || "",
      moneda: cur,
    };
  });
}

export default function ExportLiquidacionesExcel({
  byCur,
  fromISO,
  toISO,
  deptLabel,
  tz = DEFAULT_TZ,
}) {
  const [loading, setLoading] = useState(false);

  const headers = [
    "reserva",
    "Huesped",
    "check in",
    "check out",
    "Canal",
    "Forma de cobro",
    "Cobrado Bruto (reserva + comisión canal+ tasa limpieza+ IVA)",
    "Comisión Canal (booking, despegar, expedia)",
    "Tasa de limpieza pagada por el huesped",
    "Costo financiero (comision TC, IIBB etc)",
    "Neto",
    "OBSERVACIONES",
  ];

  const handleExport = async () => {
    try {
      setLoading(true);

      const [{ default: ExcelJS }, { saveAs }] = await Promise.all([
        import("exceljs"),
        import("file-saver"),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Liquidación");

      // ======== ESTILOS ========
      const fontBase = { name: "Aptos Narrow", size: 11 };
      const fontHeader = { name: "Aptos Narrow", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      const fillBlack = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000000" } };
      const borderThin = { style: "thin", color: { argb: "FFCCCCCC" } };

      const rowsUSD = (byCur?.USD || []).map(r => ({ ...r, moneda: "USD" }));
      const rowsARS = (byCur?.ARS || []).map(r => ({ ...r, moneda: "ARS" }));
      const allRows = buildRowsFromByCur(byCur);

      const rango = `${formatDate(fromISO, tz)} al ${formatDate(toISO, tz)}`;
      const monthLabel = DateTime.fromISO(fromISO).toFormat("LLLL yyyy");
      const title = `Liquidacion ${monthLabel} (${rango}) - ${deptLabel || "Departamento"}`;
      const filename = `${title.replace(/\s+/g, "_")}.xlsx`;

      // ======== TITULO (FILA 1) ========
      ws.addRow([title]);
      ws.mergeCells(1, 1, 1, headers.length);
      const titleCell = ws.getCell("A1");
      titleCell.font = { name: "Aptos Narrow", size: 13, bold: true };
      ws.getRow(1).height = 30;

      // ======== FILA 2 VACÍA ========
      ws.addRow([]);

      // ======== FILA 3: HEADERS ========
      const headerRow = ws.addRow(headers);
      headerRow.eachCell((cell) => {
        cell.font = fontHeader;
        cell.fill = fillBlack;
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.border = { top: borderThin, left: borderThin, bottom: borderThin, right: borderThin };
      });
      ws.getRow(3).height = 30;

      // helper: función que agrega una sección (ARS o USD)
      const writeSection = (label, items, startRow) => {
        const secRow = ws.addRow([label]);
        secRow.getCell(1).font = { ...fontHeader, bold: true };
        secRow.getCell(1).fill = fillBlack;
        ws.mergeCells(secRow.number, 1, secRow.number, headers.length);
        ws.getRow(secRow.number).height = 30;

        // datos
        items.forEach((r) => {
          const row = ws.addRow([
            r.reserva,
            r.huesped,
            r.checkin,
            r.checkout,
            r.canal,
            r.forma,
            r.bruto,
            r.comision,
            r.tasa,
            r.costo,
            r.neto,
            r.observaciones,
          ]);
          row.eachCell((cell, colNumber) => {
            cell.font = fontBase;
            const key = headers[colNumber - 1];
            if (["Cobrado Bruto (reserva + comisión canal+ tasa limpieza+ IVA)",
                 "Comisión Canal (booking, despegar, expedia)",
                 "Tasa de limpieza pagada por el huesped",
                 "Costo financiero (comision TC, IIBB etc)",
                 "Neto"].includes(key)) {
              cell.numFmt = '#,##0.00';
              cell.alignment = { horizontal: "right", vertical: "middle" };
            } else {
              cell.alignment = { vertical: "middle" };
            }
            cell.border = { top: borderThin, left: borderThin, bottom: borderThin, right: borderThin };
          });
          ws.getRow(row.number).height = 30;
        });

        // fila total
        const total = items.reduce((sum, r) => sum + (r.neto || 0), 0);
        const totalRow = ws.addRow(["TOTAL " + label]);
        totalRow.getCell(1).font = fontHeader;
        totalRow.getCell(1).fill = fillBlack;
        totalRow.getCell(11).value = total;
        totalRow.getCell(11).numFmt = '#,##0.00';
        totalRow.getCell(11).font = { ...fontHeader, color: { argb: "FFFFFFFF" } };
        totalRow.getCell(11).alignment = { horizontal: "right", vertical: "middle" };
        ws.mergeCells(totalRow.number, 1, totalRow.number, headers.length);
        ws.getRow(totalRow.number).height = 30;
      };

      // ======== SECCIÓN EN PESOS ========
      writeSection("LIQUIDACION EN $", buildRowsFromByCur({ ARS: byCur.ARS || [] }), ws.lastRow.number + 1);

      // ======== SECCIÓN EN USD ========
      writeSection("LIQUIDACION EN USD", buildRowsFromByCur({ USD: byCur.USD || [] }), ws.lastRow.number + 2);

      ws.columns.forEach((col, i) => {
        col.width = [12, 28, 14, 14, 16, 24, 22, 22, 26, 22, 14, 26][i] || 18;
      });

      // ======== DESCARGA ========
      const buf = await wb.xlsx.writeBuffer();
      saveAs(new Blob([buf], { type: "application/octet-stream" }), filename);
    } catch (err) {
      console.error("[ExportLiquidacionesExcel] Error:", err);
      alert("No se pudo exportar el Excel. Revisá la consola.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button type="button" className="btn" onClick={handleExport} disabled={loading}>
      {loading ? "Exportando…" : "Exportar Excel"}
    </button>
  );
}



