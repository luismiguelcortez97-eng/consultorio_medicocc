/* =====================================================
   Consultorio Médico CC - Aplicación principal
   ===================================================== */

const APP = {
  currentUser: null,
  currentRole: 'admin',
  currentModule: 'dashboard',
  chatTimer: null,
  chatLastMessageId: null,
  chatAudioContext: null,
  agendaMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  agendaSelectedDate: localDateString(new Date()),
  editingId: null,
  tempConsulta: null, // for building consultation
  unlockedCobros: false,
  unlockedBalance: false,
  personalAccessGranted: false
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
    APP.currentRole = session.role || 'admin';
    document.querySelector('.topbar-actions .text-muted').textContent = session.displayName || session.username;
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
      // En Safari/iPhone, cerrar el menú lateral al elegir cualquier apartado.
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) sidebar.classList.remove('open');
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
    APP.currentRole = session.role || 'admin';
    document.querySelector('.topbar-actions .text-muted').textContent = session.displayName || session.username;
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
  APP.currentRole = 'admin';
  APP.unlockedCobros = false;
  APP.unlockedBalance = false;
  showLogin();
}

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function showApp() {
  aplicarTemaGuardado();
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  ['personal', 'empleados', 'balance'].forEach(function (module) {
    const item = document.querySelector('.nav-item[data-module="' + module + '"]');
    if (item) item.style.display = APP.currentRole === 'admin' ? 'flex' : 'none';
  });
  // Cobros es accesible para todos los roles autenticados, incluida Enfermería.
  const cobrosNav = document.querySelector('.nav-item[data-module="cobros"]');
  if (cobrosNav) cobrosNav.style.display = 'flex';
  navigateTo('dashboard');
  if (APP.chatWatchTimer) clearInterval(APP.chatWatchTimer);
  APP.chatLastMessageId = null;
  APP.chatCheckInProgress = false;
  APP.chatWatchTimer = setInterval(async function () {
    if (!APP.currentUser || APP.chatCheckInProgress) return;
    APP.chatCheckInProgress = true;
    try {
      const messages = await DB.getAll('chat');
      procesarNotificacionesChat(messages);
      const maxId = messages.reduce(function (max, m) { return Math.max(max, Number(m.id) || 0); }, 0);
      const key = 'cmcc_chat_last_seen_' + APP.currentUser;
      const lastSeen = Number(localStorage.getItem(key) || 0);
      const dot = document.getElementById('chat-unread-dot');
      if (dot) dot.hidden = APP.currentModule === 'chat' || maxId <= lastSeen;
    } catch (e) { console.debug('No se pudo revisar chat', e); }
    finally { APP.chatCheckInProgress = false; }
  }, 1000);
}

// ========== SONIDO DE NOTIFICACIÓN DEL CHAT (SOLO ENFERMERÍA) ==========
function prepararAudioChat() {
  if (APP.currentRole !== 'enfermeria') return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!APP.chatAudioContext) APP.chatAudioContext = new AudioCtx();
    if (APP.chatAudioContext.state === 'suspended') APP.chatAudioContext.resume().catch(function () {});
  } catch (e) { console.debug('Audio de chat no disponible', e); }
}

document.addEventListener('pointerdown', prepararAudioChat);
document.addEventListener('keydown', prepararAudioChat);

function procesarNotificacionesChat(messages) {
  const maxId = messages.reduce(function (max, m) { return Math.max(max, Number(m.id) || 0); }, 0);
  // La primera lectura establece una referencia y evita sonidos por mensajes antiguos.
  if (APP.chatLastMessageId === null) {
    APP.chatLastMessageId = maxId;
    return;
  }
  const nuevos = messages.filter(function (m) {
    return Number(m.id) > APP.chatLastMessageId && m.senderUsername !== APP.currentUser;
  });
  APP.chatLastMessageId = Math.max(APP.chatLastMessageId, maxId);
  if (APP.currentRole === 'enfermeria' && nuevos.length) reproducirSonidoChat();
}

function reproducirSonidoChat() {
  if (APP.currentRole !== 'enfermeria') return;
  prepararAudioChat();
  const ctx = APP.chatAudioContext;
  if (!ctx || ctx.state !== 'running') return;
  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.23);
  } catch (e) { console.debug('No se pudo reproducir el sonido del chat', e); }
}

// ========== NAVIGATION ==========
async function navigateTo(module) {
  if (APP.chatTimer && module !== 'chat') {
    clearInterval(APP.chatTimer);
    APP.chatTimer = null;
  }
  if (['personal', 'empleados', 'balance'].includes(module) && APP.currentRole !== 'admin') {
    alert('Esta sección es exclusiva del administrador.');
    return;
  }
  // Check NIP for protected modules
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
    configuracion: 'Configuración',
    pacientes: 'Pacientes y Expedientes',
    consultas: 'Consultas Médicas',
    agenda: 'Agenda mensual de consultas',
    citasweb: 'Configuración de citas web',
    chat: 'Chat interno del personal',
    recetas: 'Receta independiente',
    personal: 'Accesos del personal',
    empleados: 'Empleados',
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
      case 'configuracion': renderConfiguracion(); break;
      case 'pacientes': await renderPacientes(); break;
      case 'consultas': await renderConsultas(); break;
      case 'agenda': await renderAgenda(); break;
      case 'citasweb': await renderCitasWeb(); break;
      case 'chat': await renderChat(); break;
      case 'recetas': await renderRecetas(); break;
      case 'personal': await renderPersonal(); break;
      case 'empleados': await renderEmpleados(); break;
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



async function renderCitasWeb() {
 const area=document.getElementById('content-area'),days=[['0','Domingo'],['1','Lunes'],['2','Martes'],['3','Miércoles'],['4','Jueves'],['5','Viernes'],['6','Sábado']];
 area.innerHTML=`<div class="card"><div class="card-header"><div><h3>Configuración de la página de citas</h3><p class="text-muted">Configura horarios y teléfonos que verán los pacientes.</p></div></div><div class="card-body"><form id="citasweb-form"><h4>Días de atención</h4><div class="citasweb-days">${days.map(d=>'<label class="citasweb-day"><input type="checkbox" name="citasweb-day" value="'+d[0]+'"><span>'+d[1]+'</span></label>').join('')}</div><div class="form-row mt-3"><div class="form-group"><label for="citasweb-start">Hora de inicio</label><select class="form-control" id="citasweb-start">${Array.from({length:24},(_,i)=>'<option value="'+i+'">'+String(i).padStart(2,'0')+':00</option>').join('')}</select></div><div class="form-group"><label for="citasweb-end">Hora de término</label><select class="form-control" id="citasweb-end">${Array.from({length:24},(_,i)=>'<option value="'+(i+1)+'">'+String(i+1).padStart(2,'0')+':00</option>').join('')}<option value="24">24:00</option></select></div></div><hr><h4>WhatsApp público del consultorio</h4><div class="form-group"><label for="citasweb-whatsapp">Número que verán los pacientes</label><input class="form-control" id="citasweb-whatsapp" type="tel" inputmode="tel" maxlength="25" placeholder="+52 686 123 4567" autocomplete="tel"></div><h4>Notificaciones de nuevas citas por correo</h4><div class="form-group"><label for="citasweb-notification-email">Correo que recibirá las notificaciones</label><input class="form-control" id="citasweb-notification-email" type="email" maxlength="254" placeholder="luismiguelcortez97@gmail.com" autocomplete="email" value="luismiguelcortez97@gmail.com"><small class="text-muted">Puedes cambiar este correo cuando lo necesites. El envío automático requiere configurar el servicio de correo en el servidor.</small></div><h4>Teléfono para llamadas</h4><div class="form-group"><label for="citasweb-phone">Número telefónico con lada</label><input class="form-control" id="citasweb-phone" type="tel" inputmode="tel" maxlength="25" placeholder="+52 686 123 4567" autocomplete="tel"></div><div id="citasweb-status" role="status" aria-live="polite"></div><button class="btn btn-primary mt-2" id="citasweb-save" type="submit">Guardar configuración</button></form></div></div>
 <div class="card mt-3"><div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h3>Solicitudes de citas web</h3><p class="text-muted">Confirma una solicitud para incorporarla a Agenda mensual.</p></div><button class="btn btn-outline btn-sm" type="button" id="citasweb-refresh">Actualizar lista</button></div><div class="card-body"><div id="citasweb-list-status" role="status" aria-live="polite"></div><div class="table-responsive" id="citasweb-table-wrap"><p>Cargando solicitudes…</p></div></div></div>
 <style>.citasweb-days{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}.citasweb-day{display:flex;align-items:center;gap:8px;padding:10px;border:1px solid var(--border-color,#d7dee8);border-radius:8px}.citasweb-day input{width:18px;height:18px}.citasweb-status{display:inline-block;padding:4px 8px;border-radius:99px;background:#fff1d6;color:#825500;font-size:.82rem;font-weight:600}.citasweb-status-confirmed{background:#e4f6e9;color:#176b39}.citasweb-actions{display:flex;gap:6px;flex-wrap:wrap;min-width:170px}</style>`;
 const form=document.getElementById('citasweb-form'),status=document.getElementById('citasweb-status'),save=document.getElementById('citasweb-save'),listStatus=document.getElementById('citasweb-list-status'),wrap=document.getElementById('citasweb-table-wrap');
 const canEditBookingSettings=APP.currentRole==='admin';
 if(!canEditBookingSettings){form.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);save.hidden=true;status.className='alert alert-info';status.textContent='Puedes consultar las citas, confirmarlas o eliminarlas. Solo el administrador puede modificar teléfonos, correo y horarios.';}
 try{const r=await fetch('/api/admin/public-booking-settings',{credentials:'same-origin'}),d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo cargar.');const s=d.settings||{},chosen=Array.isArray(s.days)?s.days.map(String):['1','2','3','4','5','6'];form.querySelectorAll('[name="citasweb-day"]').forEach(x=>x.checked=chosen.includes(x.value));document.getElementById('citasweb-start').value=String(s.startHour??9);document.getElementById('citasweb-end').value=String(s.endHour??17);document.getElementById('citasweb-whatsapp').value=s.whatsapp||'';document.getElementById('citasweb-notification-email').value=s.notificationEmail||'luismiguelcortez97@gmail.com';document.getElementById('citasweb-phone').value=s.phone||'';if(d.emailNotificationConfigured===false){status.className='alert alert-warning';status.textContent='El correo está guardado, pero falta configurar Brevo en el servidor para activar los avisos automáticos.';}}catch(e){status.className='alert alert-danger';status.textContent=e.message;}
 form.addEventListener('submit',async e=>{e.preventDefault();const s={days:Array.from(form.querySelectorAll('[name="citasweb-day"]:checked')).map(x=>Number(x.value)),startHour:Number(document.getElementById('citasweb-start').value),endHour:Number(document.getElementById('citasweb-end').value),whatsapp:document.getElementById('citasweb-whatsapp').value.trim(),notificationEmail:document.getElementById('citasweb-notification-email').value.trim(),phone:document.getElementById('citasweb-phone').value.trim()};if(!s.days.length||s.endHour<=s.startHour){status.className='alert alert-warning';status.textContent='Selecciona días y un horario válido.';return;}if([s.whatsapp,s.phone].some(n=>n&&!/^[+()\d .-]{7,25}$/.test(n))||(s.notificationEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.notificationEmail))){status.className='alert alert-warning';status.textContent='Revisa los teléfonos y el correo electrónico.';return;}save.disabled=true;try{const r=await fetch('/api/admin/public-booking-settings',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)}),d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo guardar.');status.className=d.emailNotificationConfigured?'alert alert-success':'alert alert-warning';status.textContent=d.emailNotificationConfigured?'Configuración guardada. Los avisos por correo están configurados.':'Configuración guardada. Para activar avisos, falta configurar Brevo en el servidor.';}catch(err){status.className='alert alert-danger';status.textContent=err.message;}finally{save.disabled=false;}});
 async function loadRequests(){listStatus.textContent='';wrap.innerHTML='<p>Cargando solicitudes…</p>';try{const r=await fetch('/api/admin/public-appointments',{credentials:'same-origin',cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||'No se pudieron cargar las solicitudes.');if(!d.length){wrap.innerHTML='<div class="empty-state"><p>No hay solicitudes de citas web.</p></div>';return;}wrap.innerHTML='<table><thead><tr><th>Paciente</th><th>Tipo de paciente</th><th>Fecha y hora</th><th>Teléfono</th><th>Motivo</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>'+d.map(c=>{const confirmed=c.estado==='Confirmada';return '<tr><td><strong>'+featureEscape(c.paciente||'—')+'</strong><div class="text-muted" style="font-size:.82rem">'+(c.edad!=null?'Edad: '+featureEscape(c.edad)+' años':'')+(c.fechaNacimiento?' · Nacimiento: '+featureEscape(c.fechaNacimiento):'')+'</div></td><td><span class="citasweb-status '+(c.tipoPaciente==='membresia'?'citasweb-status-confirmed':'')+'">'+(c.tipoPaciente==='membresia'?'Paciente con membresía':'Paciente particular')+'</span>'+(c.tipoPaciente==='membresia'?'<div class="text-muted" style="font-size:.82rem">Folio: '+featureEscape(c.folioMembresia||'—')+'</div>':'')+'</td><td>'+featureEscape(c.fecha||'—')+'<br>'+featureEscape(c.hora||'—')+'</td><td>'+featureEscape(c.telefonoContacto||'—')+'</td><td>'+featureEscape(c.motivo||c.tipoCita||'—')+'</td><td><span class="citasweb-status '+(confirmed?'citasweb-status-confirmed':'')+'">'+(confirmed?'Confirmada':'Pendiente')+'</span></td><td><div class="citasweb-actions">'+(!confirmed?'<button class="btn btn-success btn-sm" type="button" data-citasweb-action="confirm" data-id="'+Number(c.id)+'">Confirmar cita</button>':'<span class="text-muted">En Agenda mensual</span>')+'<button class="btn btn-danger btn-sm" type="button" data-citasweb-action="delete" data-id="'+Number(c.id)+'">Eliminar</button></div></td></tr>';}).join('')+'</tbody></table>';}catch(e){wrap.innerHTML='';listStatus.className='alert alert-danger';listStatus.textContent=e.message;}}
 document.getElementById('citasweb-refresh').addEventListener('click',loadRequests);
 wrap.addEventListener('click',async e=>{const b=e.target.closest('button[data-citasweb-action]');if(!b)return;const id=b.dataset.id,action=b.dataset.citaswebAction;if(action==='delete'&&!confirm('¿Eliminar esta solicitud de cita? Solo se eliminará la cita; no se borrará el expediente médico.'))return;if(action==='confirm'&&!confirm('¿Confirmar esta cita y agregarla a Agenda mensual?'))return;b.disabled=true;try{const url=action==='confirm'?'/api/admin/public-appointments/'+encodeURIComponent(id)+'/confirm':'/api/admin/public-appointments/'+encodeURIComponent(id);const r=await fetch(url,{method:action==='confirm'?'PUT':'DELETE',credentials:'same-origin',headers:{'Content-Type':'application/json'}}),d=await r.json();if(!r.ok)throw Error(d.error||'No se pudo actualizar la solicitud.');listStatus.className='alert alert-success';listStatus.textContent=action==='confirm'?'Cita confirmada y agregada a Agenda mensual.':'Solicitud eliminada.';await loadRequests();}catch(err){listStatus.className='alert alert-danger';listStatus.textContent=err.message;b.disabled=false;}});
 await loadRequests();
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
  const consultas = (await DB.getAll(DB.STORES.consultas)).filter(c => !c.eliminada);
  const hoy = localDateString(new Date());
  const offsetMinutos = new Date().getTimezoneOffset();
  const resumenCobros = APP.currentRole === 'admin' ? await DB.getCobrosHoy(hoy, offsetMinutos) : { total: 0 };
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
          <h4>${APP.currentRole === 'admin' ? String.fromCharCode(36) + totalHoy.toFixed(2) : '—'}</h4>
          <p>${APP.currentRole === 'admin' ? 'Cobrado hoy' : 'Dato reservado'}</p>
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
    let m = { nombre: '', especialidad: '', cedula: '', cedulaEsp: '', domicilio: '', telefono: '', institucion: '', honorarios: '', activo: true };
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
      <div class="form-group">
        <label>Nombre de la institución / consultorio</label>
        <input type="text" class="form-control" id="m-institucion" value="${escapeAttr(m.institucion || '')}" placeholder="Nombre que aparecerá en la receta">
      </div>
      <div class="form-group">
        <label>Honorarios habituales por consulta (MXN)</label>
        <input type="number" min="0" step="0.01" class="form-control" id="m-honorarios" value="${m.honorarios == null ? '' : escapeAttr(m.honorarios)}" placeholder="Ej. 800">
        <small class="text-muted">Este importe se sugerirá al registrar el cobro. Puede cambiarse en cada consulta.</small>
      </div>
    `;

    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="saveMedico()">Guardar</button>
    `;
    const fechaTexto = document.getElementById('p-fechaNac-text');
    const fechaCalendario = document.getElementById('p-fechaNac-calendario');
    fechaCalendario.addEventListener('change', function () {
      fechaTexto.value = this.value ? this.value.slice(8, 10) + '/' + this.value.slice(5, 7) + '/' + this.value.slice(0, 4) : '';
      fechaTexto.setCustomValidity('');
    });
    fechaTexto.addEventListener('input', function () {
      const iso = convertirFechaNacimientoAISO(this.value);
      fechaTexto.setCustomValidity(this.value.trim() && !iso ? 'Fecha inválida. Usa DD/MM/AAAA con año de cuatro dígitos.' : '');
      if (iso) fechaCalendario.value = iso;
      else if (!this.value.trim()) fechaCalendario.value = '';
    });
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

  const campoFechaNacimiento = document.getElementById('p-fechaNac-text');
  const fechaNac = convertirFechaNacimientoAISO(campoFechaNacimiento.value);
  if (campoFechaNacimiento.value.trim() && !fechaNac) {
    campoFechaNacimiento.setCustomValidity('Fecha inválida. Usa DD/MM/AAAA con año de cuatro dígitos.');
    campoFechaNacimiento.reportValidity();
    return;
  }
  campoFechaNacimiento.setCustomValidity('');

  const data = {
    nombre,
    especialidad: document.getElementById('m-especialidad').value.trim(),
    cedula: document.getElementById('m-cedula').value.trim(),
    cedulaEsp: document.getElementById('m-cedulaEsp').value.trim(),
    domicilio: document.getElementById('m-domicilio').value.trim(),
    telefono: document.getElementById('m-telefono').value.trim(),
    institucion: document.getElementById('m-institucion').value.trim(),
    honorarios: document.getElementById('m-honorarios').value.trim() === '' ? null : Number(document.getElementById('m-honorarios').value),
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
        <div class="pacientes-buscador">
          <label for="pacientes-busqueda"><strong>Buscar paciente registrado</strong></label>
          <input type="search" class="form-control" id="pacientes-busqueda"
            name="patient_lookup_query"
            placeholder="Escribe nombre, apellido o teléfono..."
            autocomplete="new-password" autocapitalize="none" spellcheck="false"
            data-lpignore="true" data-1p-ignore="true" data-bwignore="true"
            aria-describedby="pacientes-busqueda-ayuda" role="searchbox">
          <small id="pacientes-busqueda-ayuda" class="text-muted">Busca antes de crear un expediente para verificar si el paciente ya está registrado.</small>
        </div>
        <p id="pacientes-busqueda-resumen" class="text-muted" aria-live="polite"></p>
        <div id="pacientes-listado">
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
                <tbody id="pacientes-tabla-cuerpo">
                  ${pacientes.map(p => `
                    <tr data-paciente-busqueda="${escapeAttr([p.nombre || '', p.telefono || '', p.fechaNac || '', p.genero || '', getMedicoName(p.medicoId)].join(' '))}">
                      <td><strong>${escapeHtml(p.nombre || '—')}</strong></td>
                      <td>${p.fechaNac ? escapeHtml(formatBirthDate(p.fechaNac)) : '—'}</td>
                      <td>${escapeHtml(p.genero || '—')}</td>
                      <td>${escapeHtml(p.telefono || '—')}</td>
                      <td>${escapeHtml(getMedicoName(p.medicoId))}</td>
                      <td>
                        <button class="btn btn-outline btn-sm" onclick="verPaciente(${p.id})">Ver datos</button>
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
    </div>
  `;

  const busqueda = document.getElementById('pacientes-busqueda');
  const resumen = document.getElementById('pacientes-busqueda-resumen');
  const listado = document.getElementById('pacientes-listado');
  const cuerpo = document.getElementById('pacientes-tabla-cuerpo');

  function normalizarTexto(valor) {
    return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-MX').trim();
  }

  function filtrarPacientes() {
    const termino = normalizarTexto(busqueda.value);
    if (!pacientes.length) {
      resumen.textContent = 'Todavía no hay pacientes registrados.';
      return;
    }

    const filas = cuerpo ? Array.from(cuerpo.querySelectorAll('tr[data-paciente-busqueda]')) : [];
    let coincidencias = 0;
    filas.forEach(function (fila) {
      const coincide = !termino || normalizarTexto(fila.getAttribute('data-paciente-busqueda')).includes(termino);
      fila.hidden = !coincide;
      if (coincide) coincidencias++;
    });

    let sinResultados = document.getElementById('pacientes-sin-resultados');
    if (termino && coincidencias === 0) {
      if (!sinResultados && cuerpo) {
        sinResultados = document.createElement('tr');
        sinResultados.id = 'pacientes-sin-resultados';
        sinResultados.innerHTML = '<td colspan="6" class="text-muted">No se encontraron pacientes con ese nombre o teléfono. Verifica la búsqueda antes de registrar uno nuevo.</td>';
        cuerpo.appendChild(sinResultados);
      }
      if (sinResultados) sinResultados.hidden = false;
    } else if (sinResultados) {
      sinResultados.hidden = true;
    }

    resumen.textContent = termino
      ? 'Coincidencias: ' + coincidencias + ' de ' + pacientes.length + ' pacientes.'
      : 'Pacientes registrados: ' + pacientes.length + '. Escribe para filtrar la lista.';
  }

  busqueda.addEventListener('input', filtrarPacientes);
  filtrarPacientes();
}

async function verPaciente(id) {
  const p = await DB.get(DB.STORES.pacientes, Number(id));
  if (!p) return alert('No se encontró el paciente.');
  const [medicos, consultas] = await Promise.all([DB.getAll(DB.STORES.medicos), DB.getAll(DB.STORES.consultas)]);
  const medico = medicos.find(m => String(m.id) === String(p.medicoId));
  const historial = consultas.filter(c => !c.eliminada && String(c.pacienteId) === String(p.id)).sort((a,b) => String(b.fecha||'').localeCompare(String(a.fecha||'')));
  const edad = calcularEdad(obtenerFechaNacimientoPaciente(p));
  document.getElementById('modal-title').textContent = 'Datos del paciente';
  document.getElementById('modal-body').innerHTML = `
    <p><strong>Nombre:</strong> ${escapeHtml(p.nombre || '—')}</p>
    <p><strong>Fecha de nacimiento:</strong> ${escapeHtml(obtenerFechaNacimientoPaciente(p) ? formatBirthDate(obtenerFechaNacimientoPaciente(p)) : '—')}</p>
    <p><strong>Edad:</strong> ${edad == null ? '—' : edad + ' años'}</p>
    <p><strong>Género:</strong> ${escapeHtml(p.genero || '—')}</p>
    <p><strong>Teléfono:</strong> ${escapeHtml(p.telefono || '—')}</p>
    <p><strong>Dirección:</strong> ${escapeHtml(p.direccion || '—')}</p>
    <p><strong>Médico asignado:</strong> ${escapeHtml(medico ? medico.nombre : '—')}</p>
    <hr><h4>Historial de consultas</h4>
    ${historial.length ? '<div class="table-responsive"><table><thead><tr><th>Fecha</th><th>Motivo</th><th></th></tr></thead><tbody>' + historial.map(c => '<tr><td>' + escapeHtml(formatDate(c.fecha)) + '</td><td>' + escapeHtml(c.motivo || '—') + '</td><td><button class="btn btn-outline btn-sm" onclick="closeModal();verConsulta(' + Number(c.id) + ')">Ver consulta</button></td></tr>').join('') + '</tbody></table></div>' : '<p class="text-muted">Este paciente aún no tiene consultas registradas.</p>'}
  `;
  document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cerrar</button><button class="btn btn-primary" onclick="closeModal();openPacienteModal(' + Number(p.id) + ')">Editar paciente</button>';
  document.getElementById('generic-modal').classList.add('show');
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
          <label for="p-fechaNac-text">Fecha de nacimiento</label>
          <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem;align-items:center">
            <input type="text" class="form-control" id="p-fechaNac-text" inputmode="numeric" autocomplete="bday" placeholder="DD/MM/AAAA" maxlength="10" aria-describedby="p-fechaNac-ayuda" value="${escapeAttr(formatearFechaNacimientoEntrada(p.fechaNac || p.fechaNacimiento || p.fecha_nacimiento || ''))}">
            <label class="btn btn-outline" for="p-fechaNac-calendario" style="margin:0;white-space:nowrap;cursor:pointer">📅 Calendario</label>
            <input type="date" id="p-fechaNac-calendario" aria-label="Elegir fecha de nacimiento en calendario" value="${escapeAttr(normalizarFechaNacimientoISO(p.fechaNac || p.fechaNacimiento || p.fecha_nacimiento || ''))}" style="max-width:100%;grid-column:1 / -1">
          </div>
          <small id="p-fechaNac-ayuda" class="text-muted">Escribe DD/MM/AAAA o selecciona la fecha en el calendario. El año debe tener 4 dígitos.</small>
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
      <button class="btn btn-primary" type="button" onclick="savePaciente()">Guardar</button>
    `;

    // Mantener sincronizados el campo de fecha escrita y el calendario.
    const fechaTexto = document.getElementById('p-fechaNac-text');
    const fechaCalendario = document.getElementById('p-fechaNac-calendario');
    fechaTexto.addEventListener('input', () => {
      const iso = convertirFechaNacimientoAISO(fechaTexto.value);
      if (iso) fechaCalendario.value = iso;
      else if (!fechaTexto.value.trim()) fechaCalendario.value = '';
    });
    fechaCalendario.addEventListener('change', () => {
      fechaTexto.value = fechaCalendario.value
        ? formatearFechaNacimientoEntrada(fechaCalendario.value)
        : '';
      fechaTexto.setCustomValidity('');
    });
  };

  load();
  modal.classList.add('show');
}

async function savePaciente() {
  const nombre = document.getElementById('p-nombre').value.trim();
  const campoFechaTexto = document.getElementById('p-fechaNac-text');
  const campoFechaCalendario = document.getElementById('p-fechaNac-calendario');
  const fechaEscrita = campoFechaTexto.value.trim();
  const fechaNac = fechaEscrita
    ? convertirFechaNacimientoAISO(fechaEscrita)
    : normalizarFechaNacimientoISO(campoFechaCalendario.value);

  if (!nombre) {
    alert('El nombre es obligatorio');
    document.getElementById('p-nombre').focus();
    return;
  }

  if (fechaEscrita && !fechaNac) {
    campoFechaTexto.setCustomValidity('Fecha inválida. Usa DD/MM/AAAA con año de cuatro dígitos.');
    campoFechaTexto.reportValidity();
    campoFechaTexto.focus();
    return;
  }
  campoFechaTexto.setCustomValidity('');

  const data = {
    nombre,
    fechaNac,
    genero: document.getElementById('p-genero').value,
    telefono: document.getElementById('p-telefono').value.trim(),
    direccion: document.getElementById('p-direccion').value.trim(),
    medicoId: document.getElementById('p-medicoId').value
      ? parseInt(document.getElementById('p-medicoId').value, 10)
      : null
  };

  const botonGuardar = document.querySelector('#modal-footer button[onclick="savePaciente()"]');
  if (botonGuardar) {
    botonGuardar.disabled = true;
    botonGuardar.textContent = 'Guardando...';
  }

  try {
    if (APP.editingId) {
      data.id = APP.editingId;
      await DB.put(DB.STORES.pacientes, data);
    } else {
      await DB.add(DB.STORES.pacientes, data);
    }
    closeModal();
    await renderPacientes();
  } catch (err) {
    alert('No se pudo guardar el paciente: ' + (err && err.message ? err.message : 'Error desconocido'));
  } finally {
    if (botonGuardar) {
      botonGuardar.disabled = false;
      botonGuardar.textContent = 'Guardar';
    }
  }
}

async function deletePaciente(id) {
  if (!confirm('¿Eliminar este paciente? Esta acción no se puede deshacer.')) return;
  await DB.remove(DB.STORES.pacientes, id);
  renderPacientes();
}

// ========== CONSULTAS ==========
async function renderConsultas() {
  const consultas = (await DB.getAll(DB.STORES.consultas)).filter(c => !c.eliminada);
  const area = document.getElementById('content-area');
  const fechaHoy = localDateString(new Date());

  area.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3>Consultas Médicas</h3>
        <button class="btn btn-primary btn-sm" onclick="openConsultaModal()">+ Nueva Consulta</button>
      </div>
      <div class="card-body">
        <div class="consultas-filtros">
          <div class="form-group">
            <label for="consultas-filtro-tipo">Mostrar consultas</label>
            <select class="form-control" id="consultas-filtro-tipo">
              <option value="todas">Todas las consultas</option>
              <option value="dia">Por día</option>
              <option value="semana">Por semana</option>
            </select>
          </div>
          <div class="form-group">
            <label for="consultas-filtro-fecha">Fecha de referencia</label>
            <input class="form-control" id="consultas-filtro-fecha" type="date" value="${fechaHoy}">
          </div>
          <p id="consultas-filtro-resumen" class="text-muted" aria-live="polite"></p>
        </div>
        <div id="consultas-tabla"></div>
      </div>
    </div>
  `;

  const tipoFiltro = document.getElementById('consultas-filtro-tipo');
  const fechaFiltro = document.getElementById('consultas-filtro-fecha');
  const tabla = document.getElementById('consultas-tabla');
  const resumen = document.getElementById('consultas-filtro-resumen');

  async function actualizarTabla() {
    const tipo = tipoFiltro.value;
    const fecha = fechaFiltro.value || fechaHoy;
    let inicioSemana = '';
    let finSemana = '';

    if (tipo === 'semana') {
      const partes = fecha.split('-').map(Number);
      const seleccionada = new Date(partes[0], partes[1] - 1, partes[2]);
      seleccionada.setHours(0, 0, 0, 0);
      const lunes = new Date(seleccionada);
      lunes.setDate(lunes.getDate() - ((lunes.getDay() + 6) % 7));
      const siguienteLunes = new Date(lunes);
      siguienteLunes.setDate(siguienteLunes.getDate() + 7);
      inicioSemana = localDateString(lunes);
      finSemana = localDateString(siguienteLunes);
    }

    const filtradas = consultas.filter(function (c) {
      const fechaConsulta = String(c.fecha || '').slice(0, 10);
      if (tipo === 'dia') return fechaConsulta === fecha;
      if (tipo === 'semana') return fechaConsulta >= inicioSemana && fechaConsulta < finSemana;
      return true;
    }).sort(function (a, b) {
      return String(b.fecha || '').localeCompare(String(a.fecha || ''));
    });

    if (tipo === 'dia') resumen.textContent = 'Consultas del ' + formatDate(fecha) + ': ' + filtradas.length;
    else if (tipo === 'semana') resumen.textContent = 'Semana del ' + formatDate(inicioSemana) + ' al ' + formatDate(localDateString(new Date(new Date(finSemana + 'T00:00:00').getTime() - 86400000))) + ': ' + filtradas.length;
    else resumen.textContent = 'Todas las consultas: ' + filtradas.length;

    if (!filtradas.length) {
      tabla.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>No hay consultas para el periodo seleccionado.</p></div>';
      return;
    }

    const filas = await Promise.all(filtradas.map(async function (c) {
      const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
      const m = await DB.get(DB.STORES.medicos, c.medicoId);
      return `<tr>
        <td>${formatDate(c.fecha)}</td>
        <td>${p ? escapeHtml(p.nombre) + '<div class="text-muted" style="font-size:.82rem">Edad: ' + (calcularEdad(obtenerFechaNacimientoPaciente(p)) == null ? '—' : calcularEdad(obtenerFechaNacimientoPaciente(p)) + ' años') + ' · Nacimiento: ' + escapeHtml(obtenerFechaNacimientoPaciente(p) || '—') + ' · Tel: ' + escapeHtml(p.telefono || '—') + '</div><button class="btn btn-outline btn-sm" onclick="verPaciente(' + Number(p.id) + ')">Datos del paciente</button>' : '—'}</td>
        <td>${m ? escapeHtml(m.nombre) : '—'}</td>
        <td>${escapeHtml((c.motivo || '').substring(0, 50))}${(c.motivo || '').length > 50 ? '…' : ''}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="verConsulta(${c.id})">Ver</button>
          <button class="btn btn-outline btn-sm" onclick="openConsultaModal(${c.id})">Editar consulta</button>
          <button class="btn btn-primary btn-sm" onclick="elegirTipoReceta(${c.id})">Receta</button>
          <button class="btn btn-success btn-sm" onclick="registrarCobroConsulta(${c.id})">${c.cobroId ? 'Ver cobro registrado' : 'Registrar cobros'}</button>
          <button class="btn btn-danger btn-sm" onclick="eliminarConsulta(${c.id})">Eliminar</button>
        </td>
      </tr>`;
    }));

    tabla.innerHTML = '<div class="table-responsive"><table><thead><tr><th>Fecha</th><th>Paciente</th><th>Médico</th><th>Motivo</th><th>Acciones</th></tr></thead><tbody>' + filas.join('') + '</tbody></table></div>';
  }

  tipoFiltro.addEventListener('change', actualizarTabla);
  fechaFiltro.addEventListener('change', actualizarTabla);
  await actualizarTabla();
}

async function eliminarConsulta(id) {
  try {
    const consulta = await DB.get(DB.STORES.consultas, id);
    if (!consulta || consulta.eliminada) {
      alert('La consulta ya no está disponible.');
      return;
    }

    const mensaje = consulta.cobroId
      ? 'Esta consulta está vinculada a un cobro. Se retirará de la lista, pero se conservará el historial clínico y financiero. ¿Deseas continuar?'
      : '¿Deseas retirar esta consulta de la lista? Se conservará el registro clínico en el sistema.';

    if (!confirm(mensaje)) return;

    consulta.eliminada = true;
    consulta.eliminadaAt = new Date().toISOString();
    consulta.eliminadaPor = APP.currentUser || 'Usuario autorizado';
    await DB.put(DB.STORES.consultas, consulta);
    await renderConsultas();
    alert('Consulta retirada del listado. El historial se conservó.');
  } catch (error) {
    alert('No se pudo retirar la consulta: ' + error.message);
  }
}


function openConsultaModal(id = null) {
  APP.editingId = id == null ? null : Number(id);
  APP.tempConsulta = {
    medicamentos: [], estudios: [], estudiosImagen: [],
    signos: { ta: '', fc: '', fr: '', temp: '', peso: '', talla: '', spo2: '' }
  };

  const modal = document.getElementById('generic-modal');
  modal.querySelector('.modal').classList.add('modal-lg');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.textContent = APP.editingId ? 'Editar Consulta Médica' : 'Nueva Consulta Médica';

  const load = async () => {
    const consultaExistente = APP.editingId ? await DB.get(DB.STORES.consultas, APP.editingId) : null;
    if (APP.editingId && (!consultaExistente || consultaExistente.eliminada)) { alert('No se encontró una consulta activa para editar.'); closeModal(); return; }
    if (consultaExistente) APP.tempConsulta = {
      medicamentos: Array.isArray(consultaExistente.medicamentos) ? consultaExistente.medicamentos.map(x => ({...x})) : [],
      estudios: Array.isArray(consultaExistente.estudios) ? [...consultaExistente.estudios] : [],
      estudiosImagen: Array.isArray(consultaExistente.estudiosImagen) ? [...consultaExistente.estudiosImagen] : [],
      signos: {...(consultaExistente.signosVitales || {})}
    };
    const pacientes = await DB.getAll(DB.STORES.pacientes);
    const medicos = (await DB.getAll(DB.STORES.medicos)).filter(m => m.activo !== false);
    const meds = await DB.getAll(DB.STORES.medicamentos);
    APP.consultaMedicamentosCatalogo = meds;
    const ests = await DB.getAll(DB.STORES.estudios);
    const estudiosImagenBase = [
      'Radiografía de tórax PA', 'Radiografía de tórax PA y lateral', 'Radiografía de abdomen simple',
      'Radiografía de columna cervical', 'Radiografía de columna lumbar', 'Radiografía de pelvis',
      'Radiografía de hombro', 'Radiografía de codo', 'Radiografía de muñeca', 'Radiografía de mano',
      'Radiografía de cadera', 'Radiografía de rodilla', 'Radiografía de tobillo', 'Radiografía de pie',
      'Ultrasonido abdominal', 'Ultrasonido pélvico', 'Ultrasonido obstétrico',
      'Ultrasonido renal y vías urinarias', 'Ultrasonido hepatobiliar', 'Ultrasonido mamario',
      'Ultrasonido tiroideo', 'Ultrasonido Doppler venoso', 'Ultrasonido Doppler arterial',
      'Tomografía de cráneo simple', 'Tomografía de tórax', 'Tomografía de abdomen y pelvis',
      'Resonancia magnética de cráneo', 'Resonancia magnética de columna lumbar',
      'Resonancia magnética de rodilla', 'Mastografía bilateral', 'Densitometría ósea'
    ];
    const estudiosImagenPersonalizados = (await DB.getConfig('estudios_imagen_personalizados')) || [];
    const estudiosImagenCatalogo = [...new Set([...estudiosImagenBase, ...estudiosImagenPersonalizados])];

    body.innerHTML = `
      <div class="form-row">
        <div class="form-group">
          <label for="c-paciente-search">Buscar paciente *</label>
          <input type="text" class="form-control" id="c-paciente-search" list="c-paciente-options" placeholder="Escribe el nombre del paciente..." autocomplete="new-password" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" required>
          <datalist id="c-paciente-options">
            ${pacientes.map(p => `<option value="${escapeAttr(p.nombre)}"></option>`).join('')}
          </datalist>
          <label for="c-fecha-consulta" style="display:block;margin-top:10px;">Fecha y hora de la consulta *</label>
          <input type="datetime-local" class="form-control" id="c-fecha-consulta" value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}" required>
          <select id="c-pacienteId" aria-hidden="true" tabindex="-1" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">
            <option value="">— Seleccione —</option>
            ${pacientes.map(p => `<option value="${p.id}" data-nombre="${escapeAttr(p.nombre)}">${escapeHtml(p.nombre)}</option>`).join('')}
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

      <h4 style="margin:1.25rem 0 0.75rem; font-size:1rem;">Signos vitales</h4>
      <p id="sv-enfermeria-aviso" class="text-muted" role="status">Seleccione un paciente para cargar los signos vitales más recientes de enfermería.</p>
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
          <label>Buscar medicamento</label>
          <input type="text" class="form-control" id="add-med-search" name="clinical-medication-search-field" placeholder="Escribe para buscar medicamento..." autocomplete="new-password" autocorrect="off" autocapitalize="off" spellcheck="false" readonly onfocus="this.removeAttribute('readonly')">
          <div id="add-med-results" class="recipe-med-results"></div>
          <button type="button" class="btn btn-secondary btn-sm" style="margin-top:.45rem" onclick="registrarMedicamentoDesdeConsulta()">Medicamento no listado</button>
          <select class="form-control" id="add-med-id" style="display:none">
            <option value="">— Seleccione —</option>
            ${meds.map(m => `<option value="${m.id}">${escapeHtml(m.nombre)} ${m.presentacion || ''} ${m.concentracion || ''}</option>`).join('')}
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

      <div class="form-group">
        <label for="c-notas-adicionales">Notas adicionales para la receta</label>
        <textarea class="form-control" id="c-notas-adicionales" rows="3" placeholder="Indicaciones, recomendaciones u observaciones adicionales (opcional)"></textarea>
      </div>

      <h4 style="margin:1.25rem 0 0.75rem; font-size:1rem;">Estudios de laboratorio indicados</h4>
      <div id="ests-list"></div>
      <div class="form-row" style="align-items:end;">
        <div class="form-group" style="flex:2;">
          <label>Estudio</label>
          <input type="text" class="form-control" id="add-est-id" name="clinical-lab-study-search" placeholder="Escribe para buscar un estudio..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" aria-label="Buscar estudio de laboratorio">
          <div id="add-est-lab-results" class="recipe-med-results study-search-results" role="listbox" style="display:none;"></div>
        </div>
        <div class="form-group">
          <button type="button" class="btn btn-outline" onclick="addEstToConsulta()">Agregar</button>
          <button type="button" class="btn btn-secondary" style="margin-top:.4rem" onclick="agregarEstudioLaboratorioDesdeConsulta()">+ Estudio no listado</button>
        </div>
      </div>

      <h4 style="margin:1.25rem 0 0.75rem; font-size:1rem;">Estudios de imagen indicados</h4>
      <div id="ests-imagen-list"></div>
      <div class="form-row" style="align-items:end;">
        <div class="form-group" style="flex:2;">
          <label>Seleccionar estudio de imagen</label>
          <input type="text" class="form-control" id="add-est-imagen-search" name="clinical-imaging-study-search" placeholder="Escribe para buscar un estudio de imagen..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" aria-label="Buscar estudio de imagen">
          <div id="add-est-imagen-results" class="recipe-med-results study-image-results" role="listbox" style="display:none;"></div>
        </div>
        <div class="form-group">
          <button type="button" class="btn btn-outline" onclick="addEstImagenToConsulta()">Agregar</button>
          <button type="button" class="btn btn-secondary" style="margin-top:.4rem" onclick="agregarEstudioImagenDesdeConsulta()">+ Estudio no listado</button>
        </div>
      </div>

      <div class="form-group mt-2">
        <label>Próxima cita</label>
        <input type="date" class="form-control" id="c-proxima">
      </div>
    `;

    if (consultaExistente) {
      const paciente = pacientes.find(p => String(p.id) === String(consultaExistente.pacienteId));
      document.getElementById('c-paciente-search').value = paciente ? paciente.nombre : '';
      document.getElementById('c-pacienteId').value = String(consultaExistente.pacienteId || '');
      const fecha = new Date(consultaExistente.fecha || Date.now());
      document.getElementById('c-fecha-consulta').value = Number.isNaN(fecha.getTime()) ? '' : new Date(fecha.getTime() - fecha.getTimezoneOffset()*60000).toISOString().slice(0,16);
      document.getElementById('c-medicoId').value = String(consultaExistente.medicoId || '');
      document.getElementById('c-motivo').value = consultaExistente.motivo || '';
      document.getElementById('c-interrogatorio').value = consultaExistente.interrogatorio || '';
      document.getElementById('c-cuadro').value = consultaExistente.cuadroClinico || '';
      document.getElementById('c-exploracion').value = consultaExistente.exploracion || '';
      document.getElementById('c-tratamiento').value = consultaExistente.tratamiento || '';
      const sv = consultaExistente.signosVitales || {};
      document.getElementById('sv-ta').value = sv.ta || ''; document.getElementById('sv-fc').value = sv.fc || '';
      document.getElementById('sv-fr').value = sv.fr || ''; document.getElementById('sv-temp').value = sv.temp || '';
      document.getElementById('sv-peso').value = sv.peso || ''; document.getElementById('sv-talla').value = sv.talla || '';
      document.getElementById('sv-spo2').value = sv.spo2 || '';
      document.getElementById('c-notas-adicionales').value = consultaExistente.notasAdicionales || '';
      document.getElementById('c-proxima').value = consultaExistente.proximaCita || '';
    }
    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="saveConsulta()">${APP.editingId ? 'Guardar cambios' : 'Guardar Consulta'}</button>
    `;

    const pacienteSearch = document.getElementById('c-paciente-search');
    const pacienteIdSelect = document.getElementById('c-pacienteId');
    pacienteSearch.addEventListener('input', () => {
      const nombre = pacienteSearch.value.trim().toLocaleLowerCase('es-MX');
      const coincidencia = pacientes.find(p => (p.nombre || '').trim().toLocaleLowerCase('es-MX') === nombre);
      pacienteIdSelect.value = coincidencia ? String(coincidencia.id) : '';
      if (coincidencia) cargarSignosVitalesEnfermeria(coincidencia.id);
    });
    pacienteSearch.addEventListener('change', () => {
      if (!pacienteIdSelect.value) {
        pacienteSearch.setCustomValidity('Selecciona un paciente existente de la lista.');
      } else {
        pacienteSearch.setCustomValidity('');
      }
    });
    const labSearchInput = document.getElementById('add-est-id');
    const labResults = document.getElementById('add-est-lab-results');
    const renderLabResults = () => {
      const q = labSearchInput.value.trim().toLocaleLowerCase('es-MX');
      const matches = q ? ests.filter(e => (e.nombre || '').toLocaleLowerCase('es-MX').includes(q)).slice(0, 12) : [];
      labResults.innerHTML = matches.map(e => '<button type="button" role="option" class="recipe-med-result study-search-option" data-study-id="' + Number(e.id) + '">' + escapeHtml(e.nombre || '') + '</button>').join('');
      labResults.style.display = matches.length ? 'block' : 'none';
      labResults.querySelectorAll('[data-study-id]').forEach(button => button.addEventListener('click', () => {
        const chosen = ests.find(e => String(e.id) === button.dataset.studyId);
        if (chosen) labSearchInput.value = chosen.nombre;
        labResults.style.display = 'none';
        labSearchInput.focus();
      }));
    };
    labSearchInput.addEventListener('input', renderLabResults);
    labSearchInput.addEventListener('focus', renderLabResults);
    labSearchInput.addEventListener('blur', () => setTimeout(() => { if (labResults) labResults.style.display = 'none'; }, 180));
    const imagenSearchInput = document.getElementById('add-est-imagen-search');
    const imagenResults = document.getElementById('add-est-imagen-results');
    const renderImagenResults = () => {
      const q = imagenSearchInput.value.trim().toLocaleLowerCase('es-MX');
      const matches = q ? estudiosImagenCatalogo.filter(nombre => nombre.toLocaleLowerCase('es-MX').includes(q)).slice(0, 12) : [];
      imagenResults.innerHTML = matches.map(nombre => '<button type="button" role="option" class="recipe-med-result study-image-result" data-study-name="' + escapeAttr(nombre) + '">' + escapeHtml(nombre) + '</button>').join('');
      imagenResults.style.display = matches.length ? 'flex' : 'none';
      imagenResults.querySelectorAll('[data-study-name]').forEach(button => button.addEventListener('click', () => {
        imagenSearchInput.value = button.dataset.studyName;
        imagenResults.style.display = 'none';
        imagenSearchInput.focus();
      }));
    };
    imagenSearchInput.addEventListener('input', renderImagenResults);
    imagenSearchInput.addEventListener('focus', renderImagenResults);
    imagenSearchInput.addEventListener('blur', () => setTimeout(() => { if (imagenResults) imagenResults.style.display = 'none'; }, 180));
    const medSearchInput = document.getElementById('add-med-search');
    const medResults = document.getElementById('add-med-results');
    const renderMedSearchResults = function () {
      const q = medSearchInput.value.trim().toLocaleLowerCase('es-MX');
      const matches = q ? meds.filter(m => [m.nombre, m.presentacion, m.concentracion].join(' ').toLocaleLowerCase('es-MX').includes(q)).slice(0, 12) : [];
      medResults.innerHTML = matches.map(m => '<button type="button" class="recipe-med-result" data-med-id="' + Number(m.id) + '">' +
        escapeHtml(m.nombre || '') + ' — ' + escapeHtml(m.presentacion || '') + ' ' + escapeHtml(m.concentracion || '') + '</button>').join('');
      if (q && matches.length === 0) {
        medResults.innerHTML = '<p class="text-muted" style="padding:.5rem;margin:0">No se encontraron medicamentos en el catálogo.</p>';
      }
      medResults.style.display = q ? 'block' : 'none';
      medResults.querySelectorAll('[data-med-id]').forEach(button => button.addEventListener('click', function () {
        document.getElementById('add-med-id').value = button.dataset.medId;
        medSearchInput.value = button.textContent.trim();
        medResults.innerHTML = '';
        medResults.style.display = 'none';
      }));
    };
    medSearchInput.addEventListener('input', function () {
      document.getElementById('add-med-id').value = '';
      renderMedSearchResults();
    });
    medSearchInput.addEventListener('focus', renderMedSearchResults);
    medSearchInput.addEventListener('blur', function () {
      setTimeout(function () {
        if (medResults && !medResults.matches(':hover')) medResults.style.display = 'none';
      }, 180);
    });

    renderTempMeds();
    renderTempEsts();
    renderTempEstsImagen();
  };

  load();
  modal.classList.add('show');
}

function addMedToConsulta() {
  const selector = document.getElementById('add-med-id');
  const search = document.getElementById('add-med-search');
  const results = document.getElementById('add-med-results');
  const id = selector ? selector.value : '';
  if (!id) {
    alert('Primero busca y selecciona un medicamento de la lista de resultados.');
    if (search) search.focus();
    return;
  }
  if (!APP.tempConsulta) APP.tempConsulta = { medicamentos: [], estudios: [], estudiosImagen: [], signos: {} };
  if (!Array.isArray(APP.tempConsulta.medicamentos)) APP.tempConsulta.medicamentos = [];
  const meds = APP.tempConsulta.medicamentos;
  // Se permite repetir un medicamento cuando se necesita registrarlo con indicaciones distintas.
  meds.push({
    medicamentoId: Number.parseInt(id, 10),
    dosis: document.getElementById('add-med-dosis').value.trim() || '—',
    via: document.getElementById('add-med-via').value.trim() || 'Oral',
    frecuencia: document.getElementById('add-med-freq').value.trim() || '—',
    duracion: document.getElementById('add-med-dur').value.trim() || '—'
  });
  selector.value = '';
  search.value = '';
  if (results) { results.innerHTML = ''; results.style.display = 'none'; }
  document.getElementById('add-med-dosis').value = '';
  document.getElementById('add-med-via').value = '';
  document.getElementById('add-med-freq').value = '';
  document.getElementById('add-med-dur').value = '';
  renderTempMeds();
  if (search) search.focus();
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

async function addEstToConsulta() {
  const input = document.getElementById('add-est-id');
  const nombre = input ? input.value.trim() : '';
  if (!nombre) return;
  try {
    const existentes = await DB.getAll(DB.STORES.estudios);
    let estudio = existentes.find(e => (e.nombre || '').trim().toLocaleLowerCase('es-MX') === nombre.toLocaleLowerCase('es-MX'));
    if (!estudio) {
      if (!confirm('El estudio "' + nombre + '" no está en el catálogo. ¿Deseas agregarlo al catálogo y a esta consulta?')) return;
      estudio = await DB.add(DB.STORES.estudios, {nombre, precio: 0});
      if (!estudio || !estudio.id) {
        const actualizados = await DB.getAll(DB.STORES.estudios);
        estudio = actualizados.find(e => (e.nombre || '').trim().toLocaleLowerCase('es-MX') === nombre.toLocaleLowerCase('es-MX'));
      }
      if (!estudio || !estudio.id) return alert('No se pudo guardar el estudio en el catálogo.');

    }
    if (APP.tempConsulta.estudios.some(e => String(e) === String(estudio.id))) {
      alert('Este estudio ya está agregado');
      return;
    }
    APP.tempConsulta.estudios.push(parseInt(estudio.id, 10));
    input.value = '';
    renderTempEsts();
  } catch (err) { alert('No se pudo agregar el estudio: ' + err.message); }
}

async function agregarEstudioLaboratorioDesdeConsulta() {
  const nombre = prompt('Nombre del estudio de laboratorio que no aparece en la lista:');
  if (nombre === null) return;
  const limpio = nombre.trim();
  if (!limpio) return alert('Escribe el nombre del estudio.');
  try {
    const existentes = await DB.getAll(DB.STORES.estudios);
    const repetido = existentes.find(e => (e.nombre || '').trim().toLocaleLowerCase('es-MX') === limpio.toLocaleLowerCase('es-MX'));
    let estudio = repetido;
    if (!estudio) estudio = await DB.add(DB.STORES.estudios, {nombre: limpio, precio: 0});
    const id = estudio && estudio.id;
    if (!id) {
      const actualizados = await DB.getAll(DB.STORES.estudios);
      estudio = actualizados.find(e => (e.nombre || '').trim().toLocaleLowerCase('es-MX') === limpio.toLocaleLowerCase('es-MX'));
    }
    if (!estudio || !estudio.id) return alert('Se guardó el estudio, pero no pude seleccionarlo automáticamente. Vuelve a elegirlo en la lista.');
    const select = document.getElementById('add-est-id');
    const options = document.getElementById('add-est-lab-options');
    if (options && ![...options.options].some(o => o.value === estudio.nombre)) options.appendChild(new Option(estudio.nombre));
    if (select) select.value = estudio.nombre;
    addEstToConsulta();
    alert('Estudio agregado al catálogo y a esta consulta.');
  } catch (err) { alert('No se pudo guardar el estudio: ' + err.message); }
}

function removeEstFromConsulta(idx) {
  APP.tempConsulta.estudios.splice(idx, 1);
  renderTempEsts();
}


function addEstImagenToConsulta() {
  const input = document.getElementById('add-est-imagen-search');
  const nombre = input ? input.value.trim() : '';
  if (!nombre) return;
  const items = APP.tempConsulta.estudiosImagen || (APP.tempConsulta.estudiosImagen = []);
  if (items.some(e => e.toLocaleLowerCase('es-MX') === nombre.toLocaleLowerCase('es-MX'))) {
    alert('Este estudio de imagen ya está agregado');
    return;
  }
  items.push(nombre);
  input.value = '';
  renderTempEstsImagen();
}

async function agregarEstudioImagenDesdeConsulta() {
  const nombre = prompt('Nombre del estudio de imagen que no aparece en la lista:');
  if (nombre === null) return;
  const limpio = nombre.trim();
  if (!limpio) return alert('Escribe el nombre del estudio.');
  try {
    const catalogo = (await DB.getConfig('estudios_imagen_personalizados')) || [];
    const existente = catalogo.find(n => n.toLocaleLowerCase('es-MX') === limpio.toLocaleLowerCase('es-MX'));
    if (!existente) {
      catalogo.push(limpio);
      await DB.setConfig('estudios_imagen_personalizados', catalogo);
    }
    const select = document.getElementById('add-est-imagen-search');
    if (select) select.value = limpio;
    if (!estudiosImagenCatalogo.some(n => n.toLocaleLowerCase('es-MX') === limpio.toLocaleLowerCase('es-MX'))) estudiosImagenCatalogo.push(limpio);
    addEstImagenToConsulta();
    alert('Estudio de imagen agregado al catálogo y a esta consulta.');
  } catch (err) { alert('No se pudo guardar el estudio: ' + err.message); }
}

function removeEstImagenFromConsulta(idx) {
  APP.tempConsulta.estudiosImagen.splice(idx, 1);
  renderTempEstsImagen();
}

function renderTempEstsImagen() {
  const list = document.getElementById('ests-imagen-list');
  if (!list) return;
  const items = APP.tempConsulta.estudiosImagen || [];
  if (!items.length) {
    list.innerHTML = '<p class="text-muted" style="font-size:0.9rem;">Ningún estudio de imagen agregado.</p>';
    return;
  }
  list.innerHTML = '<ul style="list-style:none;padding:0;">' + items.map((nombre, i) =>
    '<li style="padding:0.4rem 0;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;"><span>' + escapeHtml(nombre) + '</span><button type="button" class="btn btn-danger btn-sm" onclick="removeEstImagenFromConsulta(' + i + ')">×</button></li>'
  ).join('') + '</ul>';
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

async function cargarSignosVitalesEnfermeria(pacienteId) {
  const aviso = document.getElementById('sv-enfermeria-aviso');
  const campos = {
    ta: 'sv-ta',
    fc: 'sv-fc',
    fr: 'sv-fr',
    temp: 'sv-temp',
    peso: 'sv-peso',
    talla: 'sv-talla',
    spo2: 'sv-spo2'
  };

  if (!pacienteId) {
    Object.values(campos).forEach(id => {
      const campo = document.getElementById(id);
      if (campo) campo.value = '';
    });
    if (aviso) aviso.textContent = 'Seleccione un paciente para cargar los signos vitales más recientes de enfermería.';
    return;
  }

  try {
    const [paciente, registros] = await Promise.all([
      DB.get(DB.STORES.pacientes, Number(pacienteId)),
      DB.getAll(DB.STORES.enfermeria)
    ]);
    const normalizar = valor => String(valor || '').trim().toLocaleLowerCase('es-MX');
    const delPaciente = registros.filter(r =>
      (r.pacienteId != null && String(r.pacienteId) === String(pacienteId)) ||
      (r.pacienteId == null && paciente && normalizar(r.paciente) === normalizar(paciente.nombre))
    );
    delPaciente.sort((a, b) => String(b.fechaHora || '').localeCompare(String(a.fechaHora || '')));
    const registro = delPaciente[0];

    if (!registro) {
      Object.values(campos).forEach(id => {
        const campo = document.getElementById(id);
        if (campo) campo.value = '';
      });
      if (aviso) aviso.textContent = 'No hay signos vitales de enfermería para este paciente. Puede capturarlos aquí.';
      return;
    }

    const valores = {
      ta: registro.presion || '',
      fc: registro.fc ?? '',
      fr: registro.fr ?? '',
      temp: registro.temperatura ?? '',
      peso: registro.peso ?? '',
      talla: registro.talla ?? '',
      spo2: registro.spo2 ?? ''
    };
    Object.entries(campos).forEach(([clave, id]) => {
      const campo = document.getElementById(id);
      if (campo) campo.value = valores[clave] ?? '';
    });

    const fecha = registro.fechaHora
      ? new Date(registro.fechaHora).toLocaleString('es-MX')
      : 'fecha no disponible';
    if (aviso) aviso.textContent = 'Signos vitales cargados automáticamente desde enfermería (' + fecha + '). Verifique que correspondan a esta consulta.';
  } catch (error) {
    console.error('No se pudieron cargar los signos vitales:', error);
    if (aviso) aviso.textContent = 'No se pudieron cargar los signos vitales de enfermería. Puede capturarlos manualmente.';
  }
}

async function saveConsulta() {
  const pacienteId = document.getElementById('c-pacienteId').value;
  const medicoId = document.getElementById('c-medicoId').value;
  const motivo = document.getElementById('c-motivo').value.trim();

  if (!pacienteId || !medicoId || !motivo) {
    alert('Paciente, médico y motivo de consulta son obligatorios.');
    return;
  }

  // Los signos vitales son opcionales.
  const ta = document.getElementById('sv-ta').value.trim();
  const fc = document.getElementById('sv-fc').value.trim();
  const fr = document.getElementById('sv-fr').value.trim();
  const temp = document.getElementById('sv-temp').value.trim();
  const fechaConsulta = document.getElementById('c-fecha-consulta').value;

  if (!fechaConsulta || Number.isNaN(new Date(fechaConsulta).getTime())) {
    alert('Seleccione una fecha y hora válidas para la consulta.');
    return;
  }

  const data = {
    pacienteId: parseInt(pacienteId),
    medicoId: parseInt(medicoId),
    fecha: new Date(fechaConsulta).toISOString(),
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
    estudiosImagen: APP.tempConsulta.estudiosImagen || [],
    notasAdicionales: document.getElementById('c-notas-adicionales').value.trim(),
    proximaCita: document.getElementById('c-proxima').value || null
  };

  const estabaEditando = APP.editingId != null;
  try {
    if (estabaEditando) {
      const existente = await DB.get(DB.STORES.consultas, APP.editingId);
      if (!existente || existente.eliminada) throw new Error('La consulta ya no está disponible para editar.');
      await DB.put(DB.STORES.consultas, {...existente, ...data, id: APP.editingId});
    } else {
      await DB.add(DB.STORES.consultas, data);
    }
    if (data.proximaCita) await sincronizarCitasDesdeConsultas();
    closeModal();
    document.querySelector('.modal').classList.remove('modal-lg');
    renderConsultas();
    alert(estabaEditando ? 'Consulta actualizada correctamente.' : 'Consulta guardada correctamente.');
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
}

async function verConsulta(id) {
  const c = await DB.get(DB.STORES.consultas, id);
  if (!c) return;
  const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
  const m = await DB.get(DB.STORES.medicos, c.medicoId);
  const fechaNacPaciente = obtenerFechaNacimientoPaciente(p);
  const edadPaciente = calcularEdad(fechaNacPaciente);
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

  const estsImagenHtml = (c.estudiosImagen || []).map(nombre => `<li>${escapeHtml(nombre)}</li>`).join('') || '<li>Ninguno</li>';

  const sv = c.signosVitales || {};

  const modal = document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent = 'Detalle de Consulta';
  document.getElementById('modal-body').innerHTML = `
    <p><strong>Fecha:</strong> ${formatDate(c.fecha)}</p>
    <p><strong>Paciente:</strong> ${p ? escapeHtml(p.nombre) : '—'} · <strong>Edad:</strong> ${edadPaciente == null ? '—' : edadPaciente + ' años'} · <strong>Fecha de nacimiento:</strong> ${escapeHtml(fechaNacPaciente || '—')}</p>
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
    <p><strong>Notas adicionales:</strong><br>${escapeHtml(c.notasAdicionales || '—').replace(/\n/g, '<br>')}</p>
    <p><strong>Estudios de laboratorio:</strong></p>
    <ul>${estsHtml}</ul>
    <p><strong>Estudios de imagen:</strong></p>
    <ul>${estsImagenHtml}</ul>
    <p><strong>Próxima cita:</strong> ${c.proximaCita || '—'}</p>
  `;
  document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal()">Cerrar</button>
    <button class="btn btn-primary" onclick="elegirTipoReceta(${id})">Imprimir Receta</button>
    <button class="btn btn-success" onclick="registrarCobroConsulta(${id})">${c.cobroId ? 'Ver cobro registrado' : 'Registrar cobros'}</button>
  `;
  modal.classList.add('show');
}

async function registrarCobroConsulta(consultaId) {
  try {
    const consulta = await DB.get(DB.STORES.consultas, consultaId);
    if (!consulta) return alert('No se encontró la consulta.');
    const paciente = await DB.get(DB.STORES.pacientes, consulta.pacienteId);
    const medico = await DB.get(DB.STORES.medicos, consulta.medicoId);

    if (consulta.cobroId) {
      alert('Esta consulta ya fue enviada al área de cobros. Importe registrado: $' +
        (Number(consulta.montoConsulta) || 0).toFixed(2) +
        '. Recepción puede consultar el estado y confirmar el pago desde Cobros.');
      return;
    }

    const sugerido = consulta.montoConsulta != null
      ? consulta.montoConsulta
      : (medico && medico.honorarios != null ? medico.honorarios : '');
    const respuesta = prompt(
      'REGISTRAR COBROS\nPaciente: ' + (paciente ? paciente.nombre : '—') +
      '\nMédico: ' + (medico ? medico.nombre : '—') +
      '\n\nConfirma el total a cobrar en MXN:',
      String(sugerido)
    );
    if (respuesta === null) return;
    const monto = Number(respuesta);
    if (!Number.isFinite(monto) || monto <= 0 || monto > 10000000) {
      return alert('Captura un importe válido mayor que cero.');
    }

    const resultado = await DB.registrarCobroConsulta(consultaId, monto);
    alert(resultado.duplicate
      ? 'La consulta ya estaba registrada en cobros. No se creó un duplicado.'
      : 'Consulta enviada al área de Cobros. Total pendiente: $' + Number(resultado.cobro.monto).toFixed(2) +
        '. Recepción podrá confirmar el pago.');
    await renderConsultas();
  } catch (error) {
    alert('No se pudo registrar el cobro: ' + error.message);
  }
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
      // DB.add devuelve el registro creado (incluido su id), no un id numérico aislado.
      const creado = await DB.add(DB.STORES.medicamentos, data);
      data.id = creado && typeof creado === 'object' ? creado.id : creado;
      if (data.id == null || data.id === '' || !Number.isFinite(Number(data.id))) {
        const catalogoActualizado = await DB.getAll(DB.STORES.medicamentos);
        const normalizar = valor => String(valor || '').trim().toLocaleLowerCase('es-MX');
        const encontrado = catalogoActualizado.find(m =>
          normalizar(m.nombre) === normalizar(data.nombre) &&
          normalizar(m.presentacion) === normalizar(data.presentacion) &&
          normalizar(m.concentracion) === normalizar(data.concentracion)
        );
        if (!encontrado) throw new Error('El medicamento se guardó, pero no pude recuperar su identificador para seleccionarlo en la consulta.');
        data.id = encontrado.id;
      }
    }
    if (APP.regresarConsultaMedicamento) {
      const returnState = APP.regresarConsultaMedicamento;
      APP.regresarConsultaMedicamento = null;
      const modal = document.getElementById('generic-modal');
      const body = document.getElementById('modal-body');
      body.replaceChildren(...returnState.bodyNodes);
      document.getElementById('modal-title').textContent = returnState.title;
      document.getElementById('modal-footer').innerHTML = returnState.footer;
      modal.querySelector('.modal').classList.toggle('modal-lg', returnState.large);
      modal.classList.add('show');
      APP.editingId = returnState.editingId;
      const catalogo = APP.consultaMedicamentosCatalogo || [];
      const saved = {...data};
      const index = catalogo.findIndex(m => String(m.id) === String(saved.id));
      if (index >= 0) catalogo[index] = saved; else catalogo.push(saved);
      const selector = document.getElementById('add-med-id');
      if (selector) {
        let option = Array.from(selector.options).find(o => String(o.value) === String(saved.id));
        if (!option) { option = document.createElement('option'); option.value = String(saved.id); selector.appendChild(option); }
        option.textContent = [saved.nombre, saved.presentacion, saved.concentracion].filter(Boolean).join(' ');
      }
      const search = document.getElementById('add-med-search');
      if (search) {
        search.value = [saved.nombre, saved.presentacion, saved.concentracion].filter(Boolean).join(' — ');
        const idSelector = document.getElementById('add-med-id');
        if (idSelector) idSelector.value = String(saved.id);
      }
      const results = document.getElementById('add-med-results');
      if (results) { results.innerHTML = ''; results.style.display = 'none'; }
      alert('Medicamento guardado en el catálogo. Ya está seleccionado para esta consulta; completa la dosis e indicaciones y pulsa Agregar.');
    } else {
      closeModal();
      renderMedicamentos();
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function registrarMedicamentoDesdeConsulta() {
  const modal = document.getElementById('generic-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body || !document.getElementById('add-med-search')) return;
  APP.regresarConsultaMedicamento = {
    bodyNodes: Array.from(body.childNodes),
    title: document.getElementById('modal-title').textContent,
    footer: document.getElementById('modal-footer').innerHTML,
    large: modal.querySelector('.modal').classList.contains('modal-lg'),
    editingId: APP.editingId
  };
  openMedicamentoModal();
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
                    <th>Método</th>
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
                      <td>${escapeHtml(c.metodoPago || '—')}</td>

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
  if (c.status === 'pagado') return alert('Este cobro ya está pagado.');
  const monto = Number(c.monto);
  if (!Number.isFinite(monto) || monto <= 0 || monto > 10000000) {
    return alert('El importe de este cobro es inválido. Edita el cobro y registra un importe mayor que $0 antes de confirmarlo.');
  }
  const metodoPago = prompt('Confirma el método de pago:\n1 = Efectivo\n2 = Tarjeta\n3 = Transferencia', '1');
  if (metodoPago === null) return;
  const metodos = { '1': 'Efectivo', '2': 'Tarjeta', '3': 'Transferencia' };
  if (!metodos[metodoPago]) return alert('Selecciona 1, 2 o 3 para registrar un método válido.');
  if (!confirm('¿Confirmar el cobro de $' + monto.toFixed(2) + ' por ' + metodos[metodoPago] + '?')) return;
  try {
    await DB.confirmarCobro(id, metodos[metodoPago], monto);
    alert('Cobro confirmado correctamente.');
    await renderCobros();
  } catch (error) {
    alert('No se pudo confirmar el cobro: ' + error.message);
  }
}

// ========== BALANCE ==========
async function renderBalance() {
  const cobros = await DB.getAll('balance_cobros');
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

// ========== CONFIGURACIÓN DE APARIENCIA ==========
function aplicarTemaSuave(activar, guardar = true) {
  const habilitado = Boolean(activar);
  document.body.classList.toggle('tema-suave', habilitado);
  if (guardar) {
    try { localStorage.setItem('cmcc_tema_apariencia', habilitado ? 'suave' : 'normal'); }
    catch (error) { console.debug('No se pudo guardar la preferencia visual', error); }
  }
}

function aplicarTemaGuardado() {
  let habilitado = false;
  try { habilitado = localStorage.getItem('cmcc_tema_apariencia') === 'suave'; }
  catch (error) { /* Preferencia local no disponible: se usa la apariencia normal. */ }
  aplicarTemaSuave(habilitado, false);
}

function renderConfiguracion() {
  const area = document.getElementById('content-area');
  const habilitado = document.body.classList.contains('tema-suave');
  area.innerHTML = `
    <div class="card">
      <div class="card-header"><h3>Apariencia del programa</h3></div>
      <div class="card-body">
        <p class="text-muted mb-2">Reduce el brillo de los fondos y las superficies para trabajar con más comodidad. Los colores de los botones, alertas y estados se conservan.</p>
        <label class="configuracion-tema-control" for="config-tema-suave">
          <input type="checkbox" id="config-tema-suave" ${habilitado ? 'checked' : ''}>
          <span><strong>Modo nocturno suave</strong><small>Usa fondos gris oscuro suaves, sin invertir indiscriminadamente los colores.</small></span>
        </label>
        <p class="text-muted mt-2">La preferencia se guarda en este navegador y se aplica al volver a entrar.</p>
      </div>
    </div>
  `;
  document.getElementById('config-tema-suave').addEventListener('change', function (event) {
    aplicarTemaSuave(event.target.checked);
  });
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
async function elegirTipoReceta(consultaId) {
  const c=await DB.get(DB.STORES.consultas,consultaId); if(!c)return alert('No se encontró la consulta.');
  const todas=await DB.getAll('plantillas_receta');
  const plantillas=todas.filter(function(p){return !p.medicoId||String(p.medicoId)===String(c.medicoId);});
  const modal=document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent='Elegir tipo de receta';
  document.getElementById('modal-body').innerHTML='<p>Selecciona el formato para esta consulta.</p><div class="form-group"><label for="tipo-receta-elegida">Tipo de receta</label><select class="form-control" id="tipo-receta-elegida"><option value="default">Receta predeterminada del consultorio</option>'+plantillas.map(function(p){return '<option value="'+Number(p.id)+'">'+featureEscape(p.nombre||'Plantilla')+'</option>';}).join('')+'</select></div>';
  document.getElementById('modal-footer').innerHTML='<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="confirmarTipoReceta('+Number(consultaId)+')">Continuar a imprimir</button>';
  modal.classList.add('show');
}
function confirmarTipoReceta(consultaId) { const el=document.getElementById('tipo-receta-elegida'); const id=el?el.value:'default'; closeModal(); imprimirReceta(consultaId,id); }
async function imprimirReceta(consultaId, plantillaId = 'default') {
  // Abrir la ventana inmediatamente durante el toque del usuario: Safari iOS puede bloquearla si se abre después de await.
  let printWindow = null;
  try { printWindow = window.open('', '_blank'); } catch (_) {}
  try {
  const c = await DB.get(DB.STORES.consultas, consultaId);
  if (!c) return;
  const p = await DB.get(DB.STORES.pacientes, c.pacienteId);
  const m = await DB.get(DB.STORES.medicos, c.medicoId);
  const plantillas = await DB.getAll('plantillas_receta');
  const plantilla = plantillaId && plantillaId !== 'default' ? plantillas.find(function(x){return String(x.id)===String(plantillaId);}) : null;
  if (plantillaId && plantillaId !== 'default' && !plantilla) { if(printWindow&&!printWindow.closed)printWindow.close(); return alert('La plantilla seleccionada ya no existe. Vuelve a elegir el tipo de receta.'); }
  const fechaNacPaciente = obtenerFechaNacimientoPaciente(p);
  const edadPaciente = calcularEdad(fechaNacPaciente);
  const allMeds = await DB.getAll(DB.STORES.medicamentos);
  const allEsts = await DB.getAll(DB.STORES.estudios);

  const tieneCedula = m && m.cedula && m.domicilio;
  const titulo = plantilla ? (plantilla.encabezado || plantilla.nombre || 'RECETA MÉDICA') : (tieneCedula ? 'RECETA MÉDICA' : 'HOJA DE INDICACIONES');
  const domicilioReceta = plantilla && plantilla.domicilio ? plantilla.domicilio : (m ? m.domicilio : '');
  const telefonoReceta = plantilla && plantilla.telefono ? plantilla.telefono : (m ? m.telefono : '');
  const firmaReceta = plantilla && plantilla.firma ? plantilla.firma : 'Firma Del Medico';
  const pieReceta = plantilla && plantilla.pie ? plantilla.pie : '';

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

  const estsImagenHtml = (c.estudiosImagen || []).map(nombre => `<li>${escapeHtml(nombre)}</li>`).join('') || '<li>Ninguno</li>';

  const sv = c.signosVitales || {};

  const printArea = document.getElementById('print-area');
  if (!printArea) throw new Error('No existe el área de impresión en la página.');
  printArea.innerHTML = `
    <style>
      @page { size: letter; margin: ${plantilla && plantilla.fondoImagen ? '0' : '10mm'}; }
      #print-area .rx-consulta-print { font-family: "Times New Roman", serif; color: #000 !important; font-size: 10pt; line-height: 1.18; max-width: ${plantilla && plantilla.fondoImagen ? '216mm' : '190mm'}; min-height: ${plantilla && plantilla.fondoImagen ? '279mm' : 'auto'}; margin: 0 auto; position: relative; ${plantilla && plantilla.fondoImagen ? 'background-image:url(' + JSON.stringify(plantilla.fondoImagen) + ');background-size:100% 100%;background-repeat:no-repeat;padding:' + Number(plantilla.margenSuperior || 10) + 'mm 10mm 10mm ' + Number(plantilla.margenIzquierdo || 10) + 'mm;-webkit-print-color-adjust:exact;print-color-adjust:exact;' : ''} }
      #print-area .rx-consulta-print * { color: #000 !important; box-sizing: border-box; }
      #print-area .rx-consulta-print h2 { font-size: 15pt; }
      #print-area .rx-consulta-print h3 { font-size: 11pt; margin: 8px 0 4px !important; break-after: avoid; page-break-after: avoid; }
      #print-area .rx-consulta-print table { font-size: 9pt !important; }
      #print-area .rx-consulta-print th, #print-area .rx-consulta-print td { padding: 3px 4px !important; overflow-wrap: anywhere; }
      #print-area .rx-consulta-print tr, #print-area .rx-consulta-print .rx-signature { break-inside: avoid; page-break-inside: avoid; }
      #print-area .rx-consulta-print .rx-signature { margin-top: 22px !important; text-align: center; font-size: 10pt; }
      #print-area .rx-consulta-print .rx-signature-line { border-top: 1px solid #000; width: 220px; max-width: 75%; margin: 0 auto 4px; padding-top: 4px; }
      @media print { #print-area .rx-consulta-print { max-width: none; margin: 0; } }
    </style>
    <div class="rx-consulta-print" style="font-family: 'Times New Roman', serif; max-width: ${plantilla && plantilla.fondoImagen ? '216mm' : '800px'}; margin: 0 auto;">
      <div style="position:relative; text-align:center; border-bottom:1px solid #333; padding:0 0 10px; margin-bottom:14px;">
        <h2 style="margin:0 0 8px; font-size:18pt; color:#111 !important; letter-spacing:.04em;">${titulo}</h2>
        <img src="${window.location.origin}/assets/logo-consultorio-cc-original.jpg?v=20261030" alt="Consultorio Médico CC" style="display:block;width:190px;max-width:48%;height:auto;margin:0 auto 8px;filter:grayscale(1) contrast(1.12);">
        ${m ? `
          <div style="font-size:10pt; line-height:1.35; text-align:center;">
            <strong style="font-size:12pt;">Dr(a). ${escapeHtml(m.nombre)}</strong><br>
            <strong>${escapeHtml(m.institucion || 'Consultorio Médico CC')}</strong><br>
            ${m.especialidad ? 'Especialidad: ' + escapeHtml(m.especialidad) + '<br>' : ''}
            ${m.cedula ? 'Cédula profesional: ' + escapeHtml(m.cedula) + '<br>' : ''}
            ${m.cedulaEsp ? 'Cédula de especialidad: ' + escapeHtml(m.cedulaEsp) + '<br>' : ''}
            ${domicilioReceta ? 'Domicilio: ' + escapeHtml(domicilioReceta) + '<br>' : ''}
            ${telefonoReceta ? 'Tel: ' + escapeHtml(telefonoReceta) : ''}
          </div>
        ` : ''}
      </div>

      <div style="margin-bottom: 12px; font-size: 10pt;">
        <strong>Paciente:</strong> ${p ? escapeHtml(p.nombre) : '—'}<br>
        <strong>Fecha de nacimiento:</strong> ${fechaNacPaciente ? escapeHtml(formatBirthDate(fechaNacPaciente)) : 'No registrada'}<br>
        <strong>Edad:</strong> ${edadPaciente == null ? 'No disponible' : edadPaciente + ' años'}<br>
        <strong>Fecha y hora de consulta:</strong> ${c.fecha ? new Date(c.fecha).toLocaleString('es-MX', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
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

      ${c.notasAdicionales ? '<section style="margin-top:12px;font-size:10pt;white-space:pre-wrap;overflow-wrap:anywhere;"><strong>Notas adicionales:</strong><br>' + escapeHtml(c.notasAdicionales) + '</section>' : ''}

      <h3 style="font-size: 12pt; margin: 15px 0 8px; border-bottom: 1px solid #999;">Estudios de laboratorio</h3>
      <ul style="font-size: 10pt; margin: 0; padding-left: 20px;">${estsHtml}</ul>

      <h3 style="font-size: 12pt; margin: 15px 0 8px; border-bottom: 1px solid #999;">Estudios de imagen</h3>
      <ul style="font-size: 10pt; margin: 0; padding-left: 20px;">${estsImagenHtml}</ul>

      ${c.proximaCita ? `<p style="margin-top:12px; font-size:10pt;"><strong>Próxima cita:</strong> ${c.proximaCita}</p>` : ''}

      ${pieReceta ? '<p style="margin-top:12px;font-size:9pt;">' + escapeHtml(pieReceta) + '</p>' : ''}
      <div class="rx-signature">
        <div class="rx-signature-line">${escapeHtml(firmaReceta)}</div>
      </div>

      <p style="margin-top: 12px; text-align: center; font-style: italic; font-size: 9pt; color: #000;">
        Gracias por confiarnos tu salud.
      </p>
    </div>
  `;

  if (printWindow && !printWindow.closed) {
    // Documento aislado: evita que Safari tenga que paginar toda la aplicación clínica.
    printWindow.document.open();
    printWindow.document.write(`<!doctype html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(titulo)}</title>
        <style>
          @page { size: auto; margin: 10mm; }
          html, body { margin: 0; padding: 0; width: 100%; height: auto; background: #fff; color: #000; }
          body { font-family: "Times New Roman", serif; -webkit-text-size-adjust: 100%; }
          #print-area { display: block; width: 100%; margin: 0; padding: 0; color: #000; }
          #print-area * { color: #000 !important; box-sizing: border-box; }
          table { width: 100%; border-collapse: collapse; table-layout: fixed; }
          tr, .rx-signature { break-inside: avoid; page-break-inside: avoid; }
          @media print {
            html, body { height: auto !important; overflow: visible !important; }
            #print-area { position: static !important; width: 100% !important; }
          }
        </style>
      </head>
      <body><div id="print-area">${printArea.innerHTML}</div></body>
      </html>`);
    printWindow.document.close();
    // Safari iOS no siempre dispara onload tras document.write sobre about:blank.
    printWindow.setTimeout(() => {
      try {
        if (!printWindow.closed) {
          printWindow.focus();
          printWindow.print();
        }
      } catch (printError) {
        console.error('No se pudo abrir la impresión en Safari:', printError);
        alert('Safari no abrió la impresión. Abre esta receta en Safari y permite las ventanas emergentes.');
      }
    }, 300);
    printWindow.onafterprint = () => {
      try { printWindow.close(); } catch (_) {}
      if (confirm('Receta preparada. ¿Deseas registrar ahora el cobro de esta consulta?')) {
        registrarCobroConsulta(consultaId);
      }
    };
    // Safari iOS abre la vista de impresión del documento limpio, desde donde puede guardarse como PDF.
  } else {
    // Respaldo si Safari bloquea las ventanas emergentes.
    window.print();
    if (confirm('Receta preparada. ¿Deseas registrar ahora el cobro de esta consulta?')) {
      await registrarCobroConsulta(consultaId);
    }
  }
  } catch (error) {
    console.error('Error al imprimir receta desde Consultas:', error);
    alert('No se pudo imprimir la receta: ' + (error && error.message ? error.message : 'error inesperado') + '. Recarga la página e inténtalo de nuevo.');
  }
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

function formatBirthDate(value) {
  if (!value) return '—';
  const raw = String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return String(value);
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return d.toLocaleDateString('es-MX', {year:'numeric', month:'short', day:'numeric'});
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const raw = String(iso);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const d = dateOnly ? new Date(Number(raw.slice(0,4)), Number(raw.slice(5,7))-1, Number(raw.slice(8,10))) : new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleDateString('es-MX', dateOnly ? {year:'numeric',month:'short',day:'numeric'} : {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  } catch { return String(iso); }
}

// Expose functions needed by inline onclick
window.openMedicoModal = openMedicoModal;
window.saveMedico = saveMedico;
window.toggleMedico = toggleMedico;
window.openPacienteModal = openPacienteModal;
window.verPaciente = verPaciente;
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
window.registrarMedicamentoDesdeConsulta = registrarMedicamentoDesdeConsulta;
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
    const [registros, pacientes] = await Promise.all([
      DB.getAll('enfermeria'),
      DB.getAll(DB.STORES.pacientes)
    ]);

    registros.sort((a, b) =>
      String(b.fechaHora || '').localeCompare(String(a.fechaHora || ''))
    );

    area.innerHTML = `
      <div class="card">
        <h3>Registro de enfermería y signos vitales</h3>

        <form id="form-enfermeria">
          <div class="form-grid">
            <div class="form-group">
              <label>Paciente registrado</label>
              <input class="form-control" name="pacienteNombre" list="enf-pacientes-list" autocomplete="off" placeholder="Escriba para buscar paciente">
              <datalist id="enf-pacientes-list">${pacientes.map(p => `<option value="${escapeHtml(p.nombre)}"></option>`).join('')}</datalist>
            </div>

            <div class="form-group">
              <label>Responsable de enfermería</label>
              <input class="form-control" name="responsable">
            </div>

            <div class="form-group">
              <label>Presión arterial</label>
              <input class="form-control" name="presion"
                     placeholder="120/80" inputmode="numeric">
            </div>

            <div class="form-group">
              <label>Frecuencia cardíaca (lpm)</label>
              <input class="form-control" name="fc"
                     type="number" min="1">
            </div>

            <div class="form-group">
              <label>Frecuencia respiratoria (rpm)</label>
              <input class="form-control" name="fr"
                     type="number" min="1">
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
                     step="0.1">
            </div>

            <div class="form-group">
              <label>Altura (m)</label>
              <input class="form-control" name="talla" type="number" min="0.2" max="2.5" step="0.01" placeholder="1.75">
            </div>

            <div class="form-group">
              <label>Saturación de oxígeno (%)</label>
              <input class="form-control" name="spo2"
                     type="number" min="1" max="100">
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
                  <td>${escEnf(r.temperatura ?? '')}${r.temperatura != null && r.temperatura !== '' ? ' °C' : ''}</td>
                  <td>${escEnf(r.peso ?? '')}${r.peso != null && r.peso !== '' ? ' kg' : ''}</td>
                  <td>${escEnf(r.talla == null || r.talla === '' ? '' : (Number(r.talla) > 3 ? (Number(r.talla) / 100).toFixed(2) : Number(r.talla).toFixed(2)))} m</td>
                  <td>${escEnf(r.imc ?? '')}</td>
                  <td>${escEnf(r.spo2 ?? '')}${r.spo2 != null && r.spo2 !== '' ? '%' : ''}</td>
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
    const presion = form.elements.presion;
    presion.addEventListener('input', function () { const digits = presion.value.replace(/[^0-9]/g, '').slice(0, 6); presion.value = digits.length > 3 ? digits.slice(0, 3) + '/' + digits.slice(3) : digits; });

    function actualizarIMC() {
      const p = Number(peso.value);
      const t = Number(talla.value) > 3 ? Number(talla.value) / 100 : Number(talla.value);
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

  const pesoTexto = String(datos.get('peso') || '').trim();
  const tallaTexto = String(datos.get('talla') || '').trim();
  const peso = pesoTexto ? Number(pesoTexto) : null;
  const tallaValor = tallaTexto ? Number(tallaTexto) : null;
  const tallaM = tallaValor != null && tallaValor > 0 ? (tallaValor > 3 ? tallaValor / 100 : tallaValor) : null;
  if (pesoTexto && !(peso > 0)) return alert('Verifica el peso.');
  if (tallaTexto && !(tallaM > 0 && tallaM <= 2.5)) return alert('La altura debe registrarse en metros, por ejemplo 1.75.');
  const nombrePaciente = String(datos.get('pacienteNombre') || '').trim();
  const pacientes = await DB.getAll(DB.STORES.pacientes);
  const pacienteEncontrado = pacientes.find(p => String(p.nombre || '').trim().toLocaleLowerCase('es-MX') === nombrePaciente.toLocaleLowerCase('es-MX'));
  const numeroOpcional = value => String(value == null ? '' : value).trim() === '' ? null : Number(value);
  const imc = peso > 0 && tallaM > 0 ? Number((peso / (tallaM * tallaM)).toFixed(2)) : null;
  const registro = {
    pacienteId: pacienteEncontrado ? Number(pacienteEncontrado.id) : null,
    paciente: pacienteEncontrado ? pacienteEncontrado.nombre : nombrePaciente,
    responsable: String(datos.get('responsable') || '').trim(),
    presion: String(datos.get('presion') || '').trim().replace(/^(\d{2,3})\s*(\d{2,3})$/, '$1/$2'),
    fc: numeroOpcional(datos.get('fc')), fr: numeroOpcional(datos.get('fr')),
    temperatura: numeroOpcional(datos.get('temperatura')), peso, talla: tallaM, imc,
    spo2: numeroOpcional(datos.get('spo2')),
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



// ========== AGENDA MENSUAL ==========
function featureEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

function localDateString(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

// Importa de forma idempotente las próximas citas guardadas en consultas anteriores.
async function sincronizarCitasDesdeConsultas() {
  const consultas = await DB.getAll(DB.STORES.consultas);
  const agenda = await DB.getAll('agenda');
  const consultasYaAgendadas = new Set(
    agenda.map(function (c) { return c.sourceConsultaId == null ? '' : String(c.sourceConsultaId); }).filter(Boolean)
  );
  let agregadas = 0;

  for (const consulta of consultas) {
    const fecha = String(consulta.proximaCita || '').slice(0, 10);
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(fecha) || !consulta.pacienteId || !consulta.medicoId) continue;
    if (consultasYaAgendadas.has(String(consulta.id))) continue;

    // Si recepción ya agendó a ese paciente para ese día, se conserva esa cita y no se duplica.
    const existente = agenda.some(function (c) {
      return String(c.pacienteId) === String(consulta.pacienteId) &&
        c.fecha === fecha && c.estado !== 'Cancelada' && c.estado !== 'Eliminada';
    });
    if (existente) continue;

    const cita = {
      pacienteId: Number(consulta.pacienteId),
      fecha: fecha,
      hora: 'Por definir',
      medicoId: Number(consulta.medicoId),
      motivo: 'Seguimiento de consulta: ' + String(consulta.motivo || 'Consulta médica'),
      estado: 'Programada',
      creadoPor: 'sistema-consultas',
      sourceConsultaId: consulta.id,
      createdAt: new Date().toISOString()
    };
    await DB.add('agenda', cita);
    agenda.push(cita);
    consultasYaAgendadas.add(String(consulta.id));
    agregadas++;
  }
  return agregadas;
}

async function renderAgenda() {
  const area = document.getElementById('content-area');
  await sincronizarCitasDesdeConsultas();
  const month = new Date(APP.agendaMonth.getFullYear(), APP.agendaMonth.getMonth(), 1);
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const firstDay = (monthStart.getDay() + 6) % 7;
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const citas = await DB.getAll('agenda');
  const pacientes = await DB.getAll(DB.STORES.pacientes);
  const medicos = await DB.getAll(DB.STORES.medicos);
  const patientName = function (id) {
    const p = pacientes.find(function (x) { return String(x.id) === String(id); });
    return p ? p.nombre : 'Paciente no disponible';
  };
  const doctorName = function (id) {
    const m = medicos.find(function (x) { return String(x.id) === String(id); });
    return m ? m.nombre : 'Médico no disponible';
  };
  let cells = '';
  for (let i = 0; i < firstDay; i++) cells += '<div class="agenda-day agenda-day-empty"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const date = localDateString(new Date(month.getFullYear(), month.getMonth(), day));
    const dayCitas = citas.filter(function (c) { return c.fecha === date && c.estado !== 'Cancelada' && c.estado !== 'Eliminada' && (c.creadoPor !== 'portal-publico' || c.estado === 'Confirmada'); });
    const selected = APP.agendaSelectedDate === date ? ' agenda-day-selected' : '';
    cells += '<button type="button" class="agenda-day' + selected + '" onclick="seleccionarDiaAgenda(\'' + date + '\')">' +
      '<span class="agenda-day-number">' + day + '</span>' +
      (dayCitas.length ? '<span class="agenda-day-count">' + dayCitas.length + ' cita' + (dayCitas.length === 1 ? '' : 's') + '</span>' : '') +
      dayCitas.slice(0, 2).map(function (c) {
        return '<span class="agenda-day-event">' + featureEscape(c.hora || '') + ' ' + featureEscape(c.paciente || patientName(c.pacienteId)) + '</span>';
      }).join('') +
      (dayCitas.length > 2 ? '<span class="agenda-day-more">+' + (dayCitas.length - 2) + ' más</span>' : '') +
      '</button>';
  }
  const citasDia = citas.filter(function (c) { return c.fecha === APP.agendaSelectedDate && (c.creadoPor !== 'portal-publico' || c.estado === 'Confirmada'); })
    .sort(function (a, b) { return String(a.hora || '').localeCompare(String(b.hora || '')); });
  area.innerHTML =
    '<div class="card agenda-card"><div class="card-header agenda-heading">' +
    '<div><h3>Agenda de consultas</h3><p class="text-muted">Organiza las citas por paciente, fecha y médico.</p></div>' +
    '<button class="btn btn-primary" onclick="openAgendaModal()">+ Nueva cita</button></div>' +
    '<div class="agenda-toolbar"><button class="btn btn-outline btn-sm" onclick="agendaMoverMes(-1)">‹ Anterior</button>' +
    '<h3>' + featureEscape(month.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' })) + '</h3>' +
    '<button class="btn btn-outline btn-sm" onclick="agendaMoverMes(1)">Siguiente ›</button>' +
    '<button class="btn btn-outline btn-sm" onclick="agendaIrHoy()">Hoy</button></div>' +
    '<div class="agenda-weekdays">' + ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(function (d) { return '<div>' + d + '</div>'; }).join('') + '</div>' +
    '<div class="agenda-grid">' + cells + '</div></div>' +
    '<div class="card"><div class="card-header"><h3>Citas del ' + featureEscape(APP.agendaSelectedDate) + '</h3>' +
    '<button class="btn btn-primary btn-sm" onclick="openAgendaModal(null,\'' + APP.agendaSelectedDate + '\')">+ Agendar este día</button></div>' +
    '<div class="card-body">' +
    (APP.agendaSelectedDate === localDateString(new Date()) ? '<div class="alert alert-info"><strong>Notificación de hoy:</strong> ' + (citasDia.filter(function(c){return c.estado !== 'Cancelada';}).length ? citasDia.filter(function(c){return c.estado !== 'Cancelada';}).sort(function(a,b){return String(a.hora||'').localeCompare(String(b.hora||''));}).map(function(c){return featureEscape(c.hora || 'Sin hora') + ' — ' + featureEscape(c.paciente || patientName(c.pacienteId)) + ' (' + featureEscape(doctorName(c.medicoId)) + ')';}).join('<br>') : 'No hay citas programadas para hoy.') + '</div>' : '') +
    (citasDia.length ? '<div class="table-responsive"><table><thead><tr><th>Hora</th><th>Paciente</th><th>Médico</th><th>Motivo</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>' +
      citasDia.map(function (c) {
        return '<tr><td>' + featureEscape(c.hora || '—') + '</td><td><strong>' + featureEscape(c.paciente || patientName(c.pacienteId)) + '</strong>' +
          (c.creadoPor === 'portal-publico' ? '<div class="text-muted" style="font-size:.8rem">' +
            (c.edad != null ? 'Edad: ' + featureEscape(c.edad) + ' años' : '') +
            (c.fechaNacimiento ? ' · Nacimiento: ' + featureEscape(c.fechaNacimiento) : '') +
            (c.telefonoContacto ? '<br>Tel. ' + featureEscape(c.telefonoContacto) : '') + '</div>' : '') + (c.tipoPaciente ? '<div class="text-muted" style="font-size:.82rem"><strong>' + (c.tipoPaciente === 'membresia' ? 'Paciente con membresía' : 'Paciente particular') + '</strong>' + (c.tipoPaciente === 'membresia' ? '<br>Folio: ' + featureEscape(c.folioMembresia || '—') : '') + '</div>' : '') + '</td>' +
          '<td>' + featureEscape(doctorName(c.medicoId)) + '</td><td>' + featureEscape(c.motivo || '—') + '</td>' +
          '<td>' + featureEscape(c.estado || 'Programada') + '</td><td>' +
          (c.estado !== 'Cancelada' && c.estado !== 'Eliminada' ? '<button class="btn btn-success btn-sm" onclick="confirmarCitaAgenda(' + Number(c.id) + ')">' + (c.estado === 'Confirmada' ? 'Asistencia confirmada ✓' : 'Confirmar asistencia') + '</button> ' + (c.creadoPor === 'portal-publico' ? '' : '<button class="btn btn-outline btn-sm" onclick="openAgendaModal(' + Number(c.id) + ')">Editar</button> ') + '<button class="btn btn-warning btn-sm" onclick="cancelarCitaAgenda(' + Number(c.id) + ')">Cancelar cita</button> ' : '') + '<button class="btn btn-danger btn-sm" onclick="eliminarCitaAgenda(' + Number(c.id) + ')">Eliminar cita</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty-state"><p>No hay citas para este día.</p></div>') +
    '</div></div>';
}

async function confirmarCitaAgenda(id) { const cita = await DB.get('agenda', id); if (!cita) return alert('No se encontró la cita.'); cita.estado = 'Confirmada'; cita.actualizadoPor = APP.currentUser; cita.updatedAt = new Date().toISOString(); await DB.put('agenda', cita); await renderAgenda(); }
async function eliminarCitaAgenda(id) { if (!confirm('¿Eliminar esta solicitud/cita de la agenda? Solo se eliminará la cita; no se borrará el expediente médico de ningún paciente. Esta acción no se puede deshacer.')) return; try { await DB.remove('agenda', id); await renderAgenda(); } catch (error) { alert('No se pudo eliminar la cita: ' + error.message); } }
function agendaMoverMes(delta) {
  APP.agendaMonth = new Date(APP.agendaMonth.getFullYear(), APP.agendaMonth.getMonth() + delta, 1);
  renderAgenda();
}
function agendaIrHoy() {
  const today = new Date();
  APP.agendaMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  APP.agendaSelectedDate = localDateString(today);
  renderAgenda();
}
function seleccionarDiaAgenda(date) {
  APP.agendaSelectedDate = date;
  const parts = date.split('-').map(Number);
  APP.agendaMonth = new Date(parts[0], parts[1] - 1, 1);
  renderAgenda();
}

async function openAgendaModal(id, date) {
  APP.editingId = id || null;
  const modal = document.getElementById('generic-modal');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  const pacientes = await DB.getAll(DB.STORES.pacientes);
  const medicos = (await DB.getAll(DB.STORES.medicos)).filter(function (m) { return m.activo !== false; });
  let c = { fecha: date || APP.agendaSelectedDate || localDateString(new Date()), hora: '09:00', pacienteId: '', medicoId: '', motivo: '', estado: 'Programada' };
  if (id) c = await DB.get('agenda', id) || c;
  document.getElementById('modal-title').textContent = id ? 'Editar cita' : 'Nueva cita';
  body.innerHTML =
    '<div class="form-group"><label>Paciente *</label><select class="form-control" id="ag-paciente" required><option value="">Selecciona paciente</option>' +
    pacientes.map(function (p) { return '<option value="' + p.id + '"' + (String(c.pacienteId) === String(p.id) ? ' selected' : '') + '>' + featureEscape(p.nombre) + '</option>'; }).join('') +
    '</select></div><div class="form-row"><div class="form-group"><label>Fecha *</label><input class="form-control" id="ag-fecha" type="date" required value="' + featureEscape(c.fecha) + '"></div>' +
    '<div class="form-group"><label>Hora *</label><input class="form-control" id="ag-hora" type="time" required value="' + featureEscape(c.hora || '09:00') + '"></div></div>' +
    '<div class="form-group"><label>Médico que atenderá *</label><select class="form-control" id="ag-medico" required><option value="">Selecciona médico</option>' +
    medicos.map(function (m) { return '<option value="' + m.id + '"' + (String(c.medicoId) === String(m.id) ? ' selected' : '') + '>' + featureEscape(m.nombre) + '</option>'; }).join('') +
    '</select></div><div class="form-group"><label>Motivo / nota</label><textarea class="form-control" id="ag-motivo" rows="3">' + featureEscape(c.motivo || '') + '</textarea></div>';
  footer.innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cerrar</button><button class="btn btn-primary" onclick="guardarCitaAgenda()">Guardar cita</button>';
  modal.classList.add('show');
}

async function guardarCitaAgenda() {
  const pacienteId = document.getElementById('ag-paciente').value;
  const fecha = document.getElementById('ag-fecha').value;
  const hora = document.getElementById('ag-hora').value;
  const medicoId = document.getElementById('ag-medico').value;
  const motivo = document.getElementById('ag-motivo').value.trim();
  if (!pacienteId || !fecha || !hora || !medicoId) return alert('Completa paciente, fecha, hora y médico.');
  const citas = await DB.getAll('agenda');
  const conflicto = citas.some(function (c) {
    return String(c.id) !== String(APP.editingId || '') && c.fecha === fecha && c.hora === hora &&
      String(c.medicoId) === String(medicoId) && c.estado !== 'Cancelada';
  });
  if (conflicto) return alert('Ese médico ya tiene una cita registrada en esa fecha y hora.');
  const data = { pacienteId: Number(pacienteId), fecha: fecha, hora: hora, medicoId: Number(medicoId), motivo: motivo, estado: 'Programada', actualizadoPor: APP.currentUser, updatedAt: new Date().toISOString() };
  try {
    if (APP.editingId) {
      data.id = APP.editingId;
      await DB.put('agenda', data);
    } else {
      data.creadoPor = APP.currentUser;
      data.createdAt = new Date().toISOString();
      await DB.add('agenda', data);
    }
    closeModal();
    APP.agendaSelectedDate = fecha;
    APP.agendaMonth = new Date(Number(fecha.slice(0,4)), Number(fecha.slice(5,7))-1, 1);
    await renderAgenda();
  } catch (error) { alert('No se pudo guardar la cita: ' + error.message); }
}

async function cancelarCitaAgenda(id) {
  if (!confirm('¿Cancelar esta cita? Se conservará en el historial.')) return;
  const c = await DB.get('agenda', id);
  if (!c) return;
  c.estado = 'Cancelada';
  c.actualizadoPor = APP.currentUser;
  c.updatedAt = new Date().toISOString();
  await DB.put('agenda', c);
  renderAgenda();
}

// ========== CHAT INTERNO ==========
async function renderChat() {
  const area = document.getElementById('content-area');
  area.innerHTML = '<div class="card chat-card"><div class="card-header"><div><h3>Chat del personal</h3><p class="text-muted">Comunicación interna de médicos, enfermería y personal autorizado.</p></div><span class="chat-live">● En línea</span></div>' +
    '<div id="chat-messages" class="chat-messages"><div class="empty-state"><p>Cargando mensajes...</p></div></div>' +
    '<form id="chat-form" class="chat-compose"><textarea id="chat-message" class="form-control" rows="2" maxlength="2000" placeholder="Escribe un mensaje para el equipo..." required></textarea>' +
    '<button type="submit" class="btn btn-primary">Enviar mensaje</button></form>' +
    '<p class="chat-note">No uses el chat para emergencias. Evita incluir información clínica identificable que no sea necesaria.</p></div>';
  document.getElementById('chat-form').addEventListener('submit', enviarMensajeChat);
  // Enter envía el mensaje; Shift+Enter permite escribir una nueva línea.
  document.getElementById('chat-message').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const form = document.getElementById('chat-form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (form) enviarMensajeChat({ preventDefault: function () {}, currentTarget: form });
    }
  });
  await actualizarChat();
  APP.chatTimer = setInterval(function () {
    if (APP.currentModule === 'chat') actualizarChat();
  }, 5000);
}

async function actualizarChat() {
  if (APP.currentModule !== 'chat') return;
  try {
    const messages = await DB.getAll('chat');
    const maxId = messages.reduce(function (max, m) { return Math.max(max, Number(m.id) || 0); }, 0);
    const dot = document.getElementById('chat-unread-dot');
    const lastSeenKey = 'cmcc_chat_last_seen_' + APP.currentUser;
    const storedSeen = Number(localStorage.getItem(lastSeenKey) || 0);
    if (APP.currentModule === 'chat') {
      localStorage.setItem(lastSeenKey, String(maxId));
      if (dot) dot.hidden = true;
    } else if (dot) {
      dot.hidden = maxId <= storedSeen;
    }
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.innerHTML = messages.length ? messages.map(function (m) {
      const own = m.senderUsername === APP.currentUser;
      const roleNames = { admin: 'Administrador', medico: 'Médico', enfermeria: 'Enfermería', empleado: 'Personal' };
      const date = m.createdAt ? new Date(m.createdAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '';
      return '<div class="chat-message' + (own ? ' chat-message-own' : '') + '"><div class="chat-message-meta"><strong>' + featureEscape(m.senderName) +
        '</strong><span>' + featureEscape(roleNames[m.senderRole] || m.senderRole || 'Personal') + ' · ' + featureEscape(date) +
        '</span></div><div class="chat-message-text">' + featureEscape(m.message).replace(/\n/g, '<br>') + '</div></div>';
    }).join('') : '<div class="empty-state"><p>Aún no hay mensajes. Inicia la conversación del equipo.</p></div>';
    if (wasNearBottom) box.scrollTop = box.scrollHeight;
  } catch (error) {
    console.error('Chat:', error);
  }
}

async function enviarMensajeChat(event) {
  event.preventDefault();
  const input = document.getElementById('chat-message');
  const message = input.value.trim();
  if (!message) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await DB.sendChat(message);
    input.value = '';
    await actualizarChat();
  } catch (error) {
    alert('No se pudo enviar el mensaje: ' + error.message);
  } finally { button.disabled = false; input.focus(); }
}

function obtenerFechaNacimientoPaciente(paciente) {
  return paciente ? (paciente.fechaNac || paciente.fechaNacimiento || paciente.fecha_nacimiento || '') : '';
}

// Las fechas de nacimiento son fechas de calendario, no instantes UTC.
function normalizarFechaNacimientoISO(valor) {
  if (!valor) return '';
  const raw = String(valor).trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.slice(0, 10));
  if (!match) {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    if (match) match = [match[0], match[3], match[2], match[1]];
  }
  if (!match) return '';
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (year < 1 || year > 9999 || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
  return String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

function formatearFechaNacimientoEntrada(valor) {
  const iso = normalizarFechaNacimientoISO(valor);
  return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '';
}

function convertirFechaNacimientoAISO(valor) {
  const raw = String(valor || '').trim();
  if (!raw) return '';
  let match = /^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/.exec(raw);
  if (match) return normalizarFechaNacimientoISO(match[3] + '-' + match[2] + '-' + match[1]);
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  return match ? normalizarFechaNacimientoISO(raw) : '';
}

function calcularEdad(fechaNacimiento) {
  const iso = normalizarFechaNacimientoISO(fechaNacimiento);
  if (!iso) return null;
  const nacimiento = { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
  const hoy = new Date();
  let edad = hoy.getFullYear() - nacimiento.year;
  if (hoy.getMonth() + 1 < nacimiento.month || (hoy.getMonth() + 1 === nacimiento.month && hoy.getDate() < nacimiento.day)) edad--;
  return edad >= 0 ? edad : null;
}

// ========== RECETA INDEPENDIENTE ==========
async function renderRecetas() {
  const area = document.getElementById('content-area');
  const plantillas = await DB.getAll('plantillas_receta');
  const medicos = await DB.getAll(DB.STORES.medicos);
  area.innerHTML = '<div class="card"><div class="card-header"><div><h3>Plantillas de receta</h3><p class="text-muted">Crea y administra los formatos que el médico podrá elegir al finalizar una consulta.</p></div><button class="btn btn-primary btn-sm" onclick="openPlantillaRecetaModal()">+ Nueva plantilla</button></div><div class="card-body"><div class="recipe-banner"><strong>Receta predeterminada protegida</strong><span>La receta habitual se conserva y seguirá disponible en todas las consultas. Aquí solo administras plantillas adicionales.</span></div>' +
  (plantillas.length ? '<div class="table-responsive"><table><thead><tr><th>Nombre de plantilla</th><th>Médico titular</th><th>Encabezado</th><th>Acciones</th></tr></thead><tbody>' + plantillas.map(function(p) { const m=medicos.find(function(x){return String(x.id)===String(p.medicoId);}); return '<tr><td><strong>'+featureEscape(p.nombre||'Plantilla sin nombre')+'</strong></td><td>'+featureEscape(m?m.nombre:'—')+'</td><td>'+featureEscape(p.encabezado||'—')+'</td><td><button class="btn btn-outline btn-sm" onclick="openPlantillaRecetaModal('+Number(p.id)+')">Editar</button> <button class="btn btn-danger btn-sm" onclick="eliminarPlantillaReceta('+Number(p.id)+')">Eliminar</button></td></tr>'; }).join('')+'</tbody></table></div>' : '<div class="empty-state"><p>Aún no hay plantillas adicionales. La receta predeterminada seguirá disponible en las consultas.</p></div>')+'</div></div>';
}
async function eliminarPlantillaReceta(id) {
  const p=await DB.get('plantillas_receta',id); if(!p)return alert('No se encontró la plantilla.');
  if(!confirm('¿Eliminar la plantilla "'+(p.nombre||'sin nombre')+'"? La receta predeterminada no se puede eliminar.'))return;
  try { await DB.remove('plantillas_receta',id); await renderRecetas(); alert('Plantilla eliminada. La receta predeterminada se conservó.'); }
  catch(e){alert('No se pudo eliminar la plantilla: '+e.message);}
}
async function openPlantillaRecetaModal(id) {
  APP.editingId = id || null;
  const modal = document.getElementById('generic-modal');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  const medicos = await DB.getAll(DB.STORES.medicos);
  let p = { nombre: 'Receta médica', medicoId: '', encabezado: 'CONSULTORIO MÉDICO CC', pie: 'La receta debe ser validada y firmada por el médico tratante.', firma: '', domicilio: '', telefono: '' };
  if (id) p = await DB.get('plantillas_receta', id) || p;
  document.getElementById('modal-title').textContent = id ? 'Editar plantilla de receta' : 'Nueva plantilla de receta';
  body.innerHTML = '<div class="form-group"><label>Nombre de la plantilla *</label><input class="form-control" id="pt-nombre" value="' + featureEscape(p.nombre) + '" required></div>' +
    '<div class="form-group"><label>Médico titular *</label><select class="form-control" id="pt-medico"><option value="">Selecciona médico</option>' +
    medicos.map(function (m) { return '<option value="' + m.id + '"' + (String(p.medicoId) === String(m.id) ? ' selected' : '') + '>' + featureEscape(m.nombre) + '</option>'; }).join('') +
    '</select></div><div class="form-group"><label>Encabezado / nombre del consultorio</label><input class="form-control" id="pt-encabezado" value="' + featureEscape(p.encabezado || '') + '"></div>' +
    '<div class="form-row"><div class="form-group"><label>Domicilio profesional</label><input class="form-control" id="pt-domicilio" value="' + featureEscape(p.domicilio || '') + '"></div>' +
    '<div class="form-group"><label>Teléfono</label><input class="form-control" id="pt-telefono" value="' + featureEscape(p.telefono || '') + '"></div></div>' +
    '<div class="form-group"><label>Texto de firma / cédula</label><textarea class="form-control" id="pt-firma" rows="2">' + featureEscape(p.firma || '') + '</textarea></div>' +
    '<div class="form-group"><label>Pie de página</label><textarea class="form-control" id="pt-pie" rows="2" autocomplete="off">' + featureEscape(p.pie || '') + '</textarea></div>' +
    '<hr><h4>Hoja membretada y alineación</h4><div class="form-group"><label>Imagen de fondo de la receta (JPG o PNG)</label><input class="form-control" id="pt-fondo" type="file" accept="image/png,image/jpeg" autocomplete="off"><small>Sube una imagen de tu hoja preimpresa. El texto se imprimirá encima de ella.</small></div>' +
    (p.fondoImagen ? '<div class="form-group"><img src="' + p.fondoImagen + '" alt="Fondo de receta" style="max-width:220px;max-height:150px;object-fit:contain;border:1px solid #aaa;padding:4px"><label><input type="checkbox" id="pt-quitar-fondo"> Quitar imagen actual</label></div>' : '') +
    '<div class="form-row"><div class="form-group"><label>Margen superior (mm)</label><input class="form-control" type="number" id="pt-margen-superior" min="0" max="100" value="' + Number(p.margenSuperior || 10) + '" autocomplete="off"></div><div class="form-group"><label>Margen izquierdo (mm)</label><input class="form-control" type="number" id="pt-margen-izquierdo" min="0" max="100" value="' + Number(p.margenIzquierdo || 10) + '" autocomplete="off"></div></div>' +
    '<button type="button" class="btn btn-outline btn-sm" onclick="vistaPreviaPlantillaReceta()">Vista previa / calibrar</button>';
  footer.innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="guardarPlantillaReceta()">Guardar plantilla</button>';
  modal.classList.add('show');
}

async function vistaPreviaPlantillaReceta() {
  const file=document.getElementById('pt-fondo').files[0];
  let fondo='';
  if(file){if(!/^image\/(png|jpeg)$/.test(file.type))return alert('Selecciona una imagen JPG o PNG.');fondo=await new Promise(function(resolve,reject){const r=new FileReader();r.onload=function(){resolve(r.result);};r.onerror=reject;r.readAsDataURL(file);});}
  else if(APP.editingId){const p=await DB.get('plantillas_receta',APP.editingId);fondo=p&&p.fondoImagen?p.fondoImagen:'';}
  const top=Number(document.getElementById('pt-margen-superior').value||10), left=Number(document.getElementById('pt-margen-izquierdo').value||10);
  const w=window.open('','_blank');if(!w)return alert('El navegador bloqueó la vista previa. Permite ventanas emergentes para este sitio.');
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Vista previa de receta</title><style>@page{size:letter;margin:0}*{box-sizing:border-box}body{margin:0;font:12px Arial}.sheet{position:relative;width:216mm;height:279mm;margin:0 auto;background:#fff;overflow:hidden}.bg{position:absolute;inset:0;width:100%;height:100%;object-fit:fill}.content{position:absolute;top:'+top+'mm;left:'+left+'mm;right:10mm;z-index:2;font:10pt "Times New Roman",serif}.guide{border:1px dashed #888;padding:3mm;min-height:40mm}.hint{position:fixed;top:8px;right:8px;background:#fff;padding:8px;border:1px solid #888;z-index:5}@media print{.hint{display:none}}</style></head><body><div class="hint">Tamaño carta · Superior: '+top+' mm · Izquierdo: '+left+' mm</div><div class="sheet">'+(fondo?'<img class="bg" src="'+fondo+'">':'')+'<div class="content"><div class="guide"><strong>'+featureEscape(document.getElementById('pt-encabezado').value||document.getElementById('pt-nombre').value)+'</strong><p>Paciente: __________________________________</p><p>Fecha: ________________</p><p>Diagnóstico: ______________________________</p><p>Rp/</p><p>__________________________________________</p><p>__________________________________________</p><br><p style="text-align:center">Firma Del Medico</p></div></div></div></body></html>');
  w.document.close();
}
async function guardarPlantillaReceta() {
  const nombre = document.getElementById('pt-nombre').value.trim();
  const medicoId = document.getElementById('pt-medico').value;
  if (!nombre || !medicoId) return alert('Indica el nombre de la plantilla y el médico titular.');
  const existente = APP.editingId ? await DB.get('plantillas_receta', APP.editingId) : null;
  const archivo = document.getElementById('pt-fondo').files[0];
  let fondoImagen = existente && existente.fondoImagen ? existente.fondoImagen : '';
  if (document.getElementById('pt-quitar-fondo') && document.getElementById('pt-quitar-fondo').checked) fondoImagen = '';
  if (archivo) {
    if (!/^image\/(png|jpeg)$/.test(archivo.type)) return alert('Selecciona una imagen JPG o PNG.');
    if (archivo.size > 5 * 1024 * 1024) return alert('La imagen debe pesar 5 MB o menos.');
    fondoImagen = await new Promise(function(resolve,reject){const reader=new FileReader();reader.onload=function(){resolve(reader.result);};reader.onerror=reject;reader.readAsDataURL(archivo);});
  }
  const data = {
    nombre: nombre, medicoId: Number(medicoId),
    fondoImagen: fondoImagen,
    margenSuperior: Math.max(0,Math.min(100,Number(document.getElementById('pt-margen-superior').value || 10))),
    margenIzquierdo: Math.max(0,Math.min(100,Number(document.getElementById('pt-margen-izquierdo').value || 10))),
    encabezado: document.getElementById('pt-encabezado').value.trim(),
    domicilio: document.getElementById('pt-domicilio').value.trim(),
    telefono: document.getElementById('pt-telefono').value.trim(),
    firma: document.getElementById('pt-firma').value.trim(),
    pie: document.getElementById('pt-pie').value.trim(),
    actualizadoPor: APP.currentUser, updatedAt: new Date().toISOString()
  };
  try {
    if (APP.editingId) { data.id = APP.editingId; await DB.put('plantillas_receta', data); }
    else { data.createdAt = new Date().toISOString(); await DB.add('plantillas_receta', data); }
    closeModal();
    await renderRecetas();
  } catch (error) { alert('No se pudo guardar la plantilla: ' + error.message); }
}


// ========== EMPLEADOS ==========
async function renderEmpleados() {
  const empleados = await DB.getAll(DB.STORES.empleados);
  const area = document.getElementById('content-area');
  area.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div><h3>Directorio de empleados</h3><p class="text-muted">Administra los datos del personal de recepción, administración y apoyo.</p></div>
        <button class="btn btn-primary btn-sm" onclick="openEmpleadoModal()">+ Nuevo empleado</button>
      </div>
      <div class="card-body">
        ${empleados.length ? `<div class="table-responsive"><table>
          <thead><tr><th>Nombre</th><th>Puesto</th><th>Teléfono</th><th>Correo</th><th>Estado</th><th>Acciones</th></tr></thead>
          <tbody>${empleados.map(function(e) {
            return `<tr>
              <td><strong>${featureEscape(e.nombre || '')}</strong></td>
              <td>${featureEscape(e.puesto || '—')}</td>
              <td>${featureEscape(e.telefono || '—')}</td>
              <td>${featureEscape(e.correo || '—')}</td>
              <td>${e.activo === false ? '<span class="badge badge-secondary">Inactivo</span>' : '<span class="badge badge-success">Activo</span>'}</td>
              <td><button class="btn btn-outline btn-sm" onclick="openEmpleadoModal(${Number(e.id)})">Editar</button>
              <button class="btn btn-danger btn-sm" onclick="eliminarEmpleado(${Number(e.id)})">Eliminar</button></td>
            </tr>`;
          }).join('')}</tbody></table></div>` : '<div class="empty-state"><div class="icon">👥</div><p>No hay empleados registrados todavía.</p><p>Selecciona “Nuevo empleado” para agregar el primero.</p></div>'}
      </div>
    </div>`;
}

async function openEmpleadoModal(id = null) {
  APP.editingId = id;
  const modal = document.getElementById('generic-modal');
  document.getElementById('modal-title').textContent = id ? 'Editar empleado' : 'Nuevo empleado';
  let e = { nombre: '', puesto: '', telefono: '', correo: '', notas: '', activo: true };
  if (id) e = await DB.get(DB.STORES.empleados, id) || e;
  document.getElementById('modal-body').innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>Nombre completo *</label><input class="form-control" id="emp-nombre" maxlength="120" value="${escapeAttr(e.nombre || '')}" required></div>
      <div class="form-group"><label>Puesto</label><input class="form-control" id="emp-puesto" maxlength="100" value="${escapeAttr(e.puesto || '')}" placeholder="Recepción, asistente, limpieza…"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Teléfono</label><input class="form-control" id="emp-telefono" maxlength="40" value="${escapeAttr(e.telefono || '')}"></div>
      <div class="form-group"><label>Correo electrónico</label><input class="form-control" id="emp-correo" type="email" maxlength="150" value="${escapeAttr(e.correo || '')}"></div>
    </div>
    <div class="form-group"><label>Notas</label><textarea class="form-control" id="emp-notas" rows="3" maxlength="1000">${featureEscape(e.notas || '')}</textarea></div>
    <div class="form-group"><label><input type="checkbox" id="emp-activo" ${e.activo === false ? '' : 'checked'}> Empleado activo</label></div>`;
  document.getElementById('modal-footer').innerHTML = '<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="guardarEmpleado()">Guardar empleado</button>';
  modal.classList.add('show');
}

async function guardarEmpleado() {
  const nombre = document.getElementById('emp-nombre').value.trim();
  if (!nombre) return alert('El nombre del empleado es obligatorio.');
  const data = {
    nombre,
    puesto: document.getElementById('emp-puesto').value.trim(),
    telefono: document.getElementById('emp-telefono').value.trim(),
    correo: document.getElementById('emp-correo').value.trim(),
    notas: document.getElementById('emp-notas').value.trim(),
    activo: document.getElementById('emp-activo').checked
  };
  try {
    if (APP.editingId) {
      data.id = APP.editingId;
      await DB.put(DB.STORES.empleados, data);
    } else {
      await DB.add(DB.STORES.empleados, data);
    }
    closeModal();
    await renderEmpleados();
  } catch (error) {
    alert('No se pudo guardar el empleado: ' + error.message);
  }
}

async function eliminarEmpleado(id) {
  if (!confirm('¿Eliminar este registro de empleado? Esta acción no elimina las cuentas de acceso del módulo “Accesos del personal”.')) return;
  try {
    await DB.remove(DB.STORES.empleados, id);
    await renderEmpleados();
  } catch (error) {
    alert('No se pudo eliminar el registro: ' + error.message);
  }
}

// ========== CUENTAS DEL PERSONAL ==========
async function renderPersonal() {
  if (APP.currentRole !== 'admin') return alert('Solo un administrador puede gestionar accesos.');
  if (!APP.personalAccessGranted) { const codigo = prompt('Introduce el código de acceso del personal:'); if (codigo !== '199703') { alert('Código incorrecto.'); return; } APP.personalAccessGranted = true; }
  const area = document.getElementById('content-area');
  const users = await DB.getAll('personal');
  const roleLabels = { admin: 'Administrador', medico: 'Médico', enfermeria: 'Enfermería', empleado: 'Personal / recepción' };

  area.innerHTML = '<div class="card"><div class="card-header"><div><h3>Cuentas del personal</h3><p class="text-muted">Crea accesos individuales y asigna permisos.</p></div></div>' +
    '<div class="card-body"><form id="staff-form"><div class="form-row"><div class="form-group"><label>Nombre para mostrar *</label><input class="form-control" id="staff-name" required maxlength="100"></div>' +
    '<div class="form-group"><label>Usuario de acceso *</label><input class="form-control" id="staff-username" minlength="3" maxlength="40" pattern="[A-Za-z0-9._-]+" required></div></div>' +
    '<div class="form-row"><div class="form-group"><label>Rol y permisos *</label><select class="form-control" id="staff-role"><option value="medico">Médico</option><option value="enfermeria">Enfermería</option><option value="empleado">Personal / recepción</option><option value="admin">Administrador</option></select></div>' +
    '<div class="form-group"><label>Contraseña inicial (mínimo 10 caracteres) *</label><input class="form-control" id="staff-password" type="password" minlength="10" maxlength="200" autocomplete="new-password" required></div></div>' +
    '<button class="btn btn-primary" type="submit">Crear cuenta</button><p class="text-muted staff-help">Asigna el rol de administrador solo a personas autorizadas. Las contraseñas no se muestran; solo pueden restablecerse.</p></form></div></div>' +
    '<div class="card"><div class="card-header"><h3>Usuarios registrados</h3></div><div class="card-body">' +
    (users.length ? '<div class="table-responsive"><table><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol / permisos</th><th>Estado</th><th>Administrar</th></tr></thead><tbody>' +
      users.map(function (u) {
        return '<tr><td>' + featureEscape(u.displayName) + '</td><td>' + featureEscape(u.username) + '</td><td><select class="form-control" id="staff-role-' + Number(u.id) + '">' +
          ['empleado','medico','enfermeria','admin'].map(function (r) { return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + roleLabels[r] + '</option>'; }).join('') +
          '</select><button class="btn btn-outline btn-sm" style="margin-top:5px" onclick="actualizarRolPersonal(' + Number(u.id) + ')">Guardar rol</button></td>' +
          '<td>' + (u.active ? '<span class="badge badge-success">Activo</span>' : '<span class="badge badge-secondary">Desactivado</span>') + '</td><td class="staff-actions">' +
          '<button class="btn btn-outline btn-sm" onclick="cambiarPasswordPersonal(' + Number(u.id) + ',\'' + featureEscape(u.username).replace(/'/g, '&#39;') + '\')">Cambiar contraseña</button> ' +
          '<button class="btn ' + (u.active ? 'btn-danger' : 'btn-success') + ' btn-sm" onclick="cambiarEstadoPersonal(' + Number(u.id) + ',' + (!u.active) + ')">' + (u.active ? 'Desactivar' : 'Activar') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty-state"><p>Aún no hay cuentas adicionales. La cuenta principal se configura en Render.</p></div>') +
    '</div></div>';
  document.getElementById('staff-form').addEventListener('submit', crearCuentaPersonal);
}

async function crearCuentaPersonal(event) {
  event.preventDefault();
  const data = {
    displayName: document.getElementById('staff-name').value.trim(),
    username: document.getElementById('staff-username').value.trim(),
    role: document.getElementById('staff-role').value,
    password: document.getElementById('staff-password').value
  };
  try {
    await DB.addStaffUser(data);
    alert('Cuenta creada correctamente.');
    await renderPersonal();
  } catch (error) { alert('No se pudo crear la cuenta: ' + error.message); }
}

async function actualizarRolPersonal(id) {
  const role = document.getElementById('staff-role-' + id).value;
  const labels = { admin: 'Administrador', medico: 'Médico', enfermeria: 'Enfermería', empleado: 'Personal / recepción' };
  if (!confirm('¿Cambiar los permisos de esta cuenta a "' + labels[role] + '"?')) return;
  try {
    await DB.updateStaffUser(id, { role });
    alert('Permisos actualizados. El usuario debe iniciar sesión de nuevo para que se apliquen.');
    await renderPersonal();
  } catch (error) { alert('No se pudo actualizar el rol: ' + error.message); }
}

async function cambiarPasswordPersonal(id, username) {
  const password = prompt('Escribe la nueva contraseña para ' + username + '. Debe tener al menos 10 caracteres:');
  if (password === null) return;
  if (password.length < 10 || password.length > 200) {
    alert('La contraseña debe tener entre 10 y 200 caracteres.');
    return;
  }
  try {
    await DB.updateStaffUser(id, { password });
    alert('Contraseña actualizada. Comunícala directamente a la persona y no por el chat grupal.');
  } catch (error) { alert('No se pudo cambiar la contraseña: ' + error.message); }
}

async function cambiarEstadoPersonal(id, active) {
  if (!confirm(active ? '¿Activar esta cuenta?' : '¿Desactivar esta cuenta?')) return;
  try {
    await DB.setStaffActive(id, active);
    await renderPersonal();
  } catch (error) { alert('No se pudo actualizar la cuenta: ' + error.message); }
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


// Evita el autocompletado de credenciales en campos clínicos. Chrome/Edge pueden ignorar autocomplete="off",
// por lo que los campos de texto se mantienen readonly hasta que el usuario los enfoca.
(function protegerCamposClinicosDeAutorrelleno() {
  function proteger(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('input, textarea').forEach(function(el) {
      const type=(el.getAttribute('type')||'text').toLowerCase();
      const id=(el.id||'').toLowerCase(), name=(el.name||'').toLowerCase();
      if(type==='password'||/login|usuario|username|staff-password/.test(id+' '+name))return;
      if(!(['text','search','email','tel','url','number'].includes(type)||el.tagName==='TEXTAREA'))return;
      el.setAttribute('autocomplete','new-password');
      el.setAttribute('autocorrect','off');
      el.setAttribute('autocapitalize','off');
      el.setAttribute('spellcheck','false');
      if(!el.name || /^(name|username|email|search|password)$/i.test(el.name)) el.name='clinical-field-'+Math.random().toString(36).slice(2,10);
      if(!el.dataset.autofillGuard){
        el.dataset.autofillGuard='1';
        el.setAttribute('readonly','readonly');
        el.addEventListener('focus',function(){el.removeAttribute('readonly');},{once:true});
      }
    });
  }
  function init(){proteger(document);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
  const observer=new MutationObserver(function(records){records.forEach(function(r){r.addedNodes.forEach(function(n){if(n.nodeType===1){proteger(n);if(n.matches&&n.matches('input,textarea'))proteger(n.parentNode);}});});});
  observer.observe(document.documentElement,{childList:true,subtree:true});
})();
