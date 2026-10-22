
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const { initMembershipDb, registerMembershipRoutes } = require('./membership-server');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

const STORES = new Set([
  'medicos',
  'pacientes',
  'consultas',
  'medicamentos',
  'estudios',
  'cobros',
  'config',
  'enfermeria',
  'empleados',
  'agenda',
  'plantillas_receta',
  'recetas'
]);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false
});

const SESSION_SECRET = process.env.SESSION_SECRET;

if (
  !process.env.DATABASE_URL ||
  !process.env.ADMIN_USERNAME ||
  !process.env.ADMIN_PASSWORD ||
  !process.env.BALANCE_NIP ||
  !SESSION_SECRET
) {
  console.error(
    'Faltan variables obligatorias: DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD, BALANCE_NIP y SESSION_SECRET.'
  );
  process.exit(1);
}

if (process.env.ADMIN_PASSWORD.length < 12) {
  console.warn('Advertencia: usa una contraseña de administrador de al menos 12 caracteres.');
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      sender_username TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages(created_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('medico', 'enfermeria', 'empleado')),
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migración compatible con cuentas ya existentes: ahora también admite administradores del personal.
  await pool.query('ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check');
  await pool.query("ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check CHECK (role IN ('admin', 'medico', 'enfermeria', 'empleado'))");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_records (
      store TEXT NOT NULL,
      record_key TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (store, record_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_sequences (
      store TEXT PRIMARY KEY,
      next_id BIGINT NOT NULL
    )
  `);

  await pool.query(
    'CREATE INDEX IF NOT EXISTS app_records_store_idx ON app_records(store)'
  );
  await initMembershipDb(pool);
}

function sign(value) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(value)
    .digest('hex');
}

function createToken(username, role = 'admin', displayName = username) {
  const payload = Buffer.from(
    JSON.stringify({
      username,
      role,
      displayName,
      exp: Date.now() + 8 * 60 * 60 * 1000
    })
  ).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

function getSession(req) {
  const token = req.headers.cookie
    ?.split(';')
    .map(v => v.trim())
    .find(v => v.startsWith('cmcc_session='))
    ?.slice('cmcc_session='.length);

  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const expected = Buffer.from(sign(parts[0]));
  const actual = Buffer.from(parts[1]);

  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString()
    );

    if (!payload.username || payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = getSession(req);

  if (!session) {
    return res.status(401).json({
      error: 'Sesión no válida. Inicia sesión nuevamente.'
    });
  }

  req.user = session.username;
  req.session = session;
  next();
}

function createFinanceToken(scope) {
  const payload = Buffer.from(
    JSON.stringify({
      scope,
      exp: Date.now() + 30 * 60 * 1000
    })
  ).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

function validFinanceToken(req, scope) {
  const cookieName = `cmcc_finance_${scope}=`;

  const token = req.headers.cookie
    ?.split(';')
    .map(v => v.trim())
    .find(v => v.startsWith(cookieName))
    ?.slice(cookieName.length);

  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const a = Buffer.from(sign(parts[0]));
  const b = Buffer.from(parts[1]);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString()
    );

    return payload.scope === scope && payload.exp > Date.now();
  } catch {
    return false;
  }
}



function requireFinanceWrite(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Solo administración puede modificar registros financieros.' });
  }
  // Cobros ya no requiere NIP; se conserva el control de sesión y rol.
  next();
}

function requireFinanceRead(req, res, next) {
  const role = req.session?.role;
  if (['admin', 'empleado', 'enfermeria', 'medico'].includes(role)) return next();
  return res.status(403).json({ error: 'No tienes permisos para consultar cobros.' });
}

function validStore(store) {
  return STORES.has(store);
}

function recordKey(store, data) {
  return store === 'config' ? String(data.key) : String(data.id);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiados intentos. Intenta más tarde.'
  }
});

function hashStaffPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString('hex')
  };
}

function verifyStaffPassword(password, salt, storedHash) {
  try {
    const expected = Buffer.from(storedHash, 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el administrador puede gestionar accesos del personal.' });
  }
  next();
}

app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const suppliedUserText = typeof username === 'string' ? username.trim() : '';
    const suppliedPasswordText = typeof password === 'string' ? password : '';

    const expectedUser = Buffer.from(
      String(process.env.ADMIN_USERNAME).padEnd(256, '\\0').slice(0, 256)
    );
    const suppliedUser = Buffer.from(
      suppliedUserText.padEnd(256, '\\0').slice(0, 256)
    );
    const userOk = crypto.timingSafeEqual(expectedUser, suppliedUser);
    const expectedPassword = Buffer.from(String(process.env.ADMIN_PASSWORD));
    const suppliedPassword = Buffer.from(suppliedPasswordText);
    const passOk = expectedPassword.length === suppliedPassword.length &&
      crypto.timingSafeEqual(expectedPassword, suppliedPassword);

    let sessionUser = null;
    if (userOk && passOk) {
      sessionUser = {
        username: process.env.ADMIN_USERNAME,
        displayName: process.env.ADMIN_USERNAME,
        role: 'admin'
      };
    } else if (suppliedUserText && suppliedPasswordText) {
      const found = await pool.query(
        'SELECT id, username, display_name, role, password_hash, password_salt, active FROM staff_users WHERE LOWER(username)=LOWER($1)',
        [suppliedUserText]
      );
      const staff = found.rows[0];
      if (staff && staff.active && verifyStaffPassword(suppliedPasswordText, staff.password_salt, staff.password_hash)) {
        sessionUser = {
          username: staff.username,
          displayName: staff.display_name,
          role: staff.role
        };
      }
    }

    if (!sessionUser) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    res.cookie('cmcc_session', createToken(sessionUser.username, sessionUser.role, sessionUser.displayName), {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/'
    });
    res.json(sessionUser);
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'No hay sesión activa.' });
  }
  res.json({
    username: session.username,
    displayName: session.displayName || session.username,
    role: session.role || 'admin'
  });
});

app.get('/api/staff-users', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, username, display_name AS "displayName", role, active, created_at AS "createdAt" FROM staff_users ORDER BY display_name'
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/staff-users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { username, displayName, role, password } = req.body || {};
    const cleanUsername = typeof username === 'string' ? username.trim() : '';
    const cleanName = typeof displayName === 'string' ? displayName.trim() : '';
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(cleanUsername) || cleanName.length < 2 ||
        !['admin', 'medico', 'enfermeria', 'empleado'].includes(role) ||
        typeof password !== 'string' || password.length < 10) {
      return res.status(400).json({
        error: 'Revisa los datos. Usuario: 3-40 caracteres; contraseña: mínimo 10; elige un rol válido.'
      });
    }
    const credentials = hashStaffPassword(password);
    const result = await pool.query(
      'INSERT INTO staff_users(username, display_name, role, password_hash, password_salt) VALUES($1,$2,$3,$4,$5) RETURNING id, username, display_name AS "displayName", role, active',
      [cleanUsername, cleanName, role, credentials.hash, credentials.salt]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ese nombre de usuario ya existe.' });
    }
    next(error);
  }
});

app.patch('/api/staff-users/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Usuario inválido.' });
    }

    const changes = [];
    const values = [];
    const add = (column, value) => {
      values.push(value);
      changes.push(column + '=$' + values.length);
    };

    if (Object.prototype.hasOwnProperty.call(body, 'active')) {
      if (typeof body.active !== 'boolean') {
        return res.status(400).json({ error: 'El estado debe ser válido.' });
      }
      add('active', body.active);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'role')) {
      if (!['admin', 'medico', 'enfermeria', 'empleado'].includes(body.role)) {
        return res.status(400).json({ error: 'Selecciona un rol válido.' });
      }
      if (String(req.user?.username || req.auth?.username || '') === '') {
        // La sesión autenticada sigue siendo la autoridad para permisos; no se confía en datos enviados por el navegador.
      }
      add('role', body.role);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'password')) {
      if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 200) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener entre 10 y 200 caracteres.' });
      }
      const credentials = hashStaffPassword(body.password);
      add('password_hash', credentials.hash);
      add('password_salt', credentials.salt);
    }

    if (!changes.length) {
      return res.status(400).json({ error: 'No hay cambios que guardar.' });
    }

    const current = await pool.query('SELECT username FROM staff_users WHERE id=$1', [id]);
    if (!current.rowCount) return res.status(404).json({ error: 'Usuario no encontrado.' });
    const session = getSession(req);
    if (session && current.rows[0].username === session.username &&
        ((body.active === false) || (body.role && body.role !== 'admin'))) {
      return res.status(400).json({ error: 'No puedes desactivar ni quitarte el rol de administrador desde tu propia sesión.' });
    }

    values.push(id);
    const result = await pool.query(
      'UPDATE staff_users SET ' + changes.join(', ') + ' WHERE id=$' + values.length +
      ' RETURNING id, username, display_name AS "displayName", role, active',
      values
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (_req, res) => {
  const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: '/'
  };

  res.clearCookie('cmcc_session', cookieOptions);
  res.clearCookie('cmcc_finance_cobros', cookieOptions);
  res.clearCookie('cmcc_finance_balance', cookieOptions);

  res.json({ ok: true });
});

app.post('/api/auth/verify-nip', requireAuth, (req, res) => {
  const { tipo, nip } = req.body || {};

  const expected = tipo === 'balance' ? process.env.BALANCE_NIP : null;

  if (!expected || typeof nip !== 'string') {
    return res.status(400).json({
      error: 'Solicitud inválida.'
    });
  }

  const a = Buffer.from(expected);
  const b = Buffer.from(nip);

  const ok =
    a.length === b.length &&
    crypto.timingSafeEqual(a, b);

  if (!ok) {
    return res.status(403).json({
      error: 'Código incorrecto.'
    });
  }

  res.cookie(
    `cmcc_finance_${tipo}`,
    createFinanceToken(tipo),
    {
      httpOnly: true,
      secure: isProd,
      sameSite: 'strict',
      maxAge: 30 * 60 * 1000,
      path: '/'
    }
  );

  res.json({ ok: true });
});

app.get('/api/dashboard/cobros-hoy', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const fecha = String(req.query.fecha || '');
    const offsetMinutos = Number(req.query.offsetMinutos);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) ||
        !Number.isInteger(offsetMinutos) || offsetMinutos < -840 || offsetMinutos > 840) {
      return res.status(400).json({ error: 'Fecha o zona horaria inválida.' });
    }

    // El navegador envía la fecha local y su desfase respecto a UTC.
    const [anio, mes, dia] = fecha.split('-').map(Number);
    const inicioUTC = Date.UTC(anio, mes - 1, dia) + offsetMinutos * 60000;
    const finUTC = inicioUTC + 24 * 60 * 60 * 1000;
    const result = await pool.query("SELECT data FROM app_records WHERE store='cobros'");
    const cobrosPagadosHoy = result.rows
      .map(row => row.data)
      .filter(cobro => {
        if (cobro.status !== 'pagado') return false;
        const fechaPago = cobro.cobradoAt || cobro.fecha;
        if (!fechaPago) return false;
        const instante = new Date(fechaPago).getTime();
        return Number.isFinite(instante) && instante >= inicioUTC && instante < finUTC;
      });

    const total = cobrosPagadosHoy.reduce(
      (sum, cobro) => sum + (Number.parseFloat(cobro.monto) || 0),
      0
    );
    res.json({ total, count: cobrosPagadosHoy.length });
  } catch (error) {
    next(error);
  }
});

app.get('/api/chat', requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, sender_username AS "senderUsername", sender_name AS "senderName", sender_role AS "senderRole", message, created_at AS "createdAt" FROM chat_messages ORDER BY id DESC LIMIT 300'
    );
    res.json(result.rows.reverse());
  } catch (error) {
    next(error);
  }
});

app.post('/api/chat', requireAuth, async (req, res, next) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 2000) {
      return res.status(400).json({ error: 'El mensaje debe tener entre 1 y 2000 caracteres.' });
    }
    const role = req.session?.role || 'admin';
    const displayName = req.session?.displayName || req.session?.username || 'Usuario';
    const result = await pool.query(
      'INSERT INTO chat_messages(sender_username, sender_name, sender_role, message) VALUES($1,$2,$3,$4) RETURNING id, sender_username AS "senderUsername", sender_name AS "senderName", sender_role AS "senderRole", message, created_at AS "createdAt"',
      [req.session?.username || 'admin', displayName, role, message]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/consultas/:id/registrar-cobro', requireAuth, async (req, res, next) => {
  if (!['admin', 'medico'].includes(req.session?.role)) {
    return res.status(403).json({ error: 'Solo el médico o administración puede enviar una consulta a cobros.' });
  }

  const consultaId = Number(req.params.id);
  const monto = Number(req.body?.monto);
  if (!Number.isSafeInteger(consultaId) || consultaId < 1 || !Number.isFinite(monto) || monto <= 0 || monto > 10000000) {
    return res.status(400).json({ error: 'Consulta o importe inválido. El importe debe ser mayor que cero.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const consultaResult = await client.query(
      "SELECT data FROM app_records WHERE store='consultas' AND record_key=$1 FOR UPDATE",
      [String(consultaId)]
    );
    if (!consultaResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No se encontró la consulta.' });
    }

    const consulta = consultaResult.rows[0].data;
    const existingResult = await client.query(
      "SELECT data FROM app_records WHERE store='cobros' AND data->>'consultaId'=$1 LIMIT 1 FOR UPDATE",
      [String(consultaId)]
    );
    if (existingResult.rowCount) {
      const existing = existingResult.rows[0].data;
      consulta.cobroId = existing.id;
      consulta.montoConsulta = Number(existing.monto) || monto;
      consulta.cobroRegistradoAt = consulta.cobroRegistradoAt || existing.fecha;
      await client.query(
        "UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='consultas' AND record_key=$1",
        [String(consultaId), consulta]
      );
      await client.query('COMMIT');
      return res.json({ cobro: existing, duplicate: true });
    }

    const patientResult = await client.query(
      "SELECT data FROM app_records WHERE store='pacientes' AND record_key=$1",
      [String(consulta.pacienteId)]
    );
    const doctorResult = await client.query(
      "SELECT data FROM app_records WHERE store='medicos' AND record_key=$1",
      [String(consulta.medicoId)]
    );
    const paciente = patientResult.rows[0]?.data;
    const medico = doctorResult.rows[0]?.data;
    const sequence = await client.query(
      `INSERT INTO app_sequences(store, next_id) VALUES('cobros', 1)
       ON CONFLICT(store) DO UPDATE SET next_id=app_sequences.next_id+1
       RETURNING next_id`
    );
    const cobroId = Number(sequence.rows[0].next_id);
    const now = new Date().toISOString();
    const user = req.session?.displayName || req.session?.username || 'Personal';
    const cobro = {
      id: cobroId,
      concepto: 'Consulta médica',
      referencia: (paciente?.nombre || 'Paciente') + (medico?.nombre ? ' | Dr(a). ' + medico.nombre : ''),
      monto,
      tipo: 'medico',
      status: 'pendiente',
      medicoId: consulta.medicoId || null,
      pacienteId: consulta.pacienteId || null,
      consultaId,
      fecha: now,
      creadoPor: user,
      audit: [{ fecha: now, accion: 'registrado_desde_consulta', usuario: user, consultaId }]
    };

    consulta.montoConsulta = monto;
    consulta.cobroId = cobroId;
    consulta.cobroRegistradoAt = now;
    consulta.cobroRegistradoPor = user;

    await client.query(
      "UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='consultas' AND record_key=$1",
      [String(consultaId), consulta]
    );
    await client.query(
      "INSERT INTO app_records(store, record_key, data) VALUES('cobros',$1,$2)",
      [String(cobroId), cobro]
    );
    await client.query('COMMIT');
    try { await sendWhatsAppAppointmentNotification(record, await getPublicAppointmentSettings()); }
    catch (notificationError) { console.error('No se pudo enviar la notificación de nueva cita por WhatsApp:', notificationError.message); }
    res.status(201).json({ cobro, duplicate: false });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.post('/api/cobros/:id/confirmar', requireAuth, async (req, res, next) => {
  const role = req.session?.role;
  if (!['admin', 'empleado', 'enfermeria', 'medico'].includes(role)) {
    return res.status(403).json({ error: 'No tienes permisos para confirmar cobros.' });
  }

  const id = Number(req.params.id);
  const metodoPago = req.body?.metodoPago;
  const montoSolicitado = Number(req.body?.monto);
  if (!Number.isSafeInteger(id) || id < 1 ||
      !['Efectivo', 'Tarjeta', 'Transferencia'].includes(metodoPago) ||
      !Number.isFinite(montoSolicitado) || montoSolicitado <= 0 || montoSolicitado > 10000000) {
    return res.status(400).json({ error: 'Cobro, importe o método de pago inválido.' });
  }
  const montoFinal = Math.round(montoSolicitado * 100) / 100;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      "SELECT data FROM app_records WHERE store='cobros' AND record_key=$1 FOR UPDATE",
      [String(id)]
    );
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No se encontró el cobro.' });
    }
    const cobro = found.rows[0].data;
    if (cobro.status === 'pagado') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este cobro ya fue confirmado.' });
    }

    const now = new Date().toISOString();
    const user = req.session?.displayName || req.session?.username || 'Personal';
    const montoAnterior = Number(cobro.monto) || 0;
    cobro.monto = montoFinal;
    cobro.status = 'pagado';
    cobro.metodoPago = metodoPago;
    cobro.cobradoPor = user;
    cobro.cobradoAt = now;
    cobro.audit = Array.isArray(cobro.audit) ? cobro.audit : [];
    cobro.audit.push({
      fecha: now,
      accion: 'marcado_pagado',
      metodoPago,
      usuario: user,
      montoAnterior,
      montoFinal
    });

    await client.query(
      "UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='cobros' AND record_key=$1",
      [String(id), cobro]
    );
    await client.query('COMMIT');
    res.json(cobro);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.get('/api/balance/cobros', requireAuth, requireAdmin, (req, res, next) => {
  if (!validFinanceToken(req, 'balance')) return res.status(403).json({ error: 'Ingresa el código de Balance para consultar el balance.' });
  pool.query("SELECT data FROM app_records WHERE store='cobros' ORDER BY (data->>'fecha') DESC")
    .then(result => res.json(result.rows.map(row => row.data)))
    .catch(next);
});


const publicAppointmentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta nuevamente en unos minutos.' }
});
const PUBLIC_APPOINTMENT_TYPES = new Set([
  'Cita médica', 'Certificado médico', 'Otros síntomas', 'Presión alta', 'Lectura de estudios', 'Otro motivo'
]);
function publicBirthDateIsValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return parsed.getTime() <= today.getTime() && parsed.getUTCFullYear() >= today.getUTCFullYear() - 120;
}
function publicAgeFromBirthDate(value) {
  const born = new Date(value + 'T00:00:00Z');
  const today = new Date();
  let age = today.getUTCFullYear() - born.getUTCFullYear();
  if (today.getUTCMonth() < born.getUTCMonth() || (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() < born.getUTCDate())) age--;
  return age;
}
function publicDateIsValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Math.floor((parsed.getTime() - today.getTime()) / 86400000);
  return days >= 0 && days <= 90;
}
const DEFAULT_PUBLIC_APPOINTMENT_SETTINGS={days:[1,2,3,4,5,6],startHour:9,endHour:17,whatsapp:'',notificationWhatsapp:'',notificationEmail:'',phone:''};
async function getPublicAppointmentSettings(db=pool){const r=await db.query("SELECT data FROM app_records WHERE store='config' AND record_key=$1",['public_appointments_settings']);const raw=r.rowCount?((r.rows[0].data||{}).value||{}):{};const days=Array.isArray(raw.days)?[...new Set(raw.days.map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=6))]:DEFAULT_PUBLIC_APPOINTMENT_SETTINGS.days;const clean=v=>typeof v==='string'&&/^[+()\d .-]{0,25}$/.test(v.trim())?v.trim():'';const notificationEmail=typeof raw.notificationEmail==='string'&&raw.notificationEmail.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.notificationEmail.trim())?raw.notificationEmail.trim():'';return{days,startHour:Number.isInteger(Number(raw.startHour))?Math.max(0,Math.min(23,Number(raw.startHour))):9,endHour:Number.isInteger(Number(raw.endHour))?Math.max(1,Math.min(24,Number(raw.endHour))):17,whatsapp:clean(raw.whatsapp),notificationWhatsapp:clean(raw.notificationWhatsapp),notificationEmail,phone:clean(raw.phone)};}
function publicAppointmentSlots(settings=DEFAULT_PUBLIC_APPOINTMENT_SETTINGS){if(settings.endHour<=settings.startHour)return[];return Array.from({length:settings.endHour-settings.startHour},(_,i)=>String(settings.startHour+i).padStart(2,'0')+':00');}
async function getPublicAgenda(client) {
  const result = await client.query("SELECT data FROM app_records WHERE store='agenda'");
  return result.rows.map(row => row.data);
}

app.post('/api/public/appointments/verify', publicAppointmentLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const codigo = typeof body.codigo === 'string' ? body.codigo.trim() : '';
    const telefono = typeof body.telefono === 'string' ? body.telefono.replace(/\D/g, '') : '';
    if (!/^\d{6}$/.test(codigo) && telefono.length < 7) return res.status(400).json({ error: 'Escribe el código de 6 dígitos o el número de celular registrado.' });
    const result = await pool.query("SELECT data FROM app_records WHERE store='agenda' AND data->>'creadoPor'='portal-publico'");
    let matches = result.rows.map(row => row.data).filter(c => c && !['Eliminada','Eliminado'].includes(String(c.estado || '')));
    if (/^\d{6}$/.test(codigo)) {
      const hash = crypto.createHash('sha256').update(codigo).digest('hex');
      matches = matches.filter(c => typeof c.codigoVerificacionHash === 'string' && c.codigoVerificacionHash === hash);
    } else {
      matches = matches.filter(c => String(c.telefonoContacto || '').replace(/\D/g, '') === telefono);
    }
    if (!matches.length) return res.status(404).json({ error: 'No encontramos una cita con esos datos. Revisa el código o el número e inténtalo de nuevo.' });
    matches.sort((a,b) => String(a.fecha||'').localeCompare(String(b.fecha||'')) || String(a.hora||'').localeCompare(String(b.hora||'')));
    const citas = matches.map(c => ({ fecha:String(c.fecha||''), hora:String(c.hora||''), estado:String(c.estado||'')==='Confirmada'?'Confirmada':['Cancelada','Cancelado'].includes(String(c.estado||''))?'Cancelada':'Pendiente de confirmación' }));
    res.set('Cache-Control','no-store');
    res.json({ ok:true, citas });
  } catch (error) { next(error); }
});
app.get('/api/admin/public-appointments', requireAuth, async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT data FROM app_records WHERE store='agenda' AND data->>'creadoPor'='portal-publico' AND COALESCE(data->>'estado','') NOT IN ('Eliminada','Eliminado') ORDER BY data->>'fecha', data->>'hora'");
    res.set('Cache-Control','no-store'); res.json(result.rows.map(row=>row.data));
  } catch (error) { next(error); }
});
app.put('/api/admin/public-appointments/:id/confirm', requireAuth, async (req, res, next) => {
  try {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Solicitud inválida.'});
    const result=await pool.query("SELECT data FROM app_records WHERE store='agenda' AND record_key=$1",[String(id)]);
    if(!result.rowCount||result.rows[0].data.creadoPor!=='portal-publico')return res.status(404).json({error:'No se encontró la solicitud web.'});
    const appointment=result.rows[0].data;
    if(['Eliminada','Eliminado','Cancelada','Cancelado'].includes(String(appointment.estado||'')))return res.status(409).json({error:'Esta solicitud ya fue cancelada o eliminada.'});
    appointment.estado='Confirmada'; appointment.confirmadoPor=req.user; appointment.confirmadoEn=new Date().toISOString(); appointment.updatedAt=appointment.confirmadoEn;
    const saved=await pool.query("UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='agenda' AND record_key=$1 RETURNING data",[String(id),appointment]);
    res.json({ok:true,cita:saved.rows[0].data});
  } catch(error){next(error);}
});
app.delete('/api/admin/public-appointments/:id', requireAuth, async (req, res, next) => {
  try {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:'Solicitud inválida.'});
    const result=await pool.query("SELECT data FROM app_records WHERE store='agenda' AND record_key=$1",[String(id)]);
    if(!result.rowCount||result.rows[0].data.creadoPor!=='portal-publico')return res.status(404).json({error:'No se encontró la solicitud web.'});
    await pool.query("DELETE FROM app_records WHERE store='agenda' AND record_key=$1",[String(id)]);
    res.json({ok:true});
  } catch(error){next(error);}
});

app.get('/api/public/booking-settings',async(_req,res,next)=>{try{const s=await getPublicAppointmentSettings();res.set('Cache-Control','no-store');res.json({settings:{days:s.days,startHour:s.startHour,endHour:s.endHour,whatsapp:s.whatsapp,phone:s.phone}});}catch(e){next(e);}});
app.get('/api/admin/public-booking-settings',requireAuth,async(_req,res,next)=>{try{res.set('Cache-Control','no-store');res.json({settings:await getPublicAppointmentSettings(),notificationConfigured:Boolean(process.env.BREVO_API_KEY&&process.env.BREVO_SENDER_EMAIL),emailNotificationConfigured:Boolean(process.env.BREVO_API_KEY&&process.env.BREVO_SENDER_EMAIL)});}catch(e){next(e);}});
app.put('/api/admin/public-booking-settings',requireAuth,requireAdmin,async(req,res,next)=>{try{const b=req.body||{},days=Array.isArray(b.days)?[...new Set(b.days.map(Number))]:[],startHour=Number(b.startHour),endHour=Number(b.endHour),whatsapp=typeof b.whatsapp==='string'?b.whatsapp.trim():'',notificationWhatsapp=typeof b.notificationWhatsapp==='string'?b.notificationWhatsapp.trim():'',notificationEmail=typeof b.notificationEmail==='string'?b.notificationEmail.trim():'',phone=typeof b.phone==='string'?b.phone.trim():'';if(!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6)||!Number.isInteger(startHour)||startHour<0||startHour>23||!Number.isInteger(endHour)||endHour<1||endHour>24||endHour<=startHour||(whatsapp&&!/^[+()\d .-]{7,25}$/.test(whatsapp))||(notificationWhatsapp&&!/^[+()\d .-]{7,25}$/.test(notificationWhatsapp))||(phone&&!/^[+()\d .-]{7,25}$/.test(phone))||(notificationEmail&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationEmail)||notificationEmail.length>254)))return res.status(400).json({error:'Revisa días, horario, teléfonos y correo electrónico.'});const settings={days,startHour,endHour,whatsapp,notificationWhatsapp,notificationEmail,phone};await pool.query("INSERT INTO app_records(store, record_key, data) VALUES('config',$1,$2) ON CONFLICT(store,record_key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()",['public_appointments_settings',{key:'public_appointments_settings',value:settings}]);res.json({ok:true,settings,notificationConfigured:Boolean(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID&&process.env.WHATSAPP_TEMPLATE_NAME),emailNotificationConfigured:Boolean(String(process.env.BREVO_API_KEY||'').trim()&&String(process.env.BREVO_SENDER_EMAIL||'').trim())});}catch(e){next(e);}});
app.get('/api/public/appointment-doctors', async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT data FROM app_records WHERE store='medicos'");
    const doctors = result.rows.map(row => row.data)
      .filter(m => m && m.id != null && m.activo !== false && String(m.nombre || '').trim())
      .map(m => ({ id: Number(m.id), nombre: String(m.nombre).trim() }))
      .filter(m => Number.isSafeInteger(m.id) && m.id > 0)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    res.set('Cache-Control', 'no-store');
    res.json(doctors);
  } catch (error) { next(error); }
});
app.get('/api/public/appointment-availability', async (req, res, next) => {
  try {
    const fecha = String(req.query.fecha || '');
    const medicoId = Number(req.query.medicoId);
    if (!publicDateIsValid(fecha) || !Number.isSafeInteger(medicoId) || medicoId < 1) {
      return res.status(400).json({ error: 'Selecciona una fecha válida dentro de los próximos 90 días.' });
    }
    const settings = await getPublicAppointmentSettings();
    if (!settings.days.includes(new Date(fecha + 'T00:00:00Z').getUTCDay())) {
      res.set('Cache-Control', 'no-store');
      return res.json({ fecha, medicoId, horarios: [] });
    }
    const doctorResult = await pool.query("SELECT data FROM app_records WHERE store='medicos' AND record_key=$1", [String(medicoId)]);
    if (!doctorResult.rowCount || doctorResult.rows[0].data.activo === false) {
      return res.status(404).json({ error: 'El médico seleccionado no está disponible.' });
    }
    const appointments = await getPublicAgenda(pool);
    const occupied = appointments.filter(c => c && String(c.medicoId) === String(medicoId) &&
      c.fecha === fecha && !['Cancelada', 'Eliminada'].includes(String(c.estado || '')))
      .map(c => String(c.hora || '').slice(0, 5));
    const horarios = publicAppointmentSlots(settings).filter(slot => {
      const start = Number(slot.slice(0, 2)) * 60;
      return !occupied.some(time => {
        if (!/^\d{2}:\d{2}$/.test(time)) return false;
        const begin = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
        return begin < start + 60 && begin + 60 > start;
      });
    });
    res.set('Cache-Control', 'no-store');
    res.json({ fecha, medicoId, horarios });
  } catch (error) { next(error); }
});
async function sendEmailAppointmentNotification(appointment, settings) {
  const apiKey = String(process.env.BREVO_API_KEY || '').trim();
  const senderEmail = String(process.env.BREVO_SENDER_EMAIL || '').trim();
  const recipient = String(settings?.notificationEmail || '').trim();

  // Reportar exactamente qué configuración falta, sin registrar secretos.
  const missing = [];
  if (!apiKey) missing.push('BREVO_API_KEY en Render > Environment');
  if (!senderEmail) missing.push('BREVO_SENDER_EMAIL en Render > Environment');
  if (!recipient) missing.push('correo destinatario en Configuración de la página de citas');
  if (missing.length) {
    console.warn('Notificación de cita omitida. Configuración vacía/no disponible: ' + missing.join('; ') + '.');
    return false;
  }

  const text = 'Se recibió una nueva solicitud de cita en Consultorio Médico CC.\n\nPaciente: ' +
    String(appointment.paciente || 'Paciente') + '\nFecha: ' + String(appointment.fecha || '') +
    '\nHora: ' + String(appointment.hora || '') + '\nTeléfono: ' +
    String(appointment.telefonoContacto || '') + '\nMotivo: ' +
    String(appointment.motivo || appointment.tipoCita || '') +
    '\n\nEntra al sistema para revisar y confirmar la solicitud.';

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'Consultorio Médico CC', email: senderEmail },
      to: [{ email: recipient }],
      subject: 'Nueva solicitud de cita - Consultorio Médico CC',
      textContent: text
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Brevo respondió ' + response.status + ': ' + detail.slice(0, 400));
  }
  return true;
}

async function sendWhatsAppAppointmentNotification(appointment, settings) {
  const token=process.env.WHATSAPP_ACCESS_TOKEN, phoneNumberId=process.env.WHATSAPP_PHONE_NUMBER_ID, templateName=process.env.WHATSAPP_TEMPLATE_NAME;
  const recipient=String(settings.notificationWhatsapp||'').replace(/\D/g,'');
  if(!token||!phoneNumberId||!templateName||!recipient){console.warn('Aviso WhatsApp omitido: falta número de destino o configuración de WhatsApp Cloud API.');return false;}
  const params=[String(appointment.paciente||'Paciente'),String(appointment.fecha||''),String(appointment.hora||''),String(appointment.telefonoContacto||'')].map(value=>({type:'text',text:value.slice(0,120)}));
  const response=await fetch('https://graph.facebook.com/v22.0/'+encodeURIComponent(phoneNumberId)+'/messages',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:recipient,type:'template',template:{name:templateName,language:{code:process.env.WHATSAPP_TEMPLATE_LANGUAGE||'es_MX'},components:[{type:'body',parameters:params}]}})});
  if(!response.ok){const detail=await response.text().catch(()=> '');throw new Error('WhatsApp Cloud API respondió '+response.status+': '+detail.slice(0,500));}
  return true;
}

app.post('/api/public/appointments', publicAppointmentLimiter, async (req, res, next) => {
  const body = req.body || {};
  const nombre = typeof body.nombre === 'string' ? body.nombre.trim().replace(/\s+/g, ' ') : '';
  const telefono = typeof body.telefono === 'string' ? body.telefono.trim() : '';
  const fechaNacimiento = String(body.fechaNacimiento || '');
  const medicoId = Number(body.medicoId);
  const fecha = String(body.fecha || '');
  const hora = String(body.hora || '');
  const tipo = String(body.tipo || '');
  const otroMotivo = typeof body.otroMotivo === 'string' ? body.otroMotivo.trim().replace(/\s+/g, ' ') : '';
  if (nombre.length < 2 || nombre.length > 120 || !/^[+()\d .-]{7,25}$/.test(telefono) ||
      !publicBirthDateIsValid(fechaNacimiento) ||
      !Number.isSafeInteger(medicoId) || medicoId < 1 || !publicDateIsValid(fecha) ||
      !(await getPublicAppointmentSettings()).days.includes(new Date(fecha + 'T00:00:00Z').getUTCDay()) || !publicAppointmentSlots(await getPublicAppointmentSettings()).includes(hora) || !PUBLIC_APPOINTMENT_TYPES.has(tipo) ||
      (['Otros síntomas', 'Otro motivo'].includes(tipo) && (!otroMotivo || otroMotivo.split(/\s+/).length > 50)) ||
      (!['Otros síntomas', 'Otro motivo'].includes(tipo) && otroMotivo)) {
    return res.status(400).json({ error: 'Revisa los datos. Si eliges “Otros síntomas”, describe el motivo en máximo 50 palabras.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [medicoId, Number(fecha.replace(/-/g, ''))]);
    const doctorResult = await client.query("SELECT data FROM app_records WHERE store='medicos' AND record_key=$1", [String(medicoId)]);
    if (!doctorResult.rowCount || doctorResult.rows[0].data.activo === false) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El médico seleccionado ya no está disponible.' });
    }
    const appointments = await getPublicAgenda(client);
    const start = Number(hora.slice(0, 2)) * 60;
    const conflict = appointments.some(c => {
      if (!c || String(c.medicoId) !== String(medicoId) || c.fecha !== fecha ||
          ['Cancelada', 'Eliminada'].includes(String(c.estado || ''))) return false;
      const time = String(c.hora || '').slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(time)) return false;
      const begin = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
      return begin < start + 60 && begin + 60 > start;
    });
    if (conflict) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese horario acaba de ocuparse. Selecciona otro horario disponible.' });
    }
    const seq = await client.query(
      "INSERT INTO app_sequences(store, next_id) VALUES('agenda', 1) ON CONFLICT(store) DO UPDATE SET next_id = app_sequences.next_id + 1 RETURNING next_id"
    );
    const id = Number(seq.rows[0].next_id);
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const now = new Date().toISOString();
    const record = {
      id, pacienteId: null, paciente: nombre, telefonoContacto: telefono,
      fechaNacimiento, edad: publicAgeFromBirthDate(fechaNacimiento),
      fecha, hora, medicoId, motivo: ['Otros síntomas', 'Otro motivo'].includes(tipo) ? otroMotivo : tipo,
      tipoCita: tipo, estado: 'Solicitud web',
      codigoVerificacionHash: crypto.createHash('sha256').update(codigo).digest('hex'),
      creadoPor: 'portal-publico', createdAt: now, updatedAt: now
    };
    await client.query("INSERT INTO app_records(store, record_key, data) VALUES('agenda', $1, $2)", [String(id), record]);
    await client.query('COMMIT');
    try { await sendEmailAppointmentNotification(record, await getPublicAppointmentSettings()); }
    catch (notificationError) { console.error('No se pudo enviar la notificación de nueva cita por correo:', notificationError.message); }
    res.status(201).json({
      ok: true, codigoVerificacion: codigo,
      cita: { fecha, hora, medico: String(doctorResult.rows[0].data.nombre || ''), tipo }
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

app.get(
  '/api/data/:store',
  requireAuth,
  (req, res, next) => {
    if (req.params.store === 'cobros') return requireFinanceRead(req, res, next);
    if (req.params.store === 'empleados') return requireAdmin(req, res, next);
    return next();
  },
  async (req, res, next) => {
    try {
      const { store } = req.params;

      if (!validStore(store)) {
        return res.status(404).json({
          error: 'Módulo desconocido.'
        });
      }

      const result = await pool.query(
        `SELECT data
         FROM app_records
         WHERE store = $1
         ORDER BY
           CASE
             WHEN data ? 'id' THEN (data->>'id')::bigint
             ELSE 0
           END,
           record_key`,
        [store]
      );

      res.json(result.rows.map(row => row.data));
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  '/api/data/:store/:id',
  requireAuth,
  (req, res, next) => {
    if (req.params.store === 'cobros') return requireFinanceRead(req, res, next);
    if (req.params.store === 'empleados') return requireAdmin(req, res, next);
    return next();
  },
  async (req, res, next) => {
    try {
      const { store, id } = req.params;

      if (!validStore(store)) {
        return res.status(404).json({
          error: 'Módulo desconocido.'
        });
      }

      const result = await pool.query(
        'SELECT data FROM app_records WHERE store = $1 AND record_key = $2',
        [store, id]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          error: 'Registro no encontrado.'
        });
      }

      res.json(result.rows[0].data);
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/data/:store',
  requireAuth,
  (req, res, next) => {
    if (req.params.store === 'cobros') return requireFinanceWrite(req, res, next);
    if (req.params.store === 'empleados') return requireAdmin(req, res, next);
    if (req.params.store === 'config' && (req.params.id === 'public_appointments_settings' || (req.method === 'POST' && req.body?.key === 'public_appointments_settings') || (req.method === 'DELETE' && !req.params.id))) return requireAdmin(req, res, next);
    return next();
  },
  async (req, res, next) => {
    const client = await pool.connect();

    try {
      const store = req.params.store;

      if (!validStore(store)) {
        return res.status(404).json({
          error: 'Módulo desconocido.'
        });
      }

      const data = req.body;

      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data)
      ) {
        return res.status(400).json({
          error: 'Registro inválido.'
        });
      }

      await client.query('BEGIN');

      const value = { ...data };

      if (store !== 'config') {
        if (value.id == null) {
          const seq = await client.query(
            `INSERT INTO app_sequences(store, next_id)
             VALUES($1, 1)
             ON CONFLICT(store)
             DO UPDATE SET next_id = app_sequences.next_id + 1
             RETURNING next_id`,
            [store]
          );

          value.id = Number(seq.rows[0].next_id);
        } else {
          const numericId = Number(value.id);

          if (!Number.isSafeInteger(numericId) || numericId < 1) {
            throw Object.assign(new Error('ID inválido.'), {
              status: 400
            });
          }

          await client.query(
            `INSERT INTO app_sequences(store, next_id)
             VALUES($1, $2)
             ON CONFLICT(store)
             DO UPDATE SET next_id = GREATEST(app_sequences.next_id, $2)`,
            [store, numericId]
          );
        }
      } else if (typeof value.key !== 'string' || !value.key) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          error: 'Clave de configuración inválida.'
        });
      }

      const key = recordKey(store, value);

      await client.query(
        `INSERT INTO app_records(store, record_key, data)
         VALUES($1, $2, $3)
         ON CONFLICT(store, record_key)
         DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [store, key, value]
      );

      await client.query('COMMIT');

      res.status(201).json(value);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  }
);

app.put(
  '/api/data/:store/:id',
  requireAuth,
  (req, res, next) => {
    if (req.params.store === 'cobros') return requireFinanceWrite(req, res, next);
    if (req.params.store === 'empleados') return requireAdmin(req, res, next);
    if (req.params.store === 'config' && (req.params.id === 'public_appointments_settings' || (req.method === 'POST' && req.body?.key === 'public_appointments_settings') || (req.method === 'DELETE' && !req.params.id))) return requireAdmin(req, res, next);
    return next();
  },
  async (req, res, next) => {
    try {
      const { store, id } = req.params;

      if (!validStore(store)) {
        return res.status(404).json({
          error: 'Módulo desconocido.'
        });
      }

      const value = req.body;

      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      ) {
        return res.status(400).json({
          error: 'Registro inválido.'
        });
      }

      if (store === 'config') {
        value.key = id;
      } else {
        const numericId = Number(id);

        if (!Number.isSafeInteger(numericId) || numericId < 1) {
          return res.status(400).json({
            error: 'ID inválido.'
          });
        }

        value.id = numericId;
      }

      const result = await pool.query(
        `INSERT INTO app_records(store, record_key, data)
         VALUES($1, $2, $3)
         ON CONFLICT(store, record_key)
         DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
         RETURNING data`,
        [store, id, value]
      );

      res.json(result.rows[0].data);
    } catch (error) {
      next(error);
    }
  }
);

app.delete(
  '/api/data/:store/:id',
  requireAuth,
  (req, res, next) => {
    if (req.params.store === 'cobros') return requireFinanceWrite(req, res, next);
    if (req.params.store === 'empleados') return requireAdmin(req, res, next);
    if (req.params.store === 'config' && (req.params.id === 'public_appointments_settings' || (req.method === 'POST' && req.body?.key === 'public_appointments_settings') || (req.method === 'DELETE' && !req.params.id))) return requireAdmin(req, res, next);
    return next();
  },
  async (req, res, next) => {
    try {
      const { store, id } = req.params;

      if (!validStore(store)) {
        return res.status(404).json({
          error: 'Módulo desconocido.'
        });
      }

      await pool.query(
        'DELETE FROM app_records WHERE store = $1 AND record_key = $2',
        [store, id]
      );

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

app.delete(
  '/api/data/:store',
  requireAuth,
  (req, res, next) => {
    if (req.params.store === 'cobros') return requireFinanceWrite(req, res, next);
    if (req.params.store === 'empleados') return requireAdmin(req, res, next);
    if (req.params.store === 'config' && (req.params.id === 'public_appointments_settings' || (req.method === 'POST' && req.body?.key === 'public_appointments_settings') || (req.method === 'DELETE' && !req.params.id))) return requireAdmin(req, res, next);
    return next();
  },
  async (req, res, next) => {
    try {
      const { store } = req.params;

      if (!validStore(store)) {
        return res.status(404).json({
          error: 'Módulo desconocido.'
        });
      }

      await pool.query(
        'DELETE FROM app_records WHERE store = $1',
        [store]
      );

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

const runMembershipNotifications = registerMembershipRoutes(app, pool, { requireAuth, requireAdmin });

app.use((req, res, next) => {
  if (
    /^\/(server\.js|package(?:-lock)?\.json|README\.md|render\.yaml|\.env(?:\.example)?|\.gitignore)(?:$|\?)/i.test(
      req.path
    )
  ) {
    return res.sendStatus(404);
  }

  next();
});

app.use(express.static(path.join(__dirname)));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('Error de servidor:', error.message);

  res.status(error.status || 500).json({
    error: error.status
      ? error.message
      : 'Error interno del servidor.'
  });
});

initDb()
  .then(() => {
    runMembershipNotifications().catch(error => console.error('Error inicial de notificaciones de membresías:', error.message));
    setInterval(() => runMembershipNotifications().catch(error => console.error('Error de notificaciones de membresías:', error.message)), 6 * 60 * 60 * 1000);
    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `Consultorio Médico CC escuchando en puerto ${PORT}`
      );
    });
  })
  .catch(error => {
    console.error(
      'No se pudo inicializar PostgreSQL:',
      error.message
    );

    process.exit(1);
  });
