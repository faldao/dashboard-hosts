import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecaudacionRows, neutralizeReversedPayments } from '../src/lib/recaudacion.js';

test('RH-0005 neutraliza la carga USD erronea y conserva el cobro correcto', () => {
  const reservation = {
    id: '106_RH-0005_33409',
    propiedad_id: '106',
    propiedad_nombre: 'Urbana Apartments 413',
    arrival_iso: '2026-07-02',
    departure_iso: '2026-07-07',
    currency: 'USD',
    payments: [
      { amount: 383.85, currency: 'USD', method: 'Expedia collect' },
      { amount: 45000, currency: 'USD', method: 'Transferencia' },
      { amount: -45000, currency: 'USD', method: 'Efectivo' },
      { amount: 45000, currency: 'ARS', method: 'Transferencia' },
    ],
  };

  const rows = buildRecaudacionRows([reservation]);
  assert.deepEqual(
    rows.map(({ paymentMethod, currency, total }) => ({ paymentMethod, currency, total })),
    [
      { paymentMethod: 'Expedia collect', currency: 'USD', total: 383.85 },
      { paymentMethod: 'Transferencia', currency: 'ARS', total: 45000 },
    ],
  );
  assert.ok(rows.every((row) => row.reservationCount === 1 && row.nightCount === 5));
});

test('no neutraliza importes opuestos que no coinciden exactamente', () => {
  const payments = [
    { amount: 100, currency: 'USD', method: 'Transferencia' },
    { amount: -90, currency: 'USD', method: 'Efectivo' },
  ];

  assert.deepEqual(neutralizeReversedPayments(payments), payments);
});

test('neutraliza solamente un par cuando hay movimientos repetidos', () => {
  const payments = [
    { amount: 100, currency: 'USD', method: 'Transferencia' },
    { amount: 100, currency: 'USD', method: 'Transferencia' },
    { amount: -100, currency: 'USD', method: 'Efectivo' },
  ];

  assert.deepEqual(neutralizeReversedPayments(payments), [payments[1]]);
});

test('una reserva con todos sus movimientos anulados queda como Sin pago', () => {
  const rows = buildRecaudacionRows([{
    id: 'reserva-anulada',
    propiedad_id: '106',
    propiedad_nombre: 'Urbana Apartments 413',
    arrival_iso: '2026-07-02',
    departure_iso: '2026-07-03',
    currency: 'USD',
    payments: [
      { amount: -50, currency: 'USD', method: 'Efectivo' },
      { amount: 50, currency: 'USD', method: 'Transferencia' },
    ],
  }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].paymentMethod, 'Sin pago');
  assert.equal(rows[0].total, 0);
});
