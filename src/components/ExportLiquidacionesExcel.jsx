// components/ExportLiquidacionesExcel.jsx
import React, { useState } from "react";
import { DateTime } from "luxon";

const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

/** Aplana ARS+USD y recalcula Neto igual que en la UI */
function buildRowsFromByCur(byCur) {
  const all = [...(byCur?.ARS || []), ...(byCur?.USD || [])];

  return all
    .map((r) => {
      const acc = r._res?.accounting || {};
      const fx = Number(r.fx_used || 0) || 0;
      const cur = String(r.pay_currency || "").toUpperCase();

      const bruto = Number(r.pay_amount ?? 0) || 0;

      let neto = 0;
      if (cur === "USD") {
        const brutoUSD = bruto;
        neto = +(
          brutoUSD +
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
        departamento: r.departamento_nombre || "",
        reserva: r.id_human || "",
        huesped: r.huesped || "",
        checkin: r.checkin || "",
        checkout: r.checkout || "",
        canal: r.canal || "",
        forma: [r.pay_method || "—", r.pay_concept || ""].filter(Boolean).join(" · "),
        moneda: cur,
        bruto,
        comision: Number(acc.comisionCanalUSD || 0),
        tasa: Number(acc.tasaLimpiezaUSD || 0),
        costo: Number(acc.costoFinancieroUSD || 0),
        neto,
        observaciones: acc.observaciones || "",
      };
    })
    .sort(
      (a, b) =>
        String(a.checkin).localeCompare(String(b.checkin)) ||
        String(a.reserva).localeCompare(String(b.reserva))
    );
}

export default function ExportLiquidacionesExcel({
  byCur,                 // { ARS:[], USD:[] } — EXACTO lo visible en la tabla
  fromISO,
  toISO,
  tz = DEFAULT_TZ,
  deptLabel,             // opcional para el título/archivo
  filenamePrefix = "liquidacion_depto",
  showDepartmentColumn = false,
}) {
  const [loading, setLoading] = useState(false);

  const COLUMNS = [
    ...(showDepartmentColumn ? [{ key: "departamento", header: "Departamento", width: 26 }] : []),
    { key: "reserva",       header: "Reserva",              width: 16 },
    { key: "huesped",       header: "Huésped",              width: 26 },
    { key: "checkin",       header: "Check in",             width: 12 },
    { key: "checkout",      header: "Check out",            width: 12 },
    { key: "canal",         header: "Canal",                width: 14 },
    { key: "forma",         header: "Forma de cobro",       width: 24 },
    { key: "moneda",        header: "Moneda",               width: 10 },
    { key: "bruto",         header: "Cobrado Bruto",        width: 16 },
    { key: "comision",      header: "Comisión Canal (USD)", width: 20 },
    { key: "tasa",          header: "Tasa limpieza (USD)",  width: 20 },
    { key: "costo",         header: "Costo financiero (USD)", width: 22 },
    { key: "neto",          header: "Neto",                 width: 16 },
    { key: "observaciones", header: "Observaciones",        width: 30 },
  ];

  const handleExport = async () => {
    try {
      setLoading(true);

      const rows = buildRowsFromByCur(byCur);
      if (!rows.length) {
        alert("No hay filas para exportar.");
        setLoading(false);
        return;
      }

      // ✅ una sola importación y reuso de saveAs
      const [{ default: ExcelJS }, FileSaver] = await Promise.all([
        import("exceljs"),
        import("file-saver"),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Detalle");

      const fontBase   = { name: "Aptos Narrow", size: 11 };
      const fontHeader = { ...fontBase, bold: true, color: { argb: "FF111827" } };
      const fillHeader = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
      const borderThin = { style: "thin", color: { argb: "FFE5E7EB" } };

      const rango = `${DateTime.fromISO(fromISO, { zone: tz }).toFormat("dd/LL/yyyy")} → ${DateTime.fromISO(toISO, { zone: tz }).toFormat("dd/LL/yyyy")}`;
      const titulo = `Detalle de liquidación${deptLabel ? " — " + deptLabel : ""} — ${rango}`;
      const titleRow = ws.addRow([titulo]);
      titleRow.height = 24;
      ws.mergeCells(titleRow.number, 1, titleRow.number, COLUMNS.length);
      ws.getCell(titleRow.number, 1).font = { name: "Aptos Narrow", size: 13, bold: true };

      ws.addRow([]);
      ws.columns = COLUMNS;
      const headerRow = ws.addRow(COLUMNS.map((c) => c.header));
      headerRow.eachCell((cell) => {
        cell.font = fontHeader;
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.fill = fillHeader;
        cell.border = { top: borderThin, left: borderThin, bottom: borderThin, right: borderThin };
      });
      ws.getRow(headerRow.number).height = 22;

      rows.forEach((r) => {
        const excelRow = ws.addRow(COLUMNS.map((c) => r[c.key] ?? ""));
        excelRow.eachCell((cell, colNumber) => {
          cell.font = fontBase;
          const key = COLUMNS[colNumber - 1].key;

          if (["bruto", "comision", "tasa", "costo", "neto"].includes(key)) {
            const n = Number(r[key]);
            if (Number.isFinite(n)) cell.value = n;
            cell.alignment = { horizontal: "right", vertical: "middle" };
            cell.numFmt = '#,##0.00';
          } else if (key === "checkin" || key === "checkout" || key === "moneda") {
            cell.alignment = { horizontal: "center", vertical: "middle" };
          } else {
            cell.alignment = { vertical: "middle" };
          }

          cell.border = { top: borderThin, left: borderThin, bottom: borderThin, right: borderThin };
        });
        excelRow.height = 20;
      });

      ws.views = [{ state: "frozen", ySplit: headerRow.number }];

      const labelForFile = deptLabel
        ? deptLabel.replace(/\s+/g, "_").toLowerCase()
        : "visible";
      const fname = `${filenamePrefix}_${labelForFile}_${DateTime.now().setZone(tz).toFormat("yyyy-LL-dd")}.xlsx`;

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/octet-stream" });

      // 👇 usar SIEMPRE el mismo objeto importado arriba
      FileSaver.saveAs(blob, fname);
    } catch (err) {
      console.error("[ExportLiquidacionesExcel] Error exportando:", err);
      alert("No se pudo exportar el Excel. Revisá la consola para más detalle.");
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


