'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  publicAppointmentSlots,
  appointmentConflicts,
  isMembershipActive,
  membershipMatchesPerson
} = require('../appointment-logic');

test('genera horarios laborales que terminan antes del cierre', () => {
  assert.deepEqual(publicAppointmentSlots({}, '2026-10-23'), [
    '09:30','10:30','11:30','12:30','13:30','14:30','15:30','16:30','17:30'
  ]);
  assert.deepEqual(publicAppointmentSlots({}, '2026-10-24'), [
    '09:30','10:30','11:30','12:30','13:30'
  ]);
  assert.deepEqual(publicAppointmentSlots({}, '2026-10-25'), []);
  assert.deepEqual(publicAppointmentSlots({}, 'fecha-invalida'), []);
});

test('respeta los días y las horas configuradas sin rebasar el cierre del consultorio', () => {
  assert.deepEqual(publicAppointmentSlots({ days: [1, 2, 3, 4, 5], startHour: 10, endHour: 12 }, '2026-10-23'), [
    '10:30','11:30','12:30'
  ]);
  assert.deepEqual(publicAppointmentSlots({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }, '2026-10-23'), [
    '09:30','10:30','11:30','12:30','13:30','14:30','15:30','16:30','17:30'
  ]);
  assert.deepEqual(publicAppointmentSlots({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }, '2026-10-24'), [
    '09:30','10:30','11:30','12:30','13:30'
  ]);
  assert.deepEqual(publicAppointmentSlots({ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }, '2026-10-24').filter(x => x === '14:30'), []);
});

test('bloquea el mismo horario para el mismo médico y fecha', () => {
  const existing = [{ medicoId: 3, fecha: '2026-10-23', hora: '10:30', estado: 'Solicitud web' }];
  assert.equal(appointmentConflicts(existing, 3, '2026-10-23', '10:30'), true);
});

test('bloquea citas que se traslapan aunque no tengan la misma hora exacta', () => {
  const existing = [{ medicoId: 3, fecha: '2026-10-23', hora: '10:30', estado: 'Confirmada' }];
  assert.equal(appointmentConflicts(existing, 3, '2026-10-23', '11:00'), true);
  assert.equal(appointmentConflicts(existing, 3, '2026-10-23', '11:30'), false);
  assert.equal(appointmentConflicts(existing, 3, '2026-10-23', 'mal-formato'), true);
});

test('permite el horario si es otro médico, otra fecha o la cita anterior está cancelada', () => {
  const existing = [{ medicoId: 3, fecha: '2026-10-23', hora: '10:30', estado: 'Confirmada' }];
  assert.equal(appointmentConflicts(existing, 4, '2026-10-23', '10:30'), false);
  assert.equal(appointmentConflicts(existing, 3, '2026-10-24', '10:30'), false);
  assert.equal(appointmentConflicts([{ ...existing[0], estado: 'Cancelada' }], 3, '2026-10-23', '10:30'), false);
});

test('acepta membresía activa y rechaza futura, vencida o cancelada', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const member = { startsAt: '2026-10-20T12:00:00Z', expiresAt: '2026-11-20T12:00:00Z' };
  assert.equal(isMembershipActive(member, now), true);
  assert.equal(isMembershipActive({ ...member, startsAt: '2026-10-23T12:00:00Z' }, now), false);
  assert.equal(isMembershipActive({ ...member, expiresAt: '2026-10-21T12:00:00Z' }, now), false);
  assert.equal(isMembershipActive({ ...member, canceledAt: '2026-10-21T12:00:00Z' }, now), false);
  assert.equal(isMembershipActive({ ...member, accountStatus: 'canceled' }, now), false);
});

test('el folio debe coincidir con nombre y fecha de nacimiento', () => {
  const member = { fullName: 'José Pérez López', birthDate: '1990-05-12' };
  assert.equal(membershipMatchesPerson(member, 'Jose Perez Lopez', '1990-05-12'), true);
  assert.equal(membershipMatchesPerson(member, 'Jose Perez Lopez', '1990-05-13'), false);
  assert.equal(membershipMatchesPerson(member, 'Otra Persona', '1990-05-12'), false);
});

test('la ruta de citas toma un bloqueo transaccional antes de revisar e insertar', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf("app.post('/api/public/appointments'");
  const end = source.indexOf("app.get(\\n  '/api/data/:store'", start);
  assert.ok(start >= 0 && end > start, 'debe existir la ruta de citas públicas');
  const route = source.slice(start, end);
  const lock = route.indexOf("pg_advisory_xact_lock");
  const read = route.indexOf('getPublicAgenda(client)');
  const insert = route.indexOf("INSERT INTO app_records(store, record_key, data) VALUES('agenda'");
  assert.ok(lock >= 0 && read > lock && insert > read, 'el bloqueo debe adquirirse antes de comprobar e insertar');
  assert.match(route, /if \\(conflict\\)[\\s\\S]*?status\\(409\\)/, 'debe rechazar conflictos con HTTP 409');
});
