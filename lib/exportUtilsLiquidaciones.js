// exportUtilsLiquidaciones.js
import { DateTime } from "luxon";

export const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

/* ---------- estilos Excel ---------- */
export function buildStyles() {
  const fontBase      = { name: "Aptos Narrow", size: 11 };
  const fontHeader    = { name: "Aptos Narrow", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  const fontWhiteBold = { name: "Aptos Narrow", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  const fontBlackBold = { name: "Aptos Narrow", size: 11, bold: true, color: { argb: "FF000000" } };
  const fillBlack     = { type: "pattern", pattern: "solid", fgColor: { argb: "FF000000" } };
  const borderThin    = {
    top:    { style: "thin", color: { argb: "FFCCCCCC" } },
    left:   { style: "thin", color: { argb: "FFCCCCCC" } },
    bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
    right:  { style: "thin", color: { argb: "FFCCCCCC" } },
  };
  const alignCenter = { vertical: "middle", horizontal: "center", wrapText: true };
  const alignLeft   = { vertical: "middle", horizontal: "left",   wrapText: true };
  const alignRight  = { vertical: "middle", horizontal: "right",  wrapText: true };

  return { fontBase, fontHeader, fontWhiteBold, fontBlackBold, fillBlack, borderThin, alignCenter, alignLeft, alignRight };
}

/* ---------- builder de filas (con/sin "Departamento") ---------- */
export function buildRowsFromByCur(byCur, { includeDepartment = false } = {}) {
  const all = [...(byCur?.ARS || []), ...(byCur?.USD || [])];

  return all.map((r) => {
    const acc = r._res?.accounting || {};
    const fx  = Number(r.fx_used || 0) || 0;
    const cur = String(r.pay_currency || "").toUpperCase();
    const bruto = Number(r.pay_amount ?? 0) || 0;

    // mismo cálculo que la tabla
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

    const base = {
      reserva:      r.id_human || "",
      huesped:      r.huesped || "",
      checkin:      r.checkin || "",
      checkout:     r.checkout || "",
      canal:        r.canal || "",
      forma:        [r.pay_method || "—", r.pay_concept || ""].filter(Boolean).join(" · "),
      bruto,
      comision:     Number(acc.comisionCanalUSD || 0),
      tasa:         Number(acc.tasaLimpiezaUSD || 0),
      costo:        Number(acc.costoFinancieroUSD || 0),
      neto,
      observaciones: acc.observaciones || "",
      moneda:       cur,
    };

    return includeDepartment
      ? { departamento: r.departamento_nombre || "", ...base }
      : base;
  });
}

/* ---------- headers / widths / money cols según modo ---------- */
export function getLayoutConfig({ includeDepartment }) {
  if (includeDepartment) {
    // con "Departamento" al inicio
    return {
      HEADERS: [
        "Departamento",
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
      ],
      widths: [22, 12, 28, 14, 14, 16, 24, 22, 22, 26, 22, 14, 26],
      moneyCols: [8, 9, 10, 11, 12], // H..L
      netIdx: 12,                    // "Neto"
    };
  }
  // sin "Departamento"
  return {
    HEADERS: [
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
    ],
    widths: [12, 28, 14, 14, 16, 24, 22, 22, 26, 22, 14, 26],
    moneyCols: [7, 8, 9, 10, 11], // G..K
    netIdx: 11,
  };
}

/* ---------- escribir sección ($/USD) ---------- */
export function writeSection(ws, label, rows, styles, { HEADERS, moneyCols, netIdx, rowHeights }) {
  // título de sección (negro sin fill)
  const secRow = ws.addRow([label]);
  ws.getRow(secRow.number).height = rowHeights.sectionTitle; // ~50 px
  ws.mergeCells(secRow.number, 1, secRow.number, HEADERS.length);
  const c = ws.getCell(secRow.number, 1);
  c.font = styles.fontBlackBold;
  c.alignment = styles.alignLeft;

  if (!rows.length) {
    const r = ws.addRow(["sin datos"]);
    ws.getRow(r.number).height = rowHeights.data;
    r.eachCell((cell, col) => {
      cell.font = styles.fontBase;
      cell.border = styles.borderThin;
      cell.alignment = col === 1 ? styles.alignLeft : styles.alignRight;
    });
  } else {
    rows.forEach((r) => {
      const values = (HEADERS[0] === "Departamento")
        ? [r.departamento, r.reserva, r.huesped, r.checkin, r.checkout, r.canal, r.forma, r.bruto, r.comision, r.tasa, r.costo, r.neto, r.observaciones]
        : [r.reserva, r.huesped, r.checkin, r.checkout, r.canal, r.forma, r.bruto, r.comision, r.tasa, r.costo, r.neto, r.observaciones];

      const excelRow = ws.addRow(values);
      ws.getRow(excelRow.number).height = rowHeights.data;
      excelRow.eachCell((cell, colNumber) => {
        cell.font = styles.fontBase;
        const isMoney = moneyCols.includes(colNumber);
        cell.alignment = isMoney ? styles.alignRight : styles.alignLeft;
        if (isMoney) cell.numFmt = '#,##0.00';
        cell.border = styles.borderThin;
      });
    });
  }

  // fila TOTAL (negro/blanco, sin bordes, no combinada)
  const total = rows.reduce((s, r) => s + (Number(r.neto) || 0), 0);
  const totalRow = ws.addRow(new Array(HEADERS.length).fill(""));
  ws.getRow(totalRow.number).height = rowHeights.total;

  for (let col = 1; col <= HEADERS.length; col++) {
    const cell = ws.getCell(totalRow.number, col);
    cell.fill = styles.fillBlack;
    cell.font = styles.fontWhiteBold;
    cell.border = { top: undefined, left: undefined, bottom: undefined, right: undefined };
    cell.alignment = col === netIdx ? styles.alignRight : styles.alignLeft;
  }
  ws.getCell(totalRow.number, 1).value = `TOTAL EN ${label.endsWith("USD") ? "USD" : "$"}`;
  ws.getCell(totalRow.number, netIdx).value = total;
  ws.getCell(totalRow.number, netIdx).numFmt = '#,##0.00';
}

/* ---------- título/filename ---------- */
export function buildTitleAndFilename({ fromISO, toISO, tz = DEFAULT_TZ, titleSuffix }) {
  const dFrom = DateTime.fromISO(fromISO, { zone: tz }).setLocale("es");
  const dTo   = DateTime.fromISO(toISO,   { zone: tz }).setLocale("es");
  const monthShort = dFrom.toFormat("LLL yy");
  const rango = `${dFrom.toFormat("dd/MM/yyyy")} al ${dTo.toFormat("dd/MM/yyyy")}`;
  const title = `Liquidacion ${monthShort} (${rango}) - ${titleSuffix}`;
  const filename = `${title.replace(/\s+/g, "_")}.xlsx`;
  return { title, filename, monthShort, rango };
}

export const rowHeights = {
  title: 30,
  spacer: 22,
  header: 75,
  sectionTitle: 50,
  data: 22,
  total: 22,
};