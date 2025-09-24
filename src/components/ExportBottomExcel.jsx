// src/components/ExportBottomExcel.jsx
import React, { useState } from "react";
import { DateTime } from "luxon";

const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

// Helpers locales (idénticos a los que usás arriba)
const money = (n, cur) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const c = (cur || "USD").toString().toUpperCase();
  return `${v.toFixed(2)} ${c}`;
};
const fmtDay = (iso, tz) => (iso ? DateTime.fromISO(iso, { zone: tz }).toFormat("dd/MM/yyyy") : "");
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

export default function ExportBottomExcel({ items, tz = DEFAULT_TZ, filenamePrefix = "planilla_hosts" }) {
  const [loading, setLoading] = useState(false);

  const buildRows = () => {
    const rows = [];
    items.forEach((r, idx) => {
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

      // ⬇️  CARGA DIFERIDA (esto genera chunks separados)
      const [{ default: ExcelJS }, { saveAs }] = await Promise.all([
        import('exceljs'),
        import('file-saver'),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Planilla");

      // Fuentes y colores
      const fontBase   = { name: "Aptos Narrow", size: 11 };
      const fontHeader = { ...fontBase, bold: true, color: { argb: "FF111827" } };
      const fillHeader = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
      const borderThinGray   = { style: "thin",   color: { argb: "FFE5E7EB" } };
      const borderThickBlack = { style: "medium", color: { argb: "FF0F172A" } };

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

      // Encabezado
      const headerRow = ws.addRow(columns.map(c => c.header));
      headerRow.eachCell((cell) => {
        cell.font = fontHeader;
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.fill = fillHeader;
        cell.border = { top: borderThinGray, left: borderThinGray, bottom: borderThinGray, right: borderThinGray };
      });
      ws.getRow(1).height = 22;

      // Datos
      const rows = buildRows();
      rows.forEach((r) => {
        const excelRow = ws.addRow(columns.map(c => r[c.key] ?? ""));
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
      });

      // Congelar encabezado
      ws.views = [{ state: "frozen", ySplit: 1 }];

      // Exportar
      const buf = await wb.xlsx.writeBuffer();
      const fname = `${filenamePrefix}_${DateTime.now().setZone(tz).toFormat("yyyy-LL-dd")}.xlsx`;
      saveAs(new Blob([buf], { type: "application/octet-stream" }), fname);
    } catch (err) {
      console.error('[ExportBottomExcel] Error exportando:', err);
      alert('No se pudo exportar el Excel. Revisá la consola para más detalle.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button type="button" className="btn" onClick={handleExport} disabled={loading}>
      {loading ? 'Exportando…' : 'Exportar Excel'}
    </button>
  );
}
