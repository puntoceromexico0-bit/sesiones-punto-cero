// Genera deploy/migrations/0002_seed.sql (INSERTs de PostgreSQL) a partir
// de la exportación JSON de los datos actuales del tablero
// (deploy/data/sessions.json, expenses.json, monthly_closes.json).
//
// Uso:  node deploy/scripts/generate-seed.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(name) {
  return JSON.parse(readFileSync(join(root, "data", name), "utf8"));
}

function lit(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}
const bool = (v) => (v ? "true" : "false");
const ts = (ms) =>
  ms == null ? "now()" : `'${new Date(ms).toISOString()}'::timestamptz`;

const sessions = load("sessions.json");
const expenses = load("expenses.json");
const closes = load("monthly_closes.json");

const out = [];
out.push(
  "-- Sesiones Punto Cero — datos actuales exportados del tablero",
  `-- Generado: ${new Date().toISOString()} · ${sessions.length} sesiones, ` +
    `${expenses.length} gastos, ${closes.length} cierres mensuales.`,
  "-- Ejecutar DESPUÉS de 0001_schema_postgres.sql. Es idempotente:",
  "-- borra el contenido previo de las tres tablas antes de insertar.",
  "",
  "BEGIN;",
  "TRUNCATE monthly_closes RESTART IDENTITY CASCADE;",
  "TRUNCATE expenses RESTART IDENTITY CASCADE;",
  "TRUNCATE sessions RESTART IDENTITY CASCADE;",
  "",
);

const sCols = [
  "id", "client_name", "status", "session_date", "delivery_date",
  "delivery_date_estimated", "delivery_type", "package_label", "photo_count",
  "favorites_chosen", "favorites_count", "drive_url", "uploaded_at", "sent",
  "charges_settled", "unpaid", "face_level", "body_adjustments",
  "publish_permission", "motive", "do_not_touch", "background_color",
  "first_session", "discovery_source", "notes", "delivered_at",
  "created_at", "updated_at",
];
out.push(`INSERT INTO sessions (${sCols.join(", ")}) VALUES`);
out.push(
  sessions
    .map((s) =>
      "  (" +
      [
        s.id,
        lit(s.client_name),
        lit(s.status),
        lit(s.session_date),
        lit(s.delivery_date),
        bool(s.delivery_date_estimated),
        lit(s.delivery_type),
        lit(s.package_label),
        lit(s.photo_count),
        bool(s.favorites_chosen),
        lit(s.favorites_count),
        lit(s.drive_url),
        lit(s.uploaded_at),
        bool(s.sent),
        bool(s.charges_settled),
        bool(s.unpaid),
        lit(s.face_level),
        lit(s.body_adjustments),
        lit(s.publish_permission),
        lit(s.motive),
        lit(s.do_not_touch),
        lit(s.background_color),
        s.first_session == null ? "NULL" : bool(s.first_session),
        lit(s.discovery_source),
        lit(s.notes),
        lit(s.delivered_at),
        ts(s.created_at),
        ts(s.updated_at),
      ].join(", ") +
      ")",
    )
    .join(",\n") + ";",
);
out.push("");

const eCols = ["id", "month", "expense_date", "kind", "description", "amount", "created_at"];
out.push(`INSERT INTO expenses (${eCols.join(", ")}) VALUES`);
out.push(
  expenses
    .map((e) =>
      "  (" +
      [e.id, lit(e.month), lit(e.expense_date), lit(e.kind), lit(e.description), e.amount, ts(e.created_at)].join(", ") +
      ")",
    )
    .join(",\n") + ";",
);
out.push("");

const cCols = [
  "month", "estimate_sales", "projected_sales", "actual_sales",
  "actual_fixed_costs", "actual_variable_costs", "notes", "updated_at",
];
out.push(`INSERT INTO monthly_closes (${cCols.join(", ")}) VALUES`);
out.push(
  closes
    .map((c) =>
      "  (" +
      [
        lit(c.month),
        lit(c.estimate_sales),
        lit(c.projected_sales),
        lit(c.actual_sales),
        lit(c.actual_fixed_costs),
        lit(c.actual_variable_costs),
        lit(c.notes),
        ts(c.updated_at),
      ].join(", ") +
      ")",
    )
    .join(",\n") + ";",
);
out.push(
  "",
  "SELECT setval(pg_get_serial_sequence('sessions', 'id'), (SELECT max(id) FROM sessions));",
  "SELECT setval(pg_get_serial_sequence('expenses', 'id'), (SELECT max(id) FROM expenses));",
  "",
  "COMMIT;",
  "",
);

const target = join(root, "migrations", "0002_seed.sql");
writeFileSync(target, out.join("\n"));
console.log(`Escrito ${target}`);
