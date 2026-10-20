/* =====================================================
   Consultorio Médico CC - Aplicación principal
   ===================================================== */

const APP = {
  currentUser: null,
  currentModule: 'dashboard',
  editingId: null,
  tempConsulta: null, // for building consultation
  unlockedCobros: false,
  unlockedBalance: false
};

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await DB.openDB();
    setupEventListeners();
    await checkSession();
  } catch (err) {
    console.error('Error al iniciar:', err);
    alert('No se pudo conectar con el servicio web. Verifique la conexión o contacte al administrador.');
  }
});

async function checkSession() {
  const session = await DB.getSession();
  if (session && session.username) {
    APP.currentUser = session.username;
    document.querySelector('.topbar-actions .text-muted').textContent = session.username;
    try { await DB.seedIfEmpty(); } catch (e) { console.error('No se pudieron preparar catálogos:', e); }
    showApp();
  } else showLogin();
}

function setupEventListeners() {
  // Login
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const module = item.dataset.module;
      if (module) navigateTo(module);
    });
  });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Menu toggle (mobile)
  const toggle = document.getElementById('menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      document.querySelector('.sidebar').classList.toggle('open');
    });
  }

  // Backup buttons
  document.getElementById('btn-export')?.addEventListener('click', exportData);
  document.getElementById('btn-import')?.addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file')?.addEventListener('change', importData);
}

// ========== AUTH ==========
async function handleLogin(e) {
  e.preventDefault();
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const errorEl = document.getElementById('login-error');

  try {
    const session = await DB.login(user, pass);
    APP.currentUser = session.username;
    document.querySelector('.topbar-actions .text-muted').textContent = session.username;
    errorEl.style.display = 'none';
    await DB.seedIfEmpty();
    showApp();
  } catch (err) {
    errorEl.textContent = err.message || 'Usuario o contraseña incorrectos';
    errorEl.style.display = 'block';
  }
}

async function logout() {
  await DB.logout();
  APP.currentUser = null;
  APP.unlockedCobros = false;
  APP.unlockedBalance = false;
  showLogin();
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  navigateTo('dashboard');
}

// ========== NAVIGATION ==========
async function navigateTo(module) {
  // Check NIP for protected modules
  if (module === 'cobros' && !APP.unlockedCobros) {
    showNipModal('cobros');
    return;
  }
  if (module === 'balance' && !APP.unlockedBalance) {
    showNipModal('balance');
    return;
  }

  APP.currentModule = module;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  const active = document.querySelector(`.nav-item[data-module="${module}"]`);
  if (active) active.classList.add('active');

  // Title
  const titles = {
    dashboard: 'Dashboard',
    medicos: 'Médicos',
    pacientes: 'Pacientes y Expedientes',
    consultas: 'Consultas Médicas',
    medicamentos: 'Medicamentos',
    estudios: 'Estudios de Laboratorio',
    cobros: 'Cobros y Ventas del Día',
    balance: 'Balance General',
    respaldos: 'Respaldos y Configuración'
  };
  document.getElementById('page-title').textContent = titles[module] || module;

  // Load content
  const area = document.getElementById('content-area');
  area.innerHTML = '<div class="empty-state"><p>Cargando...</p></div>';

  try {
    switch (module) {
    
      case 'dashboard': await renderDashboard(); break;
      case 'medicos': await renderMedicos(); break;
      case 'pacientes': await renderPacientes(); break;
      case 'consultas': await renderConsultas(); break;
      case 'medicamentos': await renderMedicamentos(); break;
      case 'estudios': await renderEstudios(); break;
      case 'cobros': await renderCobros(); break;
      case 'balance': await renderBalance(); break;
      case 'respaldos': renderRespaldos(); break;
      case 'enfermeria': await renderEnfermeria(); break;
      default: area.innerHTML = '<p>Módulo no encontrado</p>';
    }
  } catch (err) {
    console.error(err);
    area.innerHTML = `<div class="alert alert-danger">Error al cargar el módulo: ${err.message}</div>`;
  }
}

// ========== NIP PROTECTION ==========
function showNipModal(tipo) {
  const overlay = document.getElementById('nip-overlay');
  const title = document.getElementById('nip-title');
  const desc = document.getElementById('nip-desc');
  const input = document.getElementById('nip-input');
  const error = document.getElementById('nip-error');

  title.textContent = tipo === 'cobros' ? 'Acceso a Cobros' : 'Acceso a Balance General';
  desc.textContent = tipo === 'cobros'
    ? 'Ingrese el NIP de Cobros y Laboratorios'
    : 'Ingrese el código de Balance General';
  input.value = '';
  error.style.display = 'none';
  overlay.dataset.tipo = tipo;
  overlay.classList.add('show');
  setTimeout(() => input.focus(), 100);
}

function closeNipModal() {
  document.getElementById('nip-overlay').classList.remove('show');
}

async function verifyNip() {
  const overlay = document.getElementById('nip-overlay');
  const tipo = overlay.dataset.tipo;
  const input = document.getElementById('nip-input').value.trim();
  const error = document.getElementById('nip-error');

  try { await DB.verifyNip(tipo, input);
    if (tipo === 'cobros') {
      APP.unlockedCobros = true;
    } else APP.unlockedBalance = true;
    closeNipModal();
    navigateTo(tipo);
  } catch (err) {
    error.textContent = err.message || 'Código incorrecto';
    error.style.display = 'block';
    document.getElementById('nip-input').value = '';
    document.getElementById('nip-input').focus();
  }
}

// ========== DASHBOARD ==========
async function renderDashboard() {
  const medicos = await DB.getAll(DB.STORES.medicos);
  const pacientes = await DB.getAll(DB.STORES.pacientes);
  const consultas = await DB.getAll(DB.STORES.consultas);
  const hoy = new Date().toISOString().slice(0, 10);
  const resumenCobros = await DB.getCobrosHoy(hoy);
  const totalHoy = Number(resumenCobros.total) || 0;

  const area = document.getElementById('content-area');
  area.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue">👨‍⚕️</div>
        <div class="stat-info">
          <h4>${medicos.filter(m => m.activo !== false).length}</h4>
          <p>Médicos activos</p>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green">👤</div>
        <div class="stat-info">
          <h4>${pacientes.length}</h4>
          <p>Pacientes registrados</p>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange">📋</div>
        <div class="stat-info">
          <h4>${consultas.length}</h4>
          <p>Consultas totales</p>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon purple">💰</div>
        <div class="stat-info">
          <h4>$${totalHoy.toFixed(2)}</h4>
          <p>Cobrado hoy</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Últimas consultas</h3>
      </div>
      <div class="card-body">
        ${consultas.length === 0
          ? '<div class="empty-state"><p>No hay consultas registradas aún.</p></div>'
          : `<div class="table-responsive"><table>
              <thead><tr><th>Fecha</th><th>Paciente</th><th>Médico</th><th>Motivo</th></tr></thead>
              <tbody>
                ${(await Promise.all(consultas.slice(-8).reverse().map(async c => {
                  const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
                  const m = await DB.get(DB.STORES.medicos, c.medicoId);
                  return `<tr>
                    <td>${formatDate(c.fecha)}</td>
                    <td>${p ? p.nombre : '—'}</td>
                    <td>${m ? m.nombre : '—'}</td>
                    <td>${escapeHtml(c.motivo || '—')}</td>
                  </tr>`;
                }))).join('')}
              </tbody>
            </table></div>`
        }
      </div>
    </div>
  `;
}

// ========== MÉDICOS ==========
async function renderMedicos() {
  const medicos = await DB.getAll(DB.STORES.medicos);
  const area = document.getElementById('content-area');

  area.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3>Listado de Médicos</h3>
        <button class="btn btn-primary btn-sm" onclick="openMedicoModal()">+ Nuevo Médico</button>
      </div>
      <div class="card-body">
        ${medicos.length === 0
          ? '<div class="empty-state"><div class="icon">👨‍⚕️</div><p>No hay médicos registrados.</p></div>'
          : `<div class="table-responsive"><table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Especialidad</th>
                  <th>Cédula</th>
                  <th>Teléfono</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                ${medicos.map(m => `
                  <tr>
                    <td><strong>${escapeHtml(m.nombre)}</strong></td>
                    <td>${escapeHtml(m.especialidad || '—')}</td>
                    <td>${escapeHtml(m.cedula || '—')}</td>
                    <td>${escapeHtml(m.telefono || '—')}</td>
                    <td>${m.activo === false ? '<span class="badge badge-secondary">Inactivo</span>' : '<span class="badge badge-success">Activo</span>'}</td>
                    <td>
                      <button class="btn btn-outline btn-sm" onclick="openMedicoModal(${m.id})">Editar</button>
                      ${m.activo !== false ? `<button class="btn btn-warning btn-sm" onclick="toggleMedico(${m.id}, false)">Baja</button>` : `<button class="btn btn-success btn-sm" onclick="toggleMedico(${m.id}, true)">Reactivar</button>`}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>`
        }
      </div>
    </div>
  `;
}

function openMedicoModal(id = null) {
  APP.editingId = id;
  const modal = document.getElementById('generic-modal');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = id ? 'Editar Médico' : 'Nuevo Médico';

  const load = async () => {
    let m = { nombre: '', especialidad: '', cedula: '', cedulaEsp: '', domicilio: '', telefono: '', activo: true };
    if (id) m = await DB.get(DB.STORES.medicos, id) || m;

    body.innerHTML = `
      <div class="form-row">
        <div class="form-group">
          <label>Nombre completo *</label>
          <input type="text" class="form-control" id="m-nombre" value="${escapeAttr(m.nombre)}" required>
        </div>
        <div class="form-group">
          <label>Especialidad</label>
          <input type="text" class="form-control" id="m-especialidad" value="${escapeAttr(m.especialidad || '')}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Cédula profesional *</label>
          <input type="text" class="form-control" id="m-cedula" value="${escapeAttr(m.cedula || '')}">
        </div>
        <div class="form-group">
          <label>Cédula de especialidad</label>
          <input type="text" class="form-control" id="m-cedulaEsp" value="${escapeAttr(m.cedulaEsp || '')}">
        </div>
      </div>
      <div class="form-group">
        <label>Domicilio del establecimiento</label>
        <input type="text" class="form-control" id="m-domicilio" value="${escapeAttr(m.domicilio || '')}">
      </div>
      <div class="form-group">
        <label>Teléfono</label>
        <input type="text" class="form-control" id="m-telefono" value="${escapeAttr(m.telefono || '')}">
      </div>
    `;

    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="saveMedico()">Guardar</button>
    `;
  };

  load();
  modal.classList.add('show');
}

async function saveMedico() {
  const nombre = document.getElementById('m-nombre').value.trim();
  if (!nombre) {
    alert('El nombre es obligatorio');
    return;
  }

  const data = {
    nombre,
    especialidad: document.getElementById('m-especialidad').value.trim(),
    cedula: document.getElementById('m-cedula').value.trim(),
    cedulaEsp: document.getElementById('m-cedulaEsp').value.trim(),
    domicilio: document.getElementById('m-domicilio').value.trim(),
    telefono: document.getElementById('m-telefono').value.trim(),
    activo: true
  };

  try {
    if (APP.editingId) {
      data.id = APP.editingId;
      // preserve activo
      const existing = await DB.get(DB.STORES.medicos, APP.editingId);
      if (existing) data.activo = existing.activo;
      await DB.put(DB.STORES.medicos, data);
    } else {
      await DB.add(DB.STORES.medicos, data);
    }
    closeModal();
    renderMedicos();
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
}

async function toggleMedico(id, activo) {
  const m = await DB.get(DB.STORES.medicos, id);
  if (!m) return;
  m.activo = activo;
  await DB.put(DB.STORES.medicos, m);
  renderMedicos();
}

// ========== PACIENTES ==========
async function renderPacientes() {
  const pacientes = await DB.getAll(DB.STORES.pacientes);
  const medicos = await DB.getAll(DB.STORES.medicos);
  const area = document.getElementById('content-area');

  const getMedicoName = (id) => {
    const m = medicos.find(x => x.id === id);
    return m ? m.nombre : '—';
  };

  area.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3>Pacientes y Expedientes</h3>
        <button class="btn btn-primary btn-sm" onclick="openPacienteModal()">+ Nuevo Paciente</button>
      </div>
      <div class="card-body">
        ${pacientes.length === 0
          ? '<div class="empty-state"><div class="icon">👤</div><p>No hay pacientes registrados.</p></div>'
          : `<div class="table-responsive"><table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Fecha nac.</th>
                  <th>Género</th>
                  <th>Teléfono</th>
                  <th>Médico</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                ${pacientes.map(p => `
                  <tr>
                    <td><strong>${escapeHtml(p.nombre)}</strong></td>
                    <td>${p.fechaNac || '—'}</td>
                    <td>${p.genero || '—'}</td>
                    <td>${escapeHtml(p.telefono || '—')}</td>
                    <td>${escapeHtml(getMedicoName(p.medicoId))}</td>
                    <td>
                      <button class="btn btn-outline btn-sm" onclick="openPacienteModal(${p.id})">Editar</button>
                      <button class="btn btn-danger btn-sm" onclick="deletePaciente(${p.id})">Eliminar</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>`
        }
      </div>
    </div>
  `;
}

function openPacienteModal(id = null) {
  APP.editingId = id;
  const modal = document.getElementById('generic-modal');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = id ? 'Editar Paciente' : 'Nuevo Paciente';

  const load = async () => {
    let p = { nombre: '', fechaNac: '', genero: '', telefono: '', direccion: '', medicoId: '' };
    if (id) p = await DB.get(DB.STORES.pacientes, id) || p;
    const medicos = (await DB.getAll(DB.STORES.medicos)).filter(m => m.activo !== false);

    body.innerHTML = `
      <div class="form-row">
        <div class="form-group">
          <label>Nombre completo *</label>
          <input type="text" class="form-control" id="p-nombre" value="${escapeAttr(p.nombre)}" required>
        </div>
        <div class="form-group">
          <label>Fecha de nacimiento</label>
          <input type="date" class="form-control" id="p-fechaNac" value="${p.fechaNac || ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Género</label>
          <select class="form-control" id="p-genero">
            <option value="">—</option>
            <option value="Masculino" ${p.genero === 'Masculino' ? 'selected' : ''}>Masculino</option>
            <option value="Femenino" ${p.genero === 'Femenino' ? 'selected' : ''}>Femenino</option>
            <option value="Otro" ${p.genero === 'Otro' ? 'selected' : ''}>Otro</option>
          </select>
        </div>
        <div class="form-group">
          <label>Teléfono</label>
          <input type="text" class="form-control" id="p-telefono" value="${escapeAttr(p.telefono || '')}">
        </div>
      </div>
      <div class="form-group">
        <label>Dirección</label>
        <input type="text" class="form-control" id="p-direccion" value="${escapeAttr(p.direccion || '')}">
      </div>
      <div class="form-group">
        <label>Médico asignado</label>
        <select class="form-control" id="p-medicoId">
          <option value="">— Sin asignar —</option>
          ${medicos.map(m => `<option value="${m.id}" ${p.medicoId == m.id ? 'selected' : ''}>${escapeHtml(m.nombre)}</option>`).join('')}
        </select>
      </div>
    `;

    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="savePaciente()">Guardar</button>
    `;
  };

  load();
  modal.classList.add('show');
}

async function savePaciente() {
  const nombre = document.getElementById('p-nombre').value.trim();
  if (!nombre) {
    alert('El nombre es obligatorio');
    return;
  }

  const data = {
    nombre,
    fechaNac: document.getElementById('p-fechaNac').value,
    genero: document.getElementById('p-genero').value,
    telefono: document.getElementById('p-telefono').value.trim(),
    direccion: document.getElementById('p-direccion').value.trim(),
    medicoId: document.getElementById('p-medicoId').value ? parseInt(document.getElementById('p-medicoId').value) : null
  };

  try {
    if (APP.editingId) {
      data.id = APP.editingId;
      await DB.put(DB.STORES.pacientes, data);
    } else {
      await DB.add(DB.STORES.pacientes, data);
    }
    closeModal();
    renderPacientes();
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
}

async function deletePaciente(id) {
  if (!confirm('¿Eliminar este paciente? Esta acción no se puede deshacer.')) return;
  await DB.remove(DB.STORES.pacientes, id);
  renderPacientes();
}

// ========== CONSULTAS ==========
async function renderConsultas() {
  const consultas = await DB.getAll(DB.STORES.consultas);
  const area = document.getElementById('content-area');

  area.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3>Consultas Médicas</h3>
        <button class="btn btn-primary btn-sm" onclick="openConsultaModal()">+ Nueva Consulta</button>
      </div>
      <div class="card-body">
        ${consultas.length === 0
          ? '<div class="empty-state"><div class="icon">📋</div><p>No hay consultas registradas.</p></div>'
          : `<div class="table-responsive"><table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Paciente</th>
                  <th>Médico</th>
                  <th>Motivo</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                ${(await Promise.all(consultas.slice().reverse().map(async c => {
                  const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
                  const m = await DB.get(DB.STORES.medicos, c.medicoId);
                  return `<tr>
                    <td>${formatDate(c.fecha)}</td>
                    <td>${p ? escapeHtml(p.nombre) : '—'}</td>
                    <td>${m ? escapeHtml(m.nombre) : '—'}</td>
                    <td>${escapeHtml((c.motivo || '').substring(0, 50))}${(c.motivo || '').length > 50 ? '…' : ''}</td>
                    <td>
                      <button class="btn btn-outline btn-sm" onclick="verConsulta(${c.id})">Ver</button>
                      <button class="btn btn-primary btn-sm" onclick="imprimirReceta(${c.id})">Receta</button>
                    </td>
                  </tr>`;
                }))).join('')}
              </tbody>
            </table></div>`
        }
      </div>
    </div>
  `;
}

function openConsultaModal() {
  APP.editingId = null;
  APP.tempConsulta = {
    medicamentos: [],
    estudios: [],
    signos: { ta: '', fc: '', fr: '', temp: '', peso: '', talla: '', spo2: '' }
  };

  const modal = document.getElementById('generic-modal');
  modal.querySelector('.modal').classList.add('modal-lg');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = 'Nueva Consulta Médica';

  const load = async () => {
    const pacientes = await DB.getAll(DB.STORES.pacientes);
    const medicos = (await DB.getAll(DB.STORES.medicos)).filter(m => m.activo !== false);
    const meds = await DB.getAll(DB.STORES.medicamentos);
    const ests = await DB.getAll(DB.STORES.estudios);

    body.innerHTML = `
      <div class="form-row">
        <div class="form-group">
          <label>Paciente *</label>
          <select class="form-control" id="c-pacienteId" required>
            <option value="">— Seleccione —</option>
            ${pacientes.map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Médico *</label>
          <select class="form-control" id="c-medicoId" required>
            <option value="">— Seleccione —</option>
            ${medicos.map(m => `<option value="${m.id}">${escapeHtml(m.nombre)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="form-group">
        <label>Motivo de consulta *</label>
        <textarea class="form-control" id="c-motivo" rows="2"></textarea>
      </div>

      <div class="form-group">
        <label>Interrogatorio y antecedentes</label>
        <textarea class="form-control" id="c-interrogatorio" rows="2"></textarea>
      </div>

      <div class="form-group">
        <label>Cuadro clínico</label>
        <textarea class="form-control" id="c-cuadro" rows="2"></textarea>
      </div>

      <div class="form-group">
        <label>Exploración física</label>
        <textarea class="form-control" id="c-exploracion" rows="2"></textarea>
      </div>

      <div class="form-group">
        <label>Tratamiento / Plan</label>
        <textarea class="form-control" id="c-tratamiento" rows="2"></textarea>
      </div>

      <h4 style="margin:1.25rem 0 0.75rem; font-size:1rem;">Signos vitales (obligatorios antes de finalizar)</h4>
      <div class="form-row">
        <div class="form-group">
          <label>T.A. (mmHg)</label>
          <input type="text" class="form-control" id="sv-ta" placeholder="120/80">
        </div>
        <div class="form-group">
          <label>F.C. (lpm)</label>
          <input type="text" class="form-control" id="sv-fc" placeholder="72">
        </div>
        <div class="form-group">
          <label>F.R. (rpm)</label>
          <input type="text" class="form-control" id="sv-fr" placeholder="16">
        </div>
        <div class="form-group">
          <label>Temp. (°C)</label>
          <input type="text" class="form-control" id="sv-temp" placeholder="36.5">
        </div>
        <div class="form-group">
          <label>Peso (kg)</label>
          <input type="text" class="form-control" id="sv-peso" placeholder="70">
        </div>
        <div class="form-group">
          <label>Talla (cm)</label>
          <input type="text" class="form-control" id="sv-talla" placeholder="170">
        </div>
        <div class="form-group">
          <label>SpO2 (%)</label>
          <input type="text" class="form-control" id="sv-spo2" placeholder="98">
        </div>
      </div>

      <h4 style="margin:1.25rem 0 0.75rem; font-size:1rem;">Medicamentos prescritos</h4>
      <div id="meds-list"></div>
      <div class="form-row" style="align-items:end;">
        <div class="form-group">
          <label>Medicamento</label>
          <select class="form-control" id="add-med-id">
            <option value="">— Seleccione —</option>
            ${meds.map(m => `<option value="${m.id}">${escapeHtml(m.nombre)} ${m.concentracion || ''}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Dosis</label>
          <input type="text" class="form-control" id="add-med-dosis" placeholder="1 tableta">
        </div>
        <div class="form-group">
          <label>Vía</label>
          <input type="text" class="form-control" id="add-med-via" placeholder="Oral">
        </div>
        <div class="form-group">
          <label>Frecuencia</label>
          <input type="text" class="form-control" id="add-med-freq" placeholder="Cada 8 hrs">
        </div>
        <div class="form-group">
          <label>Duración</label>
          <input type="text" class="form-control" id="add-med-dur" placeholder="5 días">
        </div>
        <div class="form-group">
          <button type="button" class="btn btn-outline" onclick="addMedToConsulta()">Agregar</button>
        </div>
      </div>

      <h4 style="margin:1.25rem 0 0.75rem; font-size:1rem;">Estudios de laboratorio indicados</h4>
      <div id="ests-list"></div>
      <div class="form-row" style="align-items:end;">
        <div class="form-group" style="flex:2;">
          <label>Estudio</label>
          <select class="form-control" id="add-est-id">
            <option value="">— Seleccione —</option>
            ${ests.map(e => `<option value="${e.id}">${escapeHtml(e.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <button type="button" class="btn btn-outline" onclick="addEstToConsulta()">Agregar</button>
        </div>
      </div>

      <div class="form-group mt-2">
        <label>Próxima cita</label>
        <input type="date" class="form-control" id="c-proxima">
      </div>
    `;

    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="saveConsulta()">Guardar Consulta</button>
    `;

    renderTempMeds();
    renderTempEsts();
  };

  load();
  modal.classList.add('show');
}

function addMedToConsulta() {
  const id = document.getElementById('add-med-id').value;
  if (!id) return;
  const meds = APP.tempConsulta.medicamentos;
  // prevent duplicates by id
  if (meds.find(m => m.medicamentoId == id)) {
    alert('Este medicamento ya está agregado');
    return;
  }
  meds.push({
    medicamentoId: parseInt(id),
    dosis: document.getElementById('add-med-dosis').value.trim() || '—',
    via: document.getElementById('add-med-via').value.trim() || 'Oral',
    frecuencia: document.getElementById('add-med-freq').value.trim() || '—',
    duracion: document.getElementById('add-med-dur').value.trim() || '—'
  });
  document.getElementById('add-med-dosis').value = '';
  document.getElementById('add-med-via').value = '';
  document.getElementById('add-med-freq').value = '';
  document.getElementById('add-med-dur').value = '';
  renderTempMeds();
}

function removeMedFromConsulta(idx) {
  APP.tempConsulta.medicamentos.splice(idx, 1);
  renderTempMeds();
}

async function renderTempMeds() {
  const list = document.getElementById('meds-list');
  if (!list) return;
  const allMeds = await DB.getAll(DB.STORES.medicamentos);
  if (APP.tempConsulta.medicamentos.length === 0) {
    list.innerHTML = '<p class="text-muted" style="font-size:0.9rem;">Ningún medicamento agregado.</p>';
    return;
  }
  list.innerHTML = `<ul style="list-style:none; padding:0;">
    ${APP.tempConsulta.medicamentos.map((m, i) => {
      const med = allMeds.find(x => x.id === m.medicamentoId);
      return `<li style="padding:0.4rem 0; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
        <span><strong>${med ? escapeHtml(med.nombre) : '—'}</strong> ${m.dosis} · ${m.via} · ${m.frecuencia} · ${m.duracion}</span>
        <button class="btn btn-danger btn-sm" onclick="removeMedFromConsulta(${i})">×</button>
      </li>`;
    }).join('')}
  </ul>`;
}

function addEstToConsulta() {
  const id = document.getElementById('add-est-id').value;
  if (!id) return;
  if (APP.tempConsulta.estudios.find(e => e == id)) {
    alert('Este estudio ya está agregado');
    return;
  }
  APP.tempConsulta.estudios.push(parseInt(id));
  renderTempEsts();
}

function removeEstFromConsulta(idx) {
  APP.tempConsulta.estudios.splice(idx, 1);
  renderTempEsts();
}

async function renderTempEsts() {
  const list = document.getElementById('ests-list');
  if (!list) return;
  const allEsts = await DB.getAll(DB.STORES.estudios);
  if (APP.tempConsulta.estudios.length === 0) {
    list.innerHTML = '<p class="text-muted" style="font-size:0.9rem;">Ningún estudio agregado.</p>';
    return;
  }
  list.innerHTML = `<ul style="list-style:none; padding:0;">
    ${APP.tempConsulta.estudios.map((id, i) => {
      const e = allEsts.find(x => x.id === id);
      return `<li style="padding:0.4rem 0; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
        <span>${e ? escapeHtml(e.nombre) : '—'}</span>
        <button class="btn btn-danger btn-sm" onclick="removeEstFromConsulta(${i})">×</button>
      </li>`;
    }).join('')}
  </ul>`;
}

async function saveConsulta() {
  const pacienteId = document.getElementById('c-pacienteId').value;
  const medicoId = document.getElementById('c-medicoId').value;
  const motivo = document.getElementById('c-motivo').value.trim();

  if (!pacienteId || !medicoId || !motivo) {
    alert('Paciente, médico y motivo de consulta son obligatorios.');
    return;
  }

  // Signos vitales obligatorios
  const ta = document.getElementById('sv-ta').value.trim();
  const fc = document.getElementById('sv-fc').value.trim();
  const fr = document.getElementById('sv-fr').value.trim();
  const temp = document.getElementById('sv-temp').value.trim();

  if (!ta || !fc || !fr || !temp) {
    alert('Debe registrar al menos T.A., F.C., F.R. y Temperatura antes de finalizar la consulta.');
    return;
  }

  const data = {
    pacienteId: parseInt(pacienteId),
    medicoId: parseInt(medicoId),
    fecha: new Date().toISOString(),
    motivo,
    interrogatorio: document.getElementById('c-interrogatorio').value.trim(),
    cuadroClinico: document.getElementById('c-cuadro').value.trim(),
    exploracion: document.getElementById('c-exploracion').value.trim(),
    tratamiento: document.getElementById('c-tratamiento').value.trim(),
    signosVitales: {
      ta,
      fc,
      fr,
      temp,
      peso: document.getElementById('sv-peso').value.trim(),
      talla: document.getElementById('sv-talla').value.trim(),
      spo2: document.getElementById('sv-spo2').value.trim()
    },
    medicamentos: APP.tempConsulta.medicamentos,
    estudios: APP.tempConsulta.estudios,
    proximaCita: document.getElementById('c-proxima').value || null
  };

  try {
    await DB.add(DB.STORES.consultas, data);
    closeModal();
    document.querySelector('.modal').classList.remove('modal-lg');
    renderConsultas();
    alert('Consulta guardada correctamente.');
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
}

async function verConsulta(id) {
  const c = await DB.get(DB.STORES.consultas, id);
  if (!c) return;
  const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
  const m = await DB.get(DB.STORES.medicos, c.medicoId);
  const allMeds = await DB.getAll(DB.STORES.medicamentos);
  const allEsts = await DB.getAll(DB.STORES.estudios);

  const medsHtml = (c.medicamentos || []).map(med => {
    const item = allMeds.find(x => x.id === med.medicamentoId);
    return `<li>${item ? item.nombre : '—'} — ${med.dosis}, ${med.via}, ${med.frecuencia}, ${med.duracion}</li>`;
  }).join('') || '<li>Ninguno</li>';

  const estsHtml = (c.estudios || []).map(eid => {
    const item = allEsts.find(x => x.id === eid);
    return `<li>${item ? item.nombre : '—'}</li>`;
  }).join('') || '<li>Ninguno</li>';

  const sv = c.signosVitales || {};

  const modal = document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent = 'Detalle de Consulta';
  document.getElementById('modal-body').innerHTML = `
    <p><strong>Fecha:</strong> ${formatDate(c.fecha)}</p>
    <p><strong>Paciente:</strong> ${p ? escapeHtml(p.nombre) : '—'}</p>
    <p><strong>Médico:</strong> ${m ? escapeHtml(m.nombre) : '—'}</p>
    <p><strong>Motivo:</strong> ${escapeHtml(c.motivo || '—')}</p>
    <p><strong>Interrogatorio:</strong> ${escapeHtml(c.interrogatorio || '—')}</p>
    <p><strong>Cuadro clínico:</strong> ${escapeHtml(c.cuadroClinico || '—')}</p>
    <p><strong>Exploración:</strong> ${escapeHtml(c.exploracion || '—')}</p>
    <p><strong>Tratamiento:</strong> ${escapeHtml(c.tratamiento || '—')}</p>
    <p><strong>Signos vitales:</strong><br>
      T.A.: ${sv.ta || '—'} | F.C.: ${sv.fc || '—'} | F.R.: ${sv.fr || '—'} | Temp: ${sv.temp || '—'}<br>
      Peso: ${sv.peso || '—'} kg | Talla: ${sv.talla || '—'} cm | SpO2: ${sv.spo2 || '—'}%
    </p>
    <p><strong>Medicamentos:</strong></p>
    <ul>${medsHtml}</ul>
    <p><strong>Estudios:</strong></p>
    <ul>${estsHtml}</ul>
    <p><strong>Próxima cita:</strong> ${c.proximaCita || '—'}</p>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal()">Cerrar</button>
    <button class="btn btn-primary" onclick="imprimirReceta(${id}); closeModal();">Imprimir Receta</button>
  `;
  modal.classList.add('show');
}

// ========== MEDICAMENTOS ==========
async function renderMedicamentos() {
  const meds = await DB.getAll(DB.STORES.medicamentos);
  const area = document.getElementById('content-area');

  area.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3>Catálogo de Medicamentos</h3>
        <button class="btn btn-primary btn-sm" onclick="openMedicamentoModal()">+ Nuevo Medicamento</button>
      </div>
      <div class="card-body">
        ${meds.length === 0
          ? '<div class="empty-state"><p>No hay medicamentos en el catálogo.</p></div>'
          : `<div class="table-responsive"><table>
              <thead><tr><th>Nombre</th><th>Presentación</th><th>Concentración</th><th>Acciones</th></tr></thead>
              <tbody>
                ${meds.map(m => `
                  <tr>
                    <td><strong>${escapeHtml(m.nombre)}</strong></td>
                    <td>${escapeHtml(m.presentacion || '—')}</td>
                    <td>${escapeHtml(m.concentracion || '—')}</td>
                    <td>
                      <button class="btn btn-outline btn-sm" onclick="openMedicamentoModal(${m.id})">Editar</button>
                      <button class="btn btn-danger btn-sm" onclick="deleteMedicamento(${m.id})">Eliminar</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>`
        }
      </div>
    </div>
  `;
}

function openMedicamentoModal(id = null) {
  APP.editingId = id;
  const modal = document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent = id ? 'Editar Medicamento' : 'Nuevo Medicamento';

  const load = async () => {
    let m = { nombre: '', presentacion: '', concentracion: '' };
    if (id) m = await DB.get(DB.STORES.medicamentos, id) || m;

    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>Nombre *</label>
        <input type="text" class="form-control" id="med-nombre" value="${escapeAttr(m.nombre)}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Presentación</label>
          <input type="text" class="form-control" id="med-presentacion" value="${escapeAttr(m.presentacion || '')}" placeholder="Tabletas, Cápsulas, etc.">
        </div>
        <div class="form-group">
          <label>Concentración</label>
          <input type="text" class="form-control" id="med-concentracion" value="${escapeAttr(m.concentracion || '')}" placeholder="500 mg">
        </div>
      </div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="saveMedicamento()">Guardar</button>
    `;
  };
  load();
  modal.classList.add('show');
}

async function saveMedicamento() {
  const nombre = document.getElementById('med-nombre').value.trim();
  if (!nombre) { alert('El nombre es obligatorio'); return; }
  const data = {
    nombre,
    presentacion: document.getElementById('med-presentacion').value.trim(),
    concentracion: document.getElementById('med-concentracion').value.trim()
  };
  try {
    if (APP.editingId) {
      data.id = APP.editingId;
      await DB.put(DB.STORES.medicamentos, data);
    } else {
      await DB.add(DB.STORES.medicamentos, data);
    }
    closeModal();
    renderMedicamentos();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteMedicamento(id) {
  if (!confirm('¿Eliminar este medicamento del catálogo?')) return;
  await DB.remove(DB.STORES.medicamentos, id);
  renderMedicamentos();
}

// ========== ESTUDIOS ==========
async function renderEstudios() {
  const ests = await DB.getAll(DB.STORES.estudios);
  const area = document.getElementById('content-area');

  area.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3>Catálogo de Estudios de Laboratorio</h3>
        <button class="btn btn-primary btn-sm" onclick="openEstudioModal()">+ Nuevo Estudio</button>
      </div>
      <div class="card-body">
        ${ests.length === 0
          ? '<div class="empty-state"><p>No hay estudios en el catálogo.</p></div>'
          : `<div class="table-responsive"><table>
              <thead><tr><th>Nombre</th><th>Precio</th><th>Acciones</th></tr></thead>
              <tbody>
                ${ests.map(e => `
                  <tr>
                    <td><strong>${escapeHtml(e.nombre)}</strong></td>
                    <td>$${parseFloat(e.precio || 0).toFixed(2)}</td>
                    <td>
                      <button class="btn btn-outline btn-sm" onclick="openEstudioModal(${e.id})">Editar</button>
                      <button class="btn btn-danger btn-sm" onclick="deleteEstudio(${e.id})">Eliminar</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table></div>`
        }
      </div>
    </div>
  `;
}

function openEstudioModal(id = null) {
  APP.editingId = id;
  const modal = document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent = id ? 'Editar Estudio' : 'Nuevo Estudio';

  const load = async () => {
    let e = { nombre: '', precio: 0 };
    if (id) e = await DB.get(DB.STORES.estudios, id) || e;

    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>Nombre del estudio *</label>
        <input type="text" class="form-control" id="est-nombre" value="${escapeAttr(e.nombre)}">
      </div>
      <div class="form-group">
        <label>Precio</label>
        <input type="number" step="0.01" class="form-control" id="est-precio" value="${e.precio || 0}">
      </div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="saveEstudio()">Guardar</button>
    `;
  };
  load();
  modal.classList.add('show');
}

async function saveEstudio() {
  const nombre = document.getElementById('est-nombre').value.trim();
  if (!nombre) { alert('El nombre es obligatorio'); return; }
  const data = {
    nombre,
    precio: parseFloat(document.getElementById('est-precio').value) || 0
  };
  try {
    if (APP.editingId) {
      data.id = APP.editingId;
      await DB.put(DB.STORES.estudios, data);
    } else {
      await DB.add(DB.STORES.estudios, data);
    }
    closeModal();
    renderEstudios();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteEstudio(id) {
  if (!confirm('¿Eliminar este estudio del catálogo?')) return;
  await DB.remove(DB.STORES.estudios, id);
  renderEstudios();
}

 // ========== COBROS ==========
async function renderCobros() {
  const cobros = await DB.getAll(DB.STORES.cobros);
  const area = document.getElementById('content-area');

  // Fecha de hoy en la zona horaria local.
  const ahora = new Date();
  const hoy = [
    ahora.getFullYear(),
    String(ahora.getMonth() + 1).padStart(2, '0'),
    String(ahora.getDate()).padStart(2, '0')
  ].join('-');

  // Mostrar únicamente los cobros correspondientes al día local.
  const delDia = cobros.filter(c => {
    if (!c.fecha) return false;

    const fechaCobro = new Date(c.fecha);
    if (Number.isNaN(fechaCobro.getTime())) return false;

    const fechaLocal = [
      fechaCobro.getFullYear(),
      String(fechaCobro.getMonth() + 1).padStart(2, '0'),
      String(fechaCobro.getDate()).padStart(2, '0')
    ].join('-');

    return fechaLocal === hoy;
  });

  const totalPagado = delDia
    .filter(c => c.status === 'pagado')
    .reduce((s, c) => s + (parseFloat(c.monto) || 0), 0);

  const totalPendiente = delDia
    .filter(c => c.status === 'pendiente')
    .reduce((s, c) => s + (parseFloat(c.monto) || 0), 0);

  area.innerHTML = `
    <div class="stats-grid" style="margin-bottom:1.25rem;">
      <div class="stat-card">
        <div class="stat-icon green">💵</div>
        <div class="stat-info">
          <h4>$${totalPagado.toFixed(2)}</h4>
          <p>Pagado hoy</p>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange">⏳</div>
        <div class="stat-info">
          <h4>$${totalPendiente.toFixed(2)}</h4>
          <p>Pendiente hoy</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Cobros del día (${formatDate(hoy)})</h3>
        <button class="btn btn-primary btn-sm"
          onclick="openCobroModal()">+ Nuevo Cobro</button>
      </div>

      <div class="card-body">
        ${delDia.length === 0
          ? '<div class="empty-state"><p>No hay cobros registrados hoy.</p></div>'
          : `<div class="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Concepto</th>
                    <th>Paciente / Ref.</th>
                    <th>Monto</th>
                    <th>Tipo</th>
                    <th>Estatus</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  ${delDia.map(c => `
                    <tr>
                      <td>${c.fecha
                        ? new Date(c.fecha).toLocaleTimeString('es-MX', {
                            hour: '2-digit',
                            minute: '2-digit'
                          })
                        : '—'}</td>

                      <td>${escapeHtml(c.concepto || '—')}</td>
                      <td>${escapeHtml(c.referencia || '—')}</td>
                      <td><strong>$${(parseFloat(c.monto) || 0).toFixed(2)}</strong></td>

                      <td>${c.tipo === 'laboratorio'
                        ? '<span class="badge badge-info">Lab</span>'
                        : '<span class="badge badge-secondary">Médico</span>'}</td>

                      <td>${c.status === 'pagado'
                        ? '<span class="badge badge-success">Pagado</span>'
                        : '<span class="badge badge-warning">Pendiente</span>'}</td>

                      <td>
                        <button class="btn btn-outline btn-sm"
                          onclick="openCobroModal(${c.id})">Editar</button>

                       ${c.status === 'pendiente'
  ? `<button class="btn btn-success btn-sm"
      onclick="marcarPagado(${c.id})">Marcar pagado</button>`
  : ''}

<button class="btn btn-danger btn-sm"
  onclick="eliminarCobro(${c.id})">Eliminar</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>`
        }
      </div>
    </div>
  `;
}


async function eliminarCobro(id) {
  const confirmar = confirm(
    '¿Estás seguro de eliminar este cobro? ' +
    'Esta acción puede afectar el balance.'
  );

  if (!confirmar) return;

  try {
    await DB.remove(DB.STORES.cobros, id);
    alert('Cobro eliminado correctamente.');
    await renderCobros();
  } catch (error) {
    console.error('Error al eliminar el cobro:', error);
    alert('No se pudo eliminar el cobro. Intenta nuevamente.');
  }
}

function openCobroModal(id = null) {
  APP.editingId = id;
  const modal = document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent = id ? 'Editar Cobro' : 'Nuevo Cobro';

  const load = async () => {
    let c = { concepto: '', referencia: '', monto: '', tipo: 'medico', status: 'pagado', medicoId: null };
    if (id) c = await DB.get(DB.STORES.cobros, id) || c;
    const medicos = (await DB.getAll(DB.STORES.medicos)).filter(m => m.activo !== false);

    document.getElementById('modal-body').innerHTML = `
      <div class="form-group">
        <label>Concepto *</label>
        <input type="text" class="form-control" id="cob-concepto" value="${escapeAttr(c.concepto || '')}" placeholder="Consulta, Estudio, etc.">
      </div>
      <div class="form-group">
        <label>Paciente / Referencia</label>
        <input type="text" class="form-control" id="cob-referencia" value="${escapeAttr(c.referencia || '')}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Monto *</label>
          <input type="number" step="0.01" class="form-control" id="cob-monto" value="${c.monto || ''}">
        </div>
        <div class="form-group">
          <label>Tipo</label>
          <select class="form-control" id="cob-tipo">
            <option value="medico" ${c.tipo === 'medico' ? 'selected' : ''}>Médico</option>
            <option value="laboratorio" ${c.tipo === 'laboratorio' ? 'selected' : ''}>Laboratorio</option>
          </select>
        </div>
        <div class="form-group">
          <label>Estatus</label>
          <select class="form-control" id="cob-status">
            <option value="pagado" ${c.status === 'pagado' ? 'selected' : ''}>Pagado</option>
            <option value="pendiente" ${c.status === 'pendiente' ? 'selected' : ''}>Pendiente</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Médico (opcional)</label>
        <select class="form-control" id="cob-medicoId">
          <option value="">—</option>
          ${medicos.map(m => `<option value="${m.id}" ${c.medicoId == m.id ? 'selected' : ''}>${escapeHtml(m.nombre)}</option>`).join('')}
        </select>
      </div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="saveCobro()">Guardar</button>
    `;
  };
  load();
  modal.classList.add('show');
}

async function saveCobro() {
  const concepto = document.getElementById('cob-concepto').value.trim();
  const monto = parseFloat(document.getElementById('cob-monto').value);
  if (!concepto || isNaN(monto)) {
    alert('Concepto y monto son obligatorios');
    return;
  }

  const data = {
    concepto,
    referencia: document.getElementById('cob-referencia').value.trim(),
    monto,
    tipo: document.getElementById('cob-tipo').value,
    status: document.getElementById('cob-status').value,
    medicoId: document.getElementById('cob-medicoId').value ? parseInt(document.getElementById('cob-medicoId').value) : null,
    fecha: new Date().toISOString(),
    audit: []
  };

  try {
    if (APP.editingId) {
      const existing = await DB.get(DB.STORES.cobros, APP.editingId);
      data.id = APP.editingId;
      data.fecha = existing.fecha; // keep original date
      data.audit = existing.audit || [];
      data.audit.push({
        fecha: new Date().toISOString(),
        accion: 'modificación',
        anterior: { monto: existing.monto, status: existing.status, concepto: existing.concepto }
      });
      await DB.put(DB.STORES.cobros, data);
    } else {
      await DB.add(DB.STORES.cobros, data);
    }
    closeModal();
    renderCobros();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function marcarPagado(id) {
  const c = await DB.get(DB.STORES.cobros, id);
  if (!c) return;
  c.status = 'pagado';
  c.audit = c.audit || [];
  c.audit.push({ fecha: new Date().toISOString(), accion: 'marcado_pagado' });
  await DB.put(DB.STORES.cobros, c);
  renderCobros();
}

// ========== BALANCE ==========
async function renderBalance() {
  const cobros = await DB.getAll(DB.STORES.cobros);
  const medicos = await DB.getAll(DB.STORES.medicos);
  const pagados = cobros.filter(c => c.status === 'pagado');

  const totalMedico = pagados
    .filter(c => c.tipo === 'medico')
    .reduce((s, c) => s + (parseFloat(c.monto) || 0), 0);

  const totalLab = pagados
    .filter(c => c.tipo === 'laboratorio')
    .reduce((s, c) => s + (parseFloat(c.monto) || 0), 0);

  const total = totalMedico + totalLab;
  const porMedico = {};

  pagados.forEach(c => {
    const key = c.medicoId || 'sin_medico';
    if (!porMedico[key]) porMedico[key] = 0;
    porMedico[key] += parseFloat(c.monto) || 0;
  });

  const area = document.getElementById('content-area');

  const cobrosOrdenados = cobros.slice().sort((a, b) =>
    new Date(b.fecha || 0).getTime() - new Date(a.fecha || 0).getTime()
  );

  const filasCobros = cobrosOrdenados.map(c => {
    const estatus = c.status === 'pagado'
      ? '<span class="badge badge-success">Pagado</span>'
      : c.status === 'cancelado'
        ? '<span class="badge badge-danger">Cancelado</span>'
        : '<span class="badge badge-warning">Pendiente</span>';

    const medico = medicos.find(m => m.id == c.medicoId);
    const nombreMedico = medico ? escapeHtml(medico.nombre) : '—';

    return `
      <tr>
        <td>${c.fecha ? new Date(c.fecha).toLocaleString('es-MX') : '—'}</td>
        <td>${escapeHtml(c.concepto || '—')}</td>
        <td>${escapeHtml(c.referencia || '—')}</td>
        <td>${c.tipo === 'laboratorio' ? 'Laboratorio' : 'Médico'}</td>
        <td>${nombreMedico}</td>
        <td><strong>$${(parseFloat(c.monto) || 0).toFixed(2)}</strong></td>
        <td>${estatus}</td>
        <td>
          <button class="btn btn-outline btn-sm"
            onclick="openCobroModal(${Number(c.id)})">Editar</button>
          ${c.status !== 'cancelado'
            ? `<button class="btn btn-danger btn-sm"
                onclick="cancelarCobro(${Number(c.id)})">Cancelar</button>`
            : ''}
        </td>
      </tr>
    `;
  }).join('');

  const auditorias = [];
  cobros.forEach(c => {
    (c.audit || []).forEach(a => {
      auditorias.push({
        ...a,
        cobroId: c.id,
        concepto: c.concepto
      });
    });
  });

  auditorias.sort((a, b) =>
    new Date(b.fecha || 0).getTime() - new Date(a.fecha || 0).getTime()
  );

  area.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue">👨‍⚕️</div>
        <div class="stat-info">
          <h4>$${totalMedico.toFixed(2)}</h4>
          <p>Cobros médicos pagados</p>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon green">🧪</div>
        <div class="stat-info">
          <h4>$${totalLab.toFixed(2)}</h4>
          <p>Cobros de laboratorio pagados</p>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon purple">📊</div>
        <div class="stat-info">
          <h4>$${total.toFixed(2)}</h4>
          <p>Total pagado vigente</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Desglose por médico</h3>
        <button class="btn btn-primary btn-sm"
          onclick="imprimirBalance()">Imprimir PDF</button>
      </div>
      <div class="card-body">
        <div class="table-responsive">
          <table>
            <thead>
              <tr><th>Médico</th><th>Total cobrado</th></tr>
            </thead>
            <tbody>
              ${Object.entries(porMedico).map(([key, monto]) => {
                let nombre = 'Sin médico asignado';
                if (key !== 'sin_medico') {
                  const m = medicos.find(x => x.id == key);
                  nombre = m ? m.nombre : `ID ${key}`;
                }
                return `
                  <tr>
                    <td>${escapeHtml(nombre)}</td>
                    <td><strong>$${monto.toFixed(2)}</strong></td>
                  </tr>
                `;
              }).join('') || '<tr><td colspan="2">Sin datos</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Todos los cobros</h3>
      </div>
      <div class="card-body">
        ${cobrosOrdenados.length === 0
          ? '<p class="text-muted">No hay cobros registrados.</p>'
          : `<div class="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Concepto</th>
                    <th>Paciente / Referencia</th>
                    <th>Tipo</th>
                    <th>Médico</th>
                    <th>Monto</th>
                    <th>Estatus</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>${filasCobros}</tbody>
              </table>
            </div>`
        }
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>Historial de modificaciones y cancelaciones</h3>
      </div>
      <div class="card-body">
        ${auditorias.length === 0
          ? '<p class="text-muted">No hay registros de auditoría.</p>'
          : `<div class="table-responsive">
              <table>
                <thead>
                  <tr><th>Fecha</th><th>Cobro</th><th>Acción</th></tr>
                </thead>
                <tbody>
                  ${auditorias.slice(0, 50).map(a => `
                    <tr>
                      <td>${a.fecha ? new Date(a.fecha).toLocaleString('es-MX') : '—'}</td>
                      <td>${escapeHtml(a.concepto || '#' + a.cobroId)}</td>
                      <td>${escapeHtml(a.accion || '—')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>`
        }
      </div>
    </div>
  `;
}

async function cancelarCobro(id) {
  const confirmado = confirm(
    '¿Deseas cancelar este cobro? Se conservará en el historial de auditoría y dejará de contar como pago vigente.'
  );

  if (!confirmado) return;

  try {
    const cobro = await DB.get(DB.STORES.cobros, id);

    if (!cobro) {
      alert('No se encontró el cobro seleccionado.');
      return;
    }

    if (cobro.status === 'cancelado') {
      alert('Este cobro ya está cancelado.');
      return;
    }

    cobro.audit = cobro.audit || [];
    cobro.audit.push({
      fecha: new Date().toISOString(),
      accion: 'cancelación',
      anterior: {
        monto: cobro.monto,
        status: cobro.status,
        concepto: cobro.concepto,
        referencia: cobro.referencia
      }
    });

    cobro.status = 'cancelado';

    await DB.put(DB.STORES.cobros, cobro);
    await renderBalance();
  } catch (err) {
    alert('No se pudo cancelar el cobro: ' + err.message);
  }
}

// ========== RESPALDOS ==========
function renderRespaldos() {
  const area = document.getElementById('content-area');
  area.innerHTML = `
    <div class="card">
      <div class="card-header"><h3>Respaldos de información</h3></div>
      <div class="card-body">
        <p class="mb-2">Exporte todos los datos a un archivo JSON para conservarlos de forma segura. Puede restaurarlos en cualquier momento.</p>
        <div class="d-flex gap-2">
          <button class="btn btn-primary" id="btn-export" onclick="exportData()">Descargar respaldo JSON</button>
          <button class="btn btn-outline" onclick="document.getElementById('import-file').click()">Restaurar desde JSON</button>
          <input type="file" id="import-file" accept=".json" style="display:none" onchange="importData(event)">
        </div>
        <div class="alert alert-warning mt-2">
          <strong>Importante:</strong> La información se almacena en la base de datos central del servicio web. Descargue respaldos periódicos y mantenga sus credenciales en privado.
        </div>
      </div>
    </div>

    
  `;
}

// ========== BACKUP ==========
async function exportData() {
  try {
    const data = await DB.exportBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ConsultorioMedicoCC_respaldo_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Error al exportar: ' + err.message);
  }
}

async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!confirm('¿Restaurar este respaldo? Se reemplazarán todos los datos actuales.')) {
    event.target.value = '';
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const financeNip = prompt('Para restaurar el respaldo completo, ingrese el NIP de Cobros y Laboratorios:');
    if (financeNip === null) throw new Error('Restauración cancelada. No se modificaron los datos.');
    await DB.verifyNip('cobros', financeNip.trim());
    await DB.importBackup(data);
    alert('Respaldo restaurado correctamente. La página se recargará.');
    location.reload();
  } catch (err) {
    alert('Error al importar: ' + err.message);
  }
  event.target.value = '';
}

// ========== PRINT RECETA ==========
async function imprimirReceta(consultaId) {
  const c = await DB.get(DB.STORES.consultas, consultaId);
  if (!c) return;
  const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
  const m = await DB.get(DB.STORES.medicos, c.medicoId);
  const allMeds = await DB.getAll(DB.STORES.medicamentos);
  const allEsts = await DB.getAll(DB.STORES.estudios);

  const tieneCedula = m && m.cedula && m.domicilio;
  const titulo = tieneCedula ? 'RECETA MÉDICA' : 'HOJA DE INDICACIONES';

  const medsHtml = (c.medicamentos || []).map(med => {
    const item = allMeds.find(x => x.id === med.medicamentoId);
    return `<tr>
      <td>${item ? escapeHtml(item.nombre) : '—'} ${item && item.concentracion ? '(' + escapeHtml(item.concentracion) + ')' : ''}</td>
      <td>${escapeHtml(med.dosis)}</td>
      <td>${escapeHtml(med.via)}</td>
      <td>${escapeHtml(med.frecuencia)}</td>
      <td>${escapeHtml(med.duracion)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5">Sin medicamentos</td></tr>';

  const estsHtml = (c.estudios || []).map(eid => {
    const item = allEsts.find(x => x.id === eid);
    return `<li>${item ? escapeHtml(item.nombre) : '—'}</li>`;
  }).join('') || '<li>Ninguno</li>';

  const sv = c.signosVitales || {};

  const printArea = document.getElementById('print-area');
  printArea.innerHTML = `
    <div style="font-family: 'Times New Roman', serif; max-width: 800px; margin: 0 auto;">
      <div style="text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 15px;">
        <h2 style="margin:0; font-size: 18pt;">${titulo}</h2>
        <p style="margin:4px 0; font-size: 11pt;">Consultorio Médico CC</p>
      </div>

      ${m ? `
        <div style="margin-bottom: 12px; font-size: 10pt;">
          <strong>Dr(a). ${escapeHtml(m.nombre)}</strong><br>
          ${m.especialidad ? 'Especialidad: ' + escapeHtml(m.especialidad) + '<br>' : ''}
          ${m.cedula ? 'Cédula profesional: ' + escapeHtml(m.cedula) + '<br>' : ''}
          ${m.cedulaEsp ? 'Cédula de especialidad: ' + escapeHtml(m.cedulaEsp) + '<br>' : ''}
          ${m.domicilio ? 'Domicilio: ' + escapeHtml(m.domicilio) + '<br>' : ''}
          ${m.telefono ? 'Tel: ' + escapeHtml(m.telefono) : ''}
        </div>
      ` : ''}

      <div style="margin-bottom: 12px; font-size: 10pt;">
        <strong>Paciente:</strong> ${p ? escapeHtml(p.nombre) : '—'}<br>
        ${p && p.fechaNac ? 'Fecha nac.: ' + p.fechaNac + '<br>' : ''}
        <strong>Fecha de consulta:</strong> ${formatDate(c.fecha)}
      </div>

      <div style="margin-bottom: 10px; font-size: 10pt;">
        <strong>Signos vitales:</strong><br>
        T.A.: ${sv.ta || '—'} &nbsp;|&nbsp; F.C.: ${sv.fc || '—'} &nbsp;|&nbsp; F.R.: ${sv.fr || '—'} &nbsp;|&nbsp; Temp: ${sv.temp || '—'} °C<br>
        Peso: ${sv.peso || '—'} kg &nbsp;|&nbsp; Talla: ${sv.talla || '—'} cm &nbsp;|&nbsp; SpO₂: ${sv.spo2 || '—'} %
      </div>

      <div style="margin-bottom: 10px; font-size: 10pt;">
        <strong>Motivo de consulta:</strong> ${escapeHtml(c.motivo || '—')}<br>
        ${c.cuadroClinico ? '<strong>Cuadro clínico:</strong> ' + escapeHtml(c.cuadroClinico) + '<br>' : ''}
        ${c.tratamiento ? '<strong>Plan / Tratamiento:</strong> ' + escapeHtml(c.tratamiento) : ''}
      </div>

      <h3 style="font-size: 12pt; margin: 15px 0 8px; border-bottom: 1px solid #999;">Medicamentos</h3>
      <table style="width:100%; border-collapse: collapse; font-size: 10pt;">
        <thead>
          <tr style="background:#f0f0f0;">
            <th style="border:1px solid #ccc; padding:4px; text-align:left;">Medicamento</th>
            <th style="border:1px solid #ccc; padding:4px;">Dosis</th>
            <th style="border:1px solid #ccc; padding:4px;">Vía</th>
            <th style="border:1px solid #ccc; padding:4px;">Frecuencia</th>
            <th style="border:1px solid #ccc; padding:4px;">Duración</th>
          </tr>
        </thead>
        <tbody>${medsHtml}</tbody>
      </table>

      <h3 style="font-size: 12pt; margin: 15px 0 8px; border-bottom: 1px solid #999;">Estudios de laboratorio</h3>
      <ul style="font-size: 10pt; margin: 0; padding-left: 20px;">${estsHtml}</ul>

      ${c.proximaCita ? `<p style="margin-top:12px; font-size:10pt;"><strong>Próxima cita:</strong> ${c.proximaCita}</p>` : ''}

      <div style="margin-top: 40px; text-align: center; font-size: 10pt;">
        <div style="border-top: 1px solid #333; width: 220px; margin: 0 auto; padding-top: 4px;">
          Firma del médico
        </div>
      </div>

      <p style="margin-top: 30px; text-align: center; font-style: italic; font-size: 10pt; color: #555;">
        Gracias por confiarnos tu salud.
      </p>
    </div>
  `;

  window.print();
}

async function imprimirBalance() {
  const cobros = await DB.getAll(DB.STORES.cobros);
  const medicos = await DB.getAll(DB.STORES.medicos);
  const pagados = cobros.filter(c => c.status === 'pagado');

  const totalMedico = pagados.filter(c => c.tipo === 'medico').reduce((s, c) => s + (parseFloat(c.monto) || 0), 0);
  const totalLab = pagados.filter(c => c.tipo === 'laboratorio').reduce((s, c) => s + (parseFloat(c.monto) || 0), 0);

  const porMedico = {};
  pagados.forEach(c => {
    const key = c.medicoId || 'sin_medico';
    if (!porMedico[key]) porMedico[key] = 0;
    porMedico[key] += parseFloat(c.monto) || 0;
  });

  const printArea = document.getElementById('print-area');
  printArea.innerHTML = `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
      <h2 style="text-align:center;">REPORTE FINANCIERO - BALANCE GENERAL</h2>
      <p style="text-align:center;">Consultorio Médico CC · ${formatDate(new Date().toISOString())}</p>
      <hr>
      <h3>Totales</h3>
      <p>Cobros médicos: <strong>$${totalMedico.toFixed(2)}</strong></p>
      <p>Cobros laboratorio: <strong>$${totalLab.toFixed(2)}</strong></p>
      <p>Total general: <strong>$${(totalMedico + totalLab).toFixed(2)}</strong></p>
      <h3>Desglose por médico</h3>
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr style="background:#eee;"><th style="border:1px solid #ccc; padding:6px; text-align:left;">Médico</th><th style="border:1px solid #ccc; padding:6px;">Total</th></tr></thead>
        <tbody>
          ${Object.entries(porMedico).map(([key, monto]) => {
            let nombre = 'Sin médico asignado';
            if (key !== 'sin_medico') {
              const m = medicos.find(x => x.id == key);
              nombre = m ? m.nombre : `ID ${key}`;
            }
            return `<tr><td style="border:1px solid #ccc; padding:6px;">${escapeHtml(nombre)}</td><td style="border:1px solid #ccc; padding:6px;">$${monto.toFixed(2)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
      <p style="margin-top:30px; font-size:10pt; color:#666;">Documento generado por Consultorio Médico CC. Gracias por confiarnos tu salud.</p>
    </div>
  `;
  window.print();
}

// ========== MODAL HELPERS ==========
function closeModal() {
  document.getElementById('generic-modal').classList.remove('show');
  document.querySelector('.modal')?.classList.remove('modal-lg');
  APP.editingId = null;
}

// ========== UTILS ==========
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/\n/g, ' ');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// Expose functions needed by inline onclick
window.openMedicoModal = openMedicoModal;
window.saveMedico = saveMedico;
window.toggleMedico = toggleMedico;
window.openPacienteModal = openPacienteModal;
window.savePaciente = savePaciente;
window.deletePaciente = deletePaciente;
window.openConsultaModal = openConsultaModal;
window.saveConsulta = saveConsulta;
window.verConsulta = verConsulta;
window.addMedToConsulta = addMedToConsulta;
window.removeMedFromConsulta = removeMedFromConsulta;
window.addEstToConsulta = addEstToConsulta;
window.removeEstFromConsulta = removeEstFromConsulta;
window.openMedicamentoModal = openMedicamentoModal;
window.saveMedicamento = saveMedicamento;
window.deleteMedicamento = deleteMedicamento;
window.openEstudioModal = openEstudioModal;
window.saveEstudio = saveEstudio;
window.deleteEstudio = deleteEstudio;
window.openCobroModal = openCobroModal;
window.saveCobro = saveCobro;
window.marcarPagado = marcarPagado;
window.imprimirReceta = imprimirReceta;
window.imprimirBalance = imprimirBalance;
window.closeModal = closeModal;
window.verifyNip = verifyNip;
window.closeNipModal = closeNipModal;
window.exportData = exportData;
window.importData = importData;
window.logout = logout;

/* ========== MÓDULO DE ENFERMERÍA ========== */

async function renderEnfermeria() {
  const area = document.getElementById('content-area');

  if (!area) {
    alert('No se encontró el área de contenido.');
    return;
  }

  try {
    const registros = await DB.getAll('enfermeria');

    registros.sort((a, b) =>
      String(b.fechaHora || '').localeCompare(String(a.fechaHora || ''))
    );

    area.innerHTML = `
      <div class="card">
        <h3>Registro de enfermería y signos vitales</h3>

        <form id="form-enfermeria">
          <div class="form-grid">
            <div class="form-group">
              <label>Nombre del paciente</label>
              <input class="form-control" name="paciente" required>
            </div>

            <div class="form-group">
              <label>Responsable de enfermería</label>
              <input class="form-control" name="responsable" required>
            </div>

            <div class="form-group">
              <label>Presión arterial</label>
              <input class="form-control" name="presion"
                     placeholder="120/80" required>
            </div>

            <div class="form-group">
              <label>Frecuencia cardíaca (lpm)</label>
              <input class="form-control" name="fc"
                     type="number" min="1" required>
            </div>

            <div class="form-group">
              <label>Frecuencia respiratoria (rpm)</label>
              <input class="form-control" name="fr"
                     type="number" min="1" required>
            </div>

            <div class="form-group">
              <label>Temperatura (°C)</label>
              <input class="form-control" name="temperatura"
                     type="number" min="25" max="45"
                     step="0.1" required>
            </div>

            <div class="form-group">
              <label>Peso (kg)</label>
              <input class="form-control" name="peso"
                     type="number" min="0.1" max="500"
                     step="0.1" required>
            </div>

            <div class="form-group">
              <label>Talla (cm)</label>
              <input class="form-control" name="talla"
                     type="number" min="20" max="250"
                     step="0.1" required>
            </div>

            <div class="form-group">
              <label>Saturación de oxígeno (%)</label>
              <input class="form-control" name="spo2"
                     type="number" min="1" max="100" required>
            </div>

            <div class="form-group">
              <label>Observaciones</label>
              <input class="form-control" name="observaciones">
            </div>
          </div>

          <p id="imc-preview">
            IMC: complete el peso y la talla.
          </p>

          <button class="btn btn-primary" type="submit">
            Guardar registro
          </button>
        </form>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>Historial de enfermería</h3>

        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Fecha y hora</th>
                <th>Paciente</th>
                <th>Responsable</th>
                <th>Presión arterial</th>
                <th>FC</th>
                <th>FR</th>
                <th>Temperatura</th>
                <th>Peso</th>
                <th>Talla</th>
                <th>IMC</th>
                <th>SpO₂</th>
                <th>Observaciones</th>
              </tr>
            </thead>
            <tbody>
              ${registros.map(r => `
                <tr>
                  <td>${escEnf(r.fechaHora || '')}</td>
                  <td>${escEnf(r.paciente || '')}</td>
                  <td>${escEnf(r.responsable || '')}</td>
                  <td>${escEnf(r.presion || '')}</td>
                  <td>${escEnf(r.fc ?? '')}</td>
                  <td>${escEnf(r.fr ?? '')}</td>
                  <td>${escEnf(r.temperatura ?? '')} °C</td>
                  <td>${escEnf(r.peso ?? '')} kg</td>
                  <td>${escEnf(r.talla ?? '')} cm</td>
                  <td>${escEnf(r.imc ?? '')}</td>
                  <td>${escEnf(r.spo2 ?? '')}%</td>
                  <td>${escEnf(r.observaciones || '')}</td>
                </tr>
              `).join('') || `
                <tr>
                  <td colspan="12">Todavía no hay registros.</td>
                </tr>
              `}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const form = document.getElementById('form-enfermeria');
    const peso = form.elements.peso;
    const talla = form.elements.talla;

    function actualizarIMC() {
      const p = Number(peso.value);
      const t = Number(talla.value) / 100;
      const imc = p > 0 && t > 0
        ? (p / (t * t)).toFixed(2)
        : '';

      document.getElementById('imc-preview').textContent =
        imc ? `IMC calculado: ${imc}` :
        'IMC: complete el peso y la talla.';
    }

    peso.addEventListener('input', actualizarIMC);
    talla.addEventListener('input', actualizarIMC);

    form.addEventListener('submit', guardarEnfermeria);

  } catch (error) {
    console.error('Error al abrir enfermería:', error);
    area.innerHTML = `
      <div class="card">
        <h3>No se pudo abrir Enfermería</h3>
        <p>${escEnf(error.message || 'Error desconocido')}</p>
      </div>
    `;
  }
}

async function guardarEnfermeria(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const datos = new FormData(form);

  const peso = Number(datos.get('peso'));
  const talla = Number(datos.get('talla'));
  const tallaM = talla / 100;

  if (!(peso > 0 && tallaM > 0)) {
    alert('Verifica el peso y la talla.');
    return;
  }

  const registro = {
    paciente: String(datos.get('paciente') || '').trim(),
    responsable: String(datos.get('responsable') || '').trim(),
    presion: String(datos.get('presion') || '').trim(),
    fc: Number(datos.get('fc')),
    fr: Number(datos.get('fr')),
    temperatura: Number(datos.get('temperatura')),
    peso,
    talla,
    imc: Number((peso / (tallaM * tallaM)).toFixed(2)),
    spo2: Number(datos.get('spo2')),
    observaciones: String(datos.get('observaciones') || '').trim(),
    fechaHora: new Date().toISOString()
  };

  try {
    await DB.add('enfermeria', registro);
    alert('Registro de enfermería guardado.');
    await renderEnfermeria();
  } catch (error) {
    console.error('Error al guardar enfermería:', error);
    alert(
      'No se pudo guardar el registro. Verifica la configuración del servidor: ' +
      error.message
    );
  }
}

function escEnf(valor) {
  return String(valor).replace(/[&<>"']/g, caracter => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[caracter]);
}
