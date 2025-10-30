import React, { useState } from "react";
import { DateTime } from "luxon";

const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

// ---- helpers ----
function fmtDay(iso, tz = DEFAULT_TZ) {
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
  byCur,            // { ARS:[], USD:[] } => lo que ves en pantalla
  fromISO,
  toISO,
  deptLabel,        // nombre de depto para título y archivo
  tz = DEFAULT_TZ,
  filenamePrefix = "", // no se usa: armamos el nombre exacto pedido
}) {
  const [loading, setLoading] = useState(false);

  const HEADERS = [
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

  const writeSection = (ws, label, rows, styles) => {
    // Fila título de sección (sin fill, negro)
    const secRow = ws.addRow([label]);
    ws.getRow(secRow.number).height = 22;
    ws.mergeCells(secRow.number, 1, secRow.number, HEADERS.length);
    const c = ws.getCell(secRow.number, 1);
    c.font = styles.fontBlackBold;
    c.alignment = styles.alignLeft;

    // Filas de datos o "sin datos"
    if (!rows.length) {
      const r = ws.addRow(["sin datos"]);
      ws.getRow(r.number).height = 22;
      r.eachCell((cell, col) => {
        cell.font = styles.fontBase;
        cell.border = styles.borderThin;
        cell.alignment = col === 1 ? styles.alignLeft : styles.alignRight;
      });
    } else {
      rows.forEach((r) => {
        const excelRow = ws.addRow([
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
        ws.getRow(excelRow.number).height = 22;
        excelRow.eachCell((cell, colNumber) => {
          cell.font = styles.fontBase;
          const isMoney = [7, 8, 9, 10, 11].includes(colNumber); // G,K = 7..11
          cell.alignment = isMoney ? styles.alignRight : styles.alignLeft;
          if (isMoney) cell.numFmt = '#,##0.00';
          cell.border = styles.borderThin;
        });
      });
    }

    // Fila de total (no combinada)
    const total = rows.reduce((sum, r) => sum + (Number(r.neto) || 0), 0);
    const totalRow = ws.addRow(new Array(HEADERS.length).fill(""));
    ws.getRow(totalRow.number).height = 22;

    // Estilo de fila entera (negro, sin bordes)
    for (let col = 1; col <= HEADERS.length; col++) {
      const cell = ws.getCell(totalRow.number, col);
      cell.fill = styles.fillBlack;
      cell.font = styles.fontWhiteBold;
      cell.border = { top: undefined, left: undefined, bottom: undefined, right: undefined };
      cell.alignment = col === 11 ? styles.alignRight : styles.alignLeft;
    }
    ws.getCell(totalRow.number, 1).value = `TOTAL EN ${label.endsWith("USD") ? "USD" : "$"}`;
    ws.getCell(totalRow.number, 11).value = total;
    ws.getCell(totalRow.number, 11).numFmt = '#,##0.00';
  };

  const handleExport = async () => {
    try {
      setLoading(true);

      const [{ default: ExcelJS }, { saveAs }] = await Promise.all([
        import("exceljs"),
        import("file-saver"),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Liquidación");

      // ===== estilos y alineaciones
      const fontBase = { name: "Aptos Narrow", size: 11 };
      const fontHeader = { name: "Aptos Narrow", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      const fontWhiteBold = { name: "Aptos Narrow", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      const fontBlackBold = { name: "Aptos Narrow", size: 11, bold: true, color: { argb: "FF000000" } };
      const fillBlack = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000000" } };
      const borderThin = { top: { style: "thin", color: { argb: "FFCCCCCC" } },
                           left: { style: "thin", color: { argb: "FFCCCCCC" } },
                           bottom:{ style: "thin", color: { argb: "FFCCCCCC" } },
                           right: { style: "thin", color: { argb: "FFCCCCCC" } } };
      const alignCenter = { vertical: "middle", horizontal: "center", wrapText: true };
      const alignLeft   = { vertical: "middle", horizontal: "left", wrapText: true };
      const alignRight  = { vertical: "middle", horizontal: "right", wrapText: true };

      const styles = {
        fontBase, fontHeader, fontWhiteBold, fontBlackBold,
        fillBlack, borderThin, alignCenter, alignLeft, alignRight,
      };

      // ===== título y nombre de archivo (mes en español)
      const dFrom = DateTime.fromISO(fromISO, { zone: tz }).setLocale("es");
      const dTo   = DateTime.fromISO(toISO,   { zone: tz }).setLocale("es");
      const monthShort = dFrom.toFormat("LLL yy"); // MMM YY en es (ej: oct 25)
      const rango = `${dFrom.toFormat("dd/MM/yyyy")} al ${dTo.toFormat("dd/MM/yyyy")}`;
      const dept = deptLabel || "Departamento";

      const title = `Liquidacion ${monthShort} (${rango}) - ${dept}`;
      const filename = `${title.replace(/\s+/g, "_")}.xlsx`;

      // Fila 1: título (altura 50)
      const tRow = ws.addRow([title]);
      ws.mergeCells(1, 1, 1, HEADERS.length);
      ws.getCell(1, 1).font = { name: "Aptos Narrow", size: 13, bold: true };
      ws.getRow(1).height = 30;

      // Fila 2: vacía
      ws.addRow([]);
      ws.getRow(2).height = 22;

      // Fila 3: headers blanco/negro
      const hr = ws.addRow(HEADERS);
      hr.eachCell((cell) => {
        cell.font = fontHeader;
        cell.fill = fillBlack;
        cell.alignment = alignCenter;
        cell.border = borderThin;
      });
      ws.getRow(3).height = 75; // header alto

      // Anchos
      const widths = [12, 28, 14, 14, 16, 24, 22, 22, 26, 22, 14, 26];
      ws.columns = widths.map((w) => ({ width: w }));

      // Sección $ (fila 4 empieza con este título)
      const rowsARS = buildRowsFromByCur({ ARS: byCur?.ARS || [] });
      writeSection(ws, "LIQUIDACION EN $", rowsARS, styles);

      // Sección USD (misma lógica y estilo)
      const rowsUSD = buildRowsFromByCur({ USD: byCur?.USD || [] });
      writeSection(ws, "LIQUIDACION EN USD", rowsUSD, styles);

      // Descargar
      const buf = await wb.xlsx.writeBuffer();
      saveAs(new Blob([buf], { type: "application/octet-stream" }), filename);
    } catch (e) {
      console.error("[ExportLiquidacionesExcel] Error exportando:", e);
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




