// Actions for the Sesiones Punto Cero board.
//
// The board is user-managed: Monday.com's API is unavailable on the studio's
// free plan, so rows live here and are edited by Les in the UI. Delivery
// dates are board dates entered by hand — never computed from other dates.

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const statusEnum = z.enum(["pendiente", "en_edicion", "entregada", "no_show"]);
const deliveryTypeEnum = z.enum(["ESTANDAR", "EXPRESS"]);
const publishEnum = z.enum(["SI", "NO"]);
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser AAAA-MM-DD");

const sessionShape = z.object({
  id: z.number(),
  client_name: z.string(),
  status: statusEnum,
  session_date: z.string().nullable(),
  delivery_date: z.string().nullable(),
  delivery_date_estimated: z.boolean(),
  delivery_type: deliveryTypeEnum.nullable(),
  package_label: z.string().nullable(),
  photo_count: z.number().nullable(),
  favorites_chosen: z.boolean(),
  favorites_count: z.number().nullable(),
  drive_url: z.string().nullable(),
  uploaded_at: z.string().nullable(),
  sent: z.boolean(),
  charges_settled: z.boolean(),
  unpaid: z.boolean(),
  face_level: z.string().nullable(),
  body_adjustments: z.string().nullable(),
  publish_permission: publishEnum.nullable(),
  motive: z.string().nullable(),
  do_not_touch: z.string().nullable(),
  background_color: z.string().nullable(),
  first_session: z.boolean().nullable(),
  discovery_source: z.string().nullable(),
  notes: z.string().nullable(),
  delivered_at: z.string().nullable(),
});

type SessionRow = typeof schema.sessions.$inferSelect;

function toSession(row: SessionRow): z.infer<typeof sessionShape> {
  return {
    id: row.id,
    client_name: row.clientName,
    status: row.status,
    session_date: row.sessionDate,
    delivery_date: row.deliveryDate,
    delivery_date_estimated: row.deliveryDateEstimated,
    delivery_type: row.deliveryType,
    package_label: row.packageLabel,
    photo_count: row.photoCount,
    favorites_chosen: row.favoritesChosen,
    favorites_count: row.favoritesCount,
    drive_url: row.driveUrl,
    uploaded_at: row.uploadedAt,
    sent: row.sent,
    charges_settled: row.chargesSettled,
    unpaid: row.unpaid,
    face_level: row.faceLevel,
    body_adjustments: row.bodyAdjustments,
    publish_permission: row.publishPermission,
    motive: row.motive,
    do_not_touch: row.doNotTouch,
    background_color: row.backgroundColor,
    first_session: row.firstSession,
    discovery_source: row.discoverySource,
    notes: row.notes,
    delivered_at: row.deliveredAt,
  };
}

// Fields shared by create and update. Text fields accept "" from the form
// and store null so the board can tell "no data yet" from real content.
const editableFields = {
  status: statusEnum,
  session_date: dateString.nullable(),
  delivery_date: dateString.nullable(),
  delivery_date_estimated: z.boolean(),
  delivery_type: deliveryTypeEnum.nullable(),
  package_label: z.string().trim().max(40).nullable(),
  photo_count: z.number().int().min(0).max(10000).nullable(),
  favorites_chosen: z.boolean(),
  favorites_count: z.number().int().min(0).max(10000).nullable(),
  drive_url: z.string().trim().max(500).nullable(),
  uploaded_at: dateString.nullable(),
  sent: z.boolean(),
  charges_settled: z.boolean(),
  unpaid: z.boolean(),
  face_level: z.string().trim().max(120).nullable(),
  body_adjustments: z.string().trim().max(300).nullable(),
  publish_permission: publishEnum.nullable(),
  motive: z.string().trim().max(200).nullable(),
  do_not_touch: z.string().trim().max(300).nullable(),
  background_color: z.string().trim().max(60).nullable(),
  first_session: z.boolean().nullable(),
  discovery_source: z.string().trim().max(80).nullable(),
  notes: z.string().trim().max(1000).nullable(),
  delivered_at: dateString.nullable(),
};

function cleanText(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const editableShape = z.object(editableFields);

function toValues(args: z.infer<typeof editableShape>) {
  return {
    status: args.status,
    sessionDate: args.session_date,
    deliveryDate: args.delivery_date,
    deliveryDateEstimated: args.delivery_date_estimated,
    deliveryType: args.delivery_type,
    packageLabel: cleanText(args.package_label),
    photoCount: args.photo_count,
    favoritesChosen: args.favorites_chosen,
    favoritesCount: args.favorites_count,
    driveUrl: cleanText(args.drive_url),
    uploadedAt: args.uploaded_at,
    sent: args.sent,
    chargesSettled: args.charges_settled,
    unpaid: args.unpaid,
    faceLevel: cleanText(args.face_level),
    bodyAdjustments: cleanText(args.body_adjustments),
    publishPermission: args.publish_permission,
    motive: cleanText(args.motive),
    doNotTouch: cleanText(args.do_not_touch),
    backgroundColor: cleanText(args.background_color),
    firstSession: args.first_session,
    discoverySource: cleanText(args.discovery_source),
    notes: cleanText(args.notes),
    deliveredAt: args.delivered_at,
    updatedAt: new Date(),
  };
}

const updateRequest = z.object({
  id: z.number().int().positive(),
  client_name: z.string().trim().min(1).max(120),
  ...editableFields,
});

const okResponse = z.object({ ok: z.literal(true) });

// --- Finance (July 2026 price table, confirmed by Leslye) -------------------
const PACKAGE_INFO: Record<string, { price: number; included: number }> = {
  p1: { price: 870, included: 5 },
  p2: { price: 1100, included: 8 },
  p3: { price: 1335, included: 10 },
  p4: { price: 1560, included: 12 },
  p5: { price: 1910, included: 15 },
};
const EXTRA_PHOTO_PRICE = 150;
const EXPRESS_FEE = 399;
const NO_SHOW_DEPOSIT = 200;
// Monthly fixed costs from October 2025's real close; Adobe and Pixieset are
// fixed even though Daniela's sheet lists them under variables.
const FIXED_COSTS_REFERENCE = [
  { label: "Renta del estudio", amount: 3500, match: "renta" },
  { label: "Adobe", amount: 681, match: "adobe" },
  { label: "Pixieset", amount: 183, match: "pixieset" },
];

// --- Month-close calculator -------------------------------------------------
// The studio's full rate table (July 2026, confirmed by Leslye): the five
// packages at their con-IVA prices plus every extra the studio charges.
// The close calculator builds the month's real sales from counts of these
// items, so nobody has to redo the math in Excel.
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
} as const;

const saleCountsShape = z.object({
  p1: z.number().int().min(0).max(10000),
  p2: z.number().int().min(0).max(10000),
  p3: z.number().int().min(0).max(10000),
  p4: z.number().int().min(0).max(10000),
  p5: z.number().int().min(0).max(10000),
  foto_extra: z.number().int().min(0).max(10000),
  sesion_completa: z.number().int().min(0).max(10000),
  video: z.number().int().min(0).max(10000),
  express: z.number().int().min(0).max(10000),
  persona_extra: z.number().int().min(0).max(10000),
  fondo_extra: z.number().int().min(0).max(10000),
  outfit_extra: z.number().int().min(0).max(10000),
  apartado: z.number().int().min(0).max(10000),
});

type SaleCounts = z.infer<typeof saleCountsShape>;
type SaleItemKey = keyof typeof SALE_CATALOG;
const SALE_KEYS = Object.keys(SALE_CATALOG) as SaleItemKey[];

function saleItemsTotal(counts: SaleCounts): number {
  return SALE_KEYS.reduce(
    (sum, key) => sum + counts[key] * SALE_CATALOG[key].price,
    0,
  );
}

function saleItemsList(counts: SaleCounts) {
  return SALE_KEYS.filter((key) => counts[key] > 0).map((key) => ({
    key,
    label: SALE_CATALOG[key].label,
    price: SALE_CATALOG[key].price,
    count: counts[key],
    amount: counts[key] * SALE_CATALOG[key].price,
  }));
}

// Reads the counts stored by the close calculator; anything malformed or
// missing reads as "no items captured" rather than breaking the view.
function parseSaleCounts(raw: string | null): SaleCounts | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = saleCountsShape.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function packageKey(label: string | null): string | null {
  if (!label) return null;
  const m = label.toLowerCase().match(/p(?:aquete\s*)?([1-5])/);
  return m ? `p${m[1]}` : null;
}

// What a session is worth and what the client still owes in extras:
// package price + extra photos over the package's included count ($150
// each) + the Express fee ($399). Unknown package/counts contribute 0 —
// charges are never invented.
function sessionCharges(row: SessionRow) {
  const pkg = packageKey(row.packageLabel);
  const info = pkg ? PACKAGE_INFO[pkg] : undefined;
  const base = info ? info.price : 0;
  const chosen = row.favoritesChosen
    ? (row.favoritesCount ?? row.photoCount)
    : row.photoCount;
  const extrasCount =
    info && chosen != null ? Math.max(0, chosen - info.included) : 0;
  return {
    pkg,
    base,
    extrasCount,
    extrasCharge: extrasCount * EXTRA_PHOTO_PRICE,
    expressFee: row.deliveryType === "EXPRESS" ? EXPRESS_FEE : 0,
  };
}

const financeResponse = z.object({
  // The scope's month (YYYY-MM), or null for the general view.
  month: z.string().nullable(),
  computed: z.object({
    sessions_count: z.number(),
    by_package: z.array(
      z.object({ package: z.string(), count: z.number(), amount: z.number() }),
    ),
    base_total: z.number(),
    extras_total: z.number(),
    express_total: z.number(),
    no_show_count: z.number(),
    no_show_total: z.number(),
    total: z.number(),
  }),
  close: z.object({
    estimate_sales: z.number().nullable(),
    projected_sales: z.number().nullable(),
    actual_sales: z.number().nullable(),
    actual_fixed_costs: z.number().nullable(),
    actual_variable_costs: z.number().nullable(),
    cash_sales: z.number().nullable(),
    transfer_sales: z.number().nullable(),
    deductions: z.number().nullable(),
    sales_items: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        price: z.number(),
        count: z.number(),
        amount: z.number(),
      }),
    ),
    notes: z.string().nullable(),
  }),
  estimate_headline: z.number(),
  estimate_with_projection: z.number(),
  difference: z.number().nullable(),
  matches: z.boolean().nullable(),
  expenses: z.array(
    z.object({
      id: z.number(),
      month: z.string(),
      expense_date: z.string().nullable(),
      kind: z.enum(["fijo", "variable"]),
      description: z.string(),
      amount: z.number(),
    }),
  ),
  fixed_total: z.number(),
  variable_total: z.number(),
  table: z.object({
    sales: z.number(),
    sales_is_actual: z.boolean(),
    fixed: z.number(),
    variable: z.number(),
    deductions: z.number(),
    net: z.number(),
    savings: z.number(),
    each: z.number(),
  }),
  fixed_alerts: z.array(
    z.object({
      label: z.string(),
      reference_amount: z.number(),
      registered_amount: z.number().nullable(),
    }),
  ),
  // The fixed costs the month's table actually counts: the registered
  // fixed rows when the month has any, otherwise the reference amounts.
  fixed_costs: z.array(
    z.object({
      label: z.string(),
      amount: z.number(),
      from_reference: z.boolean(),
    }),
  ),
  fixed_costs_from_reference: z.boolean(),
  receivables: z.array(
    z.object({
      id: z.number(),
      client_name: z.string(),
      base_charge: z.number(),
      extras_count: z.number(),
      extras_charge: z.number(),
      express_fee: z.number(),
      total: z.number(),
    }),
  ),
  receivables_total: z.number(),
});

// --- Studio statistics -------------------------------------------------------
// Business days Mon–Sat minus Mexican public holidays — the same rule the
// board's delivery calculator uses, needed here to estimate the delivery
// date of pending sessions that have no board date yet.

function statsFmtDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function statsParseDate(value: string): Date {
  const [y = 1970, m = 1, d = 1] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const statsHolidayCache = new Map<number, Set<string>>();

function statsMexicanHolidays(year: number): Set<string> {
  const cached = statsHolidayCache.get(year);
  if (cached) return cached;
  const set = new Set<string>();
  const nthMonday = (month: number, n: number): string => {
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

function statsIsBusinessDay(value: string): boolean {
  const d = statsParseDate(value);
  if (d.getDay() === 0) return false;
  return !statsMexicanHolidays(d.getFullYear()).has(value);
}

function statsAddBusinessDays(start: string, count: number): string {
  const d = statsParseDate(start);
  let added = 0;
  while (added < count) {
    d.setDate(d.getDate() + 1);
    if (statsIsBusinessDay(statsFmtDate(d))) added++;
  }
  return statsFmtDate(d);
}

// The delivery date a pending session is measured against: the board date
// when there is one, otherwise the calculator's estimate (15 business days
// from the Drive upload, 3 for Express) — same as the board shows.
function statsEffectiveDelivery(row: SessionRow): string | null {
  if (row.deliveryDate) return row.deliveryDate;
  if (!row.uploadedAt) return null;
  return statsAddBusinessDays(
    row.uploadedAt,
    row.deliveryType === "EXPRESS" ? 3 : 15,
  );
}

function statsNormalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const statsResponse = z.object({
  // The month the figures are scoped to (YYYY-MM), or null when they
  // cover the whole history from the beginning.
  scope_month: z.string().nullable(),
  totals: z.object({
    sessions: z.number(),
    delivered: z.number(),
    pending: z.number(),
    no_show: z.number(),
    clients: z.number(),
    repeat_clients: z.number(),
    photos_total: z.number(),
    photos_sessions: z.number(),
    photos_avg: z.number(),
    revenue_total: z.number(),
    revenue_actual: z.number(),
    revenue_estimated: z.number(),
  }),
  monthly: z.array(
    z.object({
      month: z.string(),
      sessions: z.number(),
      revenue: z.number(),
      is_actual: z.boolean(),
    }),
  ),
  packages: z.array(
    z.object({
      package: z.string(),
      sessions: z.number(),
      revenue: z.number(),
    }),
  ),
  packages_unknown: z.number(),
  top_clients: z.array(
    z.object({
      client_name: z.string(),
      sessions: z.number(),
      revenue: z.number(),
      last_session_date: z.string().nullable(),
    }),
  ),
  delivery: z.object({
    on_time: z.number(),
    late: z.number(),
    without_board_date: z.number(),
    pending_overdue: z.number(),
    pending_total: z.number(),
  }),
  delivery_types: z.object({
    express: z.number(),
    standard: z.number(),
    unknown: z.number(),
  }),
  photos_top: z.array(
    z.object({
      client_name: z.string(),
      photo_count: z.number(),
      package_label: z.string().nullable(),
    }),
  ),
  // Aggregates of everything the editing-survey form asks the clients:
  // face retouch level, body adjustments, publish permission, session
  // motive, what not to touch, background color, first session or not,
  // and how they found the studio. (Express vs. standard already lives
  // in delivery_types above.)
  survey: z.object({
    total: z.number(),
    answered: z.number(),
    face_level: z.array(
      z.object({ value: z.string(), count: z.number() }),
    ),
    body_adjustments: z.array(
      z.object({ value: z.string(), count: z.number() }),
    ),
    publish: z.object({
      si: z.number(),
      no: z.number(),
      sin_dato: z.number(),
    }),
    motive: z.array(z.object({ value: z.string(), count: z.number() })),
    do_not_touch: z.array(
      z.object({ value: z.string(), count: z.number() }),
    ),
    background_color: z.array(
      z.object({ value: z.string(), count: z.number() }),
    ),
    first_session: z.object({
      si: z.number(),
      no: z.number(),
      sin_dato: z.number(),
    }),
    discovery_source: z.array(
      z.object({ value: z.string(), count: z.number() }),
    ),
  }),
});

// --- Per-month finance figures ----------------------------------------------
// One month's full finance picture, computed from the board's rows. Both
// getMonthFinance (one month, or every month summed for the general view)
// and getSavings (the 5% each month generates) read from this single
// helper so the figures can never drift apart.

type MonthCloseRow = typeof schema.monthlyCloses.$inferSelect;
type ExpenseRow = typeof schema.expenses.$inferSelect;

function currentMonthChihuahua(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chihuahua",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
}

// The month a session counts in for finance: its session date, or its
// delivery date when it has no session date. A no-show without any date
// still kept its $200 deposit, so by Leslye's rule it counts in the
// current month; any other undated session counts in no month.
function financeMonthOf(row: SessionRow, currentMonth: string): string | null {
  const ref = row.sessionDate ?? row.deliveredAt;
  if (ref != null) return ref.slice(0, 7);
  return row.status === "no_show" ? currentMonth : null;
}

function monthFigures(
  month: string,
  allSessions: SessionRow[],
  allExpenses: ExpenseRow[],
  close: MonthCloseRow | null,
  currentMonth: string,
) {
  const monthSessions = allSessions.filter(
    (row) => financeMonthOf(row, currentMonth) === month,
  );
  const monthExpenses = allExpenses
    .filter((e) => e.month === month)
    .sort((a, b) => a.id - b.id);

  // Sales estimate computed live from the board.
  const byPackageMap = new Map<string, { count: number; amount: number }>();
  let baseTotal = 0;
  let extrasTotal = 0;
  let expressTotal = 0;
  let sessionsCount = 0;
  let noShowCount = 0;
  for (const row of monthSessions) {
    if (row.status === "no_show") {
      noShowCount++;
      continue;
    }
    // A session the client has not paid is not a sale yet: its full
    // amount waits in por cobrar until she pays.
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

  const estimateHeadline = close?.estimateSales ?? computedTotal;
  const projected = close?.projectedSales ?? 0;
  const estimateWithProjection = estimateHeadline + projected;
  const actualSales = close?.actualSales ?? null;

  const fixedRows = monthExpenses.filter((e) => e.kind === "fijo");
  const fixedFromExpenses = fixedRows.reduce((sum, e) => sum + e.amount, 0);
  const variableFromExpenses = monthExpenses
    .filter((e) => e.kind === "variable")
    .reduce((sum, e) => sum + e.amount, 0);
  // Fixed costs always count in Finanzas (Leslye's rule): when the month
  // has registered fixed rows, those are used; when it has none, the
  // reference amounts (renta, Adobe, Pixieset) stand in. Never both —
  // no double counting.
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
  const tableFixed = close?.actualFixedCosts ?? effectiveFixed;
  const tableVariable = close?.actualVariableCosts ?? variableFromExpenses;
  const tableDeductions = close?.deductions ?? 0;
  const net = tableSales - tableFixed - tableVariable - tableDeductions;
  const savings = Math.round(net * 0.05 * 100) / 100;
  const each = Math.round((net - savings) * 0.5 * 100) / 100;

  return {
    monthSessions,
    monthExpenses,
    byPackage: [...byPackageMap.entries()].map(([pkg, v]) => ({
      package: pkg,
      count: v.count,
      amount: v.amount,
    })),
    baseTotal,
    extrasTotal,
    expressTotal,
    sessionsCount,
    noShowCount,
    noShowTotal,
    computedTotal,
    estimateHeadline,
    estimateWithProjection,
    actualSales,
    fixedFromExpenses,
    variableFromExpenses,
    fixedCosts,
    fixedCostsFromReference,
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
  };
}

type MonthFigures = ReturnType<typeof monthFigures>;

// --- Savings (ahorro) ---------------------------------------------------------
// The balance is generated live: every month with data contributes the
// 5% of its finance table (real close when the month has one, the board
// estimate otherwise), and the registered abonos/retiros move it up or
// down. Nothing is stored but the manual movements themselves.
const savingsResponse = z.object({
  balance: z.number(),
  generated_total: z.number(),
  deposits_total: z.number(),
  withdrawals_total: z.number(),
  monthly: z.array(
    z.object({
      month: z.string(),
      savings: z.number(),
      is_actual: z.boolean(),
    }),
  ),
  movements: z.array(
    z.object({
      id: z.number(),
      movement_date: z.string().nullable(),
      kind: z.enum(["abono", "retiro"]),
      description: z.string(),
      amount: z.number(),
    }),
  ),
});

export const Actions = {
  listSessions: defineAction({
    description:
      "Lists every Punto Cero session on the board, in editing order (delivery date ascending, undated last).",
    request: z.object({}),
    response: z.object({ sessions: z.array(sessionShape) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.sessions)
        .orderBy(asc(schema.sessions.id));
      const sessions = rows.map(toSession);
      // Editing order: pending work first by delivery date (undated last),
      // then sessions already delivered, most recent delivery first;
      // no-shows go last (they live in the finance view).
      const rank = (s: z.infer<typeof sessionShape>) =>
        s.status === "entregada" ? 1 : s.status === "no_show" ? 2 : 0;
      sessions.sort((a, b) => {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        if (rank(a) === 1) {
          return (b.delivered_at ?? "").localeCompare(a.delivered_at ?? "");
        }
        if (a.delivery_date && b.delivery_date)
          return a.delivery_date.localeCompare(b.delivery_date);
        if (a.delivery_date) return -1;
        if (b.delivery_date) return 1;
        return a.id - b.id;
      });
      return { sessions };
    },
  }),

  createSession: defineAction({
    description: "Adds a new session row to the board and returns its id.",
    request: z.object({
      client_name: z.string().trim().min(1).max(120),
      ...editableFields,
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.sessions)
        .values({ clientName: args.client_name, ...toValues(args) })
        .returning({ id: schema.sessions.id });
      const inserted = result[0];
      if (!inserted) throw new Error("createSession: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  updateSession: defineAction({
    description: "Updates one session row on the board.",
    request: updateRequest,
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.sessions)
        .set({ clientName: args.client_name, ...toValues(args) })
        .where(eq(schema.sessions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setSessionStatus: defineAction({
    description:
      "Changes a session's status (pendiente, en_edicion, entregada); when marking entregada, delivered_at can be set in the same call.",
    request: z.object({
      id: z.number().int().positive(),
      status: statusEnum,
      delivered_at: dateString.nullable().optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const patch: Partial<SessionRow> = {
        status: args.status,
        updatedAt: new Date(),
      };
      if (args.delivered_at !== undefined) patch.deliveredAt = args.delivered_at;
      if (args.status !== "entregada" && args.delivered_at === undefined) {
        // Reopening a session clears its delivery stamp.
        patch.deliveredAt = null;
      }
      await db
        .update(schema.sessions)
        .set(patch)
        .where(eq(schema.sessions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteSession: defineAction({
    description:
      "Deletes one session row from the board (trash button on the session card, or the editor). The board offers Deshacer right after, which recreates the row with its data.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setProgress: defineAction({
    description:
      "Updates checklist progress on one session: folder uploaded date, favorites chosen/count, editing status, sent flag, or delivered status.",
    request: z.object({
      id: z.number().int().positive(),
      uploaded_at: dateString.nullable().optional(),
      favorites_chosen: z.boolean().optional(),
      favorites_count: z.number().int().min(0).max(10000).nullable().optional(),
      status: statusEnum.optional(),
      sent: z.boolean().optional(),
      delivered_at: dateString.nullable().optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const patch: Partial<SessionRow> = { updatedAt: new Date() };
      if (args.uploaded_at !== undefined) patch.uploadedAt = args.uploaded_at;
      if (args.favorites_chosen !== undefined)
        patch.favoritesChosen = args.favorites_chosen;
      if (args.favorites_count !== undefined)
        patch.favoritesCount = args.favorites_count;
      if (args.status !== undefined) patch.status = args.status;
      if (args.sent !== undefined) patch.sent = args.sent;
      if (args.delivered_at !== undefined) patch.deliveredAt = args.delivered_at;
      await db
        .update(schema.sessions)
        .set(patch)
        .where(eq(schema.sessions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  refreshSurveyAnswers: defineAction({
    description:
      "Starts a background sync that reads the ENCUESTAS EDICIÓN CLIENTES Google Sheet and updates each board card with the client's survey answers.",
    request: z.object({}),
    response: z.object({ started: z.boolean() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ clientName: schema.sessions.clientName })
        .from(schema.sessions);
      const names = rows.map((r) => r.clientName);
      const result = await ctx.agent.spawnTask(
        [
          "Actualiza el tablero «Sesiones Punto Cero» con las respuestas de la encuesta de edición de Punto Cero.",
          "",
          "1. Abre la hoja de Google Sheets «ENCUESTAS EDICIÓN CLIENTES» de la cuenta de Punto Cero (puntoceromexico0@gmail.com), pestaña «Respuestas de formulario 1» (~437 respuestas).",
          "2. Para cada clienta de la lista de abajo, busca su respuesta MÁS RECIENTE en la hoja y extrae: nivel de retoque de rostro, ajustes de cuerpo, si permite publicar sus fotos (Sí/No), motivo de la sesión, qué no se debe tocar, entrega Express o estándar, color de fondo, si es su primera sesión (Sí/No) y cómo conoció Punto Cero (Me recomendaron, Instagram, Facebook u Otro).",
          "3. Guarda los datos llamando la acción indicada con un update por clienta encontrada. client_name debe ser EXACTAMENTE el nombre de la lista. Deja en null cualquier campo que la clienta no haya respondido; no inventes respuestas. Si una clienta no aparece en la hoja, no la incluyas.",
          "",
          `Clientas del tablero: ${names.join(" | ")}`,
        ].join("\n"),
        { expectsAction: "saveSurveyAnswers", dedupeKey: "survey-answers-sync" },
      );
      return { started: result.ok };
    },
  }),

  saveSurveyAnswers: defineAction({
    description:
      "Saves survey answers read from the ENCUESTAS EDICIÓN CLIENTES sheet onto matching session rows (matched by client name). Only non-null fields are written.",
    request: z.object({
      updates: z
        .array(
          z.object({
            client_name: z.string().trim().min(1).max(120),
            face_level: z.string().trim().max(120).nullable().optional(),
            body_adjustments: z.string().trim().max(300).nullable().optional(),
            publish_permission: publishEnum.nullable().optional(),
            delivery_type: deliveryTypeEnum.nullable().optional(),
            motive: z.string().trim().max(200).nullable().optional(),
            do_not_touch: z.string().trim().max(300).nullable().optional(),
            background_color: z.string().trim().max(60).nullable().optional(),
            first_session: z.boolean().nullable().optional(),
            discovery_source: z.string().trim().max(80).nullable().optional(),
          }),
        )
        .max(100),
    }),
    response: z.object({ updated: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.sessions);
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const byName = new Map(rows.map((r) => [normalize(r.clientName), r]));
      let updated = 0;
      for (const u of args.updates) {
        const row = byName.get(normalize(u.client_name));
        if (!row) continue;
        const patch: Partial<SessionRow> = { updatedAt: new Date() };
        if (u.face_level != null) patch.faceLevel = u.face_level;
        if (u.body_adjustments != null)
          patch.bodyAdjustments = u.body_adjustments;
        if (u.publish_permission != null)
          patch.publishPermission = u.publish_permission;
        // The Monday board's entrega column wins over the survey when the
        // board already has a value; the survey only fills the gap.
        if (u.delivery_type != null && row.deliveryType == null)
          patch.deliveryType = u.delivery_type;
        if (u.motive != null) patch.motive = u.motive;
        if (u.do_not_touch != null) patch.doNotTouch = u.do_not_touch;
        if (u.background_color != null)
          patch.backgroundColor = u.background_color;
        if (u.first_session != null) patch.firstSession = u.first_session;
        if (u.discovery_source != null)
          patch.discoverySource = u.discovery_source;
        await db
          .update(schema.sessions)
          .set(patch)
          .where(eq(schema.sessions.id, row.id));
        updated++;
      }
      if (updated > 0) ctx.invalidateQueries();
      return { updated };
    },
  }),

  getMonthFinance: defineAction({
    description:
      "Computes Punto Cero finance for one month — or, with month = null, the general view that sums every month with data, so every figure belongs to the chosen scope. Per month: sales estimate from the board (packages + extra photos + Express + no-show deposits — an undated no-show counts in the current month), the registered estimate and the real close when present, the estimate-vs-real comparison (month scope only), the VENTAS-style table (net, 5% savings, 50/50 split), the expenses, the fixed costs the table counts (registered fixed rows, or the renta/Adobe/Pixieset reference amounts when none are registered) and the por-cobrar list (month scope: only that month's charges; general: everything pending). Sessions marked unpaid are excluded from sales and owed in full in por cobrar.",
    request: z.object({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/, "El mes debe ser AAAA-MM")
        .nullable(),
    }),
    response: financeResponse,
    handler: async (ctx, args): Promise<z.infer<typeof financeResponse>> => {
      const db = ctx.db<typeof schema>();
      const scopeMonth = args.month;
      const allSessions = await db.select().from(schema.sessions);
      const allExpenses = await db.select().from(schema.expenses);
      const allCloses = await db.select().from(schema.monthlyCloses);
      const closeByMonth = new Map(allCloses.map((c) => [c.month, c]));
      const currentMonth = currentMonthChihuahua();

      const monthsWithData = new Set<string>();
      for (const row of allSessions) {
        const m = financeMonthOf(row, currentMonth);
        if (m) monthsWithData.add(m);
      }
      for (const e of allExpenses) monthsWithData.add(e.month);
      for (const c of allCloses) monthsWithData.add(c.month);
      const scopeMonths =
        scopeMonth != null ? [scopeMonth] : [...monthsWithData].sort();
      const figures = scopeMonths.map((m) =>
        monthFigures(
          m,
          allSessions,
          allExpenses,
          closeByMonth.get(m) ?? null,
          currentMonth,
        ),
      );

      const sum = (pick: (f: MonthFigures) => number) =>
        figures.reduce((acc, f) => acc + pick(f), 0);
      const byPackageMap = new Map<string, { count: number; amount: number }>();
      for (const f of figures) {
        for (const bp of f.byPackage) {
          const entry = byPackageMap.get(bp.package) ?? { count: 0, amount: 0 };
          entry.count += bp.count;
          entry.amount += bp.amount;
          byPackageMap.set(bp.package, entry);
        }
      }

      const scopeExpenses = figures.flatMap((f) => f.monthExpenses);
      const scopeCloses = scopeMonths
        .map((m) => closeByMonth.get(m))
        .filter((c): c is MonthCloseRow => c != null);
      // Sums a close field over the scope's closes; null when no close
      // in the scope carries the field.
      const sumClose = (
        pick: (c: MonthCloseRow) => number | null,
      ): number | null => {
        let total: number | null = null;
        for (const c of scopeCloses) {
          const v = pick(c);
          if (v != null) total = (total ?? 0) + v;
        }
        return total;
      };
      // Close-calculator items merged across the scope's closes (used by
      // the general view's CSV; a single month reads its own close).
      const mergedCounts: Partial<Record<SaleItemKey, number>> = {};
      for (const c of scopeCloses) {
        const counts = parseSaleCounts(c.salesItems);
        if (!counts) continue;
        for (const key of SALE_KEYS)
          mergedCounts[key] = (mergedCounts[key] ?? 0) + counts[key];
      }
      const mergedItems = SALE_KEYS.filter(
        (key) => (mergedCounts[key] ?? 0) > 0,
      ).map((key) => ({
        key,
        label: SALE_CATALOG[key].label,
        price: SALE_CATALOG[key].price,
        count: mergedCounts[key] ?? 0,
        amount: (mergedCounts[key] ?? 0) * SALE_CATALOG[key].price,
      }));

      const single = scopeMonth != null ? (figures[0] ?? null) : null;
      const close =
        scopeMonth != null ? (closeByMonth.get(scopeMonth) ?? null) : null;

      // Estimate-vs-real comparison only exists for a single month.
      const estimateHeadline = sum((f) => f.estimateHeadline);
      const estimateWithProjection = sum((f) => f.estimateWithProjection);
      const computedTotal = sum((f) => f.computedTotal);
      const actualSales =
        scopeMonth != null
          ? (single?.actualSales ?? null)
          : sumClose((c) => c.actualSales);
      const hasEstimate =
        scopeMonth != null &&
        (close?.estimateSales != null || computedTotal > 0);
      const difference =
        actualSales != null && hasEstimate
          ? actualSales - estimateWithProjection
          : null;

      // Fixed-cost alerts: in month scope, what that month registered
      // for each reference item; in the general view, the all-time sums.
      const fixedAlerts = FIXED_COSTS_REFERENCE.map((ref) => {
        const registered = scopeExpenses
          .filter(
            (e) =>
              e.kind === "fijo" &&
              e.description.toLowerCase().includes(ref.match),
          )
          .reduce((acc, e) => acc + e.amount, 0);
        return {
          label: ref.label,
          reference_amount: ref.amount,
          registered_amount: registered > 0 ? registered : null,
        };
      });

      // The fixed costs the table counts: a single month lists its own
      // rows (or the reference); the general view groups every
      // registered fixed row by description (or the reference when no
      // fixed row exists at all).
      let fixedCosts: {
        label: string;
        amount: number;
        from_reference: boolean;
      }[];
      let fixedCostsFromReference: boolean;
      if (single) {
        fixedCosts = single.fixedCosts;
        fixedCostsFromReference = single.fixedCostsFromReference;
      } else {
        const allFixed = scopeExpenses.filter((e) => e.kind === "fijo");
        fixedCostsFromReference = allFixed.length === 0;
        if (fixedCostsFromReference) {
          fixedCosts = FIXED_COSTS_REFERENCE.map((ref) => ({
            label: ref.label,
            amount: ref.amount,
            from_reference: true,
          }));
        } else {
          const grouped = new Map<string, number>();
          for (const e of allFixed)
            grouped.set(
              e.description,
              (grouped.get(e.description) ?? 0) + e.amount,
            );
          fixedCosts = [...grouped.entries()].map(([label, amount]) => ({
            label,
            amount,
            from_reference: false,
          }));
        }
      }

      const table = {
        sales: sum((f) => f.table.sales),
        sales_is_actual:
          figures.length > 0 && figures.every((f) => f.table.sales_is_actual),
        fixed: sum((f) => f.table.fixed),
        variable: sum((f) => f.table.variable),
        deductions: sum((f) => f.table.deductions),
        net: sum((f) => f.table.net),
        savings: Math.round(sum((f) => f.table.savings) * 100) / 100,
        each: Math.round(sum((f) => f.table.each) * 100) / 100,
      };

      // Por cobrar: in month scope only that month's pending charges;
      // in the general view, everything still pending.
      const receivables = allSessions
        .filter((row) => row.status !== "no_show")
        .filter(
          (row) =>
            scopeMonth == null ||
            financeMonthOf(row, currentMonth) === scopeMonth,
        )
        .map((row) => ({ row, charges: sessionCharges(row) }))
        .filter(({ row, charges }) =>
          row.unpaid
            ? charges.base + charges.extrasCharge + charges.expressFee > 0
            : !row.chargesSettled &&
              (charges.extrasCharge > 0 || charges.expressFee > 0),
        )
        .map(({ row, charges }) => {
          // An unpaid session owes everything: package + extras + Express.
          // A paid session only owes its unsettled extras / Express.
          const baseCharge = row.unpaid ? charges.base : 0;
          return {
            id: row.id,
            client_name: row.clientName,
            base_charge: baseCharge,
            extras_count: charges.extrasCount,
            extras_charge: charges.extrasCharge,
            express_fee: charges.expressFee,
            total: baseCharge + charges.extrasCharge + charges.expressFee,
          };
        })
        .sort((a, b) => b.total - a.total);

      return {
        month: scopeMonth,
        computed: {
          sessions_count: sum((f) => f.sessionsCount),
          by_package: [...byPackageMap.entries()].map(([pkg, v]) => ({
            package: pkg,
            count: v.count,
            amount: v.amount,
          })),
          base_total: sum((f) => f.baseTotal),
          extras_total: sum((f) => f.extrasTotal),
          express_total: sum((f) => f.expressTotal),
          no_show_count: sum((f) => f.noShowCount),
          no_show_total: sum((f) => f.noShowTotal),
          total: computedTotal,
        },
        close: {
          estimate_sales:
            scopeMonth != null
              ? (close?.estimateSales ?? null)
              : sumClose((c) => c.estimateSales),
          projected_sales:
            scopeMonth != null
              ? (close?.projectedSales ?? null)
              : sumClose((c) => c.projectedSales),
          actual_sales: actualSales,
          actual_fixed_costs:
            scopeMonth != null
              ? (close?.actualFixedCosts ?? null)
              : sumClose((c) => c.actualFixedCosts),
          actual_variable_costs:
            scopeMonth != null
              ? (close?.actualVariableCosts ?? null)
              : sumClose((c) => c.actualVariableCosts),
          cash_sales:
            scopeMonth != null
              ? (close?.cashSales ?? null)
              : sumClose((c) => c.cashSales),
          transfer_sales:
            scopeMonth != null
              ? (close?.transferSales ?? null)
              : sumClose((c) => c.transferSales),
          deductions:
            scopeMonth != null
              ? (close?.deductions ?? null)
              : sumClose((c) => c.deductions),
          sales_items:
            scopeMonth != null
              ? (() => {
                  const counts = parseSaleCounts(close?.salesItems ?? null);
                  return counts ? saleItemsList(counts) : [];
                })()
              : mergedItems,
          notes: scopeMonth != null ? (close?.notes ?? null) : null,
        },
        estimate_headline: estimateHeadline,
        estimate_with_projection: estimateWithProjection,
        difference,
        matches: difference != null ? difference === 0 : null,
        expenses: scopeExpenses.map((e) => ({
          id: e.id,
          month: e.month,
          expense_date: e.expenseDate,
          kind: e.kind,
          description: e.description,
          amount: e.amount,
        })),
        fixed_total: sum((f) => f.fixedFromExpenses),
        variable_total: sum((f) => f.variableFromExpenses),
        table,
        fixed_alerts: fixedAlerts,
        fixed_costs: fixedCosts,
        fixed_costs_from_reference: fixedCostsFromReference,
        receivables,
        receivables_total: receivables.reduce((acc, r) => acc + r.total, 0),
      };
    },
  }),

  listMonths: defineAction({
    description:
      "Lists every month (YYYY-MM, ascending) that has anything on the board — sessions by session or delivery date, registered expenses, or a monthly close — so the Finanzas and Estadísticas views can offer a button for each month with data, from the very beginning of the studio's history.",
    request: z.object({}),
    response: z.object({ months: z.array(z.string()) }),
    handler: async (ctx): Promise<{ months: string[] }> => {
      const db = ctx.db<typeof schema>();
      const months = new Set<string>();
      const allSessions = await db.select().from(schema.sessions);
      for (const row of allSessions) {
        const ref = row.sessionDate ?? row.deliveredAt;
        if (ref) months.add(ref.slice(0, 7));
      }
      const allExpenses = await db.select().from(schema.expenses);
      for (const e of allExpenses) months.add(e.month);
      const allCloses = await db.select().from(schema.monthlyCloses);
      for (const c of allCloses) months.add(c.month);
      return { months: [...months].sort() };
    },
  }),

  getStudioStats: defineAction({
    description:
      "Computes the studio's statistics from the board's own data: sessions and revenue per month (the real close when a month has one, the board estimate otherwise), best-selling packages, repeat clients, on-time vs. late deliveries against the board delivery dates, photos per session, Express vs. standard mix, and the aggregates of every editing-survey answer (face retouch level, body adjustments, publish permission, motive, what not to touch, background color, first session, discovery source). With no month it covers the whole history from the beginning; with a month (YYYY-MM) every figure except the per-month series is scoped to that month's sessions.",
    request: z.object({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/, "El mes debe ser AAAA-MM")
        .nullable()
        .optional(),
    }),
    response: statsResponse,
    handler: async (ctx, args): Promise<z.infer<typeof statsResponse>> => {
      const db = ctx.db<typeof schema>();
      const allSessions = await db.select().from(schema.sessions);
      const allCloses = await db.select().from(schema.monthlyCloses);
      const closeByMonth = new Map(allCloses.map((c) => [c.month, c]));

      const nowParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chihuahua",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const today = nowParts.slice(0, 10);
      const currentMonth = today.slice(0, 7);

      const monthOf = (row: SessionRow) =>
        (row.sessionDate ?? row.deliveredAt)?.slice(0, 7) ?? null;
      // Same rule as Finanzas: an undated no-show's deposit counts in the
      // current month.
      const noShowMonth = (row: SessionRow) =>
        monthOf(row) ?? currentMonth;

      // Optional month scope: every figure except the per-month series
      // is computed over the requested month's sessions only. No month
      // means the whole history, from the beginning.
      const scopeMonth = args.month ?? null;
      const rows =
        scopeMonth == null
          ? allSessions
          : allSessions.filter(
              (row) =>
                (row.status === "no_show"
                  ? noShowMonth(row)
                  : monthOf(row)) === scopeMonth,
            );

      // --- per-month series -------------------------------------------------
      const monthKeys = new Set<string>();
      for (const c of allCloses) monthKeys.add(c.month);
      for (const row of allSessions) {
        const m =
          row.status === "no_show" ? noShowMonth(row) : monthOf(row);
        if (m) monthKeys.add(m);
      }
      const monthly: z.infer<typeof statsResponse>["monthly"] = [];
      let revenueTotal = 0;
      let revenueActual = 0;
      let revenueEstimated = 0;
      for (const month of [...monthKeys].sort()) {
        let sessionsCount = 0;
        let computed = 0;
        for (const row of allSessions) {
          if (row.status === "no_show") {
            if (noShowMonth(row) === month) computed += NO_SHOW_DEPOSIT;
            continue;
          }
          if (monthOf(row) !== month) continue;
          sessionsCount++;
          if (row.unpaid) continue;
          const charges = sessionCharges(row);
          computed +=
            charges.base + charges.extrasCharge + charges.expressFee;
        }
        const close = closeByMonth.get(month) ?? null;
        const isActual = close?.actualSales != null;
        const revenue = isActual
          ? (close?.actualSales ?? 0)
          : (close?.estimateSales ?? computed) + (close?.projectedSales ?? 0);
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

      // In a month scope, the headline revenue figures are that month's
      // alone (its real close when there is one, its estimate otherwise).
      let scopedRevenueTotal = revenueTotal;
      let scopedRevenueActual = revenueActual;
      let scopedRevenueEstimated = revenueEstimated;
      if (scopeMonth != null) {
        const entry = monthly.find((m) => m.month === scopeMonth);
        scopedRevenueTotal = entry?.revenue ?? 0;
        scopedRevenueActual = entry?.is_actual ? scopedRevenueTotal : 0;
        scopedRevenueEstimated =
          entry && !entry.is_actual ? scopedRevenueTotal : 0;
      }

      // --- packages, clients, photos, delivery types ------------------------
      const packageMap = new Map<string, { sessions: number; revenue: number }>();
      for (const key of Object.keys(PACKAGE_INFO)) {
        packageMap.set(key, { sessions: 0, revenue: 0 });
      }
      let packagesUnknown = 0;
      const clientMap = new Map<
        string,
        {
          name: string;
          sessions: number;
          revenue: number;
          last: string | null;
        }
      >();
      let photosTotal = 0;
      let photosSessions = 0;
      const photosRows: { client_name: string; photo_count: number; package_label: string | null }[] = [];
      let express = 0;
      let standard = 0;
      let typeUnknown = 0;
      let deliveredCount = 0;
      let noShowTotalCount = 0;

      for (const row of rows) {
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
        const key = statsNormalizeName(row.clientName);
        const client = clientMap.get(key) ?? {
          name: row.clientName,
          sessions: 0,
          revenue: 0,
          last: null as string | null,
        };
        client.sessions++;
        if (!row.unpaid)
          client.revenue +=
            charges.base + charges.extrasCharge + charges.expressFee;
        const ref = row.sessionDate ?? row.deliveredAt;
        if (ref && (client.last == null || ref > client.last)) {
          client.last = ref;
          client.name = row.clientName;
        }
        clientMap.set(key, client);
        if (row.photoCount != null) {
          photosTotal += row.photoCount;
          photosSessions++;
          photosRows.push({
            client_name: row.clientName,
            photo_count: row.photoCount,
            package_label: row.packageLabel,
          });
        }
        if (row.deliveryType === "EXPRESS") express++;
        else if (row.deliveryType === "ESTANDAR") standard++;
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

      // --- deliveries: on time vs. late --------------------------------------
      let onTime = 0;
      let late = 0;
      let withoutBoardDate = 0;
      let pendingOverdue = 0;
      let pendingTotal = 0;
      for (const row of rows) {
        if (row.status === "entregada") {
          if (!row.deliveryDate || !row.deliveredAt) withoutBoardDate++;
          else if (row.deliveredAt <= row.deliveryDate) onTime++;
          else late++;
        } else if (row.status !== "no_show") {
          pendingTotal++;
          const eff = statsEffectiveDelivery(row);
          if (eff && eff < today) pendingOverdue++;
        }
      }

      // --- survey answers (the clients' editing form) ----------------------
      const surveyRows = rows.filter((r) => r.status !== "no_show");
      const hasSurveyAnswer = (r: SessionRow) =>
        r.faceLevel != null ||
        r.bodyAdjustments != null ||
        r.publishPermission != null ||
        r.motive != null ||
        r.doNotTouch != null ||
        r.backgroundColor != null ||
        r.firstSession != null ||
        r.discoverySource != null;
      // Groups a free-text survey field by its normalized value, most
      // answered first; the label shown is the first spelling seen.
      const breakdown = (
        pick: (r: SessionRow) => string | null,
        cap = 12,
      ) => {
        const map = new Map<string, { value: string; count: number }>();
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
        if (r.publishPermission === "SI") publishCounts.si++;
        else if (r.publishPermission === "NO") publishCounts.no++;
        else publishCounts.sin_dato++;
        if (r.firstSession === true) firstSessionCounts.si++;
        else if (r.firstSession === false) firstSessionCounts.no++;
        else firstSessionCounts.sin_dato++;
      }

      const totalSessions = rows.filter(
        (r) => r.status !== "no_show",
      ).length;

      return {
        scope_month: scopeMonth,
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
          revenue_total: scopedRevenueTotal,
          revenue_actual: scopedRevenueActual,
          revenue_estimated: scopedRevenueEstimated,
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
          face_level: breakdown((r) => r.faceLevel),
          body_adjustments: breakdown((r) => r.bodyAdjustments),
          publish: publishCounts,
          motive: breakdown((r) => r.motive),
          do_not_touch: breakdown((r) => r.doNotTouch),
          background_color: breakdown((r) => r.backgroundColor),
          first_session: firstSessionCounts,
          discovery_source: breakdown((r) => r.discoverySource),
        },
      };
    },
  }),

  saveMonthlyClose: defineAction({
    description:
      "Saves a month's registered estimate and/or Daniela's real close figures (sales, fixed and variable costs) so the board can compare estimate vs. real.",
    request: z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/, "El mes debe ser AAAA-MM"),
      estimate_sales: z.number().int().min(0).max(100000000).nullable(),
      projected_sales: z.number().int().min(0).max(100000000).nullable(),
      actual_sales: z.number().int().min(0).max(100000000).nullable(),
      actual_fixed_costs: z.number().int().min(0).max(100000000).nullable(),
      actual_variable_costs: z.number().int().min(0).max(100000000).nullable(),
      notes: z.string().trim().max(1000).nullable(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const values = {
        month: args.month,
        estimateSales: args.estimate_sales,
        projectedSales: args.projected_sales,
        actualSales: args.actual_sales,
        actualFixedCosts: args.actual_fixed_costs,
        actualVariableCosts: args.actual_variable_costs,
        notes: cleanText(args.notes),
        updatedAt: new Date(),
      };
      const existing = await db
        .select()
        .from(schema.monthlyCloses)
        .where(eq(schema.monthlyCloses.month, args.month));
      if (existing.length > 0) {
        await db
          .update(schema.monthlyCloses)
          .set(values)
          .where(eq(schema.monthlyCloses.month, args.month));
      } else {
        await db.insert(schema.monthlyCloses).values(values);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  saveMonthCloseCalculator: defineAction({
    description:
      "Saves a month's real close from the close calculator: counts sold of each studio rate item (packages, extra photos, full session, video, Express, extra person/background/outfit, deposits), how the sales were collected (cash and transfers) and what must be deducted. The server prices the items with the studio's rate table, takes the month's fixed costs (registered rows, or the renta/Adobe/Pixieset reference when none) and variable costs from the registered expenses, and stores everything as the month's real close so the board computes the net, the 5% savings and the 50/50 split.",
    request: z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/, "El mes debe ser AAAA-MM"),
      counts: saleCountsShape,
      cash_sales: z.number().int().min(0).max(100000000).nullable(),
      transfer_sales: z.number().int().min(0).max(100000000).nullable(),
      deductions: z.number().int().min(0).max(100000000).nullable(),
      estimate_sales: z.number().int().min(0).max(100000000).nullable(),
      projected_sales: z.number().int().min(0).max(100000000).nullable(),
      notes: z.string().trim().max(1000).nullable(),
    }),
    response: z.object({ ok: z.literal(true), total: z.number() }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: true; total: number }> => {
      const db = ctx.db<typeof schema>();
      const total = saleItemsTotal(args.counts);
      // The month's costs come from the expense register, so the close
      // never retypes them: fixed rows when the month has any, otherwise
      // the reference amounts — the same rule the finance table uses.
      const monthExpenses = await db
        .select()
        .from(schema.expenses)
        .where(eq(schema.expenses.month, args.month));
      const fixedRows = monthExpenses.filter((e) => e.kind === "fijo");
      const fixedTotal =
        fixedRows.length > 0
          ? fixedRows.reduce((sum, e) => sum + e.amount, 0)
          : FIXED_COSTS_REFERENCE.reduce((sum, ref) => sum + ref.amount, 0);
      const variableTotal = monthExpenses
        .filter((e) => e.kind === "variable")
        .reduce((sum, e) => sum + e.amount, 0);
      const values = {
        month: args.month,
        estimateSales: args.estimate_sales,
        projectedSales: args.projected_sales,
        actualSales: total,
        actualFixedCosts: fixedTotal,
        actualVariableCosts: variableTotal,
        cashSales: args.cash_sales,
        transferSales: args.transfer_sales,
        deductions: args.deductions,
        salesItems: JSON.stringify(args.counts),
        notes: cleanText(args.notes),
        updatedAt: new Date(),
      };
      const existing = await db
        .select()
        .from(schema.monthlyCloses)
        .where(eq(schema.monthlyCloses.month, args.month));
      if (existing.length > 0) {
        await db
          .update(schema.monthlyCloses)
          .set(values)
          .where(eq(schema.monthlyCloses.month, args.month));
      } else {
        await db.insert(schema.monthlyCloses).values(values);
      }
      ctx.invalidateQueries();
      return { ok: true, total };
    },
  }),

  addExpense: defineAction({
    description: "Adds one expense row (fixed or variable) to a month's sheet.",
    request: z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/, "El mes debe ser AAAA-MM"),
      expense_date: dateString.nullable(),
      kind: z.enum(["fijo", "variable"]),
      description: z.string().trim().min(1).max(200),
      amount: z.number().int().min(1).max(10000000),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.expenses)
        .values({
          month: args.month,
          expenseDate: args.expense_date,
          kind: args.kind,
          description: args.description,
          amount: args.amount,
        })
        .returning({ id: schema.expenses.id });
      const inserted = result[0];
      if (!inserted) throw new Error("addExpense: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteExpense: defineAction({
    description: "Deletes one expense row from a month's sheet.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.expenses)
        .where(eq(schema.expenses.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setChargesSettled: defineAction({
    description:
      "Marks whether a client has paid what she owed (por cobrar): her extra-photo / Express charges, or her whole session when it was marked unpaid — marking paid clears the unpaid flag too.",
    request: z.object({
      id: z.number().int().positive(),
      settled: z.boolean(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const patch: Partial<SessionRow> = {
        chargesSettled: args.settled,
        updatedAt: new Date(),
      };
      if (args.settled) patch.unpaid = false;
      await db
        .update(schema.sessions)
        .set(patch)
        .where(eq(schema.sessions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  importSalesRows: defineAction({
    description:
      "Imports rows from the monthly sales spreadsheet (uploaded from the board's Excel button, with the columns already mapped in the UI): each row is one client/session with what she paid. A row whose client already has a session in that month updates it (package, date, delivery type, and the payment: charges marked settled, the unpaid flag cleared, and extra photos derived when the amount paid exceeds the package price by whole $150 steps); otherwise a new session is created. The amount paid is also noted on the row so nothing is lost.",
    request: z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/, "El mes debe ser AAAA-MM"),
      rows: z
        .array(
          z.object({
            client_name: z.string().trim().min(1).max(120),
            session_date: dateString.nullable(),
            package_label: z.string().trim().max(40).nullable(),
            amount_paid: z.number().int().min(0).max(10000000).nullable(),
            delivery_type: deliveryTypeEnum.nullable(),
            status: statusEnum.nullable(),
          }),
        )
        .min(1)
        .max(500),
    }),
    response: z.object({
      created: z.number(),
      updated: z.number(),
      rows: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.sessions);
      type MatchRow = Pick<
        SessionRow,
        "id" | "clientName" | "sessionDate" | "deliveredAt" | "notes"
      >;
      const byName = new Map<string, MatchRow[]>();
      for (const row of existing) {
        const key = statsNormalizeName(row.clientName);
        const list = byName.get(key) ?? [];
        list.push(row);
        byName.set(key, list);
      }
      let created = 0;
      let updated = 0;
      for (const row of args.rows) {
        // Derive chosen photos from the amount paid when it lines up
        // with the rate table: package price (+ Express fee) plus whole
        // $150 extra photos. Anything else is left as a note only.
        const pkg = packageKey(row.package_label);
        const info = pkg ? PACKAGE_INFO[pkg] : undefined;
        const expressFee =
          row.delivery_type === "EXPRESS" ? EXPRESS_FEE : 0;
        let favoritesCount: number | null = null;
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
              row.session_date != null &&
              c.sessionDate === row.session_date,
          ) ??
          candidates.find((c) => {
            const ref = c.sessionDate ?? c.deliveredAt;
            return ref != null && ref.startsWith(args.month);
          }) ??
          candidates.find((c) => c.sessionDate == null);
        if (match) {
          const patch: Partial<SessionRow> = { updatedAt: new Date() };
          if (row.session_date != null) patch.sessionDate = row.session_date;
          if (row.package_label != null)
            patch.packageLabel = row.package_label;
          if (row.delivery_type != null)
            patch.deliveryType = row.delivery_type;
          if (row.status != null) patch.status = row.status;
          if (row.amount_paid != null) {
            patch.chargesSettled = true;
            patch.unpaid = false;
            if (favoritesCount != null) {
              patch.favoritesChosen = true;
              patch.favoritesCount = favoritesCount;
            }
            if (paidNote && !(match.notes ?? "").includes(paidNote)) {
              patch.notes = match.notes
                ? `${match.notes} ${paidNote}`
                : paidNote;
            }
          }
          await db
            .update(schema.sessions)
            .set(patch)
            .where(eq(schema.sessions.id, match.id));
          updated++;
        } else {
          const inserted = await db
            .insert(schema.sessions)
            .values({
              clientName: row.client_name,
              status: row.status ?? "pendiente",
              sessionDate: row.session_date,
              deliveryDate: null,
              deliveryDateEstimated: false,
              deliveryType: row.delivery_type,
              packageLabel: cleanText(row.package_label),
              photoCount: null,
              favoritesChosen: favoritesCount != null,
              favoritesCount,
              driveUrl: null,
              uploadedAt: null,
              sent: false,
              chargesSettled: row.amount_paid != null,
              unpaid: false,
              notes: paidNote,
            })
            .returning({ id: schema.sessions.id });
          const newRow = inserted[0];
          if (newRow) {
            const key = statsNormalizeName(row.client_name);
            const list = byName.get(key) ?? [];
            list.push({
              id: newRow.id,
              clientName: row.client_name,
              sessionDate: row.session_date,
              deliveredAt: null,
              notes: paidNote,
            });
            byName.set(key, list);
          }
          created++;
        }
      }
      if (created + updated > 0) ctx.invalidateQueries();
      return { created, updated, rows: args.rows.length };
    },
  }),

  getSavings: defineAction({
    description:
      "Computes the studio's savings (ahorro) balance: every month with data generates its 5% from that month's finance table (the real close when the month has one, the board estimate otherwise — the current month updates live as its estimate moves), and the registered manual movements (abonos and retiros) raise or lower it. Returns the current balance, the generated total, the movement totals, the per-month generated amounts (newest first) and the registered movements (newest first).",
    request: z.object({}),
    response: savingsResponse,
    handler: async (ctx): Promise<z.infer<typeof savingsResponse>> => {
      const db = ctx.db<typeof schema>();
      const allSessions = await db.select().from(schema.sessions);
      const allExpenses = await db.select().from(schema.expenses);
      const allCloses = await db.select().from(schema.monthlyCloses);
      const closeByMonth = new Map(allCloses.map((c) => [c.month, c]));
      const currentMonth = currentMonthChihuahua();

      const months = new Set<string>();
      for (const row of allSessions) {
        const m = financeMonthOf(row, currentMonth);
        if (m) months.add(m);
      }
      for (const c of allCloses) months.add(c.month);

      const monthly: z.infer<typeof savingsResponse>["monthly"] = [];
      let generatedTotal = 0;
      for (const m of [...months].sort()) {
        const close = closeByMonth.get(m) ?? null;
        const figures = monthFigures(
          m,
          allSessions,
          allExpenses,
          close,
          currentMonth,
        );
        monthly.push({
          month: m,
          savings: figures.table.savings,
          is_actual: close?.actualSales != null,
        });
        generatedTotal += figures.table.savings;
      }
      generatedTotal = Math.round(generatedTotal * 100) / 100;

      const movementRows = await db
        .select()
        .from(schema.savingsMovements)
        .orderBy(desc(schema.savingsMovements.id));
      let depositsTotal = 0;
      let withdrawalsTotal = 0;
      for (const mv of movementRows) {
        if (mv.kind === "abono") depositsTotal += mv.amount;
        else withdrawalsTotal += mv.amount;
      }
      return {
        balance:
          Math.round(
            (generatedTotal + depositsTotal - withdrawalsTotal) * 100,
          ) / 100,
        generated_total: generatedTotal,
        deposits_total: depositsTotal,
        withdrawals_total: withdrawalsTotal,
        monthly: monthly.reverse(),
        movements: movementRows.map((mv) => ({
          id: mv.id,
          movement_date: mv.movementDate,
          kind: mv.kind,
          description: mv.description,
          amount: mv.amount,
        })),
      };
    },
  }),

  addSavingsMovement: defineAction({
    description:
      "Registers a manual savings movement: an abono (extra money put into the ahorro) or a retiro (money taken out of the ahorro, e.g. to pay an expense). The savings balance updates immediately.",
    request: z.object({
      kind: z.enum(["abono", "retiro"]),
      amount: z.number().int().min(1).max(10000000),
      description: z.string().trim().min(1).max(200),
      movement_date: dateString.nullable(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.savingsMovements)
        .values({
          kind: args.kind,
          amount: args.amount,
          description: args.description,
          movementDate: args.movement_date,
        })
        .returning({ id: schema.savingsMovements.id });
      const inserted = result[0];
      if (!inserted)
        throw new Error("addSavingsMovement: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  deleteSavingsMovement: defineAction({
    description:
      "Deletes one registered savings movement (abono or retiro); the balance updates immediately.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.savingsMovements)
        .where(eq(schema.savingsMovements.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
