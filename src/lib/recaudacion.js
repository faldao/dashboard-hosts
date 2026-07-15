import { DateTime } from 'luxon';

const TZ = 'America/Argentina/Buenos_Aires';

function normLabel(value, fallback = 'Sin dato') {
  const txt = String(value || '').trim();
  return txt || fallback;
}

function paymentPairKey(payment, fallbackCurrency) {
  const amount = Number(payment?.amount);
  if (!Number.isFinite(amount) || amount === 0) return null;

  const currency = String(payment?.currency || fallbackCurrency || 'ARS').toUpperCase();
  const absoluteMinorUnits = Math.round(Math.abs(amount) * 100);
  return `${currency}||${absoluteMinorUnits}`;
}

/**
 * Removes exact opposite payment pairs from the revenue calculation.
 *
 * A correction can be registered with a different payment method from the
 * original entry. Pairing within the same reservation and currency prevents
 * that bookkeeping detail from creating artificial revenue in one method and
 * a negative collection in another one.
 */
export function neutralizeReversedPayments(payments = [], fallbackCurrency = 'ARS') {
  const excludedIndexes = new Set();
  const unmatched = new Map();

  payments.forEach((payment, index) => {
    const amount = Number(payment?.amount);
    const key = paymentPairKey(payment, fallbackCurrency);
    if (!key) return;

    const sign = amount > 0 ? 'positive' : 'negative';
    const oppositeSign = amount > 0 ? 'negative' : 'positive';
    const buckets = unmatched.get(key) || { positive: [], negative: [] };

    if (buckets[oppositeSign].length) {
      const oppositeIndex = buckets[oppositeSign].shift();
      excludedIndexes.add(oppositeIndex);
      excludedIndexes.add(index);
    } else {
      buckets[sign].push(index);
    }

    unmatched.set(key, buckets);
  });

  return payments.filter((_, index) => !excludedIndexes.has(index));
}

function getReservationNights(res) {
  const arrival = res?.arrival_iso ? DateTime.fromISO(res.arrival_iso, { zone: TZ }) : null;
  const departure = res?.departure_iso ? DateTime.fromISO(res.departure_iso, { zone: TZ }) : null;
  if (!arrival?.isValid || !departure?.isValid) return 0;
  return Math.max(0, Math.round(departure.startOf('day').diff(arrival.startOf('day'), 'days').days));
}

export function buildRecaudacionRows(items = []) {
  const groups = new Map();

  for (const res of items) {
    const payments = Array.isArray(res.payments) ? res.payments : [];
    const effectivePayments = neutralizeReversedPayments(payments, res.currency);
    const usablePayments = effectivePayments.length
      ? effectivePayments
      : [{ amount: 0, currency: res.currency || 'ARS', method: 'Sin pago', concept: '' }];

    for (const pay of usablePayments) {
      const amount = Number(pay.amount);
      const currency = String(pay.currency || res.currency || 'ARS').toUpperCase();
      if (currency !== 'ARS' && currency !== 'USD') continue;
      if (!Number.isFinite(amount)) continue;

      const propertyId = normLabel(res.propiedad_id, 'sin_propiedad');
      const propertyName = normLabel(res.propiedad_nombre || propertyId, 'Sin propiedad');
      const paymentMethod = normLabel(pay.method, 'Sin forma de pago');
      const key = [propertyId, propertyName, paymentMethod, currency].join('||');

      if (!groups.has(key)) {
        groups.set(key, {
          propertyId,
          propertyName,
          paymentMethod,
          currency,
          total: 0,
          reservationIds: new Set(),
          nightsByReservation: new Map(),
        });
      }

      const group = groups.get(key);
      group.total += amount;
      group.reservationIds.add(res.id);
      group.nightsByReservation.set(res.id, getReservationNights(res));
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      total: +group.total.toFixed(2),
      reservationCount: group.reservationIds.size,
      nightCount: Array.from(group.nightsByReservation.values()).reduce((sum, nights) => sum + nights, 0),
    }))
    .sort((a, b) => (
      a.paymentMethod.localeCompare(b.paymentMethod)
      || a.propertyName.localeCompare(b.propertyName)
      || a.currency.localeCompare(b.currency)
    ));
}
