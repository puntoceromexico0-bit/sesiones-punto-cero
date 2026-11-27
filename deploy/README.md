# Tablero Sesiones Punto Cero — versión para Render + Neon

Esta carpeta (`deploy/`) es el paquete para publicar el tablero en
Render y que Daniela y Leslye lo vean y lo editen desde cualquier
navegador, con los mismos datos. El tablero dentro de Muse no cambia:
esta es una copia independiente que vive en Render.

Todo es gratis y permanente ($0): el servicio web corre en el plan
gratuito de Render y la base de datos vive en **Neon** (Postgres con
plan gratuito que **no caduca**). No se usa la base de datos de
Render, porque su plan gratuito caduca a los 30 días.

## Qué trae el paquete

| Pieza | Archivo |
| --- | --- |
| Definición del despliegue (solo el servicio web; sin base de Render) | `render.yaml` en la raíz del repo |
| Servidor (Node, sirve la página y guarda en Postgres) | `deploy/server/server.mjs` |
| Página ya compilada y lista para servirse | `deploy/server/public/` |
| Esquema de la base en Postgres | `deploy/migrations/0001_schema_postgres.sql` |
| Datos actuales exportados (38 sesiones, 16 gastos, 2 cierres) | `deploy/migrations/0002_seed.sql` y `deploy/data/*.json` |
| Código fuente de la página (por si se recompila) | `deploy/client/` + `client/src/` |

Al primer arranque, si la base de Neon está vacía, el servidor crea
las tablas y carga los datos exportados automáticamente. No hay que
correr SQL a mano.

## Pasos para publicarlo

1. **Crea la base en Neon.** Entra a [neon.tech](https://neon.tech)
   con Google usando el correo de Punto Cero
   (puntoceromexico0@gmail.com) y crea un proyecto (nombre sugerido:
   `sesiones-punto-cero`). Neon crea la base sola; no hay que crear
   tablas.
2. **Copia la cadena de conexión de Neon.** En el panel del proyecto,
   *Connect* (o *Connection string*) muestra una cadena como
   `postgresql://usuario:contraseña@ep-....aws.neon.tech/neondb?sslmode=require`.
   Déjala a la mano: es el `DATABASE_URL` del paso 4. (Si ofrece
   elegir, la cadena «pooled» también sirve.)
3. **Sube este código a un repositorio.** Crea un repositorio (GitHub,
   GitLab o Bitbucket) con la cuenta que prefieras y sube TODO el
   contenido de esta carpeta del proyecto (incluidos `render.yaml`,
   `client/`, `server/` y `deploy/`). No subas `app.db` ni
   `node_modules` (ya están en `.gitignore`).
4. **En Render** (sesión iniciada con el correo de Punto Cero):
   *New → Blueprint*, elige el repositorio. Render lee `render.yaml`
   y propone crear solo el servicio web `sesiones-punto-cero` (no
   crea ninguna base). Al confirmar, Render pide el valor de
   **DATABASE_URL**: pega ahí la cadena de conexión de Neon del
   paso 2 y luego *Apply*.
   - Si ya creaste el servicio sin llenarla: en el panel del
     servicio, *Environment → Add Environment Variable*, clave
     `DATABASE_URL`, valor = la cadena de Neon, y guarda (el servicio
     se redespliega solo).
5. **Espera el primer despliegue** (unos minutos). El servidor se
   conecta a Neon, crea las tablas y carga las sesiones, los gastos
   y los cierres solos.
6. **Contraseña del tablero.** El sitio pide usuario y contraseña:
   usuario `puntocero`; la contraseña la generó Render y está en el
   panel del servicio, *Environment → BASIC_AUTH_PASSWORD* (ahí mismo
   se puede cambiar por una propia). Esa contraseña se le pasa a
   Daniela; sin ella no se puede ver ni editar el tablero.
7. **Abre la URL** que Render asigna al servicio
   (`https://sesiones-punto-cero.onrender.com` o parecida) y verifica
   que se vean las sesiones y Finanzas.

## Cosas a saber

- **Costo $0 permanente:** la base de Neon en plan gratuito no
  caduca (se “duerme” tras unos días sin uso y despierta sola en
  segundos al conectar; el tablero es chico y cabe de sobra en el
  plan gratuito). El servicio web gratuito de Render se “duerme”
  tras ~15 min sin uso y tarda hasta 1 min en despertar en la
  primera visita.
- **Son dos tableros independientes.** Lo que se edite en Render no se
  refleja en el tablero de Muse, ni al revés. Si Render queda como el
  tablero bueno, hay que trabajar solo ahí (o pedir que se vuelvan a
  exportar los datos).
- **La sincronización de encuestas no corre en Render.** El botón
  «Actualizar encuestas» depende del agente de Muse (lee la hoja de
  Google Sheets); en Render no actualiza nada y las respuestas se
  capturan a mano en cada tarjeta.
- **Respaldos:** `deploy/data/*.json` es la exportación de los datos
  al 26 nov 2026. Para regenerar la semilla SQL desde esos JSON:
  `node deploy/scripts/generate-seed.mjs`.
- **Recompilar la página** (solo si cambia el diseño): con Bun
  instalado, `bun run deploy/client/build.mjs` deja la página nueva en
  `deploy/server/public/`; después hay que subir el cambio al repo y
  Render redespliega solo.
- **Migraciones a mano (opcional):** si algún día la base se crea por
  fuera del servidor, corre en orden
  `deploy/migrations/0001_schema_postgres.sql` y luego
  `deploy/migrations/0002_seed.sql` en el editor SQL de Neon (la
  semilla es idempotente: borra y vuelve a cargar las tres tablas).
