// Sesiones Punto Cero — servidor independiente para Render.
//
// Sirve el tablero (archivos estáticos de ../public) y responde las
// acciones en POST /actions con el mismo protocolo que usa el cliente
// dentro de Muse: petición { action, args } → respuesta { data } o
// { error }. Los datos viven en la Postgres de Neon (DATABASE_URL la
// trae la cadena de conexión de Neon, puesta a mano en Render); al
// arrancar con la base vacía aplica db/0001_schema_postgres.sql y
// db/0002_seed.sql automáticamente.
//
// La única acción que NO existe aquí es refreshSurveyAnswers: la
// sincronización de la encuesta la hace el agente de Muse (necesita
// acceso a Google Sheets), así que en Render responde started:false y
// las respuestas se capturan a mano en cada tarjeta.
//
// Protección opcional: si BASIC_AUTH_USER y BASIC_AUTH_PASSWORD están
// definidas, todo el sitio pide usuario y contraseña (HTTP Basic).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Las columnas DATE se devuelven como texto 'YYYY-MM-DD', igual que en
// el tablero de Muse (SQLite guardaba texto).
pg.types.setTypeParser(1082, (v) => v);

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const port = Number(process.env.PORT ?? 10000);

// SSL: Neon exige conexión cifrada y su cadena ya trae
// ?sslmode=require. Ojo: en las versiones recientes de pg, el sslmode
// de la cadena MANDA sobre la opción ssl del Pool y "require" pasa a
// verificar el certificado, lo que puede tumbar la conexión. Por eso
// el sslmode se lee de la cadena (o de PGSSLMODE), se quita de la
// cadena que recibe pg y el SSL se fija aquí: "disable" lo apaga
// (p. ej. una Postgres local de pruebas), verify-ca/verify-full
// verifican el certificado y cualquier otro caso cifra sin verificar
// el emisor, que es lo que la cadena de Neon necesita para conectar.
function connectionConfig() {
  const raw = process.env.DATABASE_URL ?? "";
  let sslmode = process.env.PGSSLMODE ?? null;
  let connectionString = raw;
  try {
    const u = new URL(raw);
    if (sslmode == null) sslmode = u.searchParams.get("sslmode");
    u.searchParams.delete("sslmode");
    connectionString = u.toString();
  } catch {
    // Cadena no parseable como URL: se deja como viene y pg
    // reportará el error al conectar.
  }
  const mode = (sslmode ?? "require").toLowerCase();
  const ssl =
    mode === "disable"
      ? false
      : mode === "verify-ca" || mode === "verify-full"
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false };
  return { connectionString, ssl };
}

const pool = new pg.Pool(connectionConfig());

async function migrateIfEmpty() {
  const { rows } = await pool.query(
    "SELECT to_regclass('public.sessions') AS t",
  );
  if (rows[0]?.t) return;
  console.log("Base vacía: aplicando esquema y datos iniciales…");
  const schema = await readFile(
    path.join(here, "db", "0001_schema_postgres.sql"),
    "utf8",
  );
  const seed = await readFile(
    path.join(here, "db", "0002_seed.sql"),
    "utf8",
  );
  await pool.query(schema);
  await pool.query(seed);
  console.log("Esquema y datos iniciales aplicados.");
}

// --- Validación (mismos límites que las acciones del tablero) --------------

function fail(msg) {
  throw new Error(msg);
}
function optDate(v) {
  if (v == null) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    fail("La fecha debe ser AAAA-MM-DD");
  return v;
}
function cleanText(v, max) {
  if (v == null) return null;
  if (typeof v !== "string") fail("Texto inválido");
  const t = v.trim();
  if (t.length > max) fail(`Texto demasiado largo (máx. ${max})`);
  return t === "" ? null : t;
}
function reqText(v, max) {
  const t = cleanText(v, max);
  if (t == null) fail("Falta un texto requerido");
  return t;
}
function optInt(v, min, max) {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < min || v > max) fail("Número inválido");
  return v;
}
function reqBool(v) {
  if (typeof v !== "boolean") fail("Se esperaba verdadero/falso");
  return v;
}
function optBool(v) {
  if (v == null) return null;
  return reqBool(v);
}
function optEnum(v, values) {
  if (v == null) return null;
  if (!values.includes(v)) fail("Valor no permitido");
  return v;
}
function reqId(v) {
  if (!Number.isInteger(v) || v <= 0) fail("Id inválido");
  return v;
}

const STATUSES = ["pendiente", "en_edicion", "entregada", "no_show"];
const DELIVERY_TYPES = ["ESTANDAR", "EXPRESS"];
const PUBLISH = ["SI", "NO"];

// Columnas editables de sessions (nombre en la acción = nombre de columna).
function editableFrom(args) {
  return {
    status: optEnum(args.status, STATUSES) ?? "pendiente",
    session_date: optDate(args.session_date),
    delivery_date: optDate(args.delivery_date),
    delivery_date_estimated: reqBool(args.delivery_date_estimated),
    delivery_type: optEnum(args.delivery_type, DELIVERY_TYPES),
    package_label: cleanText(args.package_label, 40),
    photo_count: optInt(args.photo_count, 0, 10000),
    favorites_chosen: reqBool(args.favorites_chosen),
    favorites_count: optInt(args.favorites_count, 0, 10000),
    drive_url: cleanText(args.drive_url, 500),
    uploaded_at: optDate(args.uploaded_at),
    sent: reqBool(args.sent),
    charges_settled: reqBool(args.charges_settled),
    unpaid: reqBool(args.unpaid),
    face_level: cleanText(args.face_level, 120),
    body_adjustments: cleanText(args.body_adjustments, 300),
    publish_permission: optEnum(args.publish_permission, PUBLISH),
    motive: cleanText(args.motive, 200),
    do_not_touch: cleanText(args.do_not_touch, 300),
    background_color: cleanText(args.background_color, 60),
    first_session: optBool(args.first_session),
    discovery_source: cleanText(args.discovery_source, 80),
    notes: cleanText(args.notes, 1000),
    delivered_at: optDate(args.delivered_at),
  };
}

const SESSION_FIELDS = [
  "id", "client_name", "status", "session_date", "delivery_date",
  "delivery_date_estimated", "delivery_type", "package_label", "photo_count",
  "favorites_chosen", "favorites_count", "drive_url", "uploaded_at", "sent",
  "charges_settled", "unpaid", "face_level", "body_adjustments",
  "publish_permission", "motive", "do_not_touch", "background_color",
  "first_session", "discovery_source", "notes", "delivered_at",
];

function toSession(row) {
  const s = {};
  for (const f of SESSION_FIELDS) s[f] = row[f] ?? null;
  s.id = row.id;
  s.delivery_date_estimated = !!row.delivery_date_estimated;
  s.favorites_chosen = !!row.favorites_chosen;
  s.sent = !!row.sent;
  s.charges_settled = !!row.charges_settled;
  s.unpaid = !!row.unpaid;
  return s;
}

async function allSessions() {
  const { rows } = await pool.query("SELECT * FROM sessions ORDER BY id ASC");
  return rows;
}

// --- Finanzas (misma lógica que el tablero) --------------------------------

const PACKAGE_INFO = {
  p1: { price: 870, included: 5 },
  p2: { price: 1100, included: 8 },
  p3: { price: 1335, included: 10 },
  p4: { price: 1560, included: 12 },
  p5: { price: 1910, included: 15 },
};
const EXTRA_PHOTO_PRICE = 150;
const EXPRESS_FEE = 399;
const NO_SHOW_DEPOSIT = 200;
const FIXED_COSTS_REFERENCE = [
  { label: "Renta del estudio", amount: 3500, match: "renta" },
  { label: "Adobe", amount: 681, match: "adobe" },
  { label: "Pixieset", amount: 183, match: "pixieset" },
];

function packageKey(label) {
  if (!label) return null;
  const m = label.toLowerCase().match(/p(?:aquete\s*)?([1-5])/);
  return m ? `p${m[1]}` : null;
}

function sessionCharges(row) {
  const pkg = packageKey(row.package_label);
  const info = pkg ? PACKAGE_INFO[pkg] : undefined;
  const base = info ? info.price : 0;
  const chosen = row.favorites_chosen
    ? (row.favorites_count ?? row.photo_count)
    : row.photo_count;
  const extrasCount =
    info && chosen != null ? Math.max(0, chosen - info.included) : 0;
  return {
    pkg,
    base,
    extrasCount,
    extrasCharge: extrasCount * EXTRA_PHOTO_PRICE,
    expressFee: row.delivery_type === "EXPRESS" ? EXPRESS_FEE : 0,
  };
}

// --- Calculadora de cierre (misma tabla de tarifas del estudio) ------------
// La calculadora arma las ventas reales del mes por partidas (paquetes a
// precio con IVA + cada extra), así nadie tiene que rehacer las cuentas
// en Excel. Las partidas se guardan como JSON en monthly_closes.sales_items.
const SALE_CATALOG = {
  p1: { label: "Paquete 1", price: 870 },
  p2: { label: "Paquete 2", price: 1100 },
  p3: { label: "Paquete 3", price: 1335 },
  p4: { label: "Paquete 4", price: 1560 },
  p5: { label: "Paquete 5", price: 1910 },
  foto_extra: { label: "Foto extra", price: EXTRA_PHOTO_PRICE },
  sesion_completa: { label: "Sesión completa", price: 350 },
  video: { label: "Video de sesión", price: 199 },
  express: { label: "Express", price: EXPRESS_FEE },
  persona_extra: { label: "Persona extra", price: 200 },
  fondo_extra: { label: "Fondo extra", price: 150 },
  outfit_extra: { label: "Outfit extra", price: 105 },
  apartado: { label: "Apartado", price: NO_SHOW_DEPOSIT },
};
const SALE_KEYS = Object.keys(SALE_CATALOG);

function saleCounts(v) {
  if (v == null || typeof v !== "object" || Array.isArray(v))
    fail("Faltan las partidas");
  const counts = {};
  for (const key of SALE_KEYS) {
    const n = v[key];
    if (n == null) counts[key] = 0;
    else {
      if (!Number.isInteger(n) || n < 0 || n > 10000)
        fail("Cantidad inválida en las partidas");
      counts[key] = n;
    }
  }
  return counts;
}

function saleItemsTotal(counts) {
  return SALE_KEYS.reduce(
    (sum, key) => sum + counts[key] * SALE_CATALOG[key].price,
    0,
  );
}

function saleItemsList(counts) {
  return SALE_KEYS.filter((key) => counts[key] > 0).map((key) => ({
    key,
    label: SALE_CATALOG[key].label,
    price: SALE_CATALOG[key].price,
    count: counts[key],
    amount: counts[key] * SALE_CATALOG[key].price,
  }));
}

// Lee las partidas guardadas por la calculadora; si el JSON está mal o
// incompleto se lee como "sin partidas" en vez de romper la vista.
function parseSaleCounts(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const counts = {};
    for (const key of SALE_KEYS) {
      const n = parsed[key];
      if (!Number.isInteger(n) || n < 0 || n > 10000) return null;
      counts[key] = n;
    }
    return counts;
  } catch {
    return null;
  }
}

async function getMonthFinance(args) {
  const month = args.month;
  if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month))
    fail("El mes debe ser AAAA-MM");
  const sessions = await allSessions();
  const { rows: monthExpenses } = await pool.query(
    "SELECT * FROM expenses WHERE month = $1 ORDER BY id ASC",
    [month],
  );
  const { rows: closeRows } = await pool.query(
    "SELECT * FROM monthly_closes WHERE month = $1",
    [month],
  );
  const close = closeRows[0] ?? null;

  const inMonth = (row) => {
    const ref = row.session_date ?? row.delivered_at;
    return ref != null && ref.startsWith(month);
  };
  const currentMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chihuahua",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
  const noShowInMonth = (row) => {
    const ref = row.session_date ?? row.delivered_at;
    return ref != null ? ref.startsWith(month) : month === currentMonth;
  };

  const byPackageMap = new Map();
  let baseTotal = 0;
  let extrasTotal = 0;
  let expressTotal = 0;
  let sessionsCount = 0;
  let noShowCount = 0;
  for (const row of sessions) {
    if (row.status === "no_show") {
      if (noShowInMonth(row)) noShowCount++;
      continue;
    }
    if (!inMonth(row)) continue;
    if (row.unpaid) continue;
    sessionsCount++;
    const charges = sessionCharges(row);
    if (charges.pkg) {
      const entry = byPackageMap.get(charges.pkg) ?? { count: 0, amount: 0 };
      entry.count++;
      entry.amount += charges.base;
      byPackageMap.set(charges.pkg, entry);
      baseTotal += charges.base;
    }
    extrasTotal += charges.extrasCharge;
    expressTotal += charges.expressFee;
  }
  const noShowTotal = noShowCount * NO_SHOW_DEPOSIT;
  const computedTotal = baseTotal + extrasTotal + expressTotal + noShowTotal;

  const estimateHeadline = close?.estimate_sales ?? computedTotal;
  const projected = close?.projected_sales ?? 0;
  const estimateWithProjection = estimateHeadline + projected;
  const actualSales = close?.actual_sales ?? null;
  const hasEstimate = close?.estimate_sales != null || computedTotal > 0;
  const difference =
    actualSales != null && hasEstimate
      ? actualSales - estimateWithProjection
      : null;

  const fixedRows = monthExpenses.filter((e) => e.kind === "fijo");
  const fixedFromExpenses = fixedRows.reduce((sum, e) => sum + e.amount, 0);
  const variableFromExpenses = monthExpenses
    .filter((e) => e.kind === "variable")
    .reduce((sum, e) => sum + e.amount, 0);
  const fixedCostsFromReference = fixedRows.length === 0;
  const fixedCosts = fixedCostsFromReference
    ? FIXED_COSTS_REFERENCE.map((ref) => ({
        label: ref.label,
        amount: ref.amount,
        from_reference: true,
      }))
    : fixedRows.map((e) => ({
        label: e.description,
        amount: e.amount,
        from_reference: false,
      }));
  const effectiveFixed = fixedCosts.reduce((sum, c) => sum + c.amount, 0);
  const tableSales = actualSales ?? estimateWithProjection;
  const tableFixed = close?.actual_fixed_costs ?? effectiveFixed;
  const tableVariable = close?.actual_variable_costs ?? variableFromExpenses;
  const tableDeductions = close?.deductions ?? 0;
  const net = tableSales - tableFixed - tableVariable - tableDeductions;
  const savings = Math.round(net * 0.05 * 100) / 100;
  const each = Math.round((net - savings) * 0.5 * 100) / 100;

  const fixedAlerts = FIXED_COSTS_REFERENCE.map((ref) => {
    const registered = monthExpenses
      .filter(
        (e) =>
          e.kind === "fijo" &&
          e.description.toLowerCase().includes(ref.match),
      )
      .reduce((sum, e) => sum + e.amount, 0);
    return {
      label: ref.label,
      reference_amount: ref.amount,
      registered_amount: registered > 0 ? registered : null,
    };
  });

  const receivables = sessions
    .filter((row) => row.status !== "no_show")
    .map((row) => ({ row, charges: sessionCharges(row) }))
    .filter(({ row, charges }) =>
      row.unpaid
        ? charges.base + charges.extrasCharge + charges.expressFee > 0
        : !row.charges_settled &&
          (charges.extrasCharge > 0 || charges.expressFee > 0),
    )
    .map(({ row, charges }) => {
      const baseCharge = row.unpaid ? charges.base : 0;
      return {
        id: row.id,
        client_name: row.client_name,
        base_charge: baseCharge,
        extras_count: charges.extrasCount,
        extras_charge: charges.extrasCharge,
        express_fee: charges.expressFee,
        total: baseCharge + charges.extrasCharge + charges.expressFee,
      };
    })
    .sort((a, b) => b.total - a.total);

  return {
    month,
    computed: {
      sessions_count: sessionsCount,
      by_package: [...byPackageMap.entries()].map(([pkg, v]) => ({
        package: pkg,
        count: v.count,
        amount: v.amount,
      })),
      base_total: baseTotal,
      extras_total: extrasTotal,
      express_total: expressTotal,
      no_show_count: noShowCount,
      no_show_total: noShowTotal,
      total: computedTotal,
    },
    close: {
      estimate_sales: close?.estimate_sales ?? null,
      projected_sales: close?.projected_sales ?? null,
      actual_sales: close?.actual_sales ?? null,
      actual_fixed_costs: close?.actual_fixed_costs ?? null,
      actual_variable_costs: close?.actual_variable_costs ?? null,
      cash_sales: close?.cash_sales ?? null,
      transfer_sales: close?.transfer_sales ?? null,
      deductions: close?.deductions ?? null,
      sales_items: (() => {
        const counts = parseSaleCounts(close?.sales_items ?? null);
        return counts ? saleItemsList(counts) : [];
      })(),
      notes: close?.notes ?? null,
    },
    estimate_headline: estimateHeadline,
    estimate_with_projection: estimateWithProjection,
    difference,
    matches: difference != null ? difference === 0 : null,
    expenses: monthExpenses.map((e) => ({
      id: e.id,
      expense_date: e.expense_date,
      kind: e.kind,
      description: e.description,
      amount: e.amount,
    })),
    fixed_total: fixedFromExpenses,
    variable_total: variableFromExpenses,
    table: {
      sales: tableSales,
      sales_is_actual: actualSales != null,
      fixed: tableFixed,
      variable: tableVariable,
      deductions: tableDeductions,
      net,
      savings,
      each,
    },
    fixed_alerts: fixedAlerts,
    fixed_costs: fixedCosts,
    fixed_costs_from_reference: fixedCostsFromReference,
    receivables,
    receivables_total: receivables.reduce((sum, r) => sum + r.total, 0),
  };
}

// --- Estadísticas (mismos agregados que el tablero) ------------------------
// Días hábiles lun–sáb menos festivos mexicanos: la misma regla que usa
// la calculadora de entregas, para estimar la fecha de entrega de las
// sesiones pendientes que no tienen fecha del tablero.
function statsFmtDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function statsParseDate(value) {
  const [y = 1970, m = 1, d = 1] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const statsHolidayCache = new Map();

function statsMexicanHolidays(year) {
  const cached = statsHolidayCache.get(year);
  if (cached) return cached;
  const set = new Set();
  const nthMonday = (month, n) => {
    const d = new Date(year, month, 1);
    let seen = 0;
    while (true) {
      if (d.getDay() === 1) {
        seen++;
        if (seen === n) return statsFmtDate(d);
      }
      d.setDate(d.getDate() + 1);
    }
  };
  set.add(`${year}-01-01`);
  set.add(nthMonday(1, 1));
  set.add(nthMonday(2, 3));
  set.add(`${year}-05-01`);
  set.add(`${year}-09-16`);
  set.add(nthMonday(10, 3));
  set.add(`${year}-12-25`);
  if ((year - 2018) % 6 === 0) set.add(`${year}-12-01`);
  statsHolidayCache.set(year, set);
  return set;
}

function statsIsBusinessDay(value) {
  const d = statsParseDate(value);
  if (d.getDay() === 0) return false;
  return !statsMexicanHolidays(d.getFullYear()).has(value);
}

function statsAddBusinessDays(start, count) {
  const d = statsParseDate(start);
  let added = 0;
  while (added < count) {
    d.setDate(d.getDate() + 1);
    if (statsIsBusinessDay(statsFmtDate(d))) added++;
  }
  return statsFmtDate(d);
}

// La fecha contra la que se mide una sesión pendiente: la fecha del
// tablero cuando existe, si no el estimado de la calculadora (15 días
// hábiles desde la subida a Drive, 3 para Express).
function statsEffectiveDelivery(row) {
  if (row.delivery_date) return row.delivery_date;
  if (!row.uploaded_at) return null;
  return statsAddBusinessDays(
    row.uploaded_at,
    row.delivery_type === "EXPRESS" ? 3 : 15,
  );
}

function statsNormalizeName(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getStudioStats() {
  const sessions = await allSessions();
  const { rows: allCloses } = await pool.query(
    "SELECT * FROM monthly_closes",
  );
  const closeByMonth = new Map(allCloses.map((c) => [c.month, c]));

  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chihuahua",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const today = nowParts.slice(0, 10);
  const currentMonth = today.slice(0, 7);

  const monthOf = (row) =>
    (row.session_date ?? row.delivered_at)?.slice(0, 7) ?? null;
  // Misma regla que Finanzas: el apartado de un no-show sin fecha
  // cuenta en el mes actual.
  const noShowMonth = (row) => monthOf(row) ?? currentMonth;

  // --- serie por mes --------------------------------------------------------
  const monthKeys = new Set();
  for (const c of allCloses) monthKeys.add(c.month);
  for (const row of sessions) {
    const m = row.status === "no_show" ? noShowMonth(row) : monthOf(row);
    if (m) monthKeys.add(m);
  }
  const monthly = [];
  let revenueTotal = 0;
  let revenueActual = 0;
  let revenueEstimated = 0;
  for (const month of [...monthKeys].sort()) {
    let sessionsCount = 0;
    let computed = 0;
    for (const row of sessions) {
      if (row.status === "no_show") {
        if (noShowMonth(row) === month) computed += NO_SHOW_DEPOSIT;
        continue;
      }
      if (monthOf(row) !== month) continue;
      sessionsCount++;
      if (row.unpaid) continue;
      const charges = sessionCharges(row);
      computed += charges.base + charges.extrasCharge + charges.expressFee;
    }
    const close = closeByMonth.get(month) ?? null;
    const isActual = close?.actual_sales != null;
    const revenue = isActual
      ? (close?.actual_sales ?? 0)
      : (close?.estimate_sales ?? computed) + (close?.projected_sales ?? 0);
    revenueTotal += revenue;
    if (isActual) revenueActual += revenue;
    else revenueEstimated += revenue;
    monthly.push({
      month,
      sessions: sessionsCount,
      revenue,
      is_actual: isActual,
    });
  }

  // --- paquetes, clientas, fotos, tipos de entrega --------------------------
  const packageMap = new Map();
  for (const key of Object.keys(PACKAGE_INFO)) {
    packageMap.set(key, { sessions: 0, revenue: 0 });
  }
  let packagesUnknown = 0;
  const clientMap = new Map();
  let photosTotal = 0;
  let photosSessions = 0;
  const photosRows = [];
  let express = 0;
  let standard = 0;
  let typeUnknown = 0;
  let deliveredCount = 0;
  let noShowTotalCount = 0;

  for (const row of sessions) {
    if (row.status === "no_show") {
      noShowTotalCount++;
      continue;
    }
    if (row.status === "entregada") deliveredCount++;
    const charges = sessionCharges(row);
    if (charges.pkg) {
      const entry = packageMap.get(charges.pkg);
      if (entry) {
        entry.sessions++;
        if (!row.unpaid)
          entry.revenue +=
            charges.base + charges.extrasCharge + charges.expressFee;
      }
    } else {
      packagesUnknown++;
    }
    const key = statsNormalizeName(row.client_name);
    const client = clientMap.get(key) ?? {
      name: row.client_name,
      sessions: 0,
      revenue: 0,
      last: null,
    };
    client.sessions++;
    if (!row.unpaid)
      client.revenue +=
        charges.base + charges.extrasCharge + charges.expressFee;
    const ref = row.session_date ?? row.delivered_at;
    if (ref && (client.last == null || ref > client.last)) {
      client.last = ref;
      client.name = row.client_name;
    }
    clientMap.set(key, client);
    if (row.photo_count != null) {
      photosTotal += row.photo_count;
      photosSessions++;
      photosRows.push({
        client_name: row.client_name,
        photo_count: row.photo_count,
        package_label: row.package_label,
      });
    }
    if (row.delivery_type === "EXPRESS") express++;
    else if (row.delivery_type === "ESTANDAR") standard++;
    else typeUnknown++;
  }

  const packages = [...packageMap.entries()]
    .map(([pkg, v]) => ({
      package: pkg,
      sessions: v.sessions,
      revenue: v.revenue,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.revenue - a.revenue);

  const clients = [...clientMap.values()];
  const topClients = clients
    .filter((c) => c.sessions >= 2)
    .sort((a, b) => b.sessions - a.sessions || b.revenue - a.revenue)
    .slice(0, 10)
    .map((c) => ({
      client_name: c.name,
      sessions: c.sessions,
      revenue: c.revenue,
      last_session_date: c.last,
    }));

  photosRows.sort((a, b) => b.photo_count - a.photo_count);

  // --- entregas: a tiempo vs. tarde -----------------------------------------
  let onTime = 0;
  let late = 0;
  let withoutBoardDate = 0;
  let pendingOverdue = 0;
  let pendingTotal = 0;
  for (const row of sessions) {
    if (row.status === "entregada") {
      if (!row.delivery_date || !row.delivered_at) withoutBoardDate++;
      else if (row.delivered_at <= row.delivery_date) onTime++;
      else late++;
    } else if (row.status !== "no_show") {
      pendingTotal++;
      const eff = statsEffectiveDelivery(row);
      if (eff && eff < today) pendingOverdue++;
    }
  }

  // --- respuestas de la encuesta (el formulario de edición) -----------------
  const surveyRows = sessions.filter((r) => r.status !== "no_show");
  const hasSurveyAnswer = (r) =>
    r.face_level != null ||
    r.body_adjustments != null ||
    r.publish_permission != null ||
    r.motive != null ||
    r.do_not_touch != null ||
    r.background_color != null ||
    r.first_session != null ||
    r.discovery_source != null;
  // Agrupa un campo libre de la encuesta por su valor normalizado, lo
  // más respondido primero; la etiqueta es la primera forma vista.
  const breakdown = (pick, cap = 12) => {
    const map = new Map();
    for (const r of surveyRows) {
      const raw = pick(r);
      if (raw == null || raw.trim() === "") continue;
      const key = statsNormalizeName(raw);
      const entry = map.get(key) ?? { value: raw.trim(), count: 0 };
      entry.count++;
      map.set(key, entry);
    }
    return [...map.values()]
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, cap);
  };
  const publishCounts = { si: 0, no: 0, sin_dato: 0 };
  const firstSessionCounts = { si: 0, no: 0, sin_dato: 0 };
  for (const r of surveyRows) {
    if (r.publish_permission === "SI") publishCounts.si++;
    else if (r.publish_permission === "NO") publishCounts.no++;
    else publishCounts.sin_dato++;
    if (r.first_session === true) firstSessionCounts.si++;
    else if (r.first_session === false) firstSessionCounts.no++;
    else firstSessionCounts.sin_dato++;
  }

  const totalSessions = sessions.filter((r) => r.status !== "no_show").length;

  return {
    totals: {
      sessions: totalSessions,
      delivered: deliveredCount,
      pending: pendingTotal,
      no_show: noShowTotalCount,
      clients: clients.length,
      repeat_clients: clients.filter((c) => c.sessions >= 2).length,
      photos_total: photosTotal,
      photos_sessions: photosSessions,
      photos_avg:
        photosSessions > 0
          ? Math.round((photosTotal / photosSessions) * 10) / 10
          : 0,
      revenue_total: revenueTotal,
      revenue_actual: revenueActual,
      revenue_estimated: revenueEstimated,
    },
    monthly,
    packages,
    packages_unknown: packagesUnknown,
    top_clients: topClients,
    delivery: {
      on_time: onTime,
      late,
      without_board_date: withoutBoardDate,
      pending_overdue: pendingOverdue,
      pending_total: pendingTotal,
    },
    delivery_types: {
      express,
      standard,
      unknown: typeUnknown,
    },
    photos_top: photosRows.slice(0, 5),
    survey: {
      total: surveyRows.length,
      answered: surveyRows.filter(hasSurveyAnswer).length,
      face_level: breakdown((r) => r.face_level),
      body_adjustments: breakdown((r) => r.body_adjustments),
      publish: publishCounts,
      motive: breakdown((r) => r.motive),
      do_not_touch: breakdown((r) => r.do_not_touch),
      background_color: breakdown((r) => r.background_color),
      first_session: firstSessionCounts,
      discovery_source: breakdown((r) => r.discovery_source),
    },
  };
}

// --- Acciones ----------------------------------------------------------------

const Actions = {
  async listSessions() {
    const sessions = (await allSessions()).map(toSession);
    const rank = (s) =>
      s.status === "entregada" ? 1 : s.status === "no_show" ? 2 : 0;
    sessions.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (rank(a) === 1)
        return (b.delivered_at ?? "").localeCompare(a.delivered_at ?? "");
      if (a.delivery_date && b.delivery_date)
        return a.delivery_date.localeCompare(b.delivery_date);
      if (a.delivery_date) return -1;
      if (b.delivery_date) return 1;
      return a.id - b.id;
    });
    return { sessions };
  },

  async createSession(args) {
    const v = editableFrom(args);
    const cols = ["client_name", ...Object.keys(v)];
    const vals = [reqText(args.client_name, 120), ...Object.values(v)];
    const { rows } = await pool.query(
      `INSERT INTO sessions (${cols.join(", ")}) VALUES (${cols
        .map((_, i) => `$${i + 1}`)
        .join(", ")}) RETURNING id`,
      vals,
    );
    return { id: rows[0].id };
  },

  async updateSession(args) {
    const id = reqId(args.id);
    const v = editableFrom(args);
    const cols = ["client_name", ...Object.keys(v)];
    const vals = [reqText(args.client_name, 120), ...Object.values(v)];
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
    await pool.query(
      `UPDATE sessions SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1}`,
      [...vals, id],
    );
    return { ok: true };
  },

  async setSessionStatus(args) {
    const id = reqId(args.id);
    const status = optEnum(args.status, STATUSES);
    if (status == null) fail("Falta el estatus");
    const sets = ["status = $1", "updated_at = now()"];
    const vals = [status];
    if (args.delivered_at !== undefined) {
      vals.push(optDate(args.delivered_at));
      sets.push(`delivered_at = $${vals.length}`);
    } else if (status !== "entregada") {
      sets.push("delivered_at = NULL");
    }
    vals.push(id);
    await pool.query(
      `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${vals.length}`,
      vals,
    );
    return { ok: true };
  },

  async deleteSession(args) {
    await pool.query("DELETE FROM sessions WHERE id = $1", [reqId(args.id)]);
    return { ok: true };
  },

  async setProgress(args) {
    const id = reqId(args.id);
    const sets = ["updated_at = now()"];
    const vals = [];
    const push = (col, val) => {
      vals.push(val);
      sets.push(`${col} = $${vals.length}`);
    };
    if (args.uploaded_at !== undefined) push("uploaded_at", optDate(args.uploaded_at));
    if (args.favorites_chosen !== undefined)
      push("favorites_chosen", reqBool(args.favorites_chosen));
    if (args.favorites_count !== undefined)
      push("favorites_count", optInt(args.favorites_count, 0, 10000));
    if (args.status !== undefined) {
      const st = optEnum(args.status, STATUSES);
      if (st == null) fail("Estatus inválido");
      push("status", st);
    }
    if (args.sent !== undefined) push("sent", reqBool(args.sent));
    if (args.delivered_at !== undefined)
      push("delivered_at", optDate(args.delivered_at));
    vals.push(id);
    await pool.query(
      `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${vals.length}`,
      vals,
    );
    return { ok: true };
  },

  // Sin agente de Muse en Render: la encuesta no se sincroniza sola.
  async refreshSurveyAnswers() {
    return { started: false };
  },

  async saveSurveyAnswers(args) {
    if (!Array.isArray(args.updates)) fail("Faltan las actualizaciones");
    const rows = await allSessions();
    const normalize = (s) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const byName = new Map(rows.map((r) => [normalize(r.client_name), r]));
    let updated = 0;
    for (const u of args.updates.slice(0, 100)) {
      const row = byName.get(normalize(String(u.client_name ?? "")));
      if (!row) continue;
      const sets = ["updated_at = now()"];
      const vals = [];
      const push = (col, val) => {
        vals.push(val);
        sets.push(`${col} = $${vals.length}`);
      };
      if (u.face_level != null) push("face_level", cleanText(u.face_level, 120));
      if (u.body_adjustments != null)
        push("body_adjustments", cleanText(u.body_adjustments, 300));
      if (u.publish_permission != null)
        push("publish_permission", optEnum(u.publish_permission, PUBLISH));
      if (u.delivery_type != null && row.delivery_type == null)
        push("delivery_type", optEnum(u.delivery_type, DELIVERY_TYPES));
      if (u.motive != null) push("motive", cleanText(u.motive, 200));
      if (u.do_not_touch != null)
        push("do_not_touch", cleanText(u.do_not_touch, 300));
      if (u.background_color != null)
        push("background_color", cleanText(u.background_color, 60));
      if (u.first_session != null) push("first_session", reqBool(u.first_session));
      if (u.discovery_source != null)
        push("discovery_source", cleanText(u.discovery_source, 80));
      vals.push(row.id);
      await pool.query(
        `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${vals.length}`,
        vals,
      );
      updated++;
    }
    return { updated };
  },

  getMonthFinance,

  async saveMonthlyClose(args) {
    const month = args.month;
    if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month))
      fail("El mes debe ser AAAA-MM");
    const num = (v) => optInt(v, 0, 100000000);
    await pool.query(
      `INSERT INTO monthly_closes (month, estimate_sales, projected_sales,
         actual_sales, actual_fixed_costs, actual_variable_costs, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (month) DO UPDATE SET
         estimate_sales = EXCLUDED.estimate_sales,
         projected_sales = EXCLUDED.projected_sales,
         actual_sales = EXCLUDED.actual_sales,
         actual_fixed_costs = EXCLUDED.actual_fixed_costs,
         actual_variable_costs = EXCLUDED.actual_variable_costs,
         notes = EXCLUDED.notes,
         updated_at = now()`,
      [
        month,
        num(args.estimate_sales),
        num(args.projected_sales),
        num(args.actual_sales),
        num(args.actual_fixed_costs),
        num(args.actual_variable_costs),
        cleanText(args.notes, 1000),
      ],
    );
    return { ok: true };
  },

  // Guarda el cierre real del mes desde la calculadora: las partidas se
  // precian con la tabla del estudio, los fijos salen de las filas de
  // gastos del mes (o de la referencia renta/Adobe/Pixieset cuando no
  // hay) y los variables de los gastos; todo queda como cierre real
  // para que el tablero calcule neto, ahorro y reparto.
  async saveMonthCloseCalculator(args) {
    const month = args.month;
    if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month))
      fail("El mes debe ser AAAA-MM");
    const counts = saleCounts(args.counts);
    const total = saleItemsTotal(counts);
    const num = (v) => optInt(v, 0, 100000000);
    const { rows: monthExpenses } = await pool.query(
      "SELECT * FROM expenses WHERE month = $1",
      [month],
    );
    const fixedRows = monthExpenses.filter((e) => e.kind === "fijo");
    const fixedTotal =
      fixedRows.length > 0
        ? fixedRows.reduce((sum, e) => sum + e.amount, 0)
        : FIXED_COSTS_REFERENCE.reduce((sum, ref) => sum + ref.amount, 0);
    const variableTotal = monthExpenses
      .filter((e) => e.kind === "variable")
      .reduce((sum, e) => sum + e.amount, 0);
    await pool.query(
      `INSERT INTO monthly_closes (month, estimate_sales, projected_sales,
         actual_sales, actual_fixed_costs, actual_variable_costs,
         cash_sales, transfer_sales, deductions, sales_items, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (month) DO UPDATE SET
         estimate_sales = EXCLUDED.estimate_sales,
         projected_sales = EXCLUDED.projected_sales,
         actual_sales = EXCLUDED.actual_sales,
         actual_fixed_costs = EXCLUDED.actual_fixed_costs,
         actual_variable_costs = EXCLUDED.actual_variable_costs,
         cash_sales = EXCLUDED.cash_sales,
         transfer_sales = EXCLUDED.transfer_sales,
         deductions = EXCLUDED.deductions,
         sales_items = EXCLUDED.sales_items,
         notes = EXCLUDED.notes,
         updated_at = now()`,
      [
        month,
        num(args.estimate_sales),
        num(args.projected_sales),
        total,
        fixedTotal,
        variableTotal,
        num(args.cash_sales),
        num(args.transfer_sales),
        num(args.deductions),
        JSON.stringify(counts),
        cleanText(args.notes, 1000),
      ],
    );
    return { ok: true, total };
  },

  getStudioStats,

  // Importa renglones de la hoja mensual de ventas (botón "Cargar Excel
  // de ventas"): cada renglón es una clienta/sesión con lo que pagó. Un
  // renglón cuya clienta ya tiene sesión en ese mes la actualiza
  // (paquete, fecha, tipo de entrega y el pago: cargos liquidados, la
  // marca de no pagado se quita y las fotos extra se derivan cuando el
  // monto pagado supera el precio del paquete en pasos de $150); si no,
  // se crea la sesión. El monto pagado queda anotado en la nota.
  async importSalesRows(args) {
    const month = args.month;
    if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month))
      fail("El mes debe ser AAAA-MM");
    if (
      !Array.isArray(args.rows) ||
      args.rows.length < 1 ||
      args.rows.length > 500
    )
      fail("Faltan los renglones (1 a 500)");
    const rows = args.rows.map((r) => ({
      client_name: reqText(r.client_name, 120),
      session_date: optDate(r.session_date ?? null),
      package_label: cleanText(r.package_label ?? null, 40),
      amount_paid: optInt(r.amount_paid ?? null, 0, 10000000),
      delivery_type: optEnum(r.delivery_type ?? null, DELIVERY_TYPES),
      status: optEnum(r.status ?? null, STATUSES),
    }));
    const existing = await allSessions();
    const byName = new Map();
    for (const row of existing) {
      const key = statsNormalizeName(row.client_name);
      const list = byName.get(key) ?? [];
      list.push(row);
      byName.set(key, list);
    }
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      // Fotos elegidas derivadas del monto pagado cuando cuadra con la
      // tabla: precio del paquete (+ Express) más fotos extra en pasos
      // de $150. Cualquier otro monto queda solo como nota.
      const pkg = packageKey(row.package_label);
      const info = pkg ? PACKAGE_INFO[pkg] : undefined;
      const expressFee = row.delivery_type === "EXPRESS" ? EXPRESS_FEE : 0;
      let favoritesCount = null;
      if (info && row.amount_paid != null) {
        const rest = row.amount_paid - info.price - expressFee;
        if (rest > 0 && rest % EXTRA_PHOTO_PRICE === 0) {
          favoritesCount = info.included + rest / EXTRA_PHOTO_PRICE;
        }
      }
      const paidNote =
        row.amount_paid != null
          ? `Pagó ${row.amount_paid.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 })} según la hoja de ventas cargada.`
          : null;
      const candidates = byName.get(statsNormalizeName(row.client_name)) ?? [];
      const match =
        candidates.find(
          (c) =>
            row.session_date != null && c.session_date === row.session_date,
        ) ??
        candidates.find((c) => {
          const ref = c.session_date ?? c.delivered_at;
          return ref != null && ref.startsWith(month);
        }) ??
        candidates.find((c) => c.session_date == null);
      if (match) {
        const sets = ["updated_at = now()"];
        const vals = [];
        const push = (col, val) => {
          vals.push(val);
          sets.push(`${col} = $${vals.length}`);
        };
        if (row.session_date != null) push("session_date", row.session_date);
        if (row.package_label != null) push("package_label", row.package_label);
        if (row.delivery_type != null)
          push("delivery_type", row.delivery_type);
        if (row.status != null) push("status", row.status);
        if (row.amount_paid != null) {
          push("charges_settled", true);
          push("unpaid", false);
          if (favoritesCount != null) {
            push("favorites_chosen", true);
            push("favorites_count", favoritesCount);
          }
          if (paidNote && !(match.notes ?? "").includes(paidNote)) {
            push(
              "notes",
              match.notes ? `${match.notes} ${paidNote}` : paidNote,
            );
          }
        }
        vals.push(match.id);
        await pool.query(
          `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${vals.length}`,
          vals,
        );
        updated++;
      } else {
        const { rows: inserted } = await pool.query(
          `INSERT INTO sessions (client_name, status, session_date,
             delivery_date, delivery_date_estimated, delivery_type,
             package_label, photo_count, favorites_chosen, favorites_count,
             drive_url, uploaded_at, sent, charges_settled, unpaid, notes)
           VALUES ($1, $2, $3, NULL, false, $4, $5, NULL, $6, $7,
             NULL, NULL, false, $8, false, $9)
           RETURNING id`,
          [
            row.client_name,
            row.status ?? "pendiente",
            row.session_date,
            row.delivery_type,
            row.package_label,
            favoritesCount != null,
            favoritesCount,
            row.amount_paid != null,
            paidNote,
          ],
        );
        const newRow = inserted[0];
        if (newRow) {
          const key = statsNormalizeName(row.client_name);
          const list = byName.get(key) ?? [];
          list.push({
            id: newRow.id,
            client_name: row.client_name,
            session_date: row.session_date,
            delivered_at: null,
            notes: paidNote,
          });
          byName.set(key, list);
        }
        created++;
      }
    }
    return { created, updated, rows: rows.length };
  },

  async addExpense(args) {
    const month = args.month;
    if (typeof month !== "string" || !/^\d{4}-\d{2}$/.test(month))
      fail("El mes debe ser AAAA-MM");
    const kind = optEnum(args.kind, ["fijo", "variable"]);
    if (kind == null) fail("Falta el tipo de gasto");
    const amount = optInt(args.amount, 1, 10000000);
    if (amount == null) fail("Falta el monto");
    const { rows } = await pool.query(
      `INSERT INTO expenses (month, expense_date, kind, description, amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        month,
        optDate(args.expense_date),
        kind,
        reqText(args.description, 200),
        amount,
      ],
    );
    return { id: rows[0].id };
  },

  async deleteExpense(args) {
    await pool.query("DELETE FROM expenses WHERE id = $1", [reqId(args.id)]);
    return { ok: true };
  },

  async setChargesSettled(args) {
    const id = reqId(args.id);
    const settled = reqBool(args.settled);
    if (settled) {
      await pool.query(
        "UPDATE sessions SET charges_settled = true, unpaid = false, updated_at = now() WHERE id = $1",
        [id],
      );
    } else {
      await pool.query(
        "UPDATE sessions SET charges_settled = false, updated_at = now() WHERE id = $1",
        [id],
      );
    }
    return { ok: true };
  },
};

// --- HTTP ---------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const authUser = process.env.BASIC_AUTH_USER ?? "";
const authPass = process.env.BASIC_AUTH_PASSWORD ?? "";
function authorized(req) {
  if (!authUser || !authPass) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  return (
    decoded.slice(0, idx) === authUser && decoded.slice(idx + 1) === authPass
  );
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.normalize(path.join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const target = existsSync(filePath)
    ? filePath
    : path.join(publicDir, "index.html");
  const data = await readFile(target);
  res.writeHead(200, {
    "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
    "cache-control": target.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, {
        "www-authenticate": 'Basic realm="Sesiones Punto Cero"',
        "content-type": "text/plain; charset=utf-8",
      });
      res.end("Se necesita usuario y contraseña.");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/actions")) {
      const body = JSON.parse(await readBody(req));
      const action = Actions[body.action];
      if (!action) {
        sendJson(res, 400, { error: `Acción desconocida: ${body.action}` });
        return;
      }
      const data = await action(body.args ?? {});
      sendJson(res, 200, { data });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res, url.pathname);
      return;
    }
    res.writeHead(405);
    res.end("Method Not Allowed");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : "Error inesperado",
      });
    } else {
      res.end();
    }
  }
});

await migrateIfEmpty();
server.listen(port, () => {
  console.log(`Sesiones Punto Cero escuchando en el puerto ${port}`);
});
