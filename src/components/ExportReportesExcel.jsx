import React, { useState } from 'react';
import { DateTime } from 'luxon';

const TZ = 'America/Argentina/Buenos_Aires';

function safeSheetName(name) {
  return String(name || 'Reporte').replace(/[\\/*?:[\]]/g, ' ').slice(0, 31);
}

function buildFilename({ reportLabel, fromISO, toISO }) {
  const from = DateTime.fromISO(fromISO, { zone: TZ }).toFormat('yyyyLLdd');
  const to = DateTime.fromISO(toISO, { zone: TZ }).toFormat('yyyyLLdd');
  return `${String(reportLabel || 'Reporte').replace(/\s+/g, '_')}_${from}_${to}.xlsx`;
}

export default function ExportReportesExcel({
  rows = [],
  sections = [],
  totals = [],
  fromISO,
  toISO,
  reportLabel = 'Recaudacion',
  disabled = false,
}) {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    try {
      setLoading(true);
      const [{ default: ExcelJS }, { saveAs }] = await Promise.all([
        import('exceljs'),
        import('file-saver'),
      ]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(safeSheetName(reportLabel));
      const title = `${reportLabel} - ${DateTime.fromISO(fromISO, { zone: TZ }).toFormat('dd/MM/yyyy')} al ${DateTime.fromISO(toISO, { zone: TZ }).toFormat('dd/MM/yyyy')}`;

      const styles = {
        title: { name: 'Aptos Narrow', size: 13, bold: true },
        header: { name: 'Aptos Narrow', size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
        base: { name: 'Aptos Narrow', size: 11 },
        bold: { name: 'Aptos Narrow', size: 11, bold: true },
        fillHeader: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } },
        fillTotal: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } },
        border: {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        },
      };

      ws.mergeCells(1, 1, 1, 6);
      ws.getCell(1, 1).value = title;
      ws.getCell(1, 1).font = styles.title;
      ws.addRow([]);

      const headers = ['Forma de pago', 'Propiedad', 'Moneda', 'Cantidad reservas', 'Cantidad noches', 'Total'];
      const headerRow = ws.addRow(headers);
      headerRow.eachCell((cell) => {
        cell.font = styles.header;
        cell.fill = styles.fillHeader;
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = styles.border;
      });

      sections.forEach((section) => {
        const methodRow = ws.addRow([section.paymentMethod]);
        ws.mergeCells(methodRow.number, 1, methodRow.number, 6);
        methodRow.eachCell((cell) => {
          cell.font = styles.bold;
          cell.fill = styles.fillTotal;
          cell.border = styles.border;
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
        });

        section.rows.forEach((row) => {
          const excelRow = ws.addRow([
            '',
            row.propertyName,
            row.currency,
            row.reservationCount,
            row.nightCount,
            row.total,
          ]);
          excelRow.eachCell((cell, colNumber) => {
            cell.font = styles.base;
            cell.border = styles.border;
            cell.alignment = {
              vertical: 'middle',
              horizontal: colNumber >= 4 ? 'right' : 'left',
              wrapText: true,
            };
            if (colNumber === 6) cell.numFmt = '#,##0.00';
          });
        });

        section.totals.forEach((total) => {
          const totalRow = ws.addRow([
            `Total ${section.paymentMethod}`,
            '',
            total.currency,
            total.reservationCount,
            total.nightCount,
            total.total,
          ]);
          totalRow.eachCell((cell, colNumber) => {
            cell.font = styles.bold;
            cell.fill = styles.fillTotal;
            cell.border = styles.border;
            cell.alignment = { vertical: 'middle', horizontal: colNumber >= 4 ? 'right' : 'left' };
            if (colNumber === 6) cell.numFmt = '#,##0.00';
          });
        });
      });

      if (!rows.length) {
        const emptyRow = ws.addRow(['Sin datos para el periodo seleccionado']);
        ws.mergeCells(emptyRow.number, 1, emptyRow.number, 6);
      }

      ws.addRow([]);
      const totalHeader = ws.addRow(['Totales por moneda']);
      totalHeader.getCell(1).font = styles.bold;
      totals.forEach((total) => {
        const totalRow = ws.addRow(['', '', total.currency, total.reservationCount, total.nightCount, total.total]);
        totalRow.eachCell((cell, colNumber) => {
          cell.font = styles.bold;
          cell.fill = styles.fillTotal;
          cell.border = styles.border;
          cell.alignment = { vertical: 'middle', horizontal: colNumber >= 4 ? 'right' : 'left' };
          if (colNumber === 6) cell.numFmt = '#,##0.00';
        });
      });

      ws.columns = [
        { width: 26 },
        { width: 30 },
        { width: 12 },
        { width: 18 },
        { width: 16 },
        { width: 18 },
      ];

      const buf = await wb.xlsx.writeBuffer();
      saveAs(new Blob([buf], { type: 'application/octet-stream' }), buildFilename({ reportLabel, fromISO, toISO }));
    } catch (err) {
      console.error('[ExportReportesExcel] Error exportando:', err);
      alert('No se pudo exportar el Excel. Revisa la consola.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button type="button" className="btn" onClick={handleExport} disabled={disabled || loading}>
      {loading ? 'Exportando...' : 'Exportar Excel'}
    </button>
  );
}
