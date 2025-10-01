// money.ts / utils/money.js
export const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Formatea montos con separador de miles y 2 decimales.
 * - ARS usa es-AR → 1.234.567,89
 * - USD usa en-US → 1,234,567.89
 * @param {number} n         monto
 * @param {string} currency  "USD" | "ARS"
 * @param {boolean} symbol   true para incluir símbolo ($, US$)
 */
export const money = (n, currency = "USD", symbol = false) => {
  const val = safeNum(n);
  const cur = String(currency || "USD").toUpperCase();
  const locale = cur === "ARS" ? "es-AR" : "en-US";

  // si querés sin símbolo (p.ej. "1.234,56") y luego agregás " USD" fuera:
  if (!symbol) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(val);
  }
  // con símbolo local (para chips, tooltips, etc.)
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: cur,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
};

/** Números genéricos (TC, PAX, etc.) con miles */
export const numFmt = (n, locale = "es-AR") =>
  new Intl.NumberFormat(locale).format(safeNum(n));
