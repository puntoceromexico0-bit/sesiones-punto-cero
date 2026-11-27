// Drizzle schema for this space.
//
// One row per Punto Cero photo session. The board mirrors the Monday.com
// "Sesiones Fotográficas" board: delivery dates come from that board (never
// computed from assignment dates), the entrega column is ESTANDAR or EXPRESS,
// and each row carries the client's editing-survey answers.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clientName: text("client_name").notNull(),
  // Workflow stage shown as a colored Monday-style status pill.
  // "no_show" = the client did not show up; the $200 booking fee is kept.
  status: text("status", {
    enum: ["pendiente", "en_edicion", "entregada", "no_show"],
  })
    .notNull()
    .default("pendiente"),
  // Date the session itself took place (or was scheduled), YYYY-MM-DD.
  // Finance groups a session's sale into the month of this date.
  sessionDate: text("session_date"),
  // Board delivery date, YYYY-MM-DD. Null = no board date known yet.
  deliveryDate: text("delivery_date"),
  // True when deliveryDate is an estimate, not a board date.
  deliveryDateEstimated: integer("delivery_date_estimated", { mode: "boolean" })
    .notNull()
    .default(false),
  // From the board's entrega column; null = unknown.
  deliveryType: text("delivery_type", { enum: ["ESTANDAR", "EXPRESS"] }),
  // Package label as used in the studio (p1, p2, p3, p4, paquete 5, ...).
  packageLabel: text("package_label"),
  // Count of RAW/CR3 files in the client's Drive folder; null = not counted.
  photoCount: integer("photo_count"),
  // True when the client has chosen favorites (Pixieset list exists).
  favoritesChosen: integer("favorites_chosen", { mode: "boolean" })
    .notNull()
    .default(false),
  // How many photos the client chose as favorites in Pixieset.
  favoritesCount: integer("favorites_count"),
  // Direct link to the client's folder in PUNTO CERO > FOTOGRAFÍA (Drive).
  driveUrl: text("drive_url"),
  // Date Daniela uploaded the client's folder to Drive, YYYY-MM-DD.
  // The delivery calculator counts business days from this date.
  uploadedAt: text("uploaded_at"),
  // True once the edited gallery has been sent to the client.
  sent: integer("sent", { mode: "boolean" }).notNull().default(false),
  // True once the client has paid the extra-photo / Express charges.
  chargesSettled: integer("charges_settled", { mode: "boolean" })
    .notNull()
    .default(false),
  // True when the client has NOT paid her session at all: the session's
  // full amount (package + extras + Express) stays out of the month's
  // sales and sits in por cobrar until she pays.
  unpaid: integer("unpaid", { mode: "boolean" }).notNull().default(false),
  // Editing survey (ENCUESTAS EDICIÓN CLIENTES) answers; null = no row yet.
  faceLevel: text("face_level"),
  bodyAdjustments: text("body_adjustments"),
  publishPermission: text("publish_permission", { enum: ["SI", "NO"] }),
  motive: text("motive"),
  doNotTouch: text("do_not_touch"),
  // Background color chosen in the survey (Rosa, Cocoa, Rojo, Blanco, Negro).
  backgroundColor: text("background_color"),
  // True when it is the client's first session at the studio.
  firstSession: integer("first_session", { mode: "boolean" }),
  // How the client found Punto Cero (Me recomendaron, Instagram, Facebook…).
  discoverySource: text("discovery_source"),
  notes: text("notes"),
  // Date the session was delivered, YYYY-MM-DD; null while pending.
  deliveredAt: text("delivered_at"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One expense row of the monthly sales sheet (VENTAS style).
export const expenses = sqliteTable("expenses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Month the expense belongs to, YYYY-MM.
  month: text("month").notNull(),
  // Date of the expense, YYYY-MM-DD; null when only the month is known.
  expenseDate: text("expense_date"),
  kind: text("kind", { enum: ["fijo", "variable"] }).notNull(),
  description: text("description").notNull(),
  amount: integer("amount").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Manual movements of the studio's savings (ahorro). The 5% each month
// generates is computed live from the finance tables, so this table only
// holds what the partners register by hand: abonos (extra money put into
// the savings) and retiros (money taken out of the savings, e.g. to pay
// an expense). Balance = generated 5% total + abonos − retiros.
export const savingsMovements = sqliteTable("savings_movements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["abono", "retiro"] }).notNull(),
  amount: integer("amount").notNull(),
  description: text("description").notNull(),
  // Date of the movement, YYYY-MM-DD; null when not specified.
  movementDate: text("movement_date"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per month: the registered estimate (from Leslye's own analysis)
// and Daniela's real close figures once her Excel arrives, so the board can
// compare estimate vs. real and say whether it matches.
export const monthlyCloses = sqliteTable("monthly_closes", {
  // YYYY-MM, primary key.
  month: text("month").primaryKey(),
  // Registered estimate of the month's sales (list prices), when Leslye has
  // provided one; null = the board's live-computed estimate is used alone.
  estimateSales: integer("estimate_sales"),
  // Projected sales for the remaining days of the month, when provided.
  projectedSales: integer("projected_sales"),
  // Real figures from Daniela's closing sheet; null until she passes them.
  actualSales: integer("actual_sales"),
  actualFixedCosts: integer("actual_fixed_costs"),
  actualVariableCosts: integer("actual_variable_costs"),
  // Month-close calculator (cierre sin Excel): how the real sales were
  // collected and what was deducted before the net split.
  // Cash part of the month's real sales.
  cashSales: integer("cash_sales"),
  // Bank-transfer part of the month's real sales.
  transferSales: integer("transfer_sales"),
  // Amount deducted from the month's sales (invoicing / facturación and
  // other agreed discounts) before computing the net.
  deductions: integer("deductions"),
  // JSON object with the count sold of each studio rate item in the
  // close (paquetes p1–p5, foto extra, sesión completa, video, Express,
  // persona extra, fondo extra, outfit extra, apartado). The real sales
  // total is the sum of counts × the studio's rate table.
  salesItems: text("sales_items"),
  notes: text("notes"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
