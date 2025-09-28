// /api/dolarByDate.js
// Trae la cotización del dólar para una fecha dada usando ArgentinaDatos.
// Ejemplo: /api/dolarByDate?fecha=2024-01-01&casa=blue

import { DateTime } from "luxon";

const BASE = "https://argentinadatos.com/v1/cotizaciones/dolares";

export default async function handler(req, res) {
  try {
    const { fecha, casa = "blue", compact } = req.query;

    if (!fecha) {
      return res.status(400).json({
        error: "missing_fecha",
        message: "Parámetro 'fecha' requerido en formato YYYY-MM-DD",
        example: "/api/dolarByDate?fecha=2024-01-01&casa=blue",
      });
    }

    // Acepta YYYY-MM-DD y lo convierte a YYYY/MM/DD (formato de ArgentinaDatos)
    const dt = DateTime.fromISO(fecha, { zone: "UTC" });
    if (!dt.isValid) {
      return res.status(400).json({
        error: "invalid_fecha",
        message: "Formato inválido. Usá YYYY-MM-DD (ej: 2024-01-01)",
      });
    }
    const fechaPath = dt.toFormat("yyyy/MM/dd");

    const url = `${BASE}/${encodeURIComponent(casa)}/${fechaPath}`;
    const upstream = await fetch(url, { headers: { accept: "application/json" } });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(502).json({
        error: "upstream_error",
        status: upstream.status,
        url,
        body: text.slice(0, 500),
      });
    }

    const data = await upstream.json();

    // Opcional: modo compacto ?compact=true -> solo compra/venta/fecha/casa
    if (compact === "true") {
      // La API devuelve un objeto con {moneda, casa, fecha, compra, venta}
      const { casa: c, fecha: f, compra, venta, moneda } = data || {};
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");
      return res.status(200).json({
        fuente: "argentinadatos",
        casa: c ?? casa,
        fecha: f ?? dt.toISODate(),
        moneda: moneda ?? "USD",
        compra,
        venta,
      });
    }

    // Respuesta completa (raw) + metadatos mínimos
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");
    return res.status(200).json({
      fuente: "argentinadatos",
      casa,
      fecha: dt.toISODate(),
      raw: data,
    });
  } catch (err) {
    return res.status(500).json({
      error: "unexpected",
      message: err?.message || "Error inesperado",
    });
  }
}
