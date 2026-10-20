
/* Consultorio Médico CC - adaptador de datos API centralizada */

const STORES = {
  medicos: 'medicos',
  pacientes: 'pacientes',
  consultas: 'consultas',
  medicamentos: 'medicamentos',
  estudios: 'estudios',
  cobros: 'cobros',
  config: 'config',
  enfermeria: 'enfermeria',
  empleados: 'empleados',
  agenda: 'agenda',
  plantillas_receta: 'plantillas_receta',
  recetas: 'recetas'
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = response.status === 204
    ? null
    : await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Error HTTP ${response.status}`);
  }

  return data;
}

async function openDB() {
  await api('/api/health');
  return true;
}

async function login(username, password) {
  return api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

async function getSession() {
  try {
    return await api('/api/auth/me');
  } catch {
    return null;
  }
}

async function logout() {
  try {
    await api('/api/auth/logout', {
      method: 'POST',
      body: '{}'
    });
  } catch {}
}

async function verifyNip(tipo, nip) {
  return api('/api/auth/verify-nip', {
    method: 'POST',
    body: JSON.stringify({ tipo, nip })
  });
}

async function confirmarCobro(id, metodoPago) {
  return api(`/api/cobros/${encodeURIComponent(id)}/confirmar`, {
    method: 'POST',
    body: JSON.stringify({ metodoPago })
  });
}

async function registrarCobroConsulta(consultaId, monto) {
  return api(`/api/consultas/${encodeURIComponent(consultaId)}/registrar-cobro`, {
    method: 'POST',
    body: JSON.stringify({ monto })
  });
}

async function getCobrosHoy(fecha, offsetMinutos = new Date().getTimezoneOffset()) {
  return api(
    `/api/dashboard/cobros-hoy?fecha=${encodeURIComponent(fecha)}&offsetMinutos=${encodeURIComponent(offsetMinutos)}`
  );
}

async function add(storeName, data) {
  return api(`/api/data/${encodeURIComponent(storeName)}`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

async function put(storeName, data) {
  if (storeName === STORES.config) {
    return api(
      `/api/data/${encodeURIComponent(storeName)}/${encodeURIComponent(data.key)}`,
      {
        method: 'PUT',
        body: JSON.stringify(data)
      }
    );
  }

  if (data.id == null) {
    return add(storeName, data);
  }

  return api(
    `/api/data/${encodeURIComponent(storeName)}/${encodeURIComponent(data.id)}`,
    {
      method: 'PUT',
      body: JSON.stringify(data)
    }
  );
}

async function get(storeName, id) {
  try {
    return await api(
      `/api/data/${encodeURIComponent(storeName)}/${encodeURIComponent(id)}`
    );
  } catch (error) {
    if (error.message.includes('no encontrado')) {
      return undefined;
    }

    throw error;
  }
}

async function getAll(storeName) {
  if (storeName === 'chat') return api('/api/chat');
  if (storeName === 'personal') return api('/api/staff-users');
  return api(`/api/data/${encodeURIComponent(storeName)}`);
}

async function sendChat(message) {
  return api('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message })
  });
}

async function addStaffUser(data) {
  return api('/api/staff-users', {
    method: 'POST',
    body: JSON.stringify(data)
  });
}

async function setStaffActive(id, active) {
  return api(`/api/staff-users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ active })
  });
}

async function updateStaffUser(id, changes) {
  return api(`/api/staff-users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(changes)
  });
}

async function remove(storeName, id) {
  return api(
    `/api/data/${encodeURIComponent(storeName)}/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
}

async function clearStore(storeName) {
  return api(`/api/data/${encodeURIComponent(storeName)}`, {
    method: 'DELETE'
  });
}

async function getConfig(key) {
  const item = await get(STORES.config, key);
  return item ? item.value : null;
}

async function setConfig(key, value) {
  return put(STORES.config, { key, value });
}

async function seedIfEmpty() {
  // Catálogo inicial de referencia. Se agregan únicamente faltantes y nunca se borran
  // medicamentos que el consultorio ya haya capturado.
  const catalogoMedicamentos = [
    { nombre: 'Paracetamol', presentacion: 'Tabletas', concentracion: '500 mg' },
    { nombre: 'Paracetamol', presentacion: 'Suspensión oral', concentracion: '160 mg/5 ml' },
    { nombre: 'Ibuprofeno', presentacion: 'Tabletas', concentracion: '400 mg' },
    { nombre: 'Ibuprofeno', presentacion: 'Suspensión oral', concentracion: '100 mg/5 ml' },
    { nombre: 'Amoxicilina', presentacion: 'Cápsulas', concentracion: '500 mg' },
    { nombre: 'Amoxicilina', presentacion: 'Suspensión oral', concentracion: '250 mg/5 ml' },
    { nombre: 'Amoxicilina / ácido clavulánico', presentacion: 'Tabletas', concentracion: '875 mg/125 mg' },
    { nombre: 'Amoxicilina / ácido clavulánico', presentacion: 'Tabletas', concentracion: '500 mg/125 mg' },
    { nombre: 'Amoxicilina / ácido clavulánico', presentacion: 'Suspensión oral', concentracion: '400 mg/57 mg por 5 ml' },
    { nombre: 'Azitromicina', presentacion: 'Tabletas', concentracion: '500 mg' },
    { nombre: 'Azitromicina', presentacion: 'Suspensión oral', concentracion: '200 mg/5 ml' },
    { nombre: 'Cefalexina', presentacion: 'Cápsulas', concentracion: '500 mg' },
    { nombre: 'Cefalexina', presentacion: 'Suspensión oral', concentracion: '250 mg/5 ml' },
    { nombre: 'Cefixima', presentacion: 'Cápsulas', concentracion: '400 mg' },
    { nombre: 'Cefixima', presentacion: 'Suspensión oral', concentracion: '100 mg/5 ml' },
    { nombre: 'Levofloxacino', presentacion: 'Tabletas', concentracion: '500 mg' },
    { nombre: 'Levofloxacino', presentacion: 'Tabletas', concentracion: '750 mg' },
    { nombre: 'Trimetoprima / sulfametoxazol', presentacion: 'Tabletas', concentracion: '160 mg/800 mg' },
    { nombre: 'Metronidazol', presentacion: 'Tabletas', concentracion: '500 mg' },
    { nombre: 'Nitazoxanida', presentacion: 'Suspensión oral', concentracion: '100 mg/5 ml' },
    { nombre: 'Nitazoxanida', presentacion: 'Tabletas', concentracion: '500 mg' },
    { nombre: 'Omeprazol', presentacion: 'Cápsulas', concentracion: '20 mg' },
    { nombre: 'Esomeprazol', presentacion: 'Cápsulas', concentracion: '40 mg' },
    { nombre: 'Lansoprazol', presentacion: 'Cápsulas', concentracion: '30 mg' },
    { nombre: 'Dexlansoprazol', presentacion: 'Cápsulas de liberación retardada', concentracion: '30 mg' },
    { nombre: 'Loratadina', presentacion: 'Tabletas', concentracion: '10 mg' },
    { nombre: 'Loratadina', presentacion: 'Jarabe', concentracion: '5 mg/5 ml' },
    { nombre: 'Cetirizina', presentacion: 'Tabletas', concentracion: '10 mg' },
    { nombre: 'Levocetirizina', presentacion: 'Tabletas', concentracion: '5 mg' },
    { nombre: 'Desloratadina', presentacion: 'Tabletas', concentracion: '5 mg' },
    { nombre: 'Salbutamol', presentacion: 'Inhalador', concentracion: '100 mcg por dosis' },
    { nombre: 'Bromhexina', presentacion: 'Solución oral', concentracion: '80 mg/100 ml' },
    { nombre: 'Ambroxol', presentacion: 'Jarabe', concentracion: '15 mg/5 ml' },
    { nombre: 'Dextrometorfano', presentacion: 'Jarabe', concentracion: '15 mg/5 ml' },
    { nombre: 'Metformina', presentacion: 'Tabletas', concentracion: '500 mg' },
    { nombre: 'Metformina', presentacion: 'Tabletas', concentracion: '850 mg' },
    { nombre: 'Metformina', presentacion: 'Tabletas de liberación prolongada', concentracion: '1000 mg' },
    { nombre: 'Metformina / vildagliptina', presentacion: 'Tabletas', concentracion: '500 mg/50 mg' },
    { nombre: 'Losartán', presentacion: 'Tabletas', concentracion: '50 mg' },
    { nombre: 'Losartán', presentacion: 'Tabletas', concentracion: '100 mg' },
    { nombre: 'Irbesartán / amlodipino', presentacion: 'Tabletas', concentracion: '150 mg/5 mg' },
    { nombre: 'Amlodipino', presentacion: 'Tabletas', concentracion: '5 mg' },
    { nombre: 'Amlodipino', presentacion: 'Tabletas', concentracion: '10 mg' },
    { nombre: 'Enalapril', presentacion: 'Tabletas', concentracion: '10 mg' },
    { nombre: 'Captopril', presentacion: 'Tabletas', concentracion: '25 mg' },
    { nombre: 'Carvedilol', presentacion: 'Tabletas', concentracion: '6.25 mg' },
    { nombre: 'Atorvastatina', presentacion: 'Tabletas', concentracion: '20 mg' },
    { nombre: 'Rosuvastatina', presentacion: 'Tabletas', concentracion: '10 mg' },
    { nombre: 'Gemfibrozilo', presentacion: 'Tabletas', concentracion: '600 mg' },
    { nombre: 'Clopidogrel', presentacion: 'Tabletas', concentracion: '75 mg' },
    { nombre: 'Levotiroxina sódica', presentacion: 'Tabletas', concentracion: '100 mcg' },
    { nombre: 'Alopurinol', presentacion: 'Tabletas', concentracion: '300 mg' },
    { nombre: 'Meloxicam', presentacion: 'Tabletas', concentracion: '7.5 mg' },
    { nombre: 'Meloxicam', presentacion: 'Tabletas', concentracion: '15 mg' },
    { nombre: 'Sulindaco', presentacion: 'Tabletas', concentracion: '200 mg' },
    { nombre: 'Piroxicam', presentacion: 'Cápsulas', concentracion: '20 mg' },
    { nombre: 'Tizanidina', presentacion: 'Tabletas', concentracion: '2 mg' },
    { nombre: 'Paracetamol / ibuprofeno', presentacion: 'Tabletas', concentracion: '500 mg/200 mg' },
    { nombre: 'Paracetamol / orfenadrina', presentacion: 'Tabletas', concentracion: '450 mg/35 mg' },
    { nombre: 'Nafazolina', presentacion: 'Solución oftálmica', concentracion: '0.1%' },
    { nombre: 'Nafazolina / feniramina', presentacion: 'Solución oftálmica', concentracion: '0.025%/0.3%' },
    { nombre: 'Dexametasona / neomicina', presentacion: 'Gotas oftálmicas', concentracion: '1 mg/3.5 mg por ml' },
    { nombre: 'Cloranfenicol', presentacion: 'Ungüento oftálmico', concentracion: '5 mg/g' },
    { nombre: 'Miconazol', presentacion: 'Crema', concentracion: '2%' },
    { nombre: 'Tretinoína', presentacion: 'Crema', concentracion: '0.05%' },
    { nombre: 'Mometasona furoato', presentacion: 'Ungüento', concentracion: '0.1%' },
    { nombre: 'Polimixina B / neomicina / bacitracina', presentacion: 'Ungüento', concentracion: 'Combinación tópica' },
    { nombre: 'Fenazopiridina', presentacion: 'Tabletas', concentracion: '100 mg' },
    { nombre: 'Hidroxizina', presentacion: 'Tabletas', concentracion: '10 mg' },
    { nombre: 'Hidroxizina', presentacion: 'Tabletas', concentracion: '25 mg' },
    { nombre: 'Paroxetina', presentacion: 'Tabletas', concentracion: '20 mg' },
    { nombre: 'Quetiapina', presentacion: 'Tabletas', concentracion: '25 mg' },
    { nombre: 'Quetiapina', presentacion: 'Tabletas', concentracion: '100 mg' },
    { nombre: 'Pregabalina', presentacion: 'Cápsulas', concentracion: '50 mg' },
    { nombre: 'Atomoxetina', presentacion: 'Cápsulas', concentracion: '40 mg' },
    { nombre: 'Tamsulosina', presentacion: 'Cápsulas', concentracion: '0.4 mg' },
    { nombre: 'Dutasterida / tamsulosina', presentacion: 'Cápsulas', concentracion: '0.5 mg/0.4 mg' },
    { nombre: 'Ivermectina', presentacion: 'Tabletas', concentracion: '6 mg' },
    { nombre: 'Fosfomicina', presentacion: 'Polvo granulado', concentracion: '3 g por sobre' },
    { nombre: 'Mesalazina', presentacion: 'Tabletas de liberación prolongada', concentracion: '1200 mg' },
    { nombre: 'Sulfasalazina', presentacion: 'Tabletas de liberación prolongada', concentracion: '500 mg' },
    { nombre: 'Macrogol 3350', presentacion: 'Polvo oral', concentracion: '17 g por sobre' },
    { nombre: 'Bromuro de otilonio', presentacion: 'Tabletas', concentracion: '40 mg' },
    { nombre: 'Aluminio / magnesio / dimeticona / metoclopramida', presentacion: 'Tabletas', concentracion: 'Combinación' },
    { nombre: 'Itoprida', presentacion: 'Tabletas', concentracion: '50 mg' },
    { nombre: 'Norfene frina', presentacion: 'Solución oral', concentracion: '10 mg/ml' }
  ];

  const meds = await getAll(STORES.medicamentos);
  const normalizar = value => String(value || '').trim().toLocaleLowerCase('es-MX');
  const existentes = new Set(meds.map(m =>
    [m.nombre, m.presentacion, m.concentracion].map(normalizar).join('|')
  ));

  for (const medicine of catalogoMedicamentos) {
    const key = [medicine.nombre, medicine.presentacion, medicine.concentracion]
      .map(normalizar).join('|');
    if (existentes.has(key)) continue;
    await add(STORES.medicamentos, medicine);
    existentes.add(key);
  }

  const studies = await getAll(STORES.estudios);

  if (!studies.length) {
    for (const study of [
      { nombre: 'Biometría hemática completa', precio: 250 },
      { nombre: 'Química sanguínea de 6 elementos', precio: 320 },
      { nombre: 'Examen general de orina', precio: 120 },
      { nombre: 'Perfil lipídico', precio: 280 },
      { nombre: 'Prueba de embarazo (sangre)', precio: 180 },
      { nombre: 'TSH', precio: 350 },
      { nombre: 'Glucosa en ayunas', precio: 90 },
      { nombre: 'Hemoglobina glucosilada (HbA1c)', precio: 380 }
    ]) {
      await add(STORES.estudios, study);
    }
  }
}

async function exportBackup() {
  const data = {
    version: 3,
    fecha: new Date().toISOString(),
    origen: 'Consultorio Médico CC web'
  };

  for (const store of Object.values(STORES)) {
    data[store] = await getAll(store);
  }

  return data;
}

async function importBackup(data) {
  if (!data || !data.version) {
    throw new Error('Archivo de respaldo inválido');
  }

  /*
   * Importar un respaldo reemplaza los registros de cada módulo
   * que esté incluido en el archivo. Conserva los módulos omitidos.
   */
  for (const store of Object.values(STORES)) {
    if (!Array.isArray(data[store])) continue;

    await clearStore(store);

    for (const item of data[store]) {
      await put(store, item);
    }
  }

  await seedIfEmpty();
}

window.DB = {
  openDB,
  login,
  getSession,
  logout,
  verifyNip,
  getCobrosHoy,
  registrarCobroConsulta,
  confirmarCobro,
  add,
  put,
  get,
  getAll,
  sendChat,
  addStaffUser,
  setStaffActive,
  updateStaffUser,
  remove,
  clearStore,
  getConfig,
  setConfig,
  seedIfEmpty,
  exportBackup,
  importBackup,
  STORES
};
