import React, { useState } from "react";
import { DateTime } from "luxon";

const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

// ===== helpers locales =====
const money = (n, cur) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const c = (cur || "USD").toString().toUpperCase();
  return `${v.toFixed(2)} ${c}`;
};
const fmtDay = (iso, tz) =>
  iso ? DateTime.fromISO(String(iso), { zone: tz }).toFormat("dd/MM/yyyy") : "";
const fmtHourTS = (ts, tz) => {
  if (!ts) return "";
  if (ts?.seconds ?? ts?._seconds) {
    const s = ts.seconds ?? ts._seconds;
    return DateTime.fromSeconds(Number(s), { zone: tz }).toFormat("HH:mm");
  }
  try {
    const d = DateTime.fromISO(String(ts), { zone: tz });
    if (d.isValid) return d.toFormat("HH:mm");
  } catch {}
  return "";
};
const getPayments = (r) => (r && Array.isArray(r.payments) ? r.payments : []);

// ===== componente =====
export default function ExportBottomExcel({
  // OJO: si viene itemsLoader se usa eso (lee checkins+checkouts del backend).
  items,
  itemsLoader,
  tz = DEFAULT_TZ,
  filenamePrefix = "planilla_hosts",
}) {
  const [loading, setLoading] = useState(false);

  const buildRows = (sourceItems = []) => {
    const rows = [];
    sourceItems.forEach((r, idx) => {
      const pays = getPayments(r);
      rows.push({
        _sepTop: idx > 0,
        depto: r.depto_nombre || r.nombre_depto || r.codigo_depto || r.id_zak || "—",
        pax: r.adults ?? "",
        nombre: r.nombre_huesped || "",
        tel: r.customer_phone || r.telefono || "",
        checkin: fmtDay(r.arrival_iso, tz),
        hora_in: fmtHourTS(r.checkin_at, tz),
        checkout: fmtDay(r.departure_iso, tz),
        hora_out: fmtHourTS(r.checkout_at, tz),
        agencia: r.source || r.channel_name || "",
        toPay: money(r.toPay, "USD"),
        pago: pays[0] ? money(pays[0].amount, pays[0].currency) : "",
        metodo: pays[0]?.method || "",
        concepto: pays[0]?.concept || "",
        // flags para colorear
        payStatus: String(r.payment_status || "unpaid").toLowerCase(),
        hasCheckin: !!r.checkin_at,
        wasContacted: !!r.contacted_at,
      });

      for (let i = 1; i < pays.length; i++) {
        const p = pays[i];
        rows.push({
          _payRow: true,
          depto: "", pax: "", nombre: "", tel: "",
          checkin: "", hora_in: "", checkout: "", hora_out: "",
          agencia: "", toPay: "",
          pago: money(p.amount, p.currency),
          metodo: p.method || "",
          concepto: p.concept || "",
        });
      }
    });
    return rows;
  };

  const handleExport = async () => {
    try {
      setLoading(true);

      // 1) traigo ítems: si hay loader => checkins+checkouts; si no, prop items
      const sourceItems = itemsLoader ? await itemsLoader() : (Array.isArray(items) ? items : []);

      const [{ default: ExcelJS }, { saveAs }] = await Promise.all([
        import("exceljs"),
        import("file-saver"),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Planilla");

      // fuentes, bordes y fills (coinciden con tu UI)
      const fontBase   = { name: "Aptos Narrow", size: 11 };
      const fontHeader = { ...fontBase, bold: true, color: { argb: "FF111827" } };
      const fillHeader = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
      const borderThinGray   = { style: "thin",   color: { argb: "FFE5E7EB" } };
      const borderThickBlack = { style: "medium", color: { argb: "FF0F172A" } };

      // Colores de estado (HEX -> ARGB)
      const FILL_CHECKIN  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF38BDF8" } }; // celeste
      const FILL_CONTACT  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE68A" } }; // amarillo
      const FILL_PAID     = { type: "pattern", pattern: "solid", fgColor: { argb: "FF86EFAC" } }; // verde
      const FILL_PARTIAL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCD34D" } }; // ámbar
      const FILL_UNPAID   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFECACA" } }; // rojo claro

      // Definición de columnas
      const columns = [
        { key: "depto",   header: "Unidad",        width: 26 },
        { key: "pax",     header: "PAX",           width: 6  },
        { key: "nombre",  header: "Nombre",        width: 24 },
        { key: "tel",     header: "Teléfono",      width: 18 },
        { key: "checkin", header: "Check in",      width: 12 },
        { key: "hora_in", header: "Hora in",       width: 10 },
        { key: "checkout",header: "Check out",     width: 12 },
        { key: "hora_out",header: "Hora out",      width: 10 },
        { key: "agencia", header: "Agencia",       width: 14 },
        { key: "toPay",   header: "A pagar",       width: 14 },
        { key: "pago",    header: "Pago",          width: 14 },
        { key: "metodo",  header: "Forma de pago", width: 16 },
        { key: "concepto",header: "Concepto",      width: 18 },
      ];
      ws.columns = columns;

      // === Encabezado (una sola vez) ===
      const headerRow = ws.addRow(columns.map(c => c.header));
      headerRow.eachCell((cell) => {
        cell.font = fontHeader;
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.fill = fillHeader;
        cell.border = {
          top: borderThinGray, left: borderThinGray,
          bottom: borderThinGray, right: borderThinGray,
        };
      });
      ws.getRow(1).height = 22;

      // === Datos ===
      const rows = buildRows(sourceItems);
      rows.forEach((r) => {
        const excelRow = ws.addRow(columns.map(c => r[c.key] ?? ""));
        // bordes y alineaciones
        excelRow.eachCell((cell, colNumber) => {
          cell.font = fontBase;
          cell.border = {
            top: r._sepTop ? borderThickBlack : (r._payRow ? borderThinGray : undefined),
            left: undefined,
            bottom: borderThinGray,
            right: undefined,
          };
          const key = columns[colNumber - 1].key;
          if (key === "toPay" || key === "pago") {
            cell.alignment = { horizontal: "right",  vertical: "middle" };
          } else if (key === "hora_in" || key === "hora_out") {
            cell.alignment = { horizontal: "center", vertical: "middle" };
          } else {
            cell.alignment = { vertical: "middle" };
          }
          if (key === "toPay") cell.font = { ...fontBase, bold: true, color: { argb: "FF000000" } };
          if (key === "pago")  cell.font = { ...fontBase, bold: true, color: { argb: "FF374151" } };
        });
        excelRow.height = 20;

        // === COLORES por estado (solo filas de reserva, no subfilas de pago) ===
        if (!r._payRow) {
          // Unidad con check-in => col A
          if (r.hasCheckin) ws.getCell(excelRow.number, 1).fill = FILL_CHECKIN;
          // Nombre si contactado => col C
          if (r.wasContacted) ws.getCell(excelRow.number, 3).fill = FILL_CONTACT;
          // Pago según estado => col K
          if (r.payStatus === "paid")    ws.getCell(excelRow.number, 11).fill = FILL_PAID;
          else if (r.payStatus === "partial") ws.getCell(excelRow.number, 11).fill = FILL_PARTIAL;
          else ws.getCell(excelRow.number, 11).fill = FILL_UNPAID;
        }
      });

      // congelar encabezado
      ws.views = [{ state: "frozen", ySplit: 1 }];

      // exportar
      const buf = await wb.xlsx.writeBuffer();
      const fname = `${filenamePrefix}_${DateTime.now().setZone(tz).toFormat("yyyy-LL-dd")}.xlsx`;
      saveAs(new Blob([buf], { type: "application/octet-stream" }), fname);
    } catch (err) {
      console.error("[ExportBottomExcel] Error exportando:", err);
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


