const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';
const STORES = new Set(['medicos','pacientes','consultas','medicamentos','estudios','cobros','config']);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isProd ? { rejectUnauthorized: false } : false });
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!process.env.DATABASE_URL || !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.COBROS_NIP || !process.env.BALANCE_NIP || !SESSION_SECRET) {
  console.error('Faltan variables obligatorias: DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD, COBROS_NIP, BALANCE_NIP y SESSION_SECRET.');
  process.exit(1);
}
if (process.env.ADMIN_PASSWORD.length < 12) console.warn('Advertencia: usa una contraseña de administrador de al menos 12 caracteres.');

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_records (
    store TEXT NOT NULL,
    record_key TEXT NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (store, record_key)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS app_sequences (store TEXT PRIMARY KEY, next_id BIGINT NOT NULL)`);
  await pool.query('CREATE INDEX IF NOT EXISTS app_records_store_idx ON app_records(store)');
}
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex'); }
function createToken(username) {
  const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function getSession(req) {
  const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('cmcc_session='))?.slice('cmcc_session='.length);
  if (!token) return null;
  const parts = token.split('.'); if (parts.length !== 2) return null;
  const expected = Buffer.from(sign(parts[0])); const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try { const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); if (!payload.username || payload.exp < Date.now()) return null; return payload; } catch { return null; }
}
function requireAuth(req, res, next) { const session = getSession(req); if (!session) return res.status(401).json({ error: 'Sesión no válida. Inicia sesión nuevamente.' }); req.user = session.username; next(); }
function createFinanceToken(scope) { const payload = Buffer.from(JSON.stringify({ scope, exp: Date.now() + 30 * 60 * 1000 })).toString('base64url'); return `${payload}.${sign(payload)}`; }
function validFinanceToken(req, scope) { const cookieName = `cmcc_finance_${scope}=`; const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName))?.slice(cookieName.length); if (!token) return false; const parts=token.split('.'); if(parts.length!==2) return false; const a=Buffer.from(sign(parts[0])), b=Buffer.from(parts[1]); if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return false; try { const p=JSON.parse(Buffer.from(parts[0],'base64url').toString()); return p.scope===scope && p.exp>Date.now(); } catch { return false; } }
function requireFinanceWrite(req,res,next) { if (!validFinanceToken(req,'cobros')) return res.status(403).json({error:'Vuelve a validar el NIP de Cobros para modificar registros.'}); next(); }
function requireFinanceRead(req,res,next) { if (!validFinanceToken(req,'cobros') && !validFinanceToken(req,'balance')) return res.status(403).json({error:'Ingresa el NIP de Cobros o Balance para consultar los registros financieros.'}); next(); }
function validStore(store) { return STORES.has(store); }
function recordKey(store, data) { return store === 'config' ? String(data.key) : String(data.id); }

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos. Intenta más tarde.' } });
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const userOk = typeof username === 'string' && crypto.timingSafeEqual(Buffer.from(username.padEnd(256, '\0').slice(0,256)), Buffer.from(String(process.env.ADMIN_USERNAME).padEnd(256, '\0').slice(0,256)));
  const expected = Buffer.from(String(process.env.ADMIN_PASSWORD)); const supplied = Buffer.from(typeof password === 'string' ? password : '');
  const passOk = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  if (!userOk || !passOk) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  res.cookie('cmcc_session', createToken(process.env.ADMIN_USERNAME), { httpOnly: true, secure: isProd, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000, path: '/' });
  res.json({ username: process.env.ADMIN_USERNAME });
});
app.get('/api/auth/me', (req, res) => { const session = getSession(req); if (!session) return res.status(401).json({ error: 'No hay sesión activa.' }); res.json({ username: session.username }); });
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('cmcc_session', { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/' }); res.clearCookie('cmcc_finance_cobros', { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/' }); res.clearCookie('cmcc_finance_balance', { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/' }); res.json({ ok: true }); });
app.post('/api/auth/verify-nip', requireAuth, (req, res) => {
  const { tipo, nip } = req.body || {};
  const expected = tipo === 'cobros' ? process.env.COBROS_NIP : tipo === 'balance' ? process.env.BALANCE_NIP : null;
  if (!expected || typeof nip !== 'string') return res.status(400).json({ error: 'Solicitud inválida.' });
  const a = Buffer.from(expected); const b = Buffer.from(nip);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(403).json({ error: 'Código incorrecto.' });
  res.cookie(`cmcc_finance_${tipo}`, createFinanceToken(tipo), { httpOnly: true, secure: isProd, sameSite: 'strict', maxAge: 30 * 60 * 1000, path: '/' });
  res.json({ ok: true });
});

app.get('/api/dashboard/cobros-hoy', requireAuth, async (req,res,next) => {
  try { const fecha=String(req.query.fecha||''); if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({error:'Fecha inválida.'}); const result=await pool.query("SELECT data FROM app_records WHERE store='cobros'"); const cobros=result.rows.map(r=>r.data).filter(c=>c.fecha && String(c.fecha).startsWith(fecha) && c.status==='pagado'); const total=cobros.reduce((sum,c)=>sum+(Number.parseFloat(c.monto)||0),0); res.json({total,count:cobros.length}); } catch(e) { next(e); }
});
app.get('/api/data/:store', requireAuth, (req,res,next) => req.params.store === 'cobros' ? requireFinanceRead(req,res,next) : next(), async (req, res, next) => {
  try { const { store } = req.params; if (!validStore(store)) return res.status(404).json({ error: 'Módulo desconocido.' });
    const result = await pool.query('SELECT data FROM app_records WHERE store=$1 ORDER BY CASE WHEN data ? \'id\' THEN (data->>\'id\')::bigint ELSE 0 END, record_key', [store]);
    res.json(result.rows.map(r => r.data));
  } catch (e) { next(e); }
});
app.get('/api/data/:store/:id', requireAuth, (req,res,next) => req.params.store === 'cobros' ? requireFinanceRead(req,res,next) : next(), async (req, res, next) => {
  try { const { store, id } = req.params; if (!validStore(store)) return res.status(404).json({ error: 'Módulo desconocido.' });
    const result = await pool.query('SELECT data FROM app_records WHERE store=$1 AND record_key=$2', [store, id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Registro no encontrado.' }); res.json(result.rows[0].data);
  } catch (e) { next(e); }
});
app.post('/api/data/:store', requireAuth, (req,res,next) => req.params.store === 'cobros' ? requireFinanceWrite(req,res,next) : next(), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const store = req.params.store; if (!validStore(store)) return res.status(404).json({ error: 'Módulo desconocido.' });
    const data = req.body; if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Registro inválido.' });
    await client.query('BEGIN'); let value = { ...data };
    if (store !== 'config') {
      if (value.id == null) {
        const seq = await client.query(`INSERT INTO app_sequences(store,next_id) VALUES($1,1) ON CONFLICT(store) DO UPDATE SET next_id=app_sequences.next_id+1 RETURNING next_id`, [store]);
        value.id = Number(seq.rows[0].next_id);
      } else {
        const numericId = Number(value.id); if (!Number.isSafeInteger(numericId) || numericId < 1) throw Object.assign(new Error('ID inválido.'), { status: 400 });
        await client.query(`INSERT INTO app_sequences(store,next_id) VALUES($1,$2) ON CONFLICT(store) DO UPDATE SET next_id=GREATEST(app_sequences.next_id,$2)`, [store, numericId]);
      }
    } else if (typeof value.key !== 'string' || !value.key) return res.status(400).json({ error: 'Clave de configuración inválida.' });
    const key = recordKey(store, value);
    await client.query('INSERT INTO app_records(store,record_key,data) VALUES($1,$2,$3) ON CONFLICT(store,record_key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()', [store, key, value]);
    await client.query('COMMIT'); res.status(201).json(value);
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); next(e); } finally { client.release(); }
});
app.put('/api/data/:store/:id', requireAuth, (req,res,next) => req.params.store === 'cobros' ? requireFinanceWrite(req,res,next) : next(), async (req, res, next) => {
  try { const { store, id } = req.params; if (!validStore(store)) return res.status(404).json({ error: 'Módulo desconocido.' });
    const value = req.body; if (!value || typeof value !== 'object' || Array.isArray(value)) return res.status(400).json({ error: 'Registro inválido.' });
    if (store === 'config') value.key = id; else value.id = Number(id);
    const result = await pool.query('INSERT INTO app_records(store,record_key,data) VALUES($1,$2,$3) ON CONFLICT(store,record_key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW() RETURNING data', [store, id, value]); res.json(result.rows[0].data);
  } catch (e) { next(e); }
});
app.delete('/api/data/:store/:id', requireAuth, (req,res,next) => req.params.store === 'cobros' ? requireFinanceWrite(req,res,next) : next(), async (req, res, next) => {
  try { const { store, id } = req.params; if (!validStore(store)) return res.status(404).json({ error: 'Módulo desconocido.' });
    await pool.query('DELETE FROM app_records WHERE store=$1 AND record_key=$2', [store, id]); res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete('/api/data/:store', requireAuth, (req,res,next) => req.params.store === 'cobros' ? requireFinanceWrite(req,res,next) : next(), async (req, res, next) => {
  try { const { store } = req.params; if (!validStore(store)) return res.status(404).json({ error: 'Módulo desconocido.' }); await pool.query('DELETE FROM app_records WHERE store=$1', [store]); res.json({ ok: true }); }
  catch (e) { next(e); }
});

app.use((req,res,next) => { if (/^\/(server\.js|package(?:-lock)?\.json|README\.md|render\.yaml|\.env(?:\.example)?|\.gitignore)(?:$|\?)/i.test(req.path)) return res.sendStatus(404); next(); });
app.use(express.static(path.join(__dirname)));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use((err, _req, res, _next) => { console.error('Error de servidor:', err.message); res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno del servidor.' }); });
initDb().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Consultorio Médico CC escuchando en puerto ${PORT}`))).catch(err => { console.error('No se pudo inicializar PostgreSQL:', err.message); process.exit(1); });
