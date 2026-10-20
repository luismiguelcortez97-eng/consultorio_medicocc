# Consultorio Médico CC — versión web

Aplicación web adaptada para ejecutarse en Render con PostgreSQL. Conserva los módulos y la interfaz del proyecto original, pero reemplaza IndexedDB por una API centralizada.

## Importante antes de publicar

- Esta versión es una adaptación inicial; debe probarse exhaustivamente antes de utilizarla con datos reales de pacientes o cobros.
- El inicio de sesión es de administrador único. No hay aún cuentas separadas por médico/empleado ni permisos granulares por persona.
- Los cambios de cobros existentes conservan la auditoría que ya generaba el frontend, pero para una auditoría financiera fuerte debe añadirse un registro inmutable en servidor con usuario, fecha, valor anterior/nuevo y motivo.
- La restauración de respaldos reemplaza los datos de la base central. Descargue primero un respaldo y no restaure sin verificar el archivo.
- Use contraseñas/NIP nuevos y únicos. Nunca suba `.env` ni secretos a GitHub.
- No cargue datos reales hasta probar login, CRUD, reportes, importación/exportación, reinicios y permisos. Cumpla los requisitos aplicables a datos personales y datos de salud.

## Publicar en GitHub y Render

1. Descomprima el ZIP y cree un repositorio **privado** en GitHub. Suba el contenido de esta carpeta, excepto `.env` (no se incluye ningún `.env` real).
2. En Render, elija **New + → Blueprint** y conecte el repositorio que contiene `render.yaml`.
3. Render pedirá completar `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `COBROS_NIP` y `BALANCE_NIP`. Configure valores nuevos y únicos; contraseña recomendada de 16 caracteres o más. `SESSION_SECRET` se genera automáticamente y `DATABASE_URL` se vincula a PostgreSQL.
4. Revise el plan y costo que Render muestre antes de confirmar. La base de datos y el servicio web pueden tener costo.
5. Espere a que termine el despliegue. Compruebe `https://TU-SERVICIO.onrender.com/api/health`; debe devolver `ok: true` y `database: connected`. Después abra la URL principal e inicie sesión con los secretos configurados.
6. Antes de usarlo en operación, pruebe cada módulo con datos ficticios y verifique que los datos persistan tras cerrar sesión y reiniciar el servicio.

## Desarrollo local

Requiere Node.js 20+ y PostgreSQL. Copie `.env.example` a `.env`, cambie todos los valores y ajuste `DATABASE_URL`. No use secretos de producción en desarrollo.

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

## Estructura

- `server.js`: servidor Express, autenticación, NIP del lado servidor y API de datos.
- `js/db.js`: adaptador API que conserva la interfaz de datos que consume la aplicación.
- `js/app.js`, `css/styles.css`, `index.html`: interfaz y módulos existentes.
- `render.yaml`: configuración de Render y PostgreSQL.

## Datos y respaldos

Los datos se guardan en PostgreSQL. El respaldo JSON se descarga desde el módulo Respaldos. Guarde copias en una ubicación segura y limite su acceso: pueden contener datos de salud y financieros.


## Nuevos módulos propuestos en la rama de funciones

- **Chat del personal:** mensajes persistentes con nombre y rol tomados de la sesión autenticada.
- **Agenda mensual:** calendario, citas por paciente/médico, prevención de doble cita para un mismo médico y cancelación con historial.
- **Receta independiente:** plantillas configurables por médico, receta guardada y vista previa de impresión.
- **Cuentas del personal:** el administrador puede crear y desactivar usuarios con contraseñas almacenadas mediante scrypt. Los datos financieros quedan restringidos al administrador.

Antes de utilizar estos módulos con datos reales, valida el flujo completo en el entorno de despliegue. Las cuentas de personal comparten todavía la mayor parte de los módulos clínicos; esto no equivale a permisos granulares por paciente o por expediente. No utilices el sistema como único canal para urgencias clínicas y evita enviar datos identificables de salud por el chat si no son necesarios.
