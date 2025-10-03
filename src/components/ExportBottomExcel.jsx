import React, { useState } from "react";
import { DateTime } from "luxon";

const DEFAULT_TZ = "America/Argentina/Buenos_Aires";

/* ===== helpers locales ===== */
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

/* ===== componente ===== */
export default function ExportBottomExcel({
  // Si viene itemsLoader, lo usamos (devuelve {checkins, checkouts}).
  // Si no, usamos "items" (array plano, modo legacy).
  items,
  itemsLoader,
  tz = DEFAULT_TZ,
  filenamePrefix = "planilla_hosts",
}) {
  const [loading, setLoading] = useState(false);

  const COLUMNS = [
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

      // 1) Traer datos
      const src = itemsLoader
        ? await itemsLoader() // preferido: { checkins, checkouts }
        : (Array.isArray(items) ? items : []);

      const hasBuckets =
        src && typeof src === "object" &&
        (Array.isArray(src.checkins) || Array.isArray(src.checkouts));

      const checkins  = hasBuckets ? (src.checkins  || []) : (Array.isArray(src) ? src : []);
      const checkouts = hasBuckets ? (src.checkouts || []) : [];

      const [{ default: ExcelJS }, { saveAs }] = await Promise.all([
        import("exceljs"),
        import("file-saver"),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Planilla");

      // estilos
      const fontBase   = { name: "Aptos Narrow", size: 11 };
      const fontHeader = { ...fontBase, bold: true, color: { argb: "FF111827" } };
      const fillHeader = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
      const borderThinGray   = { style: "thin",   color: { argb: "FFE5E7EB" } };
      const borderThickBlack = { style: "medium", color: { argb: "FF0F172A" } };

      const FILL_CHECKIN  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF38BDF8" } };
      const FILL_CONTACT  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE68A" } };
      const FILL_PAID     = { type: "pattern", pattern: "solid", fgColor: { argb: "FF86EFAC" } };
      const FILL_PARTIAL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCD34D" } };
      const FILL_UNPAID   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFECACA" } };

      ws.columns = COLUMNS;

      // helper: pinta la tabla (encabezado + filas de una sección)
      const writeTable = (rows, withTopBorder = false) => {
        // encabezado
        const headerRow = ws.addRow(COLUMNS.map(c => c.header));
        headerRow.eachCell((cell) => {
          cell.font = fontHeader;
          cell.alignment = { vertical: "middle", horizontal: "center" };
          cell.fill = fillHeader;
          cell.border = {
            top: withTopBorder ? borderThickBlack : borderThinGray,
            left: borderThinGray,
            bottom: borderThinGray,
            right: borderThinGray,
          };
        });
        ws.getRow(headerRow.number).height = 22;

        // filas
        rows.forEach((r) => {
          const excelRow = ws.addRow(COLUMNS.map(c => r[c.key] ?? ""));
          excelRow.eachCell((cell, colNumber) => {
            cell.font = fontBase;
            cell.border = {
              top: r._sepTop ? borderThickBlack : (r._payRow ? borderThinGray : undefined),
              left: undefined,
              bottom: borderThinGray,
              right: undefined,
            };
            const key = COLUMNS[colNumber - 1].key;
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

          if (!r._payRow) {
            if (r.hasCheckin) ws.getCell(excelRow.number, 1).fill = FILL_CHECKIN;
            if (r.wasContacted) ws.getCell(excelRow.number, 3).fill = FILL_CONTACT;
            if (r.payStatus === "paid") ws.getCell(excelRow.number, 11).fill = FILL_PAID;
            else if (r.payStatus === "partial") ws.getCell(excelRow.number, 11).fill = FILL_PARTIAL;
            else ws.getCell(excelRow.number, 11).fill = FILL_UNPAID;
          }
        });
      };

      // helper: título de sección (merge de columnas)
      const writeSectionTitle = (label) => {
        const row = ws.addRow([label]);
        row.height = 24;
        const c = ws.getCell(row.number, 1);
        c.font = { name: "Aptos Narrow", size: 12, bold: true };
        c.alignment = { vertical: "middle", horizontal: "left" };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };
        // merge across all table columns
        ws.mergeCells(row.number, 1, row.number, COLUMNS.length);
      };

      // === escritura ===
      if (hasBuckets) {
        if (Array.isArray(checkins) && checkins.length) {
          writeSectionTitle("CHECK-INS");
          writeTable(buildRows(checkins));
        } else {
          writeSectionTitle("CHECK-INS (sin datos)");
        }

        // separador visual entre secciones
        ws.addRow([]);

        if (Array.isArray(checkouts) && checkouts.length) {
          writeSectionTitle("CHECK-OUTS");
          writeTable(buildRows(checkouts), true /* top border grueso en header */);
        } else {
          writeSectionTitle("CHECK-OUTS (sin datos)");
        }
      } else {
        // modo legacy: lista única
        writeSectionTitle("RESERVAS");
        writeTable(buildRows(checkins));
      }

      // congelar la primera fila útil (si quieres solo título no lo congeles)
      ws.views = [{ state: "frozen", ySplit: 0 }];

      // 3) descargar
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



