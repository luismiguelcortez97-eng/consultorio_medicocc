/* Consultorio Médico CC - adaptador de datos API centralizada */
const STORES = { medicos:'medicos', pacientes:'pacientes', consultas:'consultas', medicamentos:'medicamentos', estudios:'estudios', cobros:'cobros', config:'config' };
async function api(path, options={}) {
  const response = await fetch(path, { credentials:'same-origin', ...options, headers:{ 'Content-Type':'application/json', ...(options.headers||{}) } });
  const data = response.status === 204 ? null : await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);
  return data;
}
async function openDB() { await api('/api/health'); return true; }
async function login(username,password) { return api('/api/auth/login',{method:'POST',body:JSON.stringify({username,password})}); }
async function getSession() { try { return await api('/api/auth/me'); } catch { return null; } }
async function logout() { try { await api('/api/auth/logout',{method:'POST',body:'{}'}); } catch {} }
async function verifyNip(tipo,nip) { return api('/api/auth/verify-nip',{method:'POST',body:JSON.stringify({tipo,nip})}); }
async function getCobrosHoy(fecha) { return api(`/api/dashboard/cobros-hoy?fecha=${encodeURIComponent(fecha)}`); }
async function add(storeName,data) { return api(`/api/data/${encodeURIComponent(storeName)}`,{method:'POST',body:JSON.stringify(data)}); }
async function put(storeName,data) {
  if (storeName === STORES.config) return api(`/api/data/${storeName}/${encodeURIComponent(data.key)}`,{method:'PUT',body:JSON.stringify(data)});
  if (data.id == null) return add(storeName,data);
  return api(`/api/data/${storeName}/${encodeURIComponent(data.id)}`,{method:'PUT',body:JSON.stringify(data)});
}
async function get(storeName,id) { try { return await api(`/api/data/${storeName}/${encodeURIComponent(id)}`); } catch(e) { if (e.message.includes('no encontrado')) return undefined; throw e; } }
async function getAll(storeName) { return api(`/api/data/${storeName}`); }
async function remove(storeName,id) { return api(`/api/data/${storeName}/${encodeURIComponent(id)}`,{method:'DELETE'}); }
async function clearStore(storeName) { return api(`/api/data/${storeName}`,{method:'DELETE'}); }
async function getConfig(key) { const item=await get(STORES.config,key); return item ? item.value : null; }
async function setConfig(key,value) { return put(STORES.config,{key,value}); }
async function seedIfEmpty() {
  const meds=await getAll(STORES.medicamentos);
  if (!meds.length) for (const m of [
    {nombre:'Paracetamol',presentacion:'Tabletas',concentracion:'500 mg'}, {nombre:'Ibuprofeno',presentacion:'Tabletas',concentracion:'400 mg'},
    {nombre:'Amoxicilina',presentacion:'Cápsulas',concentracion:'500 mg'}, {nombre:'Omeprazol',presentacion:'Cápsulas',concentracion:'20 mg'},
    {nombre:'Loratadina',presentacion:'Tabletas',concentracion:'10 mg'}, {nombre:'Metformina',presentacion:'Tabletas',concentracion:'850 mg'},
    {nombre:'Losartán',presentacion:'Tabletas',concentracion:'50 mg'}, {nombre:'Salbutamol',presentacion:'Inhalador',concentracion:'100 mcg'}]) await add(STORES.medicamentos,m);
  const ests=await getAll(STORES.estudios);
  if (!ests.length) for (const e of [
    {nombre:'Biometría hemática completa',precio:250},{nombre:'Química sanguínea de 6 elementos',precio:320},{nombre:'Examen general de orina',precio:120},
    {nombre:'Perfil lipídico',precio:280},{nombre:'Prueba de embarazo (sangre)',precio:180},{nombre:'TSH',precio:350},{nombre:'Glucosa en ayunas',precio:90},{nombre:'Hemoglobina glucosilada (HbA1c)',precio:380}]) await add(STORES.estudios,e);
}
async function exportBackup() {
  const data={version:2,fecha:new Date().toISOString(),origen:'Consultorio Médico CC web'};
  for (const store of Object.values(STORES)) data[store]=await getAll(store);
  return data;
}
async function importBackup(data) {
  if (!data || !data.version) throw new Error('Archivo de respaldo inválido');
  for (const store of Object.values(STORES)) await clearStore(store);
  for (const store of Object.values(STORES)) {
    if (!Array.isArray(data[store])) continue;
    for (const item of data[store]) await put(store,item);
  }
  await seedIfEmpty();
}
window.DB={openDB,login,getSession,logout,verifyNip,getCobrosHoy,add,put,get,getAll,remove,clearStore,getConfig,setConfig,seedIfEmpty,exportBackup,importBackup,STORES};
