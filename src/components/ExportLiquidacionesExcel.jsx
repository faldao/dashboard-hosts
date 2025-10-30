// ExportLiquidacionesExcel.jsx
import React, { useState } from "react";
import { DateTime } from "luxon";

// Misma zona que usás en la página
const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

/** money con sufijo de moneda (solo string de presentación) */
const money = (n, cur) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const c = (cur || "USD").toString().toUpperCase();
  return `${v.toFixed(2)} ${c}`;
};

/**
 * rowsBuilder:
 *  - Recibe { ARS:[], USD:[] } de buildByCurrency
 *  - Recibe el id seleccionado del depto y el flag showDepartmentColumn por si querés incluir o no la columna
 *  - Devuelve filas normalizadas con las mismas columnas del grid (más "Moneda")
 */
function buildRowsForExcel(byCur, deptId, showDepartmentColumn) {
  const take = (arr) =>
    (Array.isArray(arr) ? arr : []).filter((r) => {
      // Filtrado por depto: tolera que tu deptId sea código o id real
      if (!deptId) return false; // requerimos depto seleccionado
      const rowDeptId =
        r._res?.codigo_departamento ||
        r._res?.departamento_codigo ||
        r._res?.dept_id ||
        r._res?.departamento_id ||
        r._res?.id_departamento ||
        r._res?.departamentoCodigo ||
        r._res?.codigo; // mejores esfuerzos
      const rowDeptCode =
        r._res?.codigo || r._res?.codigo_depto || r._res?.department_code;

      // Igualamos por id o por código
      return String(rowDeptId || rowDeptCode || "").toLowerCase() === String(deptId).toLowerCase();
    });

  // Unimos ARS y USD en una sola lista, agregando columna Moneda
  const rows = [...take(byCur.ARS), ...take(byCur.USD)].map((r) => {
    // Neto ya viene calculado UI-side en la moneda de la fila
    // En la UI lo mostrás con moneyIntl(netAmount, netCur) — acá guardamos netAmount + netCur
    const netoCur = r.pay_currency === "USD" ? "USD" : "ARS";

    // Valores “editables” que terminaste escribiendo en accounting via debounce
    const acc = r._res?.accounting || {};

    return {
      departamento: r.departamento_nombre || "",
      reserva: r.id_human || "",
      huesped: r.huesped || "",
      checkin: r.checkin || "",
      checkout: r.checkout || "",
      canal: r.canal || "",
      forma: [r.pay_method || "—", r.pay_concept || ""].filter(Boolean).join(" · "),
      moneda: r.pay_currency || "",

      // “Bruto” mostrado en la celda (r.pay_amount ya está en la moneda de la fila)
      bruto: r.pay_amount ?? 0,

      // Los demás en USD (como en tu UI/estado contable)
      comision: Number(acc.comisionCanalUSD ?? 0),
      tasa: Number(acc.tasaLimpiezaUSD ?? 0),
      costo: Number(acc.costoFinancieroUSD ?? 0),

      // Neto: si la fila es USD, usamos netoUSD; si es ARS, convertimos los componentes a ARS
      // Peeero: r ya te trae el neto renderizado; como no viaja explícito, lo recalculamos con la misma regla que tu Row:
      _fx: r.fx_used || 0,
      _netCur: netoCur,

      observaciones: acc.observaciones || "",
    };
  });

  // Recalcula “Neto” imitando la UI (sin depender del render):
  rows.forEach((row) => {
    const fx = Number(row._fx) || 0;
    if (row._netCur === "USD") {
      const brutoUSD = row.moneda === "USD" ? Number(row.bruto) : (fx ? Number(row.bruto) / fx : 0);
      const netUSD = +(brutoUSD + row.comision + row.tasa + row.costo).toFixed(2);
      row.neto = netUSD;
    } else {
      // ARS: bruto está en ARS; H/I/J en USD => pasamos a ARS
      const H_ars = fx ? row.comision * fx : 0;
      const I_ars = fx ? row.tasa * fx : 0;
      const J_ars = fx ? row.costo * fx : 0;
      const netARS = +(Number(row.bruto) + H_ars + I_ars + J_ars).toFixed(2);
      row.neto = netARS;
    }
    delete row._fx;
    delete row._netCur;
  });

  // Orden similar a la tabla: por checkin, luego reserva
  rows.sort(
    (a, b) =>
      String(a.checkin).localeCompare(String(b.checkin)) ||
      String(a.reserva).localeCompare(String(b.reserva))
  );

  // Si no querés mostrar la columna “Departamento” cuando ya hay depto filtrado
  if (!showDepartmentColumn) {
    rows.forEach((r) => delete r.departamento);
  }

  return rows;
}

export default function ExportLiquidacionesExcel({
  byCur,           // { ARS:[], USD:[] } — salida de buildByCurrency
  deptId,          // depto seleccionado (OBLIGATORIO)
  fromISO,         // para el título
  toISO,           // para el título
  tz = DEFAULT_TZ, // zona
  showDepartmentColumn = false, // en este export per-depto suele ser false
  filenamePrefix = "liquidacion_depto",
}) {
  const [loading, setLoading] = useState(false);

  const COLUMNS = [
    ...(showDepartmentColumn ? [{ key: "departamento", header: "Departamento", width: 26 }] : []),
    { key: "reserva",     header: "Reserva",          width: 16 },
    { key: "huesped",     header: "Huésped",          width: 26 },
    { key: "checkin",     header: "Check in",         width: 12 },
    { key: "checkout",    header: "Check out",        width: 12 },
    { key: "canal",       header: "Canal",            width: 14 },
    { key: "forma",       header: "Forma de cobro",   width: 24 },
    { key: "moneda",      header: "Moneda",           width: 10 },
    { key: "bruto",       header: "Cobrado Bruto",    width: 16 },
    { key: "comision",    header: "Comisión Canal (USD)", width: 20 },
    { key: "tasa",        header: "Tasa limpieza (USD)",  width: 20 },
    { key: "costo",       header: "Costo financiero (USD)", width: 22 },
    { key: "neto",        header: "Neto",             width: 16 },
    { key: "observaciones", header: "Observaciones",  width: 30 },
  ];

  const handleExport = async () => {
    try {
      if (!deptId) {
        alert("Seleccioná un departamento para exportar su detalle.");
        return;
      }

      setLoading(true);

      const rows = buildRowsForExcel(byCur, deptId, showDepartmentColumn);
      if (!rows.length) {
        alert("No hay filas para exportar en el departamento seleccionado.");
        setLoading(false);
        return;
      }

      const [{ default: ExcelJS }, { saveAs }] = await Promise.all([
        import("exceljs"),
        import("file-saver"),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Detalle");

      // Estilos base
      const fontBase   = { name: "Aptos Narrow", size: 11 };
      const fontHeader = { ...fontBase, bold: true, color: { argb: "FF111827" } };
      const fillHeader = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
      const borderThinGray   = { style: "thin",   color: { argb: "FFE5E7EB" } };

      // 1) Título (merge celdas)
      const rango = `${DateTime.fromISO(fromISO, { zone: tz }).toFormat("dd/LL/yyyy")} → ${DateTime.fromISO(toISO, { zone: tz }).toFormat("dd/LL/yyyy")}`;
      const titulo = `Detalle de liquidación — Departamento ${deptId} — ${rango}`;
      const titleRow = ws.addRow([titulo]);
      titleRow.height = 24;
      const titleCell = ws.getCell(titleRow.number, 1);
      titleCell.font = { name: "Aptos Narrow", size: 13, bold: true };
      titleCell.alignment = { vertical: "middle", horizontal: "left" };
      ws.mergeCells(titleRow.number, 1, titleRow.number, COLUMNS.length);

      // 2) Encabezado
      ws.addRow([]); // espacio
      ws.columns = COLUMNS;
      const headerRow = ws.addRow(COLUMNS.map((c) => c.header));
      headerRow.eachCell((cell) => {
        cell.font = fontHeader;
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.fill = fillHeader;
        cell.border = { top: borderThinGray, left: borderThinGray, bottom: borderThinGray, right: borderThinGray };
      });
      ws.getRow(headerRow.number).height = 22;

      // 3) Filas
      rows.forEach((r) => {
        const excelRow = ws.addRow(COLUMNS.map((c) => r[c.key] ?? ""));
        excelRow.eachCell((cell, colNumber) => {
          cell.font = fontBase;

          // Alineaciones numéricas
          const key = COLUMNS[colNumber - 1].key;
          if (["bruto", "comision", "tasa", "costo", "neto"].includes(key)) {
            // guardamos como número en Excel; si querés formato monetario visual, podés setear numFmt
            const n = Number(r[key]);
            if (Number.isFinite(n)) cell.value = n;
            cell.alignment = { horizontal: "right", vertical: "middle" };
            // un número con dos decimales
            cell.numFmt = '#,##0.00';
          } else if (key === "checkin" || key === "checkout" || key === "moneda") {
            cell.alignment = { horizontal: "center", vertical: "middle" };
          } else {
            cell.alignment = { vertical: "middle" };
          }

          // Bordes sutiles
          cell.border = {
            top: borderThinGray,
            left: borderThinGray,
            bottom: borderThinGray,
            right: borderThinGray,
          };
        });
        excelRow.height = 20;
      });

      // 4) Congelar hasta el header
      ws.views = [{ state: "frozen", ySplit: headerRow.number }];

      // 5) Descargar
      const fname = `${filenamePrefix}_${deptId}_${DateTime.now().setZone(tz).toFormat("yyyy-LL-dd")}.xlsx`;
      const buf = await wb.xlsx.writeBuffer();
      saveAs(new Blob([buf], { type: "application/octet-stream" }), fname);
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
