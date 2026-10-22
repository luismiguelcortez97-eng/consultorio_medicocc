'use strict';

const APPOINTMENT_MINUTES = 60;
const WEEKDAY_OPEN_MINUTES = 9 * 60;
const WEEKDAY_CLOSE_MINUTES = 19 * 60;
const SATURDAY_CLOSE_MINUTES = 15 * 60;

function publicAppointmentSlots(settings = {}, fecha = '') {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(fecha)
    ? new Date(fecha + 'T00:00:00Z')
    : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== fecha) return [];
  const day = parsed.getUTCDay();
  // El consultorio permanece cerrado los domingos.
  if (day === 0) return [];
  if (Array.isArray(settings.days) && !settings.days.map(Number).includes(day)) return [];

  const configuredStart = Number.isInteger(Number(settings.startHour))
    ? Number(settings.startHour) * 60 + 30
    : WEEKDAY_OPEN_MINUTES + 30;
  const configuredEnd = Number.isInteger(Number(settings.endHour))
    ? Number(settings.endHour) * 60 + 30
    : 17 * 60 + 30;
  const closing = day === 6 ? SATURDAY_CLOSE_MINUTES : WEEKDAY_CLOSE_MINUTES;
  const start = Math.max(WEEKDAY_OPEN_MINUTES + 30, configuredStart);
  const latestStart = Math.min(configuredEnd, closing - APPOINTMENT_MINUTES);
  if (start > latestStart) return [];

  const slots = [];
  for (let t = start; t <= latestStart; t += 60) {
    slots.push(String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'));
  }
  return slots;
}

function appointmentConflicts(appointments, medicoId, fecha, hora, duration = APPOINTMENT_MINUTES) {
  const requestedStart = minutesOf(hora);
  if (requestedStart < 0 || !Number.isFinite(duration) || duration <= 0) return true;
  return appointments.some(appointment => {
    if (!appointment || String(appointment.medicoId) !== String(medicoId) ||
        String(appointment.fecha || '') !== String(fecha) ||
        ['cancelada', 'cancelado', 'eliminada', 'eliminado', 'cancelled', 'canceled', 'deleted'].includes(String(appointment.estado || '').toLowerCase())) {
      return false;
    }
    const existingStart = minutesOf(appointment.hora);
    if (existingStart < 0) return false;
    return existingStart < requestedStart + duration &&
      existingStart + APPOINTMENT_MINUTES > requestedStart;
  });
}

function minutesOf(value) {
  const match = /^(\\d{2}):(\\d{2})$/.exec(String(value || ''));
  if (!match) return -1;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return -1;
  return hour * 60 + minute;
}

function isMembershipActive(member, now = Date.now()) {
  if (!member || member.canceledAt || ['canceled', 'cancelled'].includes(String(member.accountStatus || '').toLowerCase())) return false;
  const start = member.startsAt ? new Date(member.startsAt).getTime() : NaN;
  const expiry = member.expiresAt ? new Date(member.expiresAt).getTime() : NaN;
  return Number.isFinite(start) && Number.isFinite(expiry) && start <= now && expiry > now;
}

function membershipMatchesPerson(member, name, birthDate) {
  if (!member) return false;
  const normalize = value => String(value || '').normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return normalize(member.fullName) === normalize(name) &&
    String(member.birthDate || '').slice(0, 10) === String(birthDate || '');
}

module.exports = { publicAppointmentSlots, appointmentConflicts, isMembershipActive, membershipMatchesPerson };
