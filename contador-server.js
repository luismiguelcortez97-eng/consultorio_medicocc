'use strict';

const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

function hashNip(nip, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(nip, salt, 64).toString('hex') };
}

function verifyNipHash(nip, salt, storedHash) {
  try {
    const expected = Buffer.from(storedHash, 'hex');
    const actual = crypto.scryptSync(nip, salt, 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

async function initContadorDb(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contador_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contador_credentials (
      credential_key TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contador_records (
      id BIGSERIAL PRIMARY KEY,
      record_type TEXT NOT NULL,
      data JSONB NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reversed_by BIGINT REFERENCES contador_records(id),
      reversed_at TIMESTAMPTZ
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS contador_records_type_idx ON contador_records(record_type, created_at DESC)');
}

function registerContadorRoutes(app, pool, helpers) {
  const { requireAuth, requireAdmin, createFinanceToken, validFinanceToken, isProd } = helpers;
  const contadorUnlockLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos de clave. Intenta más tarde.' } });
  const financeAccess = (req, res, next) => {
    requireAuth(req, res, () => requireAdmin(req, res, () => {
      if (!validFinanceToken(req, 'contador')) {
        return res.status(403).json({ error: 'La sesión del Contador expiró. Ingresa nuevamente la clave.' });
      }
      next();
    }));
  };

  async function storedCredential() {
    const result = await pool.query(
      "SELECT password_hash, password_salt FROM contador_credentials WHERE credential_key='contador_nip'"
    );
    return result.rows[0] || null;
  }

  async function checkNip(nip) {
    if (typeof nip !== 'string' || !nip) return false;
    const credential = await storedCredential();
    return !!credential && verifyNipHash(nip, credential.password_salt, credential.password_hash);
  }

  async function getPaidIncome(client = pool) {
    const result = await client.query("SELECT data FROM app_records WHERE store='cobros'");
    return result.rows.map(row => row.data).filter(c => c && c.status === 'pagado' && c.tipo === 'medico' && c.consultaId != null);
  }

  async function getFreeCapital(client = pool) {
    const [income, expenses, settingsResult] = await Promise.all([
      getPaidIncome(client),
      client.query("SELECT record_type, data FROM contador_records WHERE reversed_at IS NULL"),
      client.query("SELECT setting_value FROM contador_settings WHERE setting_key='general'")
    ]);
    const settings = settingsResult.rows[0]?.setting_value || {};
    const initial = Number(settings.capitalInicial) || 0;
    const incomeTotal = income.reduce((sum, c) => sum + (Number(c.monto) || 0), 0);
    let spent = 0;
    let reserved = 0;
    const activeRows = expenses.rows;
    const paidAttendance = new Set(activeRows
      .filter(row => row.record_type === 'payroll_payment')
      .map(row => String(row.data?.attendanceId)));
    let payrollAccrued = 0;
    for (const row of activeRows) {
      const amount = Number(row.data?.amount) || 0;
      if (['expense', 'electricity_bill', 'admin_salary_payment', 'cash_out'].includes(row.record_type) ||
          row.record_type === 'cash_movement' && row.data?.direction === 'out') spent += amount;
      if (row.record_type === 'attendance' && !paidAttendance.has(String(row.id))) payrollAccrued += amount;
      if (row.record_type === 'reserve') reserved += amount;
      if (row.record_type === 'reversal') {
        const originalType = row.data?.originalType;
        if (['expense', 'electricity_bill', 'admin_salary_payment', 'cash_out'].includes(originalType) ||
            originalType === 'cash_movement' && row.data?.originalDirection === 'out') spent -= amount;
        if (originalType === 'reserve') reserved -= amount;
      }
    }
    return {
      initial, incomeTotal, spent, reserved, payrollAccrued,
      free: Math.max(0, initial + incomeTotal - spent - reserved - payrollAccrued)
    };
  }

  app.get('/api/contador/admin-config', requireAuth, requireAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query("SELECT setting_value FROM contador_settings WHERE setting_key='general'");
      const credential = await storedCredential();
      res.json({ settings: result.rows[0]?.setting_value || {}, nipConfigured: !!credential });
    } catch (error) { next(error); }
  });

  app.put('/api/contador/admin-config', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const body = req.body || {};
      const settings = {
        rentMonthly: Math.max(0, Number(body.rentMonthly) || 0),
        capitalInicial: Math.max(0, Number(body.capitalInicial) || 0),
        salarioBaseDiario: Math.max(0, Number(body.salarioBaseDiario) || 440),
        salaryAccountantPercent: Math.max(0, Math.min(100, Number(body.salaryAccountantPercent) || 0)),
        salaryAdminPercent: Math.max(0, Math.min(100, Number(body.salaryAdminPercent) || 0)),
        capitalDistribution: Array.isArray(body.capitalDistribution) ? body.capitalDistribution.slice(0, 20).map(item => ({
          name: String(item.name || '').trim().slice(0, 80),
          percent: Math.max(0, Math.min(100, Number(item.percent) || 0))
        })).filter(item => item.name) : []
      };
      if (settings.capitalDistribution.reduce((sum, item) => sum + item.percent, 0) > 100.0001) {
        return res.status(400).json({ error: 'La distribución del capital no puede superar el 100%.' });
      }
      await pool.query(
        "INSERT INTO contador_settings(setting_key, setting_value) VALUES('general',$1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=NOW()",
        [settings]
      );
      res.json({ ok: true, settings });
    } catch (error) { next(error); }
  });

  app.put('/api/contador/nip', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const nip = typeof req.body?.nip === 'string' ? req.body.nip : '';
      if (nip.length < 6 || nip.length > 32) {
        return res.status(400).json({ error: 'La clave debe tener entre 6 y 32 caracteres.' });
      }
      const credentials = hashNip(nip);
      await pool.query(
        "INSERT INTO contador_credentials(credential_key,password_hash,password_salt) VALUES('contador_nip',$1,$2) ON CONFLICT(credential_key) DO UPDATE SET password_hash=EXCLUDED.password_hash,password_salt=EXCLUDED.password_salt,updated_at=NOW()",
        [credentials.hash, credentials.salt]
      );
      res.clearCookie('cmcc_finance_contador', { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/' });
      res.json({ ok: true, message: 'Clave del Contador actualizada. Por seguridad no se puede consultar después de guardarla.' });
    } catch (error) { next(error); }
  });

  app.post('/api/contador/unlock', contadorUnlockLimiter, requireAuth, requireAdmin, async (req, res, next) => {
    try {
      if (!(await checkNip(req.body?.nip))) return res.status(403).json({ error: 'Clave del Contador incorrecta.' });
      res.cookie('cmcc_finance_contador', createFinanceToken('contador'), {
        httpOnly: true, secure: isProd, sameSite: 'strict', maxAge: 30 * 60 * 1000, path: '/'
      });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/api/contador/data', financeAccess, async (_req, res, next) => {
    try {
      const [recordsResult, cobrosResult, consultasResult, pacientesResult, empleadosResult, settingsResult, capital] = await Promise.all([
        pool.query('SELECT id, record_type AS type, data, created_by AS "createdBy", created_at AS "createdAt", reversed_at AS "reversedAt" FROM contador_records ORDER BY created_at DESC'),
        pool.query("SELECT data FROM app_records WHERE store='cobros' ORDER BY created_at DESC"),
        pool.query("SELECT data FROM app_records WHERE store='consultas'"),
        pool.query("SELECT data FROM app_records WHERE store='pacientes'"),
        pool.query("SELECT data FROM app_records WHERE store='empleados'"),
        pool.query("SELECT setting_value FROM contador_settings WHERE setting_key='general'"),
        getFreeCapital()
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({
        records: recordsResult.rows,
        cobros: cobrosResult.rows.map(row => row.data),
        consultas: consultasResult.rows.map(row => row.data),
        pacientes: pacientesResult.rows.map(row => row.data),
        empleados: empleadosResult.rows.map(row => row.data),
        settings: settingsResult.rows[0]?.setting_value || {},
        capital
      });
    } catch (error) { next(error); }
  });

  app.post('/api/contador/records', financeAccess, async (req, res, next) => {
    const body = req.body || {};
    const allowed = new Set(['expense', 'electricity_bill', 'employee', 'attendance', 'account', 'cash_movement', 'reserve', 'admin_salary_payment', 'payroll_payment', 'salary_config']);
    if (!allowed.has(body.type)) return res.status(400).json({ error: 'Tipo de registro no válido.' });
    const amount = body.data?.amount == null ? null : Number(body.data.amount);
    if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 100000000)) {
      return res.status(400).json({ error: 'Importe inválido.' });
    }
    const requiresNip = ['expense', 'electricity_bill', 'reserve', 'admin_salary_payment', 'payroll_payment'].includes(body.type) ||
      (body.type === 'cash_movement' && body.data?.direction === 'out');
    const client = await pool.connect();
    let cleanPayroll = body.data || {};
    try {
      await client.query('BEGIN');
      if (['expense', 'electricity_bill', 'reserve', 'admin_salary_payment', 'payroll_payment', 'cash_movement'].includes(body.type)) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('consultorio_contador_ledger'))");
      }
      if (requiresNip && !(await checkNip(body.authorizationNip))) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Se requiere la autorización del Contador. La clave no es correcta.' });
      }
      if (body.type === 'attendance') {
        const hours = Number(body.data?.hours);
        const employeeId = Number(body.data?.employeeId);
        const weekStart = typeof body.data?.weekStart === 'string' ? body.data.weekStart : '';
        if (!Number.isSafeInteger(employeeId) || employeeId < 1 || !Number.isFinite(hours) || hours < 0 || hours > 48 || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Empleado, semana u horas laboradas no válidos.' });
        }
        const weekDate = new Date(weekStart + 'T12:00:00Z');
        if (Number.isNaN(weekDate.getTime()) || weekDate.getUTCDay() !== 1 || weekDate.toISOString().slice(0,10) !== weekStart) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'La semana debe iniciar en lunes.' });
        }
        const employee = await client.query("SELECT data FROM app_records WHERE store='empleados' AND data->>'id'=$1", [String(employeeId)]);
        if (!employee.rowCount) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'El empleado seleccionado no existe.' });
        }
        const duplicate = await client.query("SELECT id FROM contador_records WHERE record_type='attendance' AND reversed_at IS NULL AND data->>'employeeId'=$1 AND data->>'weekStart'=$2", [String(employeeId), weekStart]);
        if (duplicate.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Ya existe un cálculo de nómina para ese empleado y semana.' });
        }
        const settingsResult = await client.query("SELECT setting_value FROM contador_settings WHERE setting_key='general'");
        const settings = settingsResult.rows[0]?.setting_value || {};
        const dailyRate = Number(settings.salarioBaseDiario) || 440;
        const expected = Math.round(hours * dailyRate / 8 * 100) / 100;
        if (amount !== expected) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'El importe de nómina no coincide con las horas registradas y la tarifa configurada.' });
        }
        cleanPayroll = { ...body.data, employeeId, employeeName: employee.rows[0].data?.nombre || employee.rows[0].data?.name || 'Empleado', hours, weekStart, amount: expected };
      }
      if (body.type === 'cash_movement' && !['in','out'].includes(body.data?.direction)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Tipo de movimiento de caja no válido.' });
      }
      if (body.type === 'payroll_payment') {
        const attendanceId = Number(body.data?.attendanceId);
        if (!Number.isSafeInteger(attendanceId) || attendanceId < 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Selecciona un registro de nómina válido.' });
        }
        const attendance = await client.query("SELECT data FROM contador_records WHERE id=$1 AND record_type='attendance' AND reversed_at IS NULL", [attendanceId]);
        const alreadyPaid = await client.query("SELECT id FROM contador_records WHERE record_type='payroll_payment' AND data->>'attendanceId'=$1 AND reversed_at IS NULL", [String(attendanceId)]);
        if (!attendance.rowCount || alreadyPaid.rowCount || amount !== Number(attendance.rows[0].data?.amount)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'La nómina no existe, ya fue pagada o el importe no coincide.' });
        }
        cleanPayroll = { ...body.data, employeeName: attendance.rows[0].data?.employeeName, attendanceId, amount };
      }
      if (['expense', 'electricity_bill', 'reserve', 'admin_salary_payment', 'payroll_payment', 'cash_movement'].includes(body.type) && amount > 0) {
        const capital = await getFreeCapital(client);
        if (['expense', 'electricity_bill', 'admin_salary_payment', 'payroll_payment'].includes(body.type) ||
            (body.type === 'cash_movement' && body.data?.direction === 'out')) {
          if (amount > capital.free) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El importe supera el capital libre disponible. El capital reservado está protegido.' });
          }
        }
        if (body.type === 'reserve' && amount > capital.free) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'No se puede reservar más que el capital libre disponible.' });
        }
      }
      const cleanData = { ...(typeof cleanPayroll !== 'undefined' ? cleanPayroll : body.data), amount: amount == null ? undefined : amount };
      delete cleanData.authorizationNip;
      const result = await client.query(
        'INSERT INTO contador_records(record_type,data,created_by) VALUES($1,$2,$3) RETURNING id,record_type AS type,data,created_by AS "createdBy",created_at AS "createdAt"',
        [body.type, cleanData, req.session?.displayName || req.session?.username || 'Administrador']
      );
      await client.query('COMMIT');
      res.status(201).json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  app.post('/api/contador/records/:id/reverse', financeAccess, async (req, res, next) => {
    const id = Number(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
    if (!Number.isSafeInteger(id) || id < 1 || !reason) return res.status(400).json({ error: 'Indica un motivo válido para revertir el movimiento.' });
    try {
      if (!(await checkNip(req.body?.authorizationNip))) return res.status(403).json({ error: 'Clave del Contador incorrecta.' });
      const original = await pool.query('SELECT record_type,data,reversed_at FROM contador_records WHERE id=$1', [id]);
      if (!original.rowCount || original.rows[0].reversed_at) return res.status(404).json({ error: 'Movimiento no disponible para reversión.' });
      const result = await pool.query(
        'INSERT INTO contador_records(record_type,data,created_by,reversed_by) VALUES($1,$2,$3,$4) RETURNING id,record_type AS type,data,created_at AS "createdAt"',
        ['reversal', { originalId: id, originalType: original.rows[0].record_type, amount: Number(original.rows[0].data?.amount) || 0, originalDirection: original.rows[0].data?.direction || null, originalAccount: original.rows[0].data?.account || null, reason }, req.session?.displayName || req.session?.username || 'Administrador', id]
      );
      await pool.query('UPDATE contador_records SET reversed_at=NOW() WHERE id=$1', [id]);
      res.status(201).json(result.rows[0]);
    } catch (error) { next(error); }
  });
}

module.exports = { initContadorDb, registerContadorRoutes };
