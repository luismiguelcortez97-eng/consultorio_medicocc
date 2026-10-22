'use strict';

const APPOINTMENT_MINUTES = 60;

function publicAppointmentSlots(settings = {}, fecha = '') {
  const day = fecha ? new Date(fecha + 'T00:00:00Z').getUTCDay() : 1;
  if (day === 0) return [];
  const start = 9 * 60 + 30;
  // Slots last 60 minutes and must finish before closing time:
  // weekdays close at 19:00; Saturdays close at 15:00.
  const end = day === 6 ? 13 * 60 + 30 : 17 * 60 + 30;
  const slots = [];
  for (let t = start; t <= end; t += 60) {
    slots.push(String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'));
  }
  return slots;
}

function appointmentConflicts(appointments, medicoId, fecha, hora, duration = APPOINTMENT_MINUTES) {
  const requestedStart = minutesOf(hora);
  if (requestedStart < 0) return true;
  return appointments.some(appointment => {
    if (!appointment || String(appointment.medicoId) !== String(medicoId) ||
        String(appointment.fecha || '') !== String(fecha) ||
        ['cancelada', 'cancelado', 'eliminada', 'eliminado'].includes(String(appointment.estado || '').toLowerCase())) {
      return false;
    }
    const existingStart = minutesOf(appointment.hora);
    if (existingStart < 0) return false;
    return existingStart < requestedStart + duration &&
      existingStart + APPOINTMENT_MINUTES > requestedStart;
  });
}

function minutesOf(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || '').slice(0, 5));
  if (!match) return -1;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return -1;
  return hour * 60 + minute;
}

function isMembershipActive(member, now = Date.now()) {
  if (!member || member.canceledAt || String(member.accountStatus || '').toLowerCase() === 'canceled') return false;
  const start = member.startsAt ? new Date(member.startsAt).getTime() : NaN;
  const expiry = member.expiresAt ? new Date(member.expiresAt).getTime() : NaN;
  return Number.isFinite(start) && Number.isFinite(expiry) && start <= now && expiry > now;
}

function membershipMatchesPerson(member, name, birthDate) {
  if (!member) return false;
  const normalize = value => String(value || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return normalize(member.fullName) === normalize(name) &&
    String(member.birthDate || '').slice(0, 10) === String(birthDate || '');
}

module.exports = { publicAppointmentSlots, appointmentConflicts, isMembershipActive, membershipMatchesPerson };
