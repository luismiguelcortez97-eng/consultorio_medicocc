/* =====================================================
   Consultorio Médico CC - Aplicación principal
   ===================================================== */

const APP = {
  currentUser: null,
  currentModule: 'dashboard',
  editingId: null,
  tempConsulta: null,
  unlockedCobros: false,
  unlockedBalance: false
};

// ========== INICIO ==========
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
    const user = document.querySelector('.topbar-actions .text-muted');
    if (user) user.textContent = session.username;
    try { await DB.seedIfEmpty(); } catch (e) { console.error(e); }
    showApp();
  } else {
    showLogin();
  }
}

function setupEventListeners() {
  document.getElementById('login-form')?.addEventListener('submit', handleLogin);

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.dataset.module) navigateTo(item.dataset.module);
    });
  });

  document.getElementById('btn-logout')?.addEventListener('click', logout);

  const toggle = document.getElementById('menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      document.querySelector('.sidebar')?.classList.toggle('open');
    });
  }

  document.getElementById('btn-export')?.addEventListener('click', exportData);
  document.getElementById('btn-import')?.addEventListener('click', () => {
    document.getElementById('import-file')?.click();
  });
  document.getElementById('import-file')?.addEventListener('change', importData);

  // Agregar los nuevos accesos sin duplicar los que ya existan.
  const nav = document.querySelector('.sidebar nav') ||
              document.querySelector('.sidebar .nav-menu') ||
              document.querySelector('.sidebar');

  if (nav) {
    [
      { module: 'enfermeria', icon: '🩺', label: 'Enfermería' },
      { module: 'empleados', icon: '👥', label: 'Empleados' }
    ].forEach(item => {
      if (!document.querySelector(`.nav-item[data-module="${item.module}"]`)) {
        const el = document.createElement('div');
        el.className = 'nav-item';
        el.dataset.module = item.module;
        el.innerHTML = `<span class="nav-icon">${item.icon}</span><span>${item.label}</span>`;
        el.addEventListener('click', () => navigateTo(item.module));
        nav.appendChild(el);
      }
    });
  }
}

// ========== ACCESO ==========
async function handleLogin(e) {
  e.preventDefault();
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const errorEl = document.getElementById('login-error');

  try {
    const session = await DB.login(user, pass);
    APP.currentUser = session.username;
    const topUser = document.querySelector('.topbar-actions .text-muted');
    if (topUser) topUser.textContent = session.username;
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

// ========== NAVEGACIÓN ==========
async function navigateTo(module) {
  if (module === 'cobros' && !APP.unlockedCobros) {
    showNipModal('cobros');
    return;
  }
  if (module === 'balance' && !APP.unlockedBalance) {
    showNipModal('balance');
    return;
  }

  APP.currentModule = module;

  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelector(`.nav-item[data-module="${module}"]`)?.classList.add('active');

  const titles = {
    dashboard: 'Dashboard',
    medicos: 'Médicos',
    pacientes: 'Pacientes y Expedientes',
    consultas: 'Consultas Médicas',
    medicamentos: 'Medicamentos',
    estudios: 'Estudios de Laboratorio',
    cobros: 'Cobros y Ventas del Día',
    balance: 'Balance General',
    respaldos: 'Respaldos y Configuración',
    enfermeria: 'Enfermería — Signos Vitales',
    empleados: 'Administración de Empleados'
  };

  document.getElementById('page-title').textContent = titles[module] || module;
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
      case 'empleados': await renderEmpleados(); break;
      default: area.innerHTML = '<p>Módulo no encontrado</p>';
    }
  } catch (err) {
    console.error(err);
    area.innerHTML = `<div class="alert alert-danger">Error al cargar el módulo: ${escapeHtml(err.message)}</div>`;
  }
}

// ========== NIP ==========
function showNipModal(tipo) {
  const overlay = document.getElementById('nip-overlay');
  document.getElementById('nip-title').textContent =
    tipo === 'cobros' ? 'Acceso a Cobros' : 'Acceso a Balance General';
  document.getElementById('nip-desc').textContent =
    tipo === 'cobros' ? 'Ingrese el NIP de Cobros y Laboratorios' : 'Ingrese el código de Balance General';
  document.getElementById('nip-input').value = '';
  document.getElementById('nip-error').style.display = 'none';
  overlay.dataset.tipo = tipo;
  overlay.classList.add('show');
  setTimeout(() => document.getElementById('nip-input').focus(), 100);
}

function closeNipModal() {
  document.getElementById('nip-overlay').classList.remove('show');
}

async function verifyNip() {
  const tipo = document.getElementById('nip-overlay').dataset.tipo;
  const input = document.getElementById('nip-input').value.trim();
  const error = document.getElementById('nip-error');

  try {
    await DB.verifyNip(tipo, input);
    if (tipo === 'cobros') APP.unlockedCobros = true;
    else APP.unlockedBalance = true;
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
  const resumen = await DB.getCobrosHoy(hoy);
  const totalHoy = Number(resumen.total) || 0;

  document.getElementById('content-area').innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon blue">👨‍⚕️</div><div class="stat-info"><h4>${medicos.filter(m => m.activo !== false).length}</h4><p>Médicos activos</p></div></div>
      <div class="stat-card"><div class="stat-icon green">👤</div><div class="stat-info"><h4>${pacientes.length}</h4><p>Pacientes registrados</p></div></div>
      <div class="stat-card"><div class="stat-icon orange">📋</div><div class="stat-info"><h4>${consultas.length}</h4><p>Consultas totales</p></div></div>
      <div class="stat-card"><div class="stat-icon purple">💰</div><div class="stat-info"><h4>$${totalHoy.toFixed(2)}</h4><p>Cobrado hoy</p></div></div>
    </div>
    <div class="card"><div class="card-header"><h3>Últimas consultas</h3></div><div class="card-body">
      ${consultas.length ? `<div class="table-responsive"><table><thead><tr><th>Fecha</th><th>Paciente</th><th>Médico</th><th>Motivo</th></tr></thead><tbody>
      ${(await Promise.all(consultas.slice(-8).reverse().map(async c => {
        const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
        const m = await DB.get(DB.STORES.medicos, c.medicoId);
        return `<tr><td>${formatDate(c.fecha)}</td><td>${escapeHtml(p?.nombre || '—')}</td><td>${escapeHtml(m?.nombre || '—')}</td><td>${escapeHtml(c.motivo || '—')}</td></tr>`;
      }))).join('')}</tbody></table></div>` : '<div class="empty-state"><p>No hay consultas registradas aún.</p></div>'}
    </div></div>`;
}

// ========== MÉDICOS ==========
async function renderMedicos() {
  const medicos = await DB.getAll(DB.STORES.medicos);
  document.getElementById('content-area').innerHTML = `
    <div class="card"><div class="card-header"><h3>Listado de Médicos</h3><button class="btn btn-primary btn-sm" onclick="openMedicoModal()">+ Nuevo Médico</button></div><div class="card-body">
    ${medicos.length ? `<div class="table-responsive"><table><thead><tr><th>Nombre</th><th>Especialidad</th><th>Cédula</th><th>Teléfono</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>
    ${medicos.map(m => `<tr><td><strong>${escapeHtml(m.nombre)}</strong></td><td>${escapeHtml(m.especialidad || '—')}</td><td>${escapeHtml(m.cedula || '—')}</td><td>${escapeHtml(m.telefono || '—')}</td><td>${m.activo === false ? 'Inactivo' : 'Activo'}</td><td><button class="btn btn-outline btn-sm" onclick="openMedicoModal(${m.id})">Editar</button> ${m.activo !== false ? `<button class="btn btn-warning btn-sm" onclick="toggleMedico(${m.id},false)">Baja</button>` : `<button class="btn btn-success btn-sm" onclick="toggleMedico(${m.id},true)">Reactivar</button>`}</td></tr>`).join('')}
    </tbody></table></div>` : '<p>No hay médicos registrados.</p>'}</div></div>`;
}

function openMedicoModal(id = null) {
  APP.editingId = id;
  const modal = document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent = id ? 'Editar Médico' : 'Nuevo Médico';

  (async () => {
    let m = { nombre: '', especialidad: '', cedula: '', cedulaEsp: '', domicilio: '', telefono: '', activo: true };
    if (id) m = await DB.get(DB.STORES.medicos, id) || m;

    document.getElementById('modal-body').innerHTML = `
      <div class="form-row"><div class="form-group"><label>Nombre completo *</label><input class="form-control" id="m-nombre" value="${escapeAttr(m.nombre)}"></div><div class="form-group"><label>Especialidad</label><input class="form-control" id="m-especialidad" value="${escapeAttr(m.especialidad || '')}"></div></div>
      <div class="form-row"><div class="form-group"><label>Cédula profesional</label><input class="form-control" id="m-cedula" value="${escapeAttr(m.cedula || '')}"></div><div class="form-group"><label>Cédula de especialidad</label><input class="form-control" id="m-cedulaEsp" value="${escapeAttr(m.cedulaEsp || '')}"></div></div>
      <div class="form-group"><label>Domicilio</label><input class="form-control" id="m-domicilio" value="${escapeAttr(m.domicilio || '')}"></div>
      <div class="form-group"><label>Teléfono</label><input class="form-control" id="m-telefono" value="${escapeAttr(m.telefono || '')}"></div>`;
    document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveMedico()">Guardar</button>';
  })();

  modal.classList.add('show');
}

async function saveMedico() {
  const nombre = document.getElementById('m-nombre').value.trim();
  if (!nombre) return alert('El nombre es obligatorio');

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
      const old = await DB.get(DB.STORES.medicos, APP.editingId);
      data.id = APP.editingId;
      data.activo = old?.activo !== false;
      await DB.put(DB.STORES.medicos, data);
    } else await DB.add(DB.STORES.medicos, data);
    closeModal();
    renderMedicos();
  } catch (e) { alert('Error al guardar: ' + e.message); }
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
  document.getElementById('content-area').innerHTML = `
    <div class="card"><div class="card-header"><h3>Pacientes y Expedientes</h3><button class="btn btn-primary btn-sm" onclick="openPacienteModal()">+ Nuevo Paciente</button></div><div class="card-body">
    ${pacientes.length ? `<div class="table-responsive"><table><thead><tr><th>Nombre</th><th>Fecha nac.</th><th>Género</th><th>Teléfono</th><th>Médico</th><th>Acciones</th></tr></thead><tbody>
    ${pacientes.map(p => `<tr><td>${escapeHtml(p.nombre)}</td><td>${p.fechaNac || '—'}</td><td>${escapeHtml(p.genero || '—')}</td><td>${escapeHtml(p.telefono || '—')}</td><td>${escapeHtml(medicos.find(m => m.id === p.medicoId)?.nombre || '—')}</td><td><button class="btn btn-outline btn-sm" onclick="openPacienteModal(${p.id})">Editar</button> <button class="btn btn-danger btn-sm" onclick="deletePaciente(${p.id})">Eliminar</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p>No hay pacientes registrados.</p>'}</div></div>`;
}

function openPacienteModal(id = null) {
  APP.editingId = id;
  const modal = document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent = id ? 'Editar Paciente' : 'Nuevo Paciente';

  (async () => {
    let p = { nombre: '', fechaNac: '', genero: '', telefono: '', direccion: '', medicoId: '' };
    if (id) p = await DB.get(DB.STORES.pacientes, id) || p;
    const medicos = (await DB.getAll(DB.STORES.medicos)).filter(m => m.activo !== false);
    document.getElementById('modal-body').innerHTML = `
      <div class="form-row"><div class="form-group"><label>Nombre completo *</label><input class="form-control" id="p-nombre" value="${escapeAttr(p.nombre)}"></div><div class="form-group"><label>Fecha de nacimiento</label><input type="date" class="form-control" id="p-fechaNac" value="${p.fechaNac || ''}"></div></div>
      <div class="form-row"><div class="form-group"><label>Género</label><select class="form-control" id="p-genero"><option value="">—</option><option ${p.genero === 'Masculino' ? 'selected' : ''}>Masculino</option><option ${p.genero === 'Femenino' ? 'selected' : ''}>Femenino</option><option ${p.genero === 'Otro' ? 'selected' : ''}>Otro</option></select></div><div class="form-group"><label>Teléfono</label><input class="form-control" id="p-telefono" value="${escapeAttr(p.telefono || '')}"></div></div>
      <div class="form-group"><label>Dirección</label><input class="form-control" id="p-direccion" value="${escapeAttr(p.direccion || '')}"></div>
      <div class="form-group"><label>Médico asignado</label><select class="form-control" id="p-medicoId"><option value="">— Sin asignar —</option>${medicos.map(m => `<option value="${m.id}" ${p.medicoId == m.id ? 'selected' : ''}>${escapeHtml(m.nombre)}</option>`).join('')}</select></div>`;
    document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="savePaciente()">Guardar</button>';
  })();

  modal.classList.add('show');
}

async function savePaciente() {
  const nombre = document.getElementById('p-nombre').value.trim();
  if (!nombre) return alert('El nombre es obligatorio');

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
    } else await DB.add(DB.STORES.pacientes, data);
    closeModal();
    renderPacientes();
  } catch (e) { alert('Error al guardar: ' + e.message); }
}

async function deletePaciente(id) {
  if (!confirm('¿Eliminar este paciente? Esta acción no se puede deshacer.')) return;
  await DB.remove(DB.STORES.pacientes, id);
  renderPacientes();
}

// ========== CONSULTAS ==========
async function renderConsultas() {
  const consultas = await DB.getAll(DB.STORES.consultas);
  document.getElementById('content-area').innerHTML = `
    <div class="card"><div class="card-header"><h3>Consultas Médicas</h3><button class="btn btn-primary btn-sm" onclick="openConsultaModal()">+ Nueva Consulta</button></div><div class="card-body">
    ${consultas.length ? `<div class="table-responsive"><table><thead><tr><th>Fecha</th><th>Paciente</th><th>Médico</th><th>Motivo</th><th>Acciones</th></tr></thead><tbody>
    ${(await Promise.all(consultas.slice().reverse().map(async c => {
      const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
      const m = await DB.get(DB.STORES.medicos, c.medicoId);
      return `<tr><td>${formatDate(c.fecha)}</td><td>${escapeHtml(p?.nombre || '—')}</td><td>${escapeHtml(m?.nombre || '—')}</td><td>${escapeHtml((c.motivo || '').substring(0, 50))}</td><td><button class="btn btn-outline btn-sm" onclick="verConsulta(${c.id})">Ver</button> <button class="btn btn-primary btn-sm" onclick="imprimirReceta(${c.id})">Receta</button></td></tr>`;
    }))).join('')}
    </tbody></table></div>` : '<p>No hay consultas registradas.</p>'}</div></div>`;
}

function openConsultaModal() {
  APP.editingId = null;
  APP.tempConsulta = { medicamentos: [], estudios: [] };
  const modal = document.getElementById('generic-modal');
  modal.querySelector('.modal')?.classList.add('modal-lg');
  document.getElementById('modal-title').textContent = 'Nueva Consulta Médica';

  (async () => {
    const pacientes = await DB.getAll(DB.STORES.pacientes);
    const medicos = (await DB.getAll(DB.STORES.medicos)).filter(m => m.activo !== false);
    const meds = await DB.getAll(DB.STORES.medicamentos);
    const ests = await DB.getAll(DB.STORES.estudios);

    document.getElementById('modal-body').innerHTML = `
      <div class="form-row"><div class="form-group"><label>Paciente *</label><select class="form-control" id="c-pacienteId"><option value="">— Seleccione —</option>${pacientes.map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('')}</select></div><div class="form-group"><label>Médico *</label><select class="form-control" id="c-medicoId"><option value="">— Seleccione —</option>${medicos.map(m => `<option value="${m.id}">${escapeHtml(m.nombre)}</option>`).join('')}</select></div></div>
      <div class="form-group"><label>Motivo de consulta *</label><textarea class="form-control" id="c-motivo" rows="2"></textarea></div>
      <div class="form-group"><label>Interrogatorio y antecedentes</label><textarea class="form-control" id="c-interrogatorio" rows="2"></textarea></div>
      <div class="form-group"><label>Cuadro clínico</label><textarea class="form-control" id="c-cuadro" rows="2"></textarea></div>
      <div class="form-group"><label>Exploración física</label><textarea class="form-control" id="c-exploracion" rows="2"></textarea></div>
      <div class="form-group"><label>Tratamiento / Plan</label><textarea class="form-control" id="c-tratamiento" rows="2"></textarea></div>

      <h4 style="margin:1rem 0">Signos vitales (opcionales)</h4>
      <p class="text-muted">Puede guardar la consulta sin registrar signos vitales. Para registrarlos por separado, use el módulo Enfermería.</p>
      <div class="form-row">
        <div class="form-group"><label>T.A. (mmHg)</label><input class="form-control" id="sv-ta" placeholder="120/80"></div>
        <div class="form-group"><label>F.C. (lpm)</label><input class="form-control" id="sv-fc" placeholder="72"></div>
        <div class="form-group"><label>F.R. (rpm)</label><input class="form-control" id="sv-fr" placeholder="16"></div>
        <div class="form-group"><label>Temp. (°C)</label><input class="form-control" id="sv-temp" placeholder="36.5"></div>
        <div class="form-group"><label>Peso (kg)</label><input class="form-control" id="sv-peso" placeholder="70"></div>
        <div class="form-group"><label>Talla (cm)</label><input class="form-control" id="sv-talla" placeholder="170"></div>
        <div class="form-group"><label>SpO2 (%)</label><input class="form-control" id="sv-spo2" placeholder="98"></div>
      </div>

      <h4 style="margin:1rem 0">Medicamentos prescritos</h4>
      <div id="meds-list"></div>
      <div class="form-row">
        <div class="form-group"><label>Medicamento</label><select class="form-control" id="add-med-id"><option value="">— Seleccione —</option>${meds.map(m => `<option value="${m.id}">${escapeHtml(m.nombre)} ${escapeHtml(m.concentracion || '')}</option>`).join('')}</select></div>
        <div class="form-group"><label>Dosis</label><input class="form-control" id="add-med-dosis" placeholder="1 tableta"></div>
        <div class="form-group"><label>Vía</label><input class="form-control" id="add-med-via" placeholder="Oral"></div>
        <div class="form-group"><label>Frecuencia</label><input class="form-control" id="add-med-freq" placeholder="Cada 8 hrs"></div>
        <div class="form-group"><label>Duración</label><input class="form-control" id="add-med-dur" placeholder="5 días"></div>
        <div class="form-group"><button type="button" class="btn btn-outline" onclick="addMedToConsulta()">Agregar</button></div>
      </div>

      <h4 style="margin:1rem 0">Estudios de laboratorio indicados</h4>
      <div id="ests-list"></div>
      <div class="form-row"><div class="form-group"><label>Estudio</label><select class="form-control" id="add-est-id"><option value="">— Seleccione —</option>${ests.map(e => `<option value="${e.id}">${escapeHtml(e.nombre)}</option>`).join('')}</select></div><div class="form-group"><button type="button" class="btn btn-outline" onclick="addEstToConsulta()">Agregar</button></div></div>
      <div class="form-group"><label>Próxima cita</label><input type="date" class="form-control" id="c-proxima"></div>`;

    document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveConsulta()">Guardar Consulta</button>';
    renderTempMeds();
    renderTempEsts();
  })();

  modal.classList.add('show');
}

function addMedToConsulta() {
  const id = document.getElementById('add-med-id').value;
  if (!id) return;
  if (APP.tempConsulta.medicamentos.some(m => m.medicamentoId == id)) return alert('Este medicamento ya está agregado');
  APP.tempConsulta.medicamentos.push({
    medicamentoId: parseInt(id),
    dosis: document.getElementById('add-med-dosis').value.trim() || '—',
    via: document.getElementById('add-med-via').value.trim() || 'Oral',
    frecuencia: document.getElementById('add-med-freq').value.trim() || '—',
    duracion: document.getElementById('add-med-dur').value.trim() || '—'
  });
  ['add-med-dosis', 'add-med-via', 'add-med-freq', 'add-med-dur'].forEach(id => document.getElementById(id).value = '');
  renderTempMeds();
}

function removeMedFromConsulta(idx) {
  APP.tempConsulta.medicamentos.splice(idx, 1);
  renderTempMeds();
}

async function renderTempMeds() {
  const list = document.getElementById('meds-list');
  if (!list) return;
  const all = await DB.getAll(DB.STORES.medicamentos);
  list.innerHTML = APP.tempConsulta.medicamentos.length
    ? `<ul>${APP.tempConsulta.medicamentos.map((m, i) => `<li>${escapeHtml(all.find(x => x.id === m.medicamentoId)?.nombre || '—')} — ${escapeHtml(m.dosis)}, ${escapeHtml(m.via)}, ${escapeHtml(m.frecuencia)}, ${escapeHtml(m.duracion)} <button class="btn btn-danger btn-sm" onclick="removeMedFromConsulta(${i})">×</button></li>`).join('')}</ul>`
    : '<p class="text-muted">Ningún medicamento agregado.</p>';
}

function addEstToConsulta() {
  const id = document.getElementById('add-est-id').value;
  if (!id) return;
  if (APP.tempConsulta.estudios.includes(parseInt(id))) return alert('Este estudio ya está agregado');
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
  const all = await DB.getAll(DB.STORES.estudios);
  list.innerHTML = APP.tempConsulta.estudios.length
    ? `<ul>${APP.tempConsulta.estudios.map((id, i) => `<li>${escapeHtml(all.find(x => x.id === id)?.nombre || '—')} <button class="btn btn-danger btn-sm" onclick="removeEstFromConsulta(${i})">×</button></li>`).join('')}</ul>`
    : '<p class="text-muted">Ningún estudio agregado.</p>';
}

async function saveConsulta() {
  const pacienteId = document.getElementById('c-pacienteId').value;
  const medicoId = document.getElementById('c-medicoId').value;
  const motivo = document.getElementById('c-motivo').value.trim();

  if (!pacienteId || !medicoId || !motivo) {
    alert('Paciente, médico y motivo de consulta son obligatorios.');
    return;
  }

  // Los signos vitales ya no son obligatorios.
  const signosVitales = {
    ta: document.getElementById('sv-ta').value.trim(),
    fc: document.getElementById('sv-fc').value.trim(),
    fr: document.getElementById('sv-fr').value.trim(),
    temp: document.getElementById('sv-temp').value.trim(),
    peso: document.getElementById('sv-peso').value.trim(),
    talla: document.getElementById('sv-talla').value.trim(),
    spo2: document.getElementById('sv-spo2').value.trim()
  };

  const data = {
    pacienteId: parseInt(pacienteId),
    medicoId: parseInt(medicoId),
    fecha: new Date().toISOString(),
    motivo,
    interrogatorio: document.getElementById('c-interrogatorio').value.trim(),
    cuadroClinico: document.getElementById('c-cuadro').value.trim(),
    exploracion: document.getElementById('c-exploracion').value.trim(),
    tratamiento: document.getElementById('c-tratamiento').value.trim(),
    signosVitales,
    medicamentos: APP.tempConsulta.medicamentos,
    estudios: APP.tempConsulta.estudios,
    proximaCita: document.getElementById('c-proxima').value || null
  };

  try {
    await DB.add(DB.STORES.consultas, data);
    closeModal();
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
  const meds = await DB.getAll(DB.STORES.medicamentos);
  const ests = await DB.getAll(DB.STORES.estudios);
  const sv = c.signosVitales || {};

  document.getElementById('modal-title').textContent = 'Detalle de Consulta';
  document.getElementById('modal-body').innerHTML = `
    <p><strong>Fecha:</strong> ${formatDate(c.fecha)}</p>
    <p><strong>Paciente:</strong> ${escapeHtml(p?.nombre || '—')}</p>
    <p><strong>Médico:</strong> ${escapeHtml(m?.nombre || '—')}</p>
    <p><strong>Motivo:</strong> ${escapeHtml(c.motivo || '—')}</p>
    <p><strong>Interrogatorio:</strong> ${escapeHtml(c.interrogatorio || '—')}</p>
    <p><strong>Cuadro clínico:</strong> ${escapeHtml(c.cuadroClinico || '—')}</p>
    <p><strong>Exploración:</strong> ${escapeHtml(c.exploracion || '—')}</p>
    <p><strong>Tratamiento:</strong> ${escapeHtml(c.tratamiento || '—')}</p>
    <p><strong>Signos vitales:</strong><br>T.A.: ${escapeHtml(sv.ta || '—')} | F.C.: ${escapeHtml(sv.fc || '—')} | F.R.: ${escapeHtml(sv.fr || '—')} | Temp.: ${escapeHtml(sv.temp || '—')} °C<br>Peso: ${escapeHtml(sv.peso || '—')} kg | Talla: ${escapeHtml(sv.talla || '—')} cm | SpO2: ${escapeHtml(sv.spo2 || '—')}%</p>
    <p><strong>Medicamentos:</strong></p><ul>${(c.medicamentos || []).map(x => `<li>${escapeHtml(meds.find(a => a.id === x.medicamentoId)?.nombre || '—')} — ${escapeHtml(x.dosis)}, ${escapeHtml(x.via)}, ${escapeHtml(x.frecuencia)}, ${escapeHtml(x.duracion)}</li>`).join('') || '<li>Ninguno</li>'}</ul>
    <p><strong>Estudios:</strong></p><ul>${(c.estudios || []).map(id => `<li>${escapeHtml(ests.find(a => a.id === id)?.nombre || '—')}</li>`).join('') || '<li>Ninguno</li>'}</ul>
    <p><strong>Próxima cita:</strong> ${escapeHtml(c.proximaCita || '—')}</p>`;
  document.getElementById('modal-footer').innerHTML = `<button class="btn btn-secondary" onclick="closeModal()">Cerrar</button><button class="btn btn-primary" onclick="imprimirReceta(${id});closeModal()">Imprimir Receta</button>`;
  document.getElementById('generic-modal').classList.add('show');
}

// ========== MEDICAMENTOS ==========
async function renderMedicamentos() {
  const meds = await DB.getAll(DB.STORES.medicamentos);
  document.getElementById('content-area').innerHTML = `
    <div class="card"><div class="card-header"><h3>Catálogo de Medicamentos</h3><button class="btn btn-primary btn-sm" onclick="openMedicamentoModal()">+ Nuevo Medicamento</button></div><div class="card-body">
    ${meds.length ? `<div class="table-responsive"><table><thead><tr><th>Nombre</th><th>Presentación</th><th>Concentración</th><th>Acciones</th></tr></thead><tbody>${meds.map(m => `<tr><td>${escapeHtml(m.nombre)}</td><td>${escapeHtml(m.presentacion || '—')}</td><td>${escapeHtml(m.concentracion || '—')}</td><td><button class="btn btn-outline btn-sm" onclick="openMedicamentoModal(${m.id})">Editar</button> <button class="btn btn-danger btn-sm" onclick="deleteMedicamento(${m.id})">Eliminar</button></td></tr>`).join('')}</tbody></table></div>` : '<p>No hay medicamentos en el catálogo.</p>'}</div></div>`;
}

function openMedicamentoModal(id = null) {
  APP.editingId = id;
  document.getElementById('modal-title').textContent = id ? 'Editar Medicamento' : 'Nuevo Medicamento';
  (async () => {
    let m = { nombre: '', presentacion: '', concentracion: '' };
    if (id) m = await DB.get(DB.STORES.medicamentos, id) || m;
    document.getElementById('modal-body').innerHTML = `<div class="form-group"><label>Nombre *</label><input class="form-control" id="med-nombre" value="${escapeAttr(m.nombre)}"></div><div class="form-row"><div class="form-group"><label>Presentación</label><input class="form-control" id="med-presentacion" value="${escapeAttr(m.presentacion || '')}"></div><div class="form-group"><label>Concentración</label><input class="form-control" id="med-concentracion" value="${escapeAttr(m.concentracion || '')}"></div></div>`;
    document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveMedicamento()">Guardar</button>';
  })();
  document.getElementById('generic-modal').classList.add('show');
}

async function saveMedicamento() {
  const nombre = document.getElementById('med-nombre').value.trim();
  if (!nombre) return alert('El nombre es obligatorio');
  const data = { nombre, presentacion: document.getElementById('med-presentacion').value.trim(), concentracion: document.getElementById('med-concentracion').value.trim() };
  try {
    if (APP.editingId) { data.id = APP.editingId; await DB.put(DB.STORES.medicamentos, data); }
    else await DB.add(DB.STORES.medicamentos, data);
    closeModal(); renderMedicamentos();
  } catch (e) { alert('Error: ' + e.message); }
}

async function deleteMedicamento(id) {
  if (!confirm('¿Eliminar este medicamento del catálogo?')) return;
  await DB.remove(DB.STORES.medicamentos, id);
  renderMedicamentos();
}

// ========== ESTUDIOS ==========
async function renderEstudios() {
  const ests = await DB.getAll(DB.STORES.estudios);
  document.getElementById('content-area').innerHTML = `
    <div class="card"><div class="card-header"><h3>Catálogo de Estudios de Laboratorio</h3><button class="btn btn-primary btn-sm" onclick="openEstudioModal()">+ Nuevo Estudio</button></div><div class="card-body">
    ${ests.length ? `<div class="table-responsive"><table><thead><tr><th>Nombre</th><th>Precio</th><th>Acciones</th></tr></thead><tbody>${ests.map(e => `<tr><td>${escapeHtml(e.nombre)}</td><td>$${Number(e.precio || 0).toFixed(2)}</td><td><button class="btn btn-outline btn-sm" onclick="openEstudioModal(${e.id})">Editar</button> <button class="btn btn-danger btn-sm" onclick="deleteEstudio(${e.id})">Eliminar</button></td></tr>`).join('')}</tbody></table></div>` : '<p>No hay estudios en el catálogo.</p>'}</div></div>`;
}

function openEstudioModal(id = null) {
  APP.editingId = id;
  document.getElementById('modal-title').textContent = id ? 'Editar Estudio' : 'Nuevo Estudio';
  (async () => {
    let e = { nombre: '', precio: 0 };
    if (id) e = await DB.get(DB.STORES.estudios, id) || e;
    document.getElementById('modal-body').innerHTML = `<div class="form-group"><label>Nombre del estudio *</label><input class="form-control" id="est-nombre" value="${escapeAttr(e.nombre)}"></div><div class="form-group"><label>Precio</label><input type="number" step="0.01" class="form-control" id="est-precio" value="${e.precio || 0}"></div>`;
    document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveEstudio()">Guardar</button>';
  })();
  document.getElementById('generic-modal').classList.add('show');
}

async function saveEstudio() {
  const nombre = document.getElementById('est-nombre').value.trim();
  if (!nombre) return alert('El nombre es obligatorio');
  const data = { nombre, precio: parseFloat(document.getElementById('est-precio').value) || 0 };
  try {
    if (APP.editingId) { data.id = APP.editingId; await DB.put(DB.STORES.estudios, data); }
    else await DB.add(DB.STORES.estudios, data);
    closeModal(); renderEstudios();
  } catch (e) { alert('Error: ' + e.message); }
}

async function deleteEstudio(id) {
  if (!confirm('¿Eliminar este estudio del catálogo?')) return;
  await DB.remove(DB.STORES.estudios, id);
  renderEstudios();
}

// ========== COBROS ==========
async function renderCobros() {
  const cobros = await DB.getAll(DB.STORES.cobros);
  const hoy = new Date().toISOString().slice(0, 10);
  const delDia = cobros.filter(c => c.fecha && c.fecha.startsWith(hoy));
  const pagado = delDia.filter(c => c.status === 'pagado').reduce((s, c) => s + Number(c.monto || 0), 0);
  const pendiente = delDia.filter(c => c.status === 'pendiente').reduce((s, c) => s + Number(c.monto || 0), 0);

  document.getElementById('content-area').innerHTML = `
    <div class="stats-grid"><div class="stat-card"><div class="stat-info"><h4>$${pagado.toFixed(2)}</h4><p>Pagado hoy</p></div></div><div class="stat-card"><div class="stat-info"><h4>$${pendiente.toFixed(2)}</h4><p>Pendiente hoy</p></div></div></div>
    <div class="card"><div class="card-header"><h3>Cobros del día (${formatDate(hoy)})</h3><button class="btn btn-primary btn-sm" onclick="openCobroModal()">+ Nuevo Cobro</button></div><div class="card-body">
    ${delDia.length ? `<div class="table-responsive"><table><thead><tr><th>Hora</th><th>Concepto</th><th>Paciente / Ref.</th><th>Monto</th><th>Tipo</th><th>Estatus</th><th>Acciones</th></tr></thead><tbody>${delDia.map(c => `<tr><td>${new Date(c.fecha).toLocaleTimeString('es-MX', {hour:'2-digit',minute:'2-digit'})}</td><td>${escapeHtml(c.concepto || '—')}</td><td>${escapeHtml(c.referencia || '—')}</td><td>$${Number(c.monto || 0).toFixed(2)}</td><td>${c.tipo === 'laboratorio' ? 'Laboratorio' : 'Médico'}</td><td>${c.status === 'pagado' ? 'Pagado' : 'Pendiente'}</td><td><button class="btn btn-outline btn-sm" onclick="openCobroModal(${c.id})">Editar</button> ${c.status === 'pendiente' ? `<button class="btn btn-success btn-sm" onclick="marcarPagado(${c.id})">Marcar pagado</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p>No hay cobros registrados hoy.</p>'}</div></div>`;
}

function openCobroModal(id = null) {
  APP.editingId = id;
  document.getElementById('modal-title').textContent = id ? 'Editar Cobro' : 'Nuevo Cobro';
  (async () => {
    let c = { concepto: '', referencia: '', monto: '', tipo: 'medico', status: 'pagado', medicoId: null };
    if (id) c = await DB.get(DB.STORES.cobros, id) || c;
    const medicos = (await DB.getAll(DB.STORES.medicos)).filter(m => m.activo !== false);
    document.getElementById('modal-body').innerHTML = `
      <div class="form-group"><label>Concepto *</label><input class="form-control" id="cob-concepto" value="${escapeAttr(c.concepto || '')}"></div>
      <div class="form-group"><label>Paciente / Referencia</label><input class="form-control" id="cob-referencia" value="${escapeAttr(c.referencia || '')}"></div>
      <div class="form-row"><div class="form-group"><label>Monto *</label><input type="number" step="0.01" class="form-control" id="cob-monto" value="${c.monto || ''}"></div><div class="form-group"><label>Tipo</label><select class="form-control" id="cob-tipo"><option value="medico" ${c.tipo === 'medico' ? 'selected' : ''}>Médico</option><option value="laboratorio" ${c.tipo === 'laboratorio' ? 'selected' : ''}>Laboratorio</option></select></div><div class="form-group"><label>Estatus</label><select class="form-control" id="cob-status"><option value="pagado" ${c.status === 'pagado' ? 'selected' : ''}>Pagado</option><option value="pendiente" ${c.status === 'pendiente' ? 'selected' : ''}>Pendiente</option></select></div></div>
      <div class="form-group"><label>Médico</label><select class="form-control" id="cob-medicoId"><option value="">—</option>${medicos.map(m => `<option value="${m.id}" ${c.medicoId == m.id ? 'selected' : ''}>${escapeHtml(m.nombre)}</option>`).join('')}</select></div>`;
    document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveCobro()">Guardar</button>';
  })();
  document.getElementById('generic-modal').classList.add('show');
}

async function saveCobro() {
  const concepto = document.getElementById('cob-concepto').value.trim();
  const monto = parseFloat(document.getElementById('cob-monto').value);
  if (!concepto || Number.isNaN(monto)) return alert('Concepto y monto son obligatorios');

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
      const old = await DB.get(DB.STORES.cobros, APP.editingId);
      data.id = APP.editingId;
      data.fecha = old.fecha;
      data.audit = old.audit || [];
      data.audit.push({ fecha: new Date().toISOString(), accion: 'modificación', anterior: { monto: old.monto, status: old.status, concepto: old.concepto } });
      await DB.put(DB.STORES.cobros, data);
    } else await DB.add(DB.STORES.cobros, data);
    closeModal(); renderCobros();
  } catch (e) { alert('Error: ' + e.message); }
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
  const totalMedico = pagados.filter(c => c.tipo === 'medico').reduce((s, c) => s + Number(c.monto || 0), 0);
  const totalLab = pagados.filter(c => c.tipo === 'laboratorio').reduce((s, c) => s + Number(c.monto || 0), 0);
  const porMedico = {};
  pagados.forEach(c => {
    const key = c.medicoId || 'sin_medico';
    porMedico[key] = (porMedico[key] || 0) + Number(c.monto || 0);
  });

  document.getElementById('content-area').innerHTML = `
    <div class="stats-grid"><div class="stat-card"><div class="stat-info"><h4>$${totalMedico.toFixed(2)}</h4><p>Cobros médicos</p></div></div><div class="stat-card"><div class="stat-info"><h4>$${totalLab.toFixed(2)}</h4><p>Cobros laboratorio</p></div></div><div class="stat-card"><div class="stat-info"><h4>$${(totalMedico + totalLab).toFixed(2)}</h4><p>Total general</p></div></div></div>
    <div class="card"><div class="card-header"><h3>Desglose por médico</h3><button class="btn btn-primary btn-sm" onclick="imprimirBalance()">Imprimir PDF</button></div><div class="card-body"><div class="table-responsive"><table><thead><tr><th>Médico</th><th>Total cobrado</th></tr></thead><tbody>
    ${Object.entries(porMedico).map(([key, monto]) => {
      const nombre = key === 'sin_medico' ? 'Sin médico asignado' : (medicos.find(m => m.id == key)?.nombre || `ID ${key}`);
      return `<tr><td>${escapeHtml(nombre)}</td><td>$${monto.toFixed(2)}</td></tr>`;
    }).join('') || '<tr><td colspan="2">Sin datos</td></tr>'}
    </tbody></table></div></div></div>
    <div class="card"><div class="card-header"><h3>Historial de modificaciones</h3></div><div class="card-body">
    ${(() => {
      const audits = [];
      cobros.forEach(c => (c.audit || []).forEach(a => audits.push({ ...a, concepto: c.concepto, id: c.id })));
      return audits.length ? `<div class="table-responsive"><table><thead><tr><th>Fecha</th><th>Cobro</th><th>Acción</th></tr></thead><tbody>${audits.slice(-20).reverse().map(a => `<tr><td>${formatDate(a.fecha)}</td><td>${escapeHtml(a
