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
    return result.rows.map(row => row.data).filter(c => c && c.status === 'pagado' && c.tipo === 'medico');
  }

  async function getFreeCapital(client = pool) {
    const [income, expenses, settingsResult] = await Promise.all([
      getPaidIncome(client),
      client.query("SELECT id, record_type, data FROM contador_records WHERE reversed_at IS NULL"),
      client.query("SELECT setting_value FROM contador_settings WHERE setting_key='general'")
    ]);
    const settings = settingsResult.rows[0]?.setting_value || {};
    const legacyInitial = Number(settings.capitalInicial) || 0;
    const approvedInitial = expenses.rows.filter(row => row.record_type === 'initial_capital').reduce((sum, row) => sum + (Number(row.data?.amount) || 0), 0);
    const accountOpeningCapital = expenses.rows.filter(row => row.record_type === 'account').reduce((sum,row)=>sum+(Number(row.data?.amount)||0),0);
    const initial = legacyInitial + approvedInitial + accountOpeningCapital;
    const incomeTotal = income.reduce((sum, c) => sum + (Number(c.monto) || 0), 0);
    let spent = 0;
    let reserved = 0;
    const activeRows = expenses.rows;
    const paidAttendance = new Set(activeRows.filter(row => row.record_type === 'payroll_payment').map(row => String(row.data?.attendanceId)));
    const salaryPaid = new Map();
    activeRows.filter(row => row.record_type === 'salary_payment').forEach(row => { const key=String(row.data?.accrualId); salaryPaid.set(key,(salaryPaid.get(key)||0)+(Number(row.data?.amount)||0)); });
    let payrollAccrued = 0;
    for (const row of activeRows) {
      const amount = Number(row.data?.amount) || 0;
      if (['expense', 'electricity_bill', 'admin_salary_payment', 'payroll_payment', 'salary_payment', 'cash_out'].includes(row.record_type) ||
          row.record_type === 'cash_movement' && row.data?.direction === 'out') spent += amount;
      if (row.record_type === 'attendance' && !paidAttendance.has(String(row.id))) payrollAccrued += amount;
      if (row.record_type === 'salary_accrual') payrollAccrued += Math.max(0, amount-(salaryPaid.get(String(row.id))||0));
      if (row.record_type === 'reserve') reserved += amount;
    }
    return {
      initial, incomeTotal, spent, reserved, payrollAccrued,
      free: Math.max(0, initial + incomeTotal - spent - reserved - payrollAccrued)
    };
  }

  async function getAccountBalance(account, client = pool) {
    const [incomeResult, rowsResult] = await Promise.all([
      client.query("SELECT data FROM app_records WHERE store='cobros'"),
      client.query("SELECT record_type,data FROM contador_records WHERE reversed_at IS NULL")
    ]);
    let balance = 0;
    for (const row of incomeResult.rows) {
      const cobro = row.data || {};
      if (cobro.status !== 'pagado') continue;
      if (account === 'Efectivo' && cobro.metodoPago === 'Efectivo') balance += Number(cobro.monto)||0;
      if (account === 'Electrónico' && cobro.metodoPago === 'Tarjeta') balance += Number(cobro.monto)||0;
      if (account === 'Transferencias por asignar' && cobro.metodoPago === 'Transferencia') balance += Number(cobro.monto)||0;
    }
    for (const row of rowsResult.rows) {
      const data = row.data || {}, amount = Number(data.amount)||0;
      if (row.record_type === 'account' && data.name === account) balance += amount;
      else if (row.record_type === 'cash_transfer') { if(data.fromAccount===account) balance-=amount; if(data.toAccount===account) balance+=amount; }
      else if (row.record_type === 'initial_capital' && data.account === account) balance += amount;
      else if (row.record_type === 'cash_movement' && data.account === account) balance += data.direction === 'out' ? -amount : amount;
      else if (['expense','electricity_bill','payroll_payment','admin_salary_payment','salary_payment'].includes(row.record_type) && data.account === account) balance -= amount;
      else if (row.record_type === 'reversal' && data.originalAccount === account) {
        if (data.originalType === 'cash_movement') balance += data.originalDirection === 'out' ? amount : -amount;
        else if (data.originalType === 'cash_transfer') { if(data.originalFromAccount===account) balance+=amount; if(data.originalToAccount===account) balance-=amount; }
        else if (['expense','electricity_bill','payroll_payment','admin_salary_payment','salary_payment'].includes(data.originalType)) balance += amount;
      }
    }
    return balance;
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
      const previous = await pool.query("SELECT setting_value FROM contador_settings WHERE setting_key='general'");
      const previousSettings = previous.rows[0]?.setting_value || {};
      const changesSalary = Number(body.salaryAccountantPercent) !== Number(previousSettings.salaryAccountantPercent || 0) || Number(body.salaryAdminPercent) !== Number(previousSettings.salaryAdminPercent || 0);
      if (changesSalary && !(await checkNip(body.authorizationNip))) return res.status(403).json({ error: 'El Contador debe autorizar los porcentajes salariales con su clave.' });
      const settings = {
        ...previousSettings,
        rentMonthly: Math.max(0, Number(body.rentMonthly) || 0),
        
        salarioBaseDiario: Math.max(0, Number(body.salarioBaseDiario) || 440),
        salaryAccountantPercent: Math.max(0, Math.min(100, Number(body.salaryAccountantPercent) || 0)),
        salaryAdminPercent: Math.max(0, Math.min(100, Number(body.salaryAdminPercent) || 0)),
        capitalDistribution: Array.isArray(body.capitalDistribution) ? body.capitalDistribution.slice(0, 20).map(item => ({
          name: String(item.name || '').trim().slice(0, 80),
          percent: Math.max(0, Math.min(100, Number(item.percent) || 0))
        })).filter(item => item.name) : []
      };
      if (settings.salaryAccountantPercent + settings.salaryAdminPercent > 100.0001) {
        return res.status(400).json({ error: 'Los porcentajes semanales del Contador y administrador no pueden superar juntos el 100%.' });
      }
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
      const [recordsResult, cobrosResult, consultasResult, pacientesResult, medicosResult, empleadosResult, settingsResult, capital] = await Promise.all([
        pool.query('SELECT id, record_type AS type, data, created_by AS "createdBy", created_at AS "createdAt", reversed_at AS "reversedAt" FROM contador_records ORDER BY created_at DESC'),
        pool.query("SELECT data FROM app_records WHERE store='cobros'"),
        pool.query("SELECT data FROM app_records WHERE store='consultas'"),
        pool.query("SELECT data FROM app_records WHERE store='pacientes'"),
        pool.query("SELECT data FROM app_records WHERE store='medicos'"),
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
        medicos: medicosResult.rows.map(row => row.data),
        empleados: empleadosResult.rows.map(row => row.data),
        settings: settingsResult.rows[0]?.setting_value || {},
        capital
      });
    } catch (error) { next(error); }
  });

  app.post('/api/contador/records', financeAccess, async (req, res, next) => {
    const body = req.body || {};
    const allowed = new Set(['expense', 'electricity_bill', 'employee', 'attendance', 'account', 'cash_movement', 'reserve', 'admin_salary_payment', 'payroll_payment', 'salary_config', 'salary_accrual', 'salary_payment', 'initial_capital', 'cash_transfer']);
    if (!allowed.has(body.type)) return res.status(400).json({ error: 'Tipo de registro no válido.' });
    const amount = body.data?.amount == null ? null : Number(body.data.amount);
    if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 100000000)) {
      return res.status(400).json({ error: 'Importe inválido.' });
    }
    const requiresNip = ['expense', 'electricity_bill', 'reserve', 'admin_salary_payment', 'payroll_payment', 'salary_accrual', 'salary_payment', 'initial_capital'].includes(body.type) || (body.type === 'account' && amount > 0) ||
      (body.type === 'cash_movement' && body.data?.direction === 'out') || body.type === 'cash_transfer';
    const client = await pool.connect();
    let cleanPayroll = body.data || {};
    try {
      await client.query('BEGIN');
      if (['expense', 'electricity_bill', 'reserve', 'admin_salary_payment', 'payroll_payment', 'salary_accrual', 'salary_payment', 'initial_capital', 'cash_movement', 'account', 'cash_transfer'].includes(body.type)) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('consultorio_contador_ledger'))");
      }
      if (requiresNip && !(await checkNip(body.authorizationNip))) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Se requiere la autorización del Contador. La clave no es correcta.' });
      }
      if (body.type === 'initial_capital') {
        if (!amount || amount <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'El capital inicial debe ser mayor a cero.' });
        }
        const existing = await client.query("SELECT id FROM contador_records WHERE record_type='initial_capital' AND reversed_at IS NULL");
        if (existing.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'El capital inicial ya fue autorizado. Para corregirlo debe revertirse con motivo y autorización.' });
        }
        const account = typeof body.data?.account === 'string' ? body.data.account.trim().slice(0,80) : '';
        if (!['Efectivo','Electrónico','Transferencias por asignar'].includes(account)) {
          const validAccount = await client.query("SELECT id FROM contador_records WHERE record_type='account' AND reversed_at IS NULL AND data->>'name'=$1", [account]);
          if (!account || !validAccount.rowCount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Selecciona una cuenta o caja existente para depositar el capital.' });
          }
        }
        cleanPayroll = { amount, account, concept: 'Capital inicial autorizado por el Contador', date: new Date().toISOString() };
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
      if (body.type === 'cash_transfer') {
        const fromAccount = typeof body.data?.fromAccount === 'string' ? body.data.fromAccount.trim().slice(0,80) : '';
        const toAccount = typeof body.data?.toAccount === 'string' ? body.data.toAccount.trim().slice(0,80) : '';
        if (!amount || amount <= 0 || !fromAccount || !toAccount || fromAccount === toAccount) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Selecciona dos cuentas distintas y un importe válido.' });
        }
        for (const account of [fromAccount,toAccount]) {
          const builtin = ['Efectivo','Electrónico','Transferencias por asignar'].includes(account);
          const custom = (await client.query("SELECT id FROM contador_records WHERE record_type='account' AND reversed_at IS NULL AND data->>'name'=$1", [account])).rowCount > 0;
          if (!builtin && !custom) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Una de las cuentas seleccionadas no existe.' });
          }
        }
        const available = await getAccountBalance(fromAccount, client);
        if (amount > available) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'La cuenta de origen no tiene saldo suficiente.' });
        }
        cleanPayroll = { fromAccount, toAccount, amount, concept: 'Traspaso entre cuentas' };
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
      if (body.type === 'salary_accrual') {
        const weekStart = typeof body.data?.weekStart === 'string' ? body.data.weekStart : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Selecciona una semana válida.' });
        }
        const weekDate = new Date(weekStart + 'T12:00:00Z');
        if (Number.isNaN(weekDate.getTime()) || weekDate.getUTCDay() !== 1 || weekDate.toISOString().slice(0,10) !== weekStart) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'La semana debe iniciar en lunes.' });
        }
        const duplicate = await client.query("SELECT id FROM contador_records WHERE record_type='salary_accrual' AND reversed_at IS NULL AND data->>'weekStart'=$1", [weekStart]);
        if (duplicate.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Los salarios de esa semana ya fueron calculados.' });
        }
        const configResult = await client.query("SELECT setting_value FROM contador_settings WHERE setting_key='general'");
        const config = configResult.rows[0]?.setting_value || {};
        const capital = await getFreeCapital(client);
        const accountantPercent = Number(config.salaryAccountantPercent) || 0;
        const adminPercent = Number(config.salaryAdminPercent) || 0;
        const accountantAmount = Math.round(capital.free * accountantPercent) / 100;
        const adminAmount = Math.round(capital.free * adminPercent) / 100;
        const total = Math.round((accountantAmount + adminAmount) * 100) / 100;
        if (total > capital.free) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'Los salarios superan el capital libre disponible.' });
        }
        if (total <= 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'No hay capital libre o los porcentajes salariales están en cero. No se generó ninguna obligación.' });
        }
        cleanPayroll = { weekStart, amount: total, accountantPercent, adminPercent, accountantAmount, adminAmount, concept: 'Salarios semanales de administración y Contador' };
      }
      if (body.type === 'salary_payment') {
        const accrualId = Number(body.data?.accrualId);
        const payoutDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tijuana', day: '2-digit' }).format(new Date());
        if (!Number.isSafeInteger(accrualId) || accrualId < 1 || !['14','30'].includes(payoutDate)) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Los salarios solo pueden retirarse los días 14 y 30 de cada mes.' });
        }
        const accrual = await client.query("SELECT data FROM contador_records WHERE id=$1 AND record_type='salary_accrual' AND reversed_at IS NULL", [accrualId]);
        const person = body.data?.person === 'accountant' ? 'accountant' : body.data?.person === 'admin' ? 'admin' : '';
        const alreadyPaid = await client.query("SELECT id FROM contador_records WHERE record_type='salary_payment' AND data->>'accrualId'=$1 AND data->>'person'=$2 AND reversed_at IS NULL", [String(accrualId), person]);
        if (!accrual.rowCount || !person || alreadyPaid.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'El salario no existe o ya fue retirado.' });
        }
        const salary = accrual.rows[0].data || {};
        const total = person === 'accountant' ? Number(salary.accountantAmount)||0 : Number(salary.adminAmount)||0;
        if (amount !== total || total <= 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'El importe no coincide con el salario semanal calculado.' });
        }
        const account = typeof body.data?.account === 'string' ? body.data.account.trim().slice(0,80) : '';
        if (!account) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Selecciona la caja o cuenta de donde saldrá el retiro.' });
        }
        cleanPayroll = { accrualId, person, weekStart: salary.weekStart, amount: total, account, concept: person === 'accountant' ? 'Retiro semanal del Contador' : 'Retiro semanal del administrador' };
      }
      if (['expense','electricity_bill','payroll_payment','salary_payment','admin_salary_payment','cash_movement','initial_capital'].includes(body.type)) {
        const account = typeof cleanPayroll?.account === 'string' ? cleanPayroll.account : typeof body.data?.account === 'string' ? body.data.account : '';
        const builtin = ['Efectivo','Electrónico','Transferencias por asignar'].includes(account);
        const custom = account && (await client.query("SELECT id FROM contador_records WHERE record_type='account' AND reversed_at IS NULL AND data->>'name'=$1", [account])).rowCount > 0;
        if (!account || (!builtin && !custom)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Selecciona una caja o cuenta bancaria registrada.' });
        }
        if (body.type !== 'initial_capital' && body.type !== 'cash_movement' && amount > 0) {
          const available = await getAccountBalance(account, client);
          if (amount > available) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El saldo de esa caja o cuenta es insuficiente para este movimiento.' });
          }
        }
        if (body.type === 'cash_movement' && body.data?.direction === 'out' && amount > 0) {
          const available = await getAccountBalance(account, client);
          if (amount > available) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El saldo de esa caja o cuenta es insuficiente.' });
          }
        }
      }
      if (['expense', 'electricity_bill', 'reserve', 'admin_salary_payment', 'payroll_payment', 'salary_accrual', 'salary_payment', 'cash_movement'].includes(body.type) && amount > 0) {
        const capital = await getFreeCapital(client);
        if (['expense', 'electricity_bill', 'admin_salary_payment', 'payroll_payment', 'salary_payment'].includes(body.type) ||
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
      const cleanData = { ...(typeof cleanPayroll !== 'undefined' ? cleanPayroll : body.data), amount: amount == null ? (cleanPayroll?.amount ?? undefined) : amount };
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

  app.post('/api/contador/cobros/registrar-desde-consulta', financeAccess, async (req, res, next) => {
    const consultaId = Number(req.body?.consultaId);
    const amount = Number(req.body?.amount);
    const method = typeof req.body?.method === 'string' ? req.body.method.trim() : '';
    const allowedMethods = new Set(['Efectivo', 'Tarjeta', 'Transferencia']);
    if (!Number.isSafeInteger(consultaId) || consultaId < 1 || !Number.isFinite(amount) || amount <= 0 || amount > 10000000 || !allowedMethods.has(method)) {
      return res.status(400).json({ error: 'Verifica el importe y selecciona un método de pago válido.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('consultorio_contador_cobros'))");
      const found = await client.query("SELECT data FROM app_records WHERE store='consultas' AND record_key=$1 FOR UPDATE", [String(consultaId)]);
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No se encontró la consulta.' });
      }
      const consulta = found.rows[0].data || {};
      if (consulta.cobroRevisionAnuladaAt || consulta.cobroId != null) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La consulta ya tiene un cobro asociado o fue marcada como no cobrada. Actualiza la lista.' });
      }
      const existing = await client.query("SELECT data FROM app_records WHERE store='cobros' AND data->>'consultaId'=$1 LIMIT 1 FOR UPDATE", [String(consultaId)]);
      if (existing.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Ya existe un registro de cobro para esta consulta. Actualiza la lista y confirma desde Cobros pendientes.' });
      }
      const patientResult = await client.query("SELECT data FROM app_records WHERE store='pacientes' AND record_key=$1", [String(consulta.pacienteId)]);
      const doctorResult = await client.query("SELECT data FROM app_records WHERE store='medicos' AND record_key=$1", [String(consulta.medicoId)]);
      const paciente = patientResult.rows[0]?.data || {};
      const medico = doctorResult.rows[0]?.data || {};
      const sequence = await client.query(`INSERT INTO app_sequences(store, next_id) VALUES('cobros', 1)
        ON CONFLICT(store) DO UPDATE SET next_id=app_sequences.next_id+1 RETURNING next_id`);
      const id = Number(sequence.rows[0].next_id);
      const now = new Date().toISOString();
      const user = req.session?.displayName || req.session?.username || 'Contador';
      const received = Math.round(amount * 100) / 100;
      const cobro = {
        id, concepto: 'Consulta médica',
        referencia: (paciente.nombre || 'Paciente') + (medico.nombre ? ' | Dr(a). ' + medico.nombre : ''),
        monto: received, montoSolicitado: Number(consulta.montoConsulta) || null,
        montoRecibido: received, metodoPago: method, tipo: 'medico', status: 'pagado',
        medicoId: consulta.medicoId || null, pacienteId: consulta.pacienteId || null, consultaId,
        fecha: now, cobradoAt: now, pagadoAt: now, pagadoPor: user, creadoPor: user,
        audit: [{ fecha: now, accion: 'cobro_registrado_y_confirmado_por_contador', usuario: user, consultaId, montoRecibido: received, metodoPago: method }]
      };
      consulta.montoConsulta = received;
      consulta.cobroId = id;
      consulta.cobroRegistradoAt = now;
      consulta.cobroRegistradoPor = user;
      consulta.cobroConfirmadoAt = now;
      consulta.cobroConfirmadoPor = user;
      await client.query("UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='consultas' AND record_key=$1", [String(consultaId), consulta]);
      await client.query("INSERT INTO app_records(store, record_key, data) VALUES('cobros',$1,$2)", [String(id), cobro]);
      await client.query('COMMIT');
      res.status(201).json({ ok: true, cobro });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  app.post('/api/contador/cobros/confirmar', financeAccess, async (req, res, next) => {
    const id = Number(req.body?.id);
    const amount = Number(req.body?.amount);
    const method = typeof req.body?.method === 'string' ? req.body.method.trim() : '';
    const allowedMethods = new Set(['Efectivo', 'Tarjeta', 'Transferencia']);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isFinite(amount) || amount <= 0 || amount > 10000000 || !allowedMethods.has(method)) {
      return res.status(400).json({ error: 'Verifica el importe recibido y selecciona un método de pago válido.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('consultorio_contador_cobros'))");
      const found = await client.query("SELECT data FROM app_records WHERE store='cobros' AND record_key=$1 FOR UPDATE", [String(id)]);
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No se encontró el cobro.' });
      }
      const cobro = found.rows[0].data || {};
      if (cobro.status !== 'pendiente') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: cobro.status === 'cancelado' ? 'Este cobro fue anulado y no puede confirmarse.' : 'Este cobro ya fue confirmado o no está pendiente.' });
      }
      const now = new Date().toISOString();
      const user = req.session?.displayName || req.session?.username || 'Contador';
      const requestedAmount = Number(cobro.monto) || 0;
      cobro.montoSolicitado = cobro.montoSolicitado == null ? requestedAmount : cobro.montoSolicitado;
      cobro.monto = Math.round(amount * 100) / 100;
      cobro.montoRecibido = cobro.monto;
      cobro.metodoPago = method;
      cobro.status = 'pagado';
      cobro.cobradoAt = now;
      cobro.pagadoAt = now;
      cobro.pagadoPor = user;
      cobro.audit = Array.isArray(cobro.audit) ? cobro.audit : [];
      cobro.audit.push({ fecha: now, accion: 'cobro_confirmado_por_contador', usuario: user, montoSolicitado: requestedAmount, montoRecibido: cobro.monto, metodoPago: method });
      await client.query("UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='cobros' AND record_key=$1", [String(id), cobro]);
      await client.query('COMMIT');
      res.json({ ok: true, cobro });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { client.release(); }
  });

  app.post('/api/contador/cobros/anular', financeAccess, async (req, res, next) => {
    const kind = req.body?.kind === 'cobro' ? 'cobro' : req.body?.kind === 'consulta' ? 'consulta' : '';
    const id = Number(req.body?.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
    if (!kind || !Number.isSafeInteger(id) || id < 1 || !reason) {
      return res.status(400).json({ error: 'Selecciona un registro e indica el motivo de la anulación.' });
    }
    try {
      if (!(await checkNip(req.body?.authorizationNip))) {
        return res.status(403).json({ error: 'Clave del Contador incorrecta.' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('consultorio_contador_cobros'))");
        const now = new Date().toISOString();
        const user = req.session?.displayName || req.session?.username || 'Contador';
        if (kind === 'cobro') {
          const found = await client.query("SELECT data FROM app_records WHERE store='cobros' AND record_key=$1 FOR UPDATE", [String(id)]);
          if (!found.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'No se encontró el cobro.' });
          }
          const cobro = found.rows[0].data || {};
          if (cobro.status === 'pagado') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'No se puede anular un cobro que ya fue confirmado como pagado.' });
          }
          if (cobro.status === 'cancelado') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Este cobro ya fue anulado.' });
          }
          cobro.status = 'cancelado';
          cobro.anuladoAt = now;
          cobro.anuladoPor = user;
          cobro.motivoAnulacion = reason;
          cobro.audit = Array.isArray(cobro.audit) ? cobro.audit : [];
          cobro.audit.push({ fecha: now, accion: 'anulado_por_contador', usuario: user, motivo: reason });
          await client.query("UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='cobros' AND record_key=$1", [String(id), cobro]);
          if (cobro.consultaId != null) {
            const consultaResult = await client.query("SELECT data FROM app_records WHERE store='consultas' AND record_key=$1 FOR UPDATE", [String(cobro.consultaId)]);
            if (consultaResult.rowCount) {
              const consulta = consultaResult.rows[0].data || {};
              consulta.cobroRevisionAnuladaAt = now;
              consulta.cobroRevisionAnuladaPor = user;
              consulta.cobroRevisionMotivo = reason;
              await client.query("UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='consultas' AND record_key=$1", [String(cobro.consultaId), consulta]);
            }
          }
        } else {
          const found = await client.query("SELECT data FROM app_records WHERE store='consultas' AND record_key=$1 FOR UPDATE", [String(id)]);
          if (!found.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'No se encontró la consulta.' });
          }
          const consulta = found.rows[0].data || {};
          if (consulta.cobroId != null || consulta.cobroRevisionAnuladaAt) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Esta consulta ya tiene un cobro asociado o ya fue marcada como no cobrada.' });
          }
          const existing = await client.query("SELECT data FROM app_records WHERE store='cobros' AND data->>'consultaId'=$1 AND COALESCE(data->>'status','') <> 'cancelado' LIMIT 1", [String(id)]);
          if (existing.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'La consulta tiene un cobro asociado. Actualiza la lista e inténtalo desde el cobro pendiente.' });
          }
          consulta.cobroRevisionAnuladaAt = now;
          consulta.cobroRevisionAnuladaPor = user;
          consulta.cobroRevisionMotivo = reason;
          consulta.cobroRevisionEstado = 'no_cobrado_confirmado';
          await client.query("UPDATE app_records SET data=$2, updated_at=NOW() WHERE store='consultas' AND record_key=$1", [String(id), consulta]);
        }
        await client.query('COMMIT');
        res.json({ ok: true, message: 'Registro anulado y conservado en el historial.' });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    } catch (error) { next(error); }
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
        ['reversal', { originalId: id, originalType: original.rows[0].record_type, amount: Number(original.rows[0].data?.amount) || 0, originalDirection: original.rows[0].data?.direction || null, originalAccount: original.rows[0].data?.account || null, originalFromAccount: original.rows[0].data?.fromAccount || null, originalToAccount: original.rows[0].data?.toAccount || null, reason }, req.session?.displayName || req.session?.username || 'Administrador', id]
      );
      await pool.query('UPDATE contador_records SET reversed_at=NOW() WHERE id=$1', [id]);
      res.status(201).json(result.rows[0]);
    } catch (error) { next(error); }
  });
}

module.exports = { initContadorDb, registerContadorRoutes };
