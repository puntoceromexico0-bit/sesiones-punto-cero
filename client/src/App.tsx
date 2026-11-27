import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";
import logoLavanda from "./assets/logo-pc-lavanda.png";

const FIELDS = actionFields<typeof Actions>();

type Session = ApiResponse<typeof api, "listSessions">["sessions"][number];
type Status = Session["status"];

const STATUS_META: Record<
  Status,
  { label: string; color: string; softBg: string }
> = {
  pendiente: { label: "Pendiente", color: "#b97a12", softBg: "#fdf0d9" },
  en_edicion: { label: "En edición", color: "#1b1be0", softBg: "#e3e3fd" },
  entregada: { label: "Entregada", color: "#0a8a55", softBg: "#d9f5e7" },
  no_show: { label: "No-show", color: "#ffffff", softBg: "#17141f" },
};

const STATUS_ORDER: Status[] = [
  "pendiente",
  "en_edicion",
  "entregada",
  "no_show",
];

/* ---------- date helpers (plain calendar dates, local time) ---------- */

function parseDate(value: string): Date {
  const [y = 1970, m = 1, d = 1] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function todayStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function todayString(): string {
  return fmtDate(new Date());
}

function diffDays(value: string): number {
  return Math.round(
    (parseDate(value).getTime() - todayStart().getTime()) / 86_400_000,
  );
}

const dateFmt = new Intl.DateTimeFormat("es-MX", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

function formatDate(value: string): string {
  return dateFmt.format(parseDate(value));
}

function relativeLabel(value: string): string {
  const diff = diffDays(value);
  if (diff === 0) return "hoy";
  if (diff === 1) return "mañana";
  if (diff === -1) return "ayer";
  if (diff < 0) return `hace ${-diff} días`;
  return `en ${diff} días`;
}

/* ---------- business days: Mon–Sat, minus Mexican public holidays ---------- */

const holidayCache = new Map<number, Set<string>>();

function mexicanHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const set = new Set<string>();
  const nthMonday = (month: number, n: number): string => {
    const d = new Date(year, month, 1);
    let seen = 0;
    while (true) {
      if (d.getDay() === 1) {
        seen++;
        if (seen === n) return fmtDate(d);
      }
      d.setDate(d.getDate() + 1);
    }
  };
  set.add(`${year}-01-01`); // Año Nuevo
  set.add(nthMonday(1, 1)); // Constitución (primer lunes de febrero)
  set.add(nthMonday(2, 3)); // Natalicio de Benito Juárez (tercer lunes de marzo)
  set.add(`${year}-05-01`); // Día del Trabajo
  set.add(`${year}-09-16`); // Independencia
  set.add(nthMonday(10, 3)); // Revolución (tercer lunes de noviembre)
  set.add(`${year}-12-25`); // Navidad
  if ((year - 2018) % 6 === 0) set.add(`${year}-12-01`); // Transmisión del Poder Ejecutivo
  holidayCache.set(year, set);
  return set;
}

function isBusinessDay(value: string): boolean {
  const d = parseDate(value);
  if (d.getDay() === 0) return false; // Sundays never count
  return !mexicanHolidays(d.getFullYear()).has(value);
}

function addBusinessDays(start: string, count: number): string {
  const d = parseDate(start);
  let added = 0;
  while (added < count) {
    d.setDate(d.getDate() + 1);
    if (isBusinessDay(fmtDate(d))) added++;
  }
  return fmtDate(d);
}

/** Business days from today to the target date (target inclusive, today
 *  exclusive). Negative when the date has passed. */
function businessDaysUntil(target: string): number {
  const today = todayString();
  if (target === today) return 0;
  const forward = target > today;
  const from = forward ? today : target;
  const to = forward ? target : today;
  let count = 0;
  const d = parseDate(from);
  const end = parseDate(to);
  while (d < end) {
    d.setDate(d.getDate() + 1);
    if (isBusinessDay(fmtDate(d))) count++;
  }
  return forward ? count : -count;
}

/** Business hours (24 h per business day, Mon–Sat minus holidays) left
 *  between now and the end of the deadline date. */
function businessHoursRemaining(deadline: string): number {
  const now = new Date();
  const end = parseDate(deadline);
  end.setHours(23, 59, 59, 999);
  if (end.getTime() <= now.getTime()) return 0;
  let ms = 0;
  const cursor = new Date(now);
  while (cursor.getTime() < end.getTime()) {
    const nextMidnight = new Date(cursor);
    nextMidnight.setHours(24, 0, 0, 0);
    const segmentEnd = Math.min(nextMidnight.getTime(), end.getTime());
    if (isBusinessDay(fmtDate(cursor))) ms += segmentEnd - cursor.getTime();
    cursor.setTime(segmentEnd);
  }
  return Math.floor(ms / 3_600_000);
}

/* ---------- delivery dates: board date wins, calculator is the estimate ---------- */

function calculatedDelivery(s: Session): string | null {
  if (!s.uploaded_at) return null;
  return addBusinessDays(s.uploaded_at, s.delivery_type === "EXPRESS" ? 3 : 15);
}

type EffectiveDelivery = {
  date: string;
  kind: "tablero" | "estimada" | "calculada";
};

function effectiveDelivery(s: Session): EffectiveDelivery | null {
  if (s.delivery_date)
    return {
      date: s.delivery_date,
      kind: s.delivery_date_estimated ? "estimada" : "tablero",
    };
  const calc = calculatedDelivery(s);
  if (calc) return { date: calc, kind: "calculada" };
  return null;
}

/* ---------- traffic light ---------- */

type Urgency = {
  level: "green" | "yellow" | "red" | "overdue";
  label: string;
};

function urgencyOf(s: Session): Urgency | null {
  if (s.status === "entregada" || s.status === "no_show") return null;
  const eff = effectiveDelivery(s);
  if (!eff) return null;
  const bd = businessDaysUntil(eff.date);
  if (bd < 0) return { level: "overdue", label: "¡Vencida!" };
  if (bd === 0) return { level: "red", label: "Vence hoy" };
  if (bd === 1) return { level: "red", label: "Vence mañana" };
  if (bd <= 3)
    return { level: "yellow", label: `Quedan ${bd} días hábiles` };
  return { level: "green", label: `Quedan ${bd} días hábiles` };
}

const URGENCY_COLORS: Record<Urgency["level"], string> = {
  green: "#0a8a55",
  yellow: "#c78f0a",
  red: "#d92b4a",
  overdue: "#d92b4a",
};

/* ---------- package reference (from Punto Cero's price cards) ---------- */

const PACKAGES = [
  { key: "p1", label: "Paquete 1", price: 870, minutes: 20, photos: 5 },
  { key: "p2", label: "Paquete 2", price: 1100, minutes: 25, photos: 8 },
  { key: "p3", label: "Paquete 3", price: 1335, minutes: 30, photos: 10 },
  { key: "p4", label: "Paquete 4", price: 1560, minutes: 35, photos: 12 },
  { key: "p5", label: "Paquete 5", price: 1910, minutes: 40, photos: 15 },
] as const;

/* Every rate the close calculator can add up: the five packages plus all
   the studio's extras (July 2026 price table). Keys match the server's
   rate catalog. */
const SALE_ITEMS = [
  { key: "p1", label: "Paquete 1", price: 870 },
  { key: "p2", label: "Paquete 2", price: 1100 },
  { key: "p3", label: "Paquete 3", price: 1335 },
  { key: "p4", label: "Paquete 4", price: 1560 },
  { key: "p5", label: "Paquete 5", price: 1910 },
  { key: "foto_extra", label: "Foto extra", price: 150 },
  { key: "sesion_completa", label: "Sesión completa", price: 350 },
  { key: "video", label: "Video de sesión", price: 199 },
  { key: "express", label: "Express", price: 399 },
  { key: "persona_extra", label: "Persona extra", price: 200 },
  { key: "fondo_extra", label: "Fondo extra", price: 150 },
  { key: "outfit_extra", label: "Outfit extra", price: 105 },
  { key: "apartado", label: "Apartado", price: 200 },
] as const;

type SaleItemKey = (typeof SALE_ITEMS)[number]["key"];

function matchPackage(label: string | null | undefined) {
  if (!label) return null;
  const normalized = label.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    PACKAGES.find(
      (p) =>
        normalized === p.key ||
        normalized === p.label.toLowerCase() ||
        normalized === `paquete ${p.key.slice(1)}`,
    ) ?? null
  );
}

function money(n: number): string {
  return `$${n.toLocaleString("es-MX")}`;
}

/* Extra photos: the client pays $150 per photo chosen beyond what her
   package includes (July 2026 price table: p1 5, p2 8, p3 10, p4 12,
   p5 15 — the printed cards said 16 for p5, still to confirm, so the
   table's 15 is what the comparison uses). */
const EXTRA_PHOTO_PRICE = 150;
const INCLUDED_PHOTOS: Record<string, number> = {
  p1: 5,
  p2: 8,
  p3: 10,
  p4: 12,
  p5: 15,
};

function extraPhotos(s: {
  package_label: string | null;
  favorites_count: number | null;
  photo_count: number | null;
}): { count: number; charge: number } | null {
  const pkg = matchPackage(s.package_label);
  if (!pkg) return null;
  const included = INCLUDED_PHOTOS[pkg.key];
  if (included == null) return null;
  const chosen = s.favorites_count ?? s.photo_count;
  if (chosen == null || chosen <= included) return null;
  const count = chosen - included;
  return { count, charge: count * EXTRA_PHOTO_PRICE };
}

const BACKGROUND_COLORS = ["Rosa", "Cocoa", "Rojo", "Blanco", "Negro"];
const DISCOVERY_SOURCES = ["Me recomendaron", "Instagram", "Facebook", "Otro"];

/* ---------- form state ---------- */

type FormState = {
  client_name: string;
  status: Status;
  session_date: string;
  delivery_date: string;
  delivery_date_estimated: boolean;
  delivery_type: "" | "ESTANDAR" | "EXPRESS";
  package_label: string;
  photo_count: string;
  favorites_chosen: boolean;
  favorites_count: string;
  drive_url: string;
  uploaded_at: string;
  sent: boolean;
  charges_settled: boolean;
  unpaid: boolean;
  face_level: string;
  body_adjustments: string;
  publish_permission: "" | "SI" | "NO";
  motive: string;
  do_not_touch: string;
  background_color: string;
  first_session: "" | "SI" | "NO";
  discovery_source: string;
  notes: string;
  delivered_at: string;
};

function emptyForm(): FormState {
  return {
    client_name: "",
    status: "pendiente",
    session_date: "",
    delivery_date: "",
    delivery_date_estimated: false,
    delivery_type: "",
    package_label: "",
    photo_count: "",
    favorites_chosen: false,
    favorites_count: "",
    drive_url: "",
    uploaded_at: "",
    sent: false,
    charges_settled: false,
    unpaid: false,
    face_level: "",
    body_adjustments: "",
    publish_permission: "",
    motive: "",
    do_not_touch: "",
    background_color: "",
    first_session: "",
    discovery_source: "",
    notes: "",
    delivered_at: "",
  };
}

function formFromSession(s: Session): FormState {
  return {
    client_name: s.client_name,
    status: s.status,
    session_date: s.session_date ?? "",
    delivery_date: s.delivery_date ?? "",
    delivery_date_estimated: s.delivery_date_estimated,
    delivery_type: s.delivery_type ?? "",
    package_label: s.package_label ?? "",
    photo_count: s.photo_count != null ? String(s.photo_count) : "",
    favorites_chosen: s.favorites_chosen,
    favorites_count: s.favorites_count != null ? String(s.favorites_count) : "",
    drive_url: s.drive_url ?? "",
    uploaded_at: s.uploaded_at ?? "",
    sent: s.sent,
    charges_settled: s.charges_settled,
    unpaid: s.unpaid,
    face_level: s.face_level ?? "",
    body_adjustments: s.body_adjustments ?? "",
    publish_permission: s.publish_permission ?? "",
    motive: s.motive ?? "",
    do_not_touch: s.do_not_touch ?? "",
    background_color: s.background_color ?? "",
    first_session:
      s.first_session == null ? "" : s.first_session ? "SI" : "NO",
    discovery_source: s.discovery_source ?? "",
    notes: s.notes ?? "",
    delivered_at: s.delivered_at ?? "",
  };
}

function formPayload(form: FormState) {
  const photos = form.photo_count.trim();
  const favs = form.favorites_count.trim();
  return {
    status: form.status,
    session_date: form.session_date || null,
    delivery_date: form.delivery_date || null,
    delivery_date_estimated: form.delivery_date
      ? form.delivery_date_estimated
      : false,
    delivery_type: form.delivery_type || null,
    package_label: form.package_label || null,
    photo_count: photos === "" ? null : Number(photos),
    favorites_chosen: form.favorites_chosen,
    favorites_count: favs === "" ? null : Number(favs),
    drive_url: form.drive_url || null,
    uploaded_at: form.uploaded_at || null,
    sent: form.sent,
    charges_settled: form.charges_settled,
    unpaid: form.unpaid,
    face_level: form.face_level || null,
    body_adjustments: form.body_adjustments || null,
    publish_permission: form.publish_permission || null,
    motive: form.motive || null,
    do_not_touch: form.do_not_touch || null,
    background_color: form.background_color || null,
    first_session:
      form.first_session === "" ? null : form.first_session === "SI",
    discovery_source: form.discovery_source || null,
    notes: form.notes || null,
    delivered_at:
      form.status === "entregada"
        ? form.delivered_at || todayString()
        : null,
  };
}

function hasSurvey(s: Session): boolean {
  return Boolean(
    s.face_level ||
      s.body_adjustments ||
      s.publish_permission ||
      s.motive ||
      s.do_not_touch ||
      s.background_color ||
      s.first_session != null ||
      s.discovery_source,
  );
}

/* ---------- status pill ---------- */

function StatusPill({
  status,
  onPick,
  disabled,
}: {
  status: Status;
  onPick: (status: Status) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[status];
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Estado: ${meta.label}. Cambiar estado`}
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold whitespace-nowrap"
        style={{ backgroundColor: meta.softBg, color: meta.color }}
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: meta.color }}
        />
        {meta.label}
        <span aria-hidden="true" className="text-[10px]">▾</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Cerrar menú de estado"
            className="fixed inset-0 z-10 cursor-default"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-solid)] shadow-lg">
            {STATUS_ORDER.map((st) => (
              <button
                key={st}
                type="button"
                aria-label={`Marcar como ${STATUS_META[st].label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  onPick(st);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-[var(--text)]"
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: STATUS_META[st].color }}
                />
                {STATUS_META[st].label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- per-client checklist ---------- */

type ProgressPatch = {
  uploaded_at?: string | null;
  favorites_chosen?: boolean;
  status?: Status;
  sent?: boolean;
  delivered_at?: string | null;
};

function Checklist({
  session,
  onProgress,
  busy,
}: {
  session: Session;
  onProgress: (patch: ProgressPatch) => void;
  busy: boolean;
}) {
  const s = session;
  const steps: {
    key: string;
    label: string;
    done: boolean;
    toggle: () => void;
  }[] = [
    {
      key: "carpeta",
      label: "Carpeta subida",
      done: s.uploaded_at != null || s.drive_url != null,
      toggle: () =>
        onProgress({
          uploaded_at: s.uploaded_at != null ? null : todayString(),
        }),
    },
    {
      key: "favoritas",
      label: "Favoritas elegidas",
      done: s.favorites_chosen,
      toggle: () => onProgress({ favorites_chosen: !s.favorites_chosen }),
    },
    {
      key: "editando",
      label: "Editando",
      done: s.status === "en_edicion" || s.status === "entregada",
      toggle: () =>
        onProgress({
          status: s.status === "en_edicion" ? "pendiente" : "en_edicion",
        }),
    },
    {
      key: "enviada",
      label: "Subida",
      done: s.sent,
      toggle: () => onProgress({ sent: !s.sent }),
    },
    {
      key: "entregada",
      label: "Entregada",
      done: s.status === "entregada",
      toggle: () =>
        s.status === "entregada"
          ? onProgress({ status: "en_edicion", delivered_at: null })
          : onProgress({ status: "entregada", delivered_at: todayString() }),
    },
  ];

  return (
    <div
      className="mt-3 flex items-start"
      role="group"
      aria-label={`Avance de la sesión de ${s.client_name}`}
      onClick={(e) => e.stopPropagation()}
    >
      {steps.map((step, i) => (
        <div key={step.key} className="flex flex-1 items-start last:flex-none">
          <button
            type="button"
            disabled={busy}
            aria-label={`${step.label}: ${step.done ? "hecho" : "pendiente"}. Tocar para ${step.done ? "desmarcar" : "marcar"}`}
            aria-pressed={step.done}
            onClick={step.toggle}
            className="flex w-12 flex-col items-center gap-1 disabled:opacity-60"
          >
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full border-2 text-[11px] font-extrabold ${
                step.done
                  ? "border-[#1b1be0] bg-[#1b1be0] text-white"
                  : "border-[#b9b0d9] bg-white text-transparent"
              }`}
            >
              ✓
            </span>
            <span
              className={`text-center text-[10px] leading-tight font-semibold ${
                step.done ? "text-[#1b1be0]" : "text-[var(--dim)]"
              }`}
            >
              {step.label}
            </span>
          </button>
          {i < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={`mt-3 h-0.5 min-w-2 flex-1 rounded ${
                step.done ? "bg-[#1b1be0]" : "bg-[#ddd3f5]"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------- session card ---------- */

function SessionCard({
  session,
  onOpen,
  onStatus,
  onProgress,
  busy,
}: {
  session: Session;
  onOpen: () => void;
  onStatus: (status: Status) => void;
  onProgress: (patch: ProgressPatch) => void;
  busy: boolean;
}) {
  const s = session;
  const delivered = s.status === "entregada";
  const eff = effectiveDelivery(s);
  const urg = urgencyOf(s);
  const readyToEdit = s.favorites_chosen && s.status === "pendiente";
  const extras = extraPhotos(s);
  const expressHours =
    s.delivery_type === "EXPRESS" && !delivered && eff
      ? businessHoursRemaining(eff.date)
      : null;

  return (
    <article
      className="glass cursor-pointer rounded-3xl p-3.5 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-display min-w-0 text-base leading-snug font-bold text-[var(--text)]">
          {s.drive_url ? (
            <a
              href={s.drive_url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Abrir la carpeta de Drive de ${s.client_name}`}
              onClick={(e) => e.stopPropagation()}
              className="underline decoration-[#1b1be0] decoration-2 underline-offset-2"
            >
              {s.client_name}
            </a>
          ) : (
            s.client_name
          )}
          {s.package_label && (
            <span className="ml-2 align-middle text-xs font-semibold text-[var(--dim)]">
              {s.package_label}
            </span>
          )}
        </h3>
        <div onClick={(e) => e.stopPropagation()}>
          <StatusPill status={s.status} onPick={onStatus} disabled={busy} />
        </div>
      </div>

      {s.publish_permission === "NO" && (
        <p className="mt-2 flex items-center gap-1.5 rounded-xl bg-[#d92b4a] px-2.5 py-1.5 text-xs font-extrabold tracking-wide text-white">
          NO PUBLICAR — esta clienta no autorizó publicar sus fotos
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {s.delivery_type === "EXPRESS" && (
          <span className="rounded-md bg-[#d92b4a] px-2 py-0.5 text-[11px] font-extrabold tracking-wide text-white">
            EXPRESS
            {expressHours != null &&
              (expressHours > 0
                ? ` · quedan ${expressHours} h hábiles`
                : " · tiempo cumplido")}
          </span>
        )}
        {s.delivery_type === "ESTANDAR" && (
          <span className="rounded-md bg-[var(--surface-alt)] px-2 py-0.5 text-[11px] font-bold text-[var(--dim)]">
            Estándar
          </span>
        )}
        {readyToEdit && (
          <span className="rounded-md bg-[#0a8a55] px-2 py-0.5 text-[11px] font-extrabold tracking-wide text-white">
            Lista para editar
          </span>
        )}
        {urg && urg.level === "overdue" ? (
          <span className="rounded-md bg-[#17141f] px-2 py-0.5 text-[11px] font-extrabold tracking-wide text-white">
            {urg.label}
          </span>
        ) : urg ? (
          <span
            className="flex items-center gap-1 text-xs font-bold"
            style={{ color: URGENCY_COLORS[urg.level] }}
          >
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: URGENCY_COLORS[urg.level] }}
            />
            {urg.label}
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-sm">
        {delivered ? (
          <span className="font-medium text-[var(--dim)]">
            Entregada {s.delivered_at ? `el ${formatDate(s.delivered_at)}` : ""}
          </span>
        ) : eff ? (
          <span className="font-semibold text-[var(--text)]">
            Entrega: {formatDate(eff.date)} · {relativeLabel(eff.date)}
            {eff.kind === "calculada" && (
              <span className="ml-1.5 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--dim)]">
                fecha calculada
              </span>
            )}
            {eff.kind === "estimada" && (
              <span className="ml-1.5 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--dim)]">
                fecha estimada
              </span>
            )}
            {eff.kind === "tablero" && (
              <span className="ml-1.5 rounded bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--dim)]">
                fecha del tablero
              </span>
            )}
          </span>
        ) : (
          <span className="font-medium text-[var(--dim)]">
            Sin fecha de entrega
            {s.uploaded_at == null && " · falta la fecha de subida"}
          </span>
        )}
      </p>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-[var(--dim)]">
        {s.photo_count != null && (
          <span>
            {s.photo_count} {s.photo_count === 1 ? "foto" : "fotos"} en Drive
          </span>
        )}
        {s.favorites_chosen && (
          <span className="font-medium text-[#0a8a55]">
            {s.favorites_count != null
              ? `Eligió ${s.favorites_count} favoritas`
              : "Favoritos elegidos ✓"}
          </span>
        )}
        {extras && (
          <span className="rounded-md bg-[#7b5cd6] px-2 py-0.5 font-bold text-white">
            {extras.count} foto{extras.count === 1 ? "" : "s"} extra · cargo +
            {money(extras.charge)}
          </span>
        )}
        {s.publish_permission === "SI" && <span>✓ Puede publicarse</span>}
        {s.uploaded_at && !delivered && (
          <span>Carpeta subida el {formatDate(s.uploaded_at)}</span>
        )}
      </div>

      {hasSurvey(s) && (
        <p className="mt-1.5 text-sm text-[var(--text)]">
          {[
            s.face_level && `Retoque: ${s.face_level}`,
            s.body_adjustments && `Cuerpo: ${s.body_adjustments}`,
            s.background_color && `Fondo: ${s.background_color}`,
            s.motive && `Motivo: ${s.motive}`,
            s.do_not_touch && `No tocar: ${s.do_not_touch}`,
            s.first_session != null &&
              (s.first_session ? "Primera sesión" : "Ya es clienta"),
            s.discovery_source && `Llegó por: ${s.discovery_source}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {!hasSurvey(s) && !delivered && (
        <p className="mt-1.5 text-xs text-[var(--dim)] italic">
          Sin respuestas de la encuesta de edición
        </p>
      )}
      {s.notes && (
        <p className="mt-1 text-sm [overflow-wrap:anywhere] text-[var(--dim)]">
          {s.notes}
        </p>
      )}

      <Checklist session={s} onProgress={onProgress} busy={busy} />
    </article>
  );
}

/* ---------- packages reference panel ---------- */

function PackagesPanel() {
  return (
    <section
      aria-label="Paquetes de Punto Cero"
      className="glass-soft mt-4 rounded-3xl p-4 text-white"
    >
      <h2 className="font-display text-base font-bold tracking-wide">
        Paquetes · Fotografía de estudio
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {PACKAGES.map((p) => (
          <div
            key={p.key}
            className="rounded-2xl border border-white/30 bg-white/10 px-3 py-2.5"
          >
            <p className="font-display text-sm font-bold">{p.label}</p>
            <p className="mt-0.5 text-xs text-white/85">
              {p.minutes} min · {p.photos} fotos editadas
            </p>
            <p className="font-display mt-1 text-lg leading-none font-bold">
              {money(p.price)}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-white/85">
        Entrega estándar: 15 días hábiles desde la subida de la carpeta ·
        Entrega Express (72 h hábiles): +$399 · Apartado de fecha: $200
      </p>
    </section>
  );
}

/* ---------- editor sheet ---------- */

const inputClass =
  "w-full rounded-xl border border-[#cfc8e8] bg-white px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[#1b1be0]";
const labelClass =
  "block text-xs font-bold tracking-wide text-[var(--dim)] uppercase";

function EditorSheet({
  initial,
  sessionId,
  onClose,
}: {
  initial: FormState;
  sessionId: number | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(initial);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["sessions"] });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        client_name: form.client_name.trim(),
        ...formPayload(form),
      };
      return sessionId != null
        ? await api.updateSession({ id: sessionId, ...payload })
        : await api.createSession(payload);
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: () =>
      setSaveError("No se pudo guardar. Revisa los datos e inténtalo de nuevo."),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (sessionId == null) throw new Error("Sin sesión");
      return await api.deleteSession({ id: sessionId });
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: () => setSaveError("No se pudo eliminar la sesión."),
  });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const pkg = matchPackage(form.package_label);
  const calcPreview = form.uploaded_at
    ? addBusinessDays(
        form.uploaded_at,
        form.delivery_type === "EXPRESS" ? 3 : 15,
      )
    : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-[#14083f]/60 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={sessionId != null ? "Editar sesión" : "Nueva sesión"}
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-[#f6f2fc] p-4 pb-6 shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold text-[var(--text)]">
            {sessionId != null ? "Editar sesión" : "Nueva sesión"}
          </h2>
          <button
            type="button"
            aria-label="Cerrar editor"
            onClick={onClose}
            className="rounded-full bg-white px-3 py-1 text-sm font-bold text-[var(--dim)]"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="f-name" className={labelClass}>
              Cliente
            </label>
            <input
              id="f-name"
              {...FIELDS.updateSession.client_name}
              className={inputClass}
              value={form.client_name}
              onChange={(e) => {
                set("client_name", e.target.value);
                setNameError(null);
              }}
              placeholder="Nombre de la clienta o cliente"
            />
            {nameError && (
              <p className="mt-1 text-sm font-medium text-[#d92b4a]">
                {nameError}
              </p>
            )}
          </div>

          <div>
            <span className={labelClass}>Estado</span>
            <div className="mt-1 grid grid-cols-4 gap-1 rounded-2xl bg-white p-1">
              {STATUS_ORDER.map((st) => (
                <button
                  key={st}
                  type="button"
                  aria-label={`Estado ${STATUS_META[st].label}`}
                  aria-pressed={form.status === st}
                  onClick={() => set("status", st)}
                  className="rounded-xl px-1 py-1.5 text-[13px] font-bold"
                  style={
                    form.status === st
                      ? {
                          backgroundColor: STATUS_META[st].softBg,
                          color: STATUS_META[st].color,
                        }
                      : { color: "var(--dim)" }
                  }
                >
                  {STATUS_META[st].label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="f-session-date" className={labelClass}>
              Fecha de la sesión
            </label>
            <input
              id="f-session-date"
              type="date"
              className={inputClass}
              value={form.session_date}
              onChange={(e) => set("session_date", e.target.value)}
            />
            {form.status === "no_show" ? (
              <p className="mt-1.5 text-xs text-[var(--dim)]">
                No-show: la clienta no asistió y se queda el apartado de $200.
                La sesión sale del tablero y el apartado se suma en Finanzas.
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-[var(--dim)]">
                Con esta fecha la venta se cuenta en su mes en Finanzas.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="f-uploaded" className={labelClass}>
                Subida de la carpeta
              </label>
              <input
                id="f-uploaded"
                type="date"
                className={inputClass}
                value={form.uploaded_at}
                onChange={(e) => set("uploaded_at", e.target.value)}
              />
              {calcPreview && (
                <p className="mt-1.5 text-xs text-[var(--dim)]">
                  Entrega calculada:{" "}
                  <strong className="text-[var(--text)]">
                    {formatDate(calcPreview)}
                  </strong>{" "}
                  ({form.delivery_type === "EXPRESS" ? "3" : "15"} días
                  hábiles)
                </p>
              )}
            </div>
            <div>
              <label htmlFor="f-type" className={labelClass}>
                Tipo de entrega
              </label>
              <select
                id="f-type"
                className={inputClass}
                value={form.delivery_type}
                onChange={(e) =>
                  set(
                    "delivery_type",
                    e.target.value as FormState["delivery_type"],
                  )
                }
              >
                <option value="">Sin dato</option>
                <option value="ESTANDAR">Estándar</option>
                <option value="EXPRESS">Express</option>
              </select>
              {form.delivery_type === "EXPRESS" && (
                <p className="mt-1.5 text-xs text-[var(--dim)]">
                  Express: 72 h hábiles desde la subida (+$399).
                </p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="f-delivery" className={labelClass}>
              Fecha de entrega del tablero (Monday)
            </label>
            <input
              id="f-delivery"
              type="date"
              className={inputClass}
              value={form.delivery_date}
              onChange={(e) => set("delivery_date", e.target.value)}
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4">
              <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#1b1be0]"
                  checked={form.delivery_date_estimated}
                  onChange={(e) =>
                    set("delivery_date_estimated", e.target.checked)
                  }
                />
                Es una fecha estimada
              </label>
              <p className="text-xs text-[var(--dim)]">
                Si el tablero trae fecha, esa manda sobre la calculada.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="f-package" className={labelClass}>
                Paquete
              </label>
              <input
                id="f-package"
                {...FIELDS.updateSession.package_label}
                className={inputClass}
                value={form.package_label}
                onChange={(e) => set("package_label", e.target.value)}
                placeholder="p1, p2, p3…"
                list="package-options"
              />
              <datalist id="package-options">
                {PACKAGES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label} · {money(p.price)}
                  </option>
                ))}
              </datalist>
              {pkg && (
                <p className="mt-1.5 text-xs text-[var(--dim)]">
                  {pkg.label}: {money(pkg.price)} · {pkg.minutes} min ·{" "}
                  {pkg.photos} fotos editadas
                </p>
              )}
            </div>
            <div>
              <label htmlFor="f-photos" className={labelClass}>
                Fotos en Drive (RAW)
              </label>
              <input
                id="f-photos"
                {...FIELDS.updateSession.photo_count}
                type="number"
                inputMode="numeric"
                className={inputClass}
                value={form.photo_count}
                onChange={(e) => set("photo_count", e.target.value)}
                placeholder="Sin contar"
              />
            </div>
          </div>

          <div>
            <label htmlFor="f-drive" className={labelClass}>
              Enlace a su carpeta de Drive
            </label>
            <input
              id="f-drive"
              {...FIELDS.updateSession.drive_url}
              type="url"
              inputMode="url"
              className={inputClass}
              value={form.drive_url}
              onChange={(e) => set("drive_url", e.target.value)}
              placeholder="https://drive.google.com/drive/folders/…"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium text-[var(--text)]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#1b1be0]"
                checked={form.favorites_chosen}
                onChange={(e) => set("favorites_chosen", e.target.checked)}
              />
              Ya eligió sus favoritas
            </label>
            <div>
              <label htmlFor="f-favcount" className={labelClass}>
                ¿Cuántas favoritas?
              </label>
              <input
                id="f-favcount"
                {...FIELDS.updateSession.favorites_count}
                type="number"
                inputMode="numeric"
                className={inputClass}
                value={form.favorites_count}
                onChange={(e) => set("favorites_count", e.target.value)}
                placeholder="Ej. 35"
              />
              {(() => {
                const ex = extraPhotos({
                  package_label: form.package_label || null,
                  favorites_count:
                    form.favorites_count.trim() === ""
                      ? null
                      : Number(form.favorites_count),
                  photo_count:
                    form.photo_count.trim() === ""
                      ? null
                      : Number(form.photo_count),
                });
                return ex ? (
                  <p className="mt-1.5 text-xs font-semibold text-[#7b5cd6]">
                    {ex.count} foto{ex.count === 1 ? "" : "s"} extra sobre el
                    paquete · cargo +{money(ex.charge)}
                  </p>
                ) : null;
              })()}
            </div>
          </div>

          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium text-[var(--text)]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[#1b1be0]"
              checked={form.sent}
              onChange={(e) => set("sent", e.target.checked)}
            />
            Galería ya enviada a la clienta
          </label>

          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium text-[var(--text)]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[#1b1be0]"
              checked={form.charges_settled}
              onChange={(e) => set("charges_settled", e.target.checked)}
            />
            Ya pagó sus cargos extra (fotos extra / Express)
          </label>

          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium text-[var(--text)]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[#d92b4a]"
              checked={form.unpaid}
              onChange={(e) => set("unpaid", e.target.checked)}
            />
            No ha pagado su sesión (su total va a por cobrar, no a ventas)
          </label>

          <fieldset className="rounded-2xl border border-[#ddd3f5] bg-white/70 p-3">
            <legend className="px-1 text-xs font-bold tracking-wide text-[var(--dim)] uppercase">
              Encuesta de edición
            </legend>
            <div className="space-y-3">
              <div>
                <label htmlFor="f-face" className={labelClass}>
                  Nivel de retoque facial
                </label>
                <input
                  id="f-face"
                  {...FIELDS.updateSession.face_level}
                  className={inputClass}
                  value={form.face_level}
                  onChange={(e) => set("face_level", e.target.value)}
                  placeholder="Ligera, Avanzada, Porcelana…"
                  list="face-options"
                />
                <datalist id="face-options">
                  <option value="Ligera" />
                  <option value="Avanzada" />
                  <option value="Definición Premium Porcelana" />
                  <option value="Retoque Estético" />
                </datalist>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="f-body" className={labelClass}>
                    Ajustes de cuerpo
                  </label>
                  <input
                    id="f-body"
                    {...FIELDS.updateSession.body_adjustments}
                    className={inputClass}
                    value={form.body_adjustments}
                    onChange={(e) => set("body_adjustments", e.target.value)}
                    placeholder="Ajustes ligeros…"
                  />
                </div>
                <div>
                  <label htmlFor="f-bg" className={labelClass}>
                    Color de fondo
                  </label>
                  <select
                    id="f-bg"
                    className={inputClass}
                    value={form.background_color}
                    onChange={(e) => set("background_color", e.target.value)}
                  >
                    <option value="">Sin dato</option>
                    {BACKGROUND_COLORS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                    {form.background_color &&
                      !BACKGROUND_COLORS.includes(form.background_color) && (
                        <option value={form.background_color}>
                          {form.background_color}
                        </option>
                      )}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="f-publish" className={labelClass}>
                    ¿Publicar sus fotos?
                  </label>
                  <select
                    id="f-publish"
                    className={inputClass}
                    value={form.publish_permission}
                    onChange={(e) =>
                      set(
                        "publish_permission",
                        e.target.value as FormState["publish_permission"],
                      )
                    }
                  >
                    <option value="">Sin dato</option>
                    <option value="SI">Sí</option>
                    <option value="NO">No</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="f-motive" className={labelClass}>
                    Motivo de la sesión
                  </label>
                  <input
                    id="f-motive"
                    {...FIELDS.updateSession.motive}
                    className={inputClass}
                    value={form.motive}
                    onChange={(e) => set("motive", e.target.value)}
                    placeholder="Personal, cumpleaños…"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="f-donttouch" className={labelClass}>
                  Que no se toque
                </label>
                <input
                  id="f-donttouch"
                  {...FIELDS.updateSession.do_not_touch}
                  className={inputClass}
                  value={form.do_not_touch}
                  onChange={(e) => set("do_not_touch", e.target.value)}
                  placeholder="Nada en especial…"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="f-first" className={labelClass}>
                    ¿Es su primera sesión?
                  </label>
                  <select
                    id="f-first"
                    className={inputClass}
                    value={form.first_session}
                    onChange={(e) =>
                      set(
                        "first_session",
                        e.target.value as FormState["first_session"],
                      )
                    }
                  >
                    <option value="">Sin dato</option>
                    <option value="SI">Sí, es la primera</option>
                    <option value="NO">No, ya es clienta</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="f-source" className={labelClass}>
                    ¿Cómo conoció Punto Cero?
                  </label>
                  <select
                    id="f-source"
                    className={inputClass}
                    value={form.discovery_source}
                    onChange={(e) => set("discovery_source", e.target.value)}
                  >
                    <option value="">Sin dato</option>
                    {DISCOVERY_SOURCES.map((src) => (
                      <option key={src} value={src}>
                        {src}
                      </option>
                    ))}
                    {form.discovery_source &&
                      !DISCOVERY_SOURCES.includes(form.discovery_source) && (
                        <option value={form.discovery_source}>
                          {form.discovery_source}
                        </option>
                      )}
                  </select>
                </div>
              </div>
            </div>
          </fieldset>

          <div>
            <label htmlFor="f-notes" className={labelClass}>
              Notas
            </label>
            <textarea
              id="f-notes"
              {...FIELDS.updateSession.notes}
              className={`${inputClass} min-h-16`}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Cualquier detalle de la sesión…"
            />
          </div>

          {form.status === "entregada" && (
            <div>
              <label htmlFor="f-delivered" className={labelClass}>
                Fecha en que se entregó
              </label>
              <input
                id="f-delivered"
                type="date"
                className={inputClass}
                value={form.delivered_at}
                onChange={(e) => set("delivered_at", e.target.value)}
              />
            </div>
          )}
        </div>

        {saveError && (
          <p className="mt-3 text-sm font-medium text-[#d92b4a]">{saveError}</p>
        )}

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            aria-label="Guardar sesión"
            disabled={save.isPending}
            onClick={() => {
              if (!form.client_name.trim()) {
                setNameError("Escribe el nombre de la clienta o cliente.");
                return;
              }
              save.mutate();
            }}
            className="flex-1 rounded-2xl bg-[#1b1be0] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
          >
            {save.isPending ? "Guardando…" : "Guardar"}
          </button>
          <button
            type="button"
            aria-label="Cancelar"
            onClick={onClose}
            className="rounded-2xl bg-white px-4 py-2.5 text-sm font-bold text-[var(--dim)]"
          >
            Cancelar
          </button>
        </div>

        {sessionId != null && (
          <div className="mt-4 border-t border-[#ddd3f5] pt-3">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-sm font-medium text-[#d92b4a]">
                  ¿Eliminar esta sesión del tablero?
                </p>
                <button
                  type="button"
                  aria-label="Confirmar eliminar sesión"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                  className="rounded-xl bg-[#d92b4a] px-3 py-1.5 text-sm font-bold text-white disabled:opacity-60"
                >
                  Sí, eliminar
                </button>
                <button
                  type="button"
                  aria-label="No eliminar"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-xl bg-white px-3 py-1.5 text-sm font-bold text-[var(--dim)]"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label="Eliminar sesión"
                onClick={() => setConfirmDelete(true)}
                className="text-sm font-bold text-[#d92b4a]"
              >
                Eliminar sesión
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- finance helpers ---------- */

function money2(n: number): string {
  return `$${n.toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const monthLongFmt = new Intl.DateTimeFormat("es-MX", {
  month: "long",
  year: "numeric",
});

function monthLabel(month: string): string {
  const [y = 1970, m = 1] = month.split("-").map(Number);
  const label = monthLongFmt.format(new Date(y, m - 1, 1));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function shiftMonth(month: string, delta: number): string {
  const [y = 1970, m = 1] = month.split("-").map(Number);
  return fmtDate(new Date(y, m - 1 + delta, 1)).slice(0, 7);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob(["\ufeff" + content], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

/* ---------- client message templates ---------- */

type TemplateKey = "confirmacion" | "recordatorio" | "entrega" | "cobro";

const TEMPLATES: { key: TemplateKey; label: string }[] = [
  { key: "confirmacion", label: "Confirmación de sesión" },
  { key: "recordatorio", label: "Recordatorio" },
  { key: "entrega", label: "Aviso de entrega de galería" },
  { key: "cobro", label: "Cobro de fotos extra" },
];

function buildMessage(key: TemplateKey, s: Session): string | null {
  const name = firstName(s.client_name);
  const pkg = matchPackage(s.package_label);
  if (key === "confirmacion") {
    const detail = pkg
      ? ` Tu sesión es el ${pkg.label} (${pkg.photos} fotos editadas, ${pkg.minutes} min) por ${money(pkg.price)}.`
      : "";
    return `¡Hola, ${name}! Te confirmamos tu sesión de fotos en Punto Cero.${detail} Para apartar tu fecha pedimos un anticipo de $200. ¡Gracias por confiar en nosotras!`;
  }
  if (key === "recordatorio") {
    const when = s.session_date
      ? ` el ${formatDate(s.session_date)}`
      : "";
    return `¡Hola, ${name}! Te recordamos tu sesión de fotos en Punto Cero${when}. Te esperamos en el estudio; si necesitas reagendar, avísanos con tiempo, por favor. ¡Gracias!`;
  }
  if (key === "entrega") {
    const link = s.drive_url
      ? ` Puedes ver y descargar tus fotos en tu carpeta: ${s.drive_url}`
      : "";
    return `¡Hola, ${name}! Tu galería de Punto Cero ya está lista.${link} Esperamos que te encanten tus fotos. ¡Gracias por tu confianza!`;
  }
  // cobro
  const extras = extraPhotos(s);
  const expressFee = s.delivery_type === "EXPRESS" ? 399 : 0;
  const sessionBase = s.unpaid && pkg ? pkg.price : 0;
  if (!extras && expressFee === 0 && sessionBase === 0) return null;
  const parts: string[] = [];
  if (sessionBase > 0)
    parts.push(
      `el pago de tu sesión (${pkg?.label}) sigue pendiente (${money(sessionBase)})`,
    );
  if (extras)
    parts.push(
      `elegiste ${extras.count} foto${extras.count === 1 ? "" : "s"} extra además de las de tu paquete (${money(150)} cada una = ${money(extras.charge)})`,
    );
  if (expressFee > 0) parts.push(`tu entrega fue Express (${money(expressFee)})`);
  const total = sessionBase + (extras?.charge ?? 0) + expressFee;
  return `¡Hola, ${name}! De tu sesión en Punto Cero, ${parts.join(" y ")}. El total por cobrar es de ${money(total)}. ¡Muchas gracias!`;
}

/* ---------- finance view ---------- */

const finLabelClass =
  "block text-xs font-bold tracking-wide text-[var(--dim)] uppercase";
const finInputClass =
  "w-full rounded-xl border border-[#cfc8e8] bg-white px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[#1b1be0]";

/* ---------- sales spreadsheet import (Excel) ---------- */

type ImportFieldKey =
  | "client_name"
  | "session_date"
  | "package_label"
  | "amount_paid"
  | "delivery_type"
  | "status";

const IMPORT_FIELDS: {
  key: ImportFieldKey;
  label: string;
  required?: boolean;
  hints: string[];
}[] = [
  { key: "client_name", label: "Clienta", required: true, hints: ["clienta", "cliente", "nombre"] },
  { key: "session_date", label: "Fecha de la sesión", hints: ["fecha"] },
  { key: "package_label", label: "Paquete", hints: ["paquete"] },
  {
    key: "amount_paid",
    label: "Cuánto pagó",
    hints: ["pago", "pagó", "monto", "total", "importe", "precio", "cobro", "cantidad", "venta"],
  },
  { key: "delivery_type", label: "Tipo de entrega", hints: ["entrega", "express", "tipo"] },
  { key: "status", label: "Estado", hints: ["estado", "estatus"] },
];

function normalizeHeader(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return fmtDate(value);
  return String(value).trim();
}

function cellDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return fmtDate(value);
  if (typeof value === "number" && value > 20000 && value < 90000) {
    // Excel serial date (days since 1899-12-30).
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  }
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  return null;
}

function cellAmount(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number")
    return Number.isFinite(value) ? Math.round(value) : null;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

type ImportRowPayload = {
  client_name: string;
  session_date: string | null;
  package_label: string | null;
  amount_paid: number | null;
  delivery_type: "ESTANDAR" | "EXPRESS" | null;
  status: Status | null;
};

function ExcelImportCard({ month }: { month: string }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<{
    headers: string[];
    rows: unknown[][];
  } | null>(null);
  const [mapping, setMapping] = useState<Record<ImportFieldKey, number>>({
    client_name: -1,
    session_date: -1,
    package_label: -1,
    amount_paid: -1,
    delivery_type: -1,
    status: -1,
  });
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setFileError(null);
    setResult(null);
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array", cellDates: true });
      const wsName = wb.SheetNames[0];
      if (!wsName) throw new Error("sin hojas");
      const ws = wb.Sheets[wsName];
      if (!ws) throw new Error("sin hoja");
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
        header: 1,
        defval: null,
        raw: true,
      });
      const firstData = aoa.findIndex((r) =>
        r.some((c) => cellText(c) !== ""),
      );
      if (firstData < 0) throw new Error("hoja vacía");
      const headers = (aoa[firstData] ?? []).map((c, i) => {
        const t = cellText(c);
        return t === "" ? `Columna ${i + 1}` : t;
      });
      const rows = aoa
        .slice(firstData + 1)
        .filter((r) => r.some((c) => cellText(c) !== ""));
      if (rows.length === 0) throw new Error("sin renglones");
      const guessed = { ...mapping };
      for (const field of IMPORT_FIELDS) {
        const idx = headers.findIndex((h) => {
          const n = normalizeHeader(h);
          return field.hints.some((hint) => n.includes(normalizeHeader(hint)));
        });
        guessed[field.key] = idx;
      }
      setMapping(guessed);
      setSheet({ headers, rows });
    } catch {
      setSheet(null);
      setFileError(
        "No se pudo leer ese archivo. Que sea un Excel (.xlsx, .xls) o .csv con una fila de encabezados.",
      );
    }
  };

  const builtRows = useMemo<ImportRowPayload[]>(() => {
    if (!sheet || mapping.client_name < 0) return [];
    const cell = (row: unknown[], key: ImportFieldKey): unknown =>
      mapping[key] >= 0 ? row[mapping[key]] : null;
    const out: ImportRowPayload[] = [];
    for (const row of sheet.rows) {
      const name = cellText(cell(row, "client_name"));
      if (name === "") continue;
      const typeText = normalizeHeader(cellText(cell(row, "delivery_type")));
      const statusText = normalizeHeader(cellText(cell(row, "status")));
      out.push({
        client_name: name.slice(0, 120),
        session_date: cellDate(cell(row, "session_date")),
        package_label: cellText(cell(row, "package_label")).slice(0, 40) || null,
        amount_paid: cellAmount(cell(row, "amount_paid")),
        delivery_type: typeText.includes("express")
          ? "EXPRESS"
          : typeText.includes("estandar")
            ? "ESTANDAR"
            : null,
        status: statusText.includes("entreg")
          ? "entregada"
          : statusText.includes("no-show") ||
              statusText.includes("no show") ||
              statusText.includes("no asist")
            ? "no_show"
            : statusText.includes("edici")
              ? "en_edicion"
              : statusText.includes("pendient")
                ? "pendiente"
                : null,
      });
      if (out.length >= 500) break;
    }
    return out;
  }, [sheet, mapping]);

  const importMutation = useMutation({
    mutationFn: async () =>
      await api.importSalesRows({ month, rows: builtRows }),
    onSuccess: (res) => {
      setResult(
        `Listo: se cargaron ${res.rows} renglones — ${res.created} sesiones nuevas y ${res.updated} actualizadas en ${monthLabel(month)}.`,
      );
      setSheet(null);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["finance"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: () =>
      setFileError("No se pudieron cargar los datos. Revisa el acomodo de columnas e inténtalo de nuevo."),
  });

  return (
    <section
      aria-label="Cargar hoja de ventas desde Excel"
      className="glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
    >
      <h3 className="font-display text-base font-bold text-[var(--text)]">
        Cargar la hoja de ventas (Excel)
      </h3>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Sube el archivo del mes con las clientas, sus sesiones y cuánto
        pagaron: el tablero lo lee y acomoda los datos solo. Si las
        columnas de la hoja no coinciden exacto, en el siguiente paso tú
        eliges qué columna es cada dato. Las clientas que ya están en el
        tablero se actualizan, no se duplican.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        aria-label="Elegir archivo Excel de ventas"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Cargar Excel de ventas"
        onClick={() => fileRef.current?.click()}
        className="mt-3 rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white"
      >
        Cargar Excel de ventas
      </button>
      {fileError && (
        <p className="mt-2 rounded-xl bg-[#fde3e8] px-3 py-2 text-sm font-semibold text-[#a11230]">
          {fileError}
        </p>
      )}
      {result && (
        <p className="mt-2 rounded-xl bg-[#d9f5e7] px-3 py-2 text-sm font-semibold text-[#0a6b41]">
          {result}
        </p>
      )}

      {sheet && (
        <div className="mt-3 border-t border-[#ddd3f5] pt-3">
          <p className="text-sm font-bold text-[var(--text)]">
            Acomoda las columnas
          </p>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            La hoja trae {sheet.rows.length} renglones. Indica qué columna
            de la hoja es cada dato del tablero; lo que no venga, déjalo en
            «No viene en la hoja».
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {IMPORT_FIELDS.map((field) => (
              <label
                key={field.key}
                className="block text-xs font-bold text-[var(--dim)]"
              >
                {field.label}
                {field.required ? " *" : ""}
                <select
                  aria-label={`Columna de la hoja para ${field.label}`}
                  value={mapping[field.key]}
                  onChange={(e) =>
                    setMapping((m) => ({
                      ...m,
                      [field.key]: Number(e.target.value),
                    }))
                  }
                  className="mt-1 w-full rounded-xl border border-[#ddd3f5] bg-white px-2 py-1.5 text-sm font-semibold text-[var(--text)]"
                >
                  <option value={-1}>No viene en la hoja</option>
                  {sheet.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {mapping.client_name < 0 ? (
            <p className="mt-2 text-sm font-semibold text-[#a11230]">
              Elige la columna de la clienta para poder cargar.
            </p>
          ) : (
            <>
              <p className="mt-3 text-sm font-semibold text-[var(--text)]">
                {builtRows.length} renglones listos para cargar en{" "}
                {monthLabel(month)}
              </p>
              {builtRows.length > 0 && (
                <div className="mt-1 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#ddd3f5] text-left text-[11px] tracking-wide text-[var(--dim)] uppercase">
                        <th scope="col" className="py-1.5 pr-2 font-bold">Clienta</th>
                        <th scope="col" className="py-1.5 pr-2 font-bold">Fecha</th>
                        <th scope="col" className="py-1.5 pr-2 font-bold">Paquete</th>
                        <th scope="col" className="py-1.5 pr-2 text-right font-bold">Pagó</th>
                        <th scope="col" className="py-1.5 font-bold">Entrega</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#e7e0f7]">
                      {builtRows.slice(0, 5).map((r, i) => (
                        <tr key={i}>
                          <td className="py-1.5 pr-2 font-semibold text-[var(--text)]">
                            {r.client_name}
                          </td>
                          <td className="py-1.5 pr-2 text-[var(--text)]">
                            {r.session_date ? formatDate(r.session_date) : "—"}
                          </td>
                          <td className="py-1.5 pr-2 text-[var(--text)]">
                            {r.package_label ?? "—"}
                          </td>
                          <td className="py-1.5 pr-2 text-right text-[var(--text)]">
                            {r.amount_paid != null ? money(r.amount_paid) : "—"}
                          </td>
                          <td className="py-1.5 text-[var(--text)]">
                            {r.delivery_type === "EXPRESS"
                              ? "Express"
                              : r.delivery_type === "ESTANDAR"
                                ? "Estándar"
                                : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {builtRows.length > 5 && (
                    <p className="mt-1 text-xs text-[var(--dim)]">
                      …y {builtRows.length - 5} renglones más.
                    </p>
                  )}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label="Cargar los datos de la hoja al tablero"
                  disabled={builtRows.length === 0 || importMutation.isPending}
                  onClick={() => importMutation.mutate()}
                  className="rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  {importMutation.isPending
                    ? "Cargando…"
                    : "Cargar al tablero"}
                </button>
                <button
                  type="button"
                  aria-label="Cancelar la carga del Excel"
                  onClick={() => setSheet(null)}
                  className="rounded-xl border border-[#ddd3f5] bg-white px-4 py-2 text-sm font-bold text-[var(--text)]"
                >
                  Cancelar
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function FinanceView({
  sessions,
  month,
  onMonthChange,
}: {
  sessions: Session[];
  month: string;
  onMonthChange: (month: string) => void;
}) {
  const queryClient = useQueryClient();
  const finQuery = useQuery({
    queryKey: ["finance", month],
    queryFn: () => api.getMonthFinance({ month }),
  });
  const fin = finQuery.data;

  const invalidateFinance = () => {
    queryClient.invalidateQueries({ queryKey: ["finance"] });
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
  };

  type CalcForm = {
    counts: Record<SaleItemKey, string>;
    cash_sales: string;
    transfer_sales: string;
    deductions: string;
    estimate_sales: string;
    projected_sales: string;
    notes: string;
  };
  const [calcForm, setCalcForm] = useState<CalcForm | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [finError, setFinError] = useState<string | null>(null);

  const saveCalc = useMutation({
    mutationFn: async () => {
      if (!calcForm) throw new Error("Sin formulario");
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      const counts = Object.fromEntries(
        SALE_ITEMS.map((it) => {
          const n = Number(calcForm.counts[it.key]);
          return [it.key, Number.isFinite(n) && n > 0 ? Math.floor(n) : 0];
        }),
      ) as Record<SaleItemKey, number>;
      return await api.saveMonthCloseCalculator({
        month,
        counts,
        cash_sales: num(calcForm.cash_sales),
        transfer_sales: num(calcForm.transfer_sales),
        deductions: num(calcForm.deductions),
        estimate_sales: num(calcForm.estimate_sales),
        projected_sales: num(calcForm.projected_sales),
        notes: calcForm.notes || null,
      });
    },
    onSuccess: () => {
      invalidateFinance();
      setCalcForm(null);
      setCalcError(null);
    },
    onError: () =>
      setCalcError("No se pudo guardar el cierre. Revisa las cifras."),
  });

  // Opens the close calculator: with the items already saved when the
  // month has a calculator close, otherwise prefilled from what the
  // board knows about the month (packages sold, extra photos, Express
  // fees and no-show deposits), ready to adjust by hand.
  const openCalculator = () => {
    if (!fin) return;
    const counts = Object.fromEntries(
      SALE_ITEMS.map((it) => [it.key, ""]),
    ) as Record<SaleItemKey, string>;
    if (fin.close.sales_items.length > 0) {
      for (const item of fin.close.sales_items) {
        if (item.key in counts)
          counts[item.key as SaleItemKey] = String(item.count);
      }
    } else {
      for (const bp of fin.computed.by_package) {
        if (bp.package in counts)
          counts[bp.package as SaleItemKey] = String(bp.count);
      }
      counts.foto_extra = String(
        Math.round(fin.computed.extras_total / EXTRA_PHOTO_PRICE),
      );
      counts.express = String(Math.round(fin.computed.express_total / 399));
      counts.apartado = String(fin.computed.no_show_count);
    }
    setCalcError(null);
    setCalcForm({
      counts,
      cash_sales:
        fin.close.cash_sales != null ? String(fin.close.cash_sales) : "",
      transfer_sales:
        fin.close.transfer_sales != null
          ? String(fin.close.transfer_sales)
          : "",
      deductions:
        fin.close.deductions != null ? String(fin.close.deductions) : "",
      estimate_sales:
        fin.close.estimate_sales != null
          ? String(fin.close.estimate_sales)
          : "",
      projected_sales:
        fin.close.projected_sales != null
          ? String(fin.close.projected_sales)
          : "",
      notes: fin.close.notes ?? "",
    });
  };

  const settle = useMutation({
    mutationFn: async (args: { id: number; settled: boolean }) =>
      await api.setChargesSettled(args),
    onSuccess: invalidateFinance,
    onError: () => setFinError("No se pudo actualizar el cobro."),
  });

  const [expenseForm, setExpenseForm] = useState({
    description: "",
    amount: "",
    kind: "variable" as "fijo" | "variable",
    date: "",
  });
  const [expenseError, setExpenseError] = useState<string | null>(null);
  const addExpense = useMutation({
    mutationFn: async () =>
      await api.addExpense({
        month,
        expense_date: expenseForm.date || null,
        kind: expenseForm.kind,
        description: expenseForm.description.trim(),
        amount: Number(expenseForm.amount),
      }),
    onSuccess: () => {
      invalidateFinance();
      setExpenseForm({ description: "", amount: "", kind: "variable", date: "" });
      setExpenseError(null);
    },
    onError: () => setExpenseError("No se pudo agregar el gasto."),
  });
  const deleteExpense = useMutation({
    mutationFn: async (id: number) => await api.deleteExpense({ id }),
    onSuccess: invalidateFinance,
    onError: () => setFinError("No se pudo eliminar el gasto."),
  });

  const [template, setTemplate] = useState<TemplateKey>("confirmacion");
  const [msgClientId, setMsgClientId] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const noShows = useMemo(
    () => sessions.filter((s) => s.status === "no_show"),
    [sessions],
  );

  const msgSession =
    sessions.find((s) => s.id === msgClientId) ?? sessions[0] ?? null;
  const message =
    msgSession != null ? buildMessage(template, msgSession) : null;

  // Live math of the close calculator, recomputed on every keystroke:
  // items total − the month's costs (from the expense register, the same
  // figures the server will save) − deductions = net, then 5% savings
  // and the 50/50 split.
  const calcCount = (key: SaleItemKey): number => {
    if (!calcForm) return 0;
    const n = Number(calcForm.counts[key]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const calcAmount = (v: string): number => {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : 0;
  };
  const calcItemsTotal = calcForm
    ? SALE_ITEMS.reduce((sum, it) => sum + calcCount(it.key) * it.price, 0)
    : 0;
  const calcCollected = calcForm
    ? calcAmount(calcForm.cash_sales) + calcAmount(calcForm.transfer_sales)
    : 0;
  const calcDeductions = calcForm ? calcAmount(calcForm.deductions) : 0;
  const calcFixed = fin
    ? fin.fixed_costs.reduce((sum, c) => sum + c.amount, 0)
    : 0;
  const calcVariable = fin ? fin.variable_total : 0;
  const calcNet = calcItemsTotal - calcFixed - calcVariable - calcDeductions;
  const calcSavings = Math.round(calcNet * 0.05 * 100) / 100;
  const calcEach = Math.round((calcNet - calcSavings) * 0.5 * 100) / 100;
  const calcVsEstimate = fin
    ? calcItemsTotal - fin.estimate_with_projection
    : 0;

  const monthReport = fin
    ? [
        `Punto Cero — Cierre de ${monthLabel(month)}`,
        `Ventas: ${money2(fin.table.sales)}${fin.table.sales_is_actual ? " (cierre real)" : " (estimado)"}`,
        ...(fin.close.cash_sales != null || fin.close.transfer_sales != null
          ? [
              `Cobrado: ${[
                fin.close.cash_sales != null &&
                  `efectivo ${money2(fin.close.cash_sales)}`,
                fin.close.transfer_sales != null &&
                  `transferencias ${money2(fin.close.transfer_sales)}`,
              ]
                .filter(Boolean)
                .join(" · ")}`,
            ]
          : []),
        `Gastos fijos: ${money2(fin.table.fixed)}`,
        `Gastos variables: ${money2(fin.table.variable)}`,
        ...(fin.table.deductions > 0
          ? [`Deducciones: ${money2(fin.table.deductions)}`]
          : []),
        `Ventas netas: ${money2(fin.table.net)}`,
        `Ahorro (5%): ${money2(fin.table.savings)}`,
        `Reparto 50/50: ${money2(fin.table.each)} para cada una`,
      ].join("\n")
    : "";

  const downloadCsv = () => {
    if (!fin) return;
    const rows: (string | number)[][] = [
      [`Punto Cero — Ventas de ${monthLabel(month)}`],
      [],
      ["VENTAS"],
      ...(fin.close.sales_items.length > 0
        ? fin.close.sales_items.map(
            (i) =>
              [`${i.label} x${i.count}`, i.amount] as (string | number)[],
          )
        : [
            ...fin.computed.by_package.map((bp) => {
              const p = PACKAGES.find((x) => x.key === bp.package);
              return [
                `${p?.label ?? bp.package} x${bp.count}`,
                bp.amount,
              ] as (string | number)[];
            }),
            ["Fotos extra", fin.computed.extras_total] as (string | number)[],
            ["Express", fin.computed.express_total] as (string | number)[],
            [
              `Apartados por no-show (${fin.computed.no_show_count})`,
              fin.computed.no_show_total,
            ] as (string | number)[],
          ]),
      [
        fin.table.sales_is_actual ? "Ventas totales (cierre real)" : "Ventas totales (estimado)",
        fin.table.sales,
      ],
      ...(fin.close.cash_sales != null
        ? [["En efectivo", fin.close.cash_sales] as (string | number)[]]
        : []),
      ...(fin.close.transfer_sales != null
        ? [
            ["En transferencias", fin.close.transfer_sales] as (
              | string
              | number
            )[],
          ]
        : []),
      [],
      ["GASTOS FIJOS"],
      ...fin.fixed_costs.map(
        (c) => [c.label, c.amount] as (string | number)[],
      ),
      ["Total gastos fijos", fin.table.fixed],
      [],
      ["GASTOS VARIABLES"],
      ...fin.expenses
        .filter((e) => e.kind === "variable")
        .map((e) => [e.description, e.amount] as (string | number)[]),
      ["Total gastos variables", fin.table.variable],
      ...(fin.table.deductions > 0
        ? [[], ["Deducciones", fin.table.deductions]] as (string | number)[][]
        : []),
      [],
      ["Ventas netas", fin.table.net],
      ["Ahorro (5%)", fin.table.savings],
      ["Reparto (50% c/u)", fin.table.each],
    ];
    downloadTextFile(
      `ventas-${month}.csv`,
      rows.map((r) => r.map(csvCell).join(";")).join("\n"),
    );
  };

  return (
    <div className="mt-4 space-y-4">
      {/* Month navigation */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label="Mes anterior"
          onClick={() => onMonthChange(shiftMonth(month, -1))}
          className="glass-soft rounded-full px-3.5 py-1.5 text-sm font-bold text-white"
        >
          ←
        </button>
        <h2 className="font-display text-lg font-bold text-white">
          {monthLabel(month)}
        </h2>
        <button
          type="button"
          aria-label="Mes siguiente"
          onClick={() => onMonthChange(shiftMonth(month, 1))}
          className="glass-soft rounded-full px-3.5 py-1.5 text-sm font-bold text-white"
        >
          →
        </button>
      </div>

      {finError && (
        <p className="rounded-2xl bg-[#d92b4a] px-3 py-2 text-sm font-bold text-white">
          {finError}
        </p>
      )}

      <ExcelImportCard month={month} />
      {finQuery.isPending && (
        <p className="py-8 text-center text-sm font-medium text-white/85">
          Cargando finanzas…
        </p>
      )}
      {finQuery.isError && (
        <div className="glass rounded-3xl p-4 text-center">
          <p className="text-sm font-medium text-[var(--text)]">
            No se pudieron cargar las finanzas.
          </p>
          <button
            type="button"
            aria-label="Reintentar cargar finanzas"
            onClick={() => finQuery.refetch()}
            className="mt-2 rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white"
          >
            Reintentar
          </button>
        </div>
      )}

      {fin && (
        <>
          {/* Cierre del mes */}
          <section
            aria-label="Cierre del mes"
            className="glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
          >
            <h3 className="font-display text-base font-bold text-[var(--text)]">
              Cierre del mes
            </h3>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
              <p className="font-display text-3xl leading-none font-bold text-[var(--text)]">
                {money(fin.estimate_with_projection)}
              </p>
              <p className="text-xs font-semibold text-[var(--dim)]">
                estimado de ventas del mes
              </p>
            </div>
            <div className="mt-2 space-y-1 text-sm text-[var(--text)]">
              {fin.close.estimate_sales != null ? (
                <p>
                  Estimado registrado: {money(fin.close.estimate_sales)}
                  {fin.close.projected_sales != null &&
                    ` · proyección de fin de mes: +${money(fin.close.projected_sales)}`}
                </p>
              ) : (
                <p>
                  Paquetes {money(fin.computed.base_total)} · fotos extra{" "}
                  {money(fin.computed.extras_total)} · Express{" "}
                  {money(fin.computed.express_total)} · apartados no-show{" "}
                  {money(fin.computed.no_show_total)}
                </p>
              )}
              {fin.close.estimate_sales != null && (
                <p className="text-[var(--dim)]">
                  Con las sesiones registradas en el tablero hoy se calculan{" "}
                  {money(fin.computed.total)} ({fin.computed.sessions_count}{" "}
                  sesiones del mes).
                </p>
              )}
              {fin.close.notes && (
                <p className="text-[var(--dim)]">{fin.close.notes}</p>
              )}
            </div>

            <div className="mt-3 border-t border-[#ddd3f5] pt-3">
              {fin.close.actual_sales != null ? (
                <div className="text-sm">
                  <p className="text-[var(--text)]">
                    Cierre real:{" "}
                    <strong>{money(fin.close.actual_sales)}</strong>
                    {fin.close.actual_fixed_costs != null &&
                      ` · fijos ${money(fin.close.actual_fixed_costs)}`}
                    {fin.close.actual_variable_costs != null &&
                      ` · variables ${money(fin.close.actual_variable_costs)}`}
                  </p>
                  {fin.close.sales_items.length > 0 && (
                    <p className="mt-1 text-[var(--dim)]">
                      {fin.close.sales_items
                        .map((i) => `${i.label} ×${i.count}`)
                        .join(" · ")}
                    </p>
                  )}
                  {(fin.close.cash_sales != null ||
                    fin.close.transfer_sales != null) && (
                    <p className="mt-1 text-[var(--dim)]">
                      Cobrado:{" "}
                      {[
                        fin.close.cash_sales != null &&
                          `efectivo ${money(fin.close.cash_sales)}`,
                        fin.close.transfer_sales != null &&
                          `transferencias ${money(fin.close.transfer_sales)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  {fin.close.deductions != null &&
                    fin.close.deductions > 0 && (
                      <p className="mt-1 text-[var(--dim)]">
                        Deducciones: {money(fin.close.deductions)}
                      </p>
                    )}
                  {fin.matches ? (
                    <p className="mt-1 font-bold text-[#0a8a55]">
                      ✓ Cuadra con el estimado
                    </p>
                  ) : (
                    <p className="mt-1 font-bold text-[#b97a12]">
                      {fin.difference != null && fin.difference > 0
                        ? `El cierre real quedó ${money(fin.difference)} arriba del estimado`
                        : `El cierre real quedó ${money(Math.abs(fin.difference ?? 0))} abajo del estimado`}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-[var(--dim)]">
                  Todavía no se hace el cierre real del mes. Con la
                  calculadora lo armas aquí mismo, sin Excel: capturas las
                  partidas vendidas, cuánto fue en efectivo y en
                  transferencias y lo que hay que deducir; los gastos salen
                  de los registrados y el tablero calcula el neto y el
                  reparto.
                </p>
              )}
              {calcForm == null ? (
                <button
                  type="button"
                  aria-label="Abrir la calculadora de cierre del mes"
                  onClick={openCalculator}
                  className="mt-2 rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white"
                >
                  {fin.close.actual_sales != null
                    ? "Editar cierre"
                    : "Hacer el cierre del mes"}
                </button>
              ) : (
                <div className="mt-2 space-y-4">
                  <div>
                    <h4 className="font-display text-sm font-bold text-[var(--text)]">
                      1 · Ventas por partidas
                    </h4>
                    <p className="mt-0.5 text-xs text-[var(--dim)]">
                      Escribe cuántos se vendieron de cada uno. Ya viene
                      llenado con lo que el tablero sabe del mes; ajústalo
                      si hace falta.
                    </p>
                    <ul className="mt-2 divide-y divide-[#e7e0f7]">
                      {SALE_ITEMS.map((it) => (
                        <li
                          key={it.key}
                          className="flex items-center gap-2 py-1.5"
                        >
                          <span className="min-w-0 flex-1 text-sm text-[var(--text)]">
                            {it.label}
                            <span className="text-[var(--dim)]">
                              {" "}
                              · {money(it.price)}
                            </span>
                          </span>
                          <label
                            htmlFor={`calc-${it.key}`}
                            className="sr-only"
                          >
                            Cantidad de {it.label}
                          </label>
                          <input
                            id={`calc-${it.key}`}
                            {...FIELDS.saveMonthCloseCalculator.counts[it.key]}
                            type="number"
                            inputMode="numeric"
                            placeholder="0"
                            className="w-20 rounded-xl border border-[#cfc8e8] bg-white px-2 py-1.5 text-right text-sm text-[var(--text)] outline-none focus:border-[#1b1be0]"
                            value={calcForm.counts[it.key]}
                            onChange={(e) =>
                              setCalcForm({
                                ...calcForm,
                                counts: {
                                  ...calcForm.counts,
                                  [it.key]: e.target.value,
                                },
                              })
                            }
                          />
                          <span className="w-20 text-right font-display text-sm font-bold text-[var(--text)]">
                            {money(calcCount(it.key) * it.price)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 flex items-baseline justify-between text-sm font-bold text-[var(--text)]">
                      <span>Ventas totales</span>
                      <span className="font-display text-base">
                        {money(calcItemsTotal)}
                      </span>
                    </p>
                  </div>

                  <div>
                    <h4 className="font-display text-sm font-bold text-[var(--text)]">
                      2 · ¿Cómo se cobró?
                    </h4>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="calc-cash" className={finLabelClass}>
                          En efectivo
                        </label>
                        <input
                          id="calc-cash"
                          {...FIELDS.saveMonthCloseCalculator.cash_sales}
                          type="number"
                          inputMode="numeric"
                          className={finInputClass}
                          value={calcForm.cash_sales}
                          onChange={(e) =>
                            setCalcForm({
                              ...calcForm,
                              cash_sales: e.target.value,
                            })
                          }
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="calc-transfer"
                          className={finLabelClass}
                        >
                          En transferencias
                        </label>
                        <input
                          id="calc-transfer"
                          {...FIELDS.saveMonthCloseCalculator.transfer_sales}
                          type="number"
                          inputMode="numeric"
                          className={finInputClass}
                          value={calcForm.transfer_sales}
                          onChange={(e) =>
                            setCalcForm({
                              ...calcForm,
                              transfer_sales: e.target.value,
                            })
                          }
                        />
                      </div>
                    </div>
                    {(calcForm.cash_sales.trim() !== "" ||
                      calcForm.transfer_sales.trim() !== "") &&
                      (calcCollected === calcItemsTotal ? (
                        <p className="mt-2 text-sm font-bold text-[#0a8a55]">
                          ✓ Cuadra: efectivo + transferencias ={" "}
                          {money(calcCollected)}
                        </p>
                      ) : calcCollected < calcItemsTotal ? (
                        <p className="mt-2 text-sm font-bold text-[#b97a12]">
                          Cobrado {money(calcCollected)} · faltan{" "}
                          {money(calcItemsTotal - calcCollected)} para
                          cuadrar con las ventas
                        </p>
                      ) : (
                        <p className="mt-2 text-sm font-bold text-[#b97a12]">
                          Cobrado {money(calcCollected)} · sobran{" "}
                          {money(calcCollected - calcItemsTotal)} contra las
                          ventas
                        </p>
                      ))}
                  </div>

                  <div>
                    <h4 className="font-display text-sm font-bold text-[var(--text)]">
                      3 · Gastos y deducciones
                    </h4>
                    <dl className="mt-2 space-y-1 text-sm text-[var(--text)]">
                      <div className="flex items-baseline justify-between gap-2">
                        <dt>
                          Gastos fijos{" "}
                          <span className="text-xs text-[var(--dim)]">
                            {fin.fixed_costs_from_reference
                              ? "(referencia: renta, Adobe y Pixieset)"
                              : "(registrados este mes)"}
                          </span>
                        </dt>
                        <dd className="font-display">
                          − {money2(calcFixed)}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <dt>
                          Gastos variables{" "}
                          <span className="text-xs text-[var(--dim)]">
                            (registrados este mes)
                          </span>
                        </dt>
                        <dd className="font-display">
                          − {money2(calcVariable)}
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-1 text-xs text-[var(--dim)]">
                      Los gastos se toman solos de los registrados abajo;
                      no hay que volverlos a capturar.
                    </p>
                    <div className="mt-2">
                      <label
                        htmlFor="calc-deductions"
                        className={finLabelClass}
                      >
                        Deducciones (facturación y otros descuentos)
                      </label>
                      <input
                        id="calc-deductions"
                        {...FIELDS.saveMonthCloseCalculator.deductions}
                        type="number"
                        inputMode="numeric"
                        className={finInputClass}
                        value={calcForm.deductions}
                        onChange={(e) =>
                          setCalcForm({
                            ...calcForm,
                            deductions: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="rounded-2xl bg-white/70 p-3">
                    <h4 className="font-display text-sm font-bold text-[var(--text)]">
                      Así queda el cierre
                    </h4>
                    <dl className="mt-2 space-y-1.5 text-sm">
                      {[
                        ["Ventas", money2(calcItemsTotal)],
                        ["Gastos fijos", `− ${money2(calcFixed)}`],
                        ["Gastos variables", `− ${money2(calcVariable)}`],
                        ["Deducciones", `− ${money2(calcDeductions)}`],
                        ["Ventas netas", money2(calcNet)],
                        ["Ahorro (5%)", money2(calcSavings)],
                        ["Reparto (50% c/u)", money2(calcEach)],
                      ].map(([label, value], i) => (
                        <div
                          key={label}
                          className={`flex items-baseline justify-between gap-2 ${
                            i >= 4
                              ? "border-t border-[#ddd3f5] pt-1.5 font-bold text-[var(--text)]"
                              : "text-[var(--text)]"
                          }`}
                        >
                          <dt>{label}</dt>
                          <dd className="font-display">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 text-xs text-[var(--dim)]">
                      {calcVsEstimate === 0
                        ? "Las ventas quedan igual que el estimado del mes."
                        : calcVsEstimate > 0
                          ? `Las ventas quedan ${money(Math.abs(calcVsEstimate))} arriba del estimado del mes.`
                          : `Las ventas quedan ${money(Math.abs(calcVsEstimate))} abajo del estimado del mes.`}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="calc-est" className={finLabelClass}>
                        Estimado registrado
                      </label>
                      <input
                        id="calc-est"
                        {...FIELDS.saveMonthCloseCalculator.estimate_sales}
                        type="number"
                        inputMode="numeric"
                        className={finInputClass}
                        value={calcForm.estimate_sales}
                        onChange={(e) =>
                          setCalcForm({
                            ...calcForm,
                            estimate_sales: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <label htmlFor="calc-proj" className={finLabelClass}>
                        Proyección fin de mes
                      </label>
                      <input
                        id="calc-proj"
                        {...FIELDS.saveMonthCloseCalculator.projected_sales}
                        type="number"
                        inputMode="numeric"
                        className={finInputClass}
                        value={calcForm.projected_sales}
                        onChange={(e) =>
                          setCalcForm({
                            ...calcForm,
                            projected_sales: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="calc-notes" className={finLabelClass}>
                      Notas del cierre
                    </label>
                    <textarea
                      id="calc-notes"
                      {...FIELDS.saveMonthCloseCalculator.notes}
                      className={`${finInputClass} min-h-14`}
                      value={calcForm.notes}
                      onChange={(e) =>
                        setCalcForm({ ...calcForm, notes: e.target.value })
                      }
                    />
                  </div>
                  {calcError && (
                    <p className="text-sm font-medium text-[#d92b4a]">
                      {calcError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      aria-label="Guardar el cierre del mes"
                      disabled={saveCalc.isPending}
                      onClick={() => {
                        const moneyFields = [
                          calcForm.cash_sales,
                          calcForm.transfer_sales,
                          calcForm.deductions,
                          calcForm.estimate_sales,
                          calcForm.projected_sales,
                        ];
                        const badMoney = moneyFields.some(
                          (v) =>
                            v.trim() !== "" &&
                            (!Number.isFinite(Number(v)) || Number(v) < 0),
                        );
                        const badCount = SALE_ITEMS.some((it) => {
                          const v = calcForm.counts[it.key];
                          return (
                            v.trim() !== "" &&
                            (!Number.isFinite(Number(v)) || Number(v) < 0)
                          );
                        });
                        if (badMoney || badCount) {
                          setCalcError(
                            "Revisa las cifras: cantidades y montos deben ser números de cero en adelante.",
                          );
                          return;
                        }
                        setCalcError(null);
                        saveCalc.mutate();
                      }}
                      className="flex-1 rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
                    >
                      {saveCalc.isPending ? "Guardando…" : "Guardar cierre"}
                    </button>
                    <button
                      type="button"
                      aria-label="Cancelar la calculadora de cierre"
                      onClick={() => setCalcForm(null)}
                      className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-[var(--dim)]"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Por cobrar */}
          <section
            aria-label="Por cobrar"
            className="glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
          >
            <div className="flex flex-wrap items-baseline gap-x-3">
              <h3 className="font-display text-base font-bold text-[var(--text)]">
                Por cobrar
              </h3>
              <p className="font-display text-xl leading-none font-bold text-[var(--text)]">
                {money(fin.receivables_total)}
              </p>
            </div>
            {fin.receivables.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Nadie tiene pagos pendientes por ahora.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-[#e7e0f7]">
                {fin.receivables.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-[var(--text)]">
                        {r.client_name}
                      </p>
                      <p className="text-xs text-[var(--dim)]">
                        {[
                          r.base_charge > 0 &&
                            `Sesión sin pagar · ${money(r.base_charge)}`,
                          r.extras_charge > 0 &&
                            `${r.extras_count} foto${r.extras_count === 1 ? "" : "s"} extra · ${money(r.extras_charge)}`,
                          r.express_fee > 0 &&
                            `Express · ${money(r.express_fee)}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <span className="font-display text-sm font-bold text-[var(--text)]">
                      {money(r.total)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Marcar cobrado a ${r.client_name}`}
                      disabled={settle.isPending}
                      onClick={() =>
                        settle.mutate({ id: r.id, settled: true })
                      }
                      className="rounded-lg bg-[#0a8a55] px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                    >
                      Ya pagó
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Tabla del mes */}
          <section
            aria-label="Tabla de ventas del mes"
            className="glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-base font-bold text-[var(--text)]">
                Tabla del mes
              </h3>
              <button
                type="button"
                aria-label="Descargar la tabla del mes en CSV"
                onClick={downloadCsv}
                className="rounded-xl bg-[#1b1be0] px-3 py-1.5 text-xs font-bold text-white"
              >
                Descargar CSV
              </button>
            </div>
            <dl className="mt-2 space-y-1.5 text-sm">
              {[
                [
                  `Ventas (${fin.table.sales_is_actual ? "cierre real" : "estimado"})`,
                  money2(fin.table.sales),
                ],
                ["Gastos fijos", `− ${money2(fin.table.fixed)}`],
                ["Gastos variables", `− ${money2(fin.table.variable)}`],
                ...(fin.table.deductions > 0
                  ? [
                      [
                        "Deducciones",
                        `− ${money2(fin.table.deductions)}`,
                      ] as [string, string],
                    ]
                  : []),
                ["Ventas netas", money2(fin.table.net)],
                ["Ahorro (5%)", money2(fin.table.savings)],
                ["Reparto (50% c/u)", money2(fin.table.each)],
              ].map(([label, value], i, rows) => (
                <div
                  key={label}
                  className={`flex items-baseline justify-between gap-2 ${
                    i >= rows.length - 3
                      ? "border-t border-[#ddd3f5] pt-1.5 font-bold text-[var(--text)]"
                      : "text-[var(--text)]"
                  }`}
                >
                  <dt>{label}</dt>
                  <dd className="font-display">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-[var(--dim)]">
              Como la hoja VENTAS: ventas menos gastos y deducciones,
              ahorro del 5% y el resto se reparte 50/50.
            </p>
          </section>

          {/* Gastos fijos + gastos del mes */}
          <section
            aria-label="Gastos del mes"
            className="glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
          >
            <h3 className="font-display text-base font-bold text-[var(--text)]">
              Gastos fijos del mes
            </h3>
            <ul className="mt-2 space-y-1.5">
              {fin.fixed_alerts.map((a) => (
                <li
                  key={a.label}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span className="font-semibold text-[var(--text)]">
                    {a.label}
                  </span>
                  <span className="text-[var(--dim)]">
                    ref. {money(a.reference_amount)}
                  </span>
                  {a.registered_amount != null ? (
                    <span className="rounded-md bg-[#d9f5e7] px-2 py-0.5 text-[11px] font-bold text-[#0a8a55]">
                      Registrado: {money(a.registered_amount)}
                    </span>
                  ) : (
                    <span className="rounded-md bg-[#fdf0d9] px-2 py-0.5 text-[11px] font-bold text-[#b97a12]">
                      Se cuenta la referencia
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-[var(--text)]">
              <strong>
                Total en la tabla del mes: {money(fin.table.fixed)}
              </strong>
              {fin.close.actual_fixed_costs != null
                ? " — del cierre real."
                : fin.fixed_costs_from_reference
                  ? " — los montos de referencia, porque este mes todavía no hay gastos fijos registrados."
                  : " — de los gastos fijos registrados este mes."}
            </p>
            <p className="mt-1.5 text-xs text-[var(--dim)]">
              Referencias del cierre real de octubre 2025; Adobe y Pixieset
              son fijos aunque la hoja de cierre los liste en variables.
            </p>

            <h4 className="font-display mt-4 text-sm font-bold text-[var(--text)]">
              Gastos registrados · fijos {money(fin.fixed_total)} · variables{" "}
              {money(fin.variable_total)}
            </h4>
            {fin.expenses.length === 0 ? (
              <p className="mt-1.5 text-sm text-[var(--dim)]">
                Sin gastos registrados en {monthLabel(month).toLowerCase()}.
              </p>
            ) : (
              <ul className="mt-1.5 divide-y divide-[#e7e0f7]">
                {fin.expenses.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 py-1.5">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide ${
                        e.kind === "fijo"
                          ? "bg-[#e3e3fd] text-[#1b1be0]"
                          : "bg-[#fdf0d9] text-[#b97a12]"
                      }`}
                    >
                      {e.kind === "fijo" ? "FIJO" : "VAR"}
                    </span>
                    <span className="min-w-0 flex-1 text-sm text-[var(--text)]">
                      {e.description}
                      {e.expense_date && (
                        <span className="text-[var(--dim)]">
                          {" "}
                          · {formatDate(e.expense_date)}
                        </span>
                      )}
                    </span>
                    <span className="text-sm font-bold text-[var(--text)]">
                      {money(e.amount)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Eliminar gasto ${e.description}`}
                      disabled={deleteExpense.isPending}
                      onClick={() => deleteExpense.mutate(e.id)}
                      className="rounded-lg px-2 py-1 text-sm font-bold text-[#d92b4a] disabled:opacity-60"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <label htmlFor="e-desc" className={finLabelClass}>
                  Nuevo gasto
                </label>
                <input
                  id="e-desc"
                  {...FIELDS.addExpense.description}
                  className={finInputClass}
                  value={expenseForm.description}
                  onChange={(e) =>
                    setExpenseForm({
                      ...expenseForm,
                      description: e.target.value,
                    })
                  }
                  placeholder="Descripción (ej. Renta del estudio)"
                />
              </div>
              <div>
                <label htmlFor="e-amount" className={finLabelClass}>
                  Monto
                </label>
                <input
                  id="e-amount"
                  {...FIELDS.addExpense.amount}
                  type="number"
                  inputMode="numeric"
                  className={finInputClass}
                  value={expenseForm.amount}
                  onChange={(e) =>
                    setExpenseForm({ ...expenseForm, amount: e.target.value })
                  }
                  placeholder="$"
                />
              </div>
              <div>
                <label htmlFor="e-kind" className={finLabelClass}>
                  Tipo
                </label>
                <select
                  id="e-kind"
                  className={finInputClass}
                  value={expenseForm.kind}
                  onChange={(e) =>
                    setExpenseForm({
                      ...expenseForm,
                      kind: e.target.value as "fijo" | "variable",
                    })
                  }
                >
                  <option value="fijo">Fijo</option>
                  <option value="variable">Variable</option>
                </select>
              </div>
              <div>
                <label htmlFor="e-date" className={finLabelClass}>
                  Fecha (opcional)
                </label>
                <input
                  id="e-date"
                  type="date"
                  className={finInputClass}
                  value={expenseForm.date}
                  onChange={(e) =>
                    setExpenseForm({ ...expenseForm, date: e.target.value })
                  }
                />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  aria-label="Agregar gasto"
                  disabled={addExpense.isPending}
                  onClick={() => {
                    if (!expenseForm.description.trim()) {
                      setExpenseError("Escribe la descripción del gasto.");
                      return;
                    }
                    if (
                      expenseForm.amount.trim() === "" ||
                      Number(expenseForm.amount) <= 0
                    ) {
                      setExpenseError("Escribe un monto mayor a cero.");
                      return;
                    }
                    addExpense.mutate();
                  }}
                  className="w-full rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
                >
                  {addExpense.isPending ? "Agregando…" : "Agregar gasto"}
                </button>
              </div>
            </div>
            {expenseError && (
              <p className="mt-2 text-sm font-medium text-[#d92b4a]">
                {expenseError}
              </p>
            )}
          </section>

          {/* No-shows */}
          <section
            aria-label="Control de no-shows"
            className="glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
          >
            <h3 className="font-display text-base font-bold text-[var(--text)]">
              No-shows · apartados que se quedan
            </h3>
            {noShows.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Sin no-shows registrados. Se marcan desde el editor de la
                sesión, con el estado «No-show».
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-[#e7e0f7]">
                {noShows.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 font-semibold text-[var(--text)]">
                      {s.client_name}
                      {s.session_date && (
                        <span className="font-normal text-[var(--dim)]">
                          {" "}
                          · {formatDate(s.session_date)}
                        </span>
                      )}
                    </span>
                    <span className="rounded-md bg-[#17141f] px-2 py-0.5 text-[11px] font-extrabold text-white">
                      Apartado {money(200)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Reporte mensual */}
          <section
            aria-label="Reporte mensual"
            className="glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-base font-bold text-[var(--text)]">
                Reporte del mes
              </h3>
              <button
                type="button"
                aria-label="Copiar reporte del mes"
                onClick={async () => {
                  const ok = await copyText(monthReport);
                  setCopied(ok ? "reporte" : null);
                  if (!ok) setFinError("No se pudo copiar; selecciona el texto y cópialo manualmente.");
                }}
                className="rounded-xl bg-[#1b1be0] px-3 py-1.5 text-xs font-bold text-white"
              >
                {copied === "reporte" ? "¡Copiado!" : "Copiar reporte"}
              </button>
            </div>
            <pre className="mt-2 rounded-2xl bg-white/70 p-3 font-sans text-sm whitespace-pre-wrap text-[var(--text)]">
              {monthReport}
            </pre>
          </section>

          {/* Mensajes para clientas */}
          <section
            aria-label="Mensajes para clientas"
            className="glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]"
          >
            <h3 className="font-display text-base font-bold text-[var(--text)]">
              Mensajes para clientas
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="m-template" className={finLabelClass}>
                  Plantilla
                </label>
                <select
                  id="m-template"
                  className={finInputClass}
                  value={template}
                  onChange={(e) => setTemplate(e.target.value as TemplateKey)}
                >
                  {TEMPLATES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="m-client" className={finLabelClass}>
                  Clienta
                </label>
                <select
                  id="m-client"
                  className={finInputClass}
                  value={msgSession?.id ?? ""}
                  onChange={(e) => setMsgClientId(Number(e.target.value))}
                >
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.client_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {message ? (
              <>
                <p className="mt-2 rounded-2xl bg-white/70 p-3 text-sm text-[var(--text)]">
                  {message}
                </p>
                <button
                  type="button"
                  aria-label="Copiar mensaje para la clienta"
                  onClick={async () => {
                    const ok = await copyText(message);
                    setCopied(ok ? "mensaje" : null);
                    if (!ok) setFinError("No se pudo copiar; selecciona el texto y cópialo manualmente.");
                  }}
                  className="mt-2 rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white"
                >
                  {copied === "mensaje" ? "¡Copiado!" : "Copiar mensaje"}
                </button>
              </>
            ) : (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Esta clienta no tiene cargos extra registrados, así que la
                plantilla de cobro no aplica. Elige otra clienta u otra
                plantilla.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/* ---------- statistics view ---------- */

const monthShortFmt = new Intl.DateTimeFormat("es-MX", { month: "short" });

function monthShortLabel(month: string): string {
  const [y = 1970, m = 1] = month.split("-").map(Number);
  const mon = monthShortFmt
    .format(new Date(y, m - 1, 1))
    .replace(".", "");
  return `${mon} ${String(y).slice(2)}`;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

const chartTooltipStyle = {
  borderRadius: 12,
  border: "1px solid #ddd3f5",
  fontFamily: "Montserrat, sans-serif",
  fontSize: 12,
} as const;

const statsCardClass =
  "glass rounded-3xl p-4 shadow-[0_8px_24px_rgba(20,8,80,0.25)]";
const statsTitleClass =
  "font-display text-base font-bold text-[var(--text)]";

function KpiCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className={statsCardClass}>
      <p className="text-[11px] font-bold tracking-wide text-[var(--dim)] uppercase">
        {label}
      </p>
      <p className="font-display mt-1 text-3xl leading-none font-bold text-[var(--text)]">
        {value}
      </p>
      <p className="mt-1.5 text-xs font-medium text-[var(--dim)]">{sub}</p>
    </div>
  );
}

function SurveyBars({
  title,
  entries,
}: {
  title: string;
  entries: { value: string; count: number }[];
}) {
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  const max = entries.reduce((m, e) => Math.max(m, e.count), 0);
  return (
    <div>
      <h4 className="text-sm font-bold text-[var(--text)]">{title}</h4>
      {total === 0 ? (
        <p className="mt-1 text-sm text-[var(--dim)]">
          Todavía no hay respuestas registradas.
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {entries.map((e) => (
            <li key={e.value}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 text-[var(--text)]">{e.value}</span>
                <strong className="font-display shrink-0 text-[var(--text)]">
                  {e.count} · {pct(e.count, total)}
                </strong>
              </div>
              <div
                className="mt-0.5 h-2 overflow-hidden rounded-full bg-[#e7e0f7]"
                aria-hidden="true"
              >
                <div
                  className="h-full rounded-full bg-[#1b1be0]"
                  style={{
                    width: `${max > 0 ? Math.round((e.count / max) * 100) : 0}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatsView() {
  const statsQuery = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.getStudioStats({}),
  });
  const stats = statsQuery.data;

  if (statsQuery.isPending) {
    return (
      <p className="mt-4 py-8 text-center text-sm font-medium text-white/85">
        Cargando estadísticas…
      </p>
    );
  }
  if (statsQuery.isError || !stats) {
    return (
      <div className="glass mt-4 rounded-3xl p-4 text-center">
        <p className="text-sm font-medium text-[var(--text)]">
          No se pudieron cargar las estadísticas.
        </p>
        <button
          type="button"
          aria-label="Reintentar cargar estadísticas"
          onClick={() => statsQuery.refetch()}
          className="mt-2 rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white"
        >
          Reintentar
        </button>
      </div>
    );
  }

  const t = stats.totals;
  const d = stats.delivery;
  const judgedDeliveries = d.on_time + d.late;
  const knownTypes =
    stats.delivery_types.express + stats.delivery_types.standard;
  const monthlyData = stats.monthly.map((m) => ({
    ...m,
    label: monthShortLabel(m.month),
  }));
  const packageData = stats.packages.map((p) => {
    const meta = PACKAGES.find((x) => x.key === p.package);
    return { ...p, label: meta?.label ?? p.package.toUpperCase() };
  });
  const knownPackageSessions = stats.packages.reduce(
    (sum, p) => sum + p.sessions,
    0,
  );
  const deliveryPie = [
    { name: "A tiempo", value: d.on_time, color: "#0a8a55" },
    { name: "Atrasadas", value: d.late, color: "#d92b4a" },
  ].filter((s) => s.value > 0);
  const typePie = [
    { name: "Express", value: stats.delivery_types.express, color: "#d92b4a" },
    { name: "Estándar", value: stats.delivery_types.standard, color: "#1b1be0" },
    { name: "Sin dato", value: stats.delivery_types.unknown, color: "#c9bde8" },
  ].filter((s) => s.value > 0);
  const packageColors = ["#241263", "#1b1be0", "#7b5cd6", "#b18fe8", "#d9b8f5"];

  return (
    <div className="mt-4 space-y-4">
      <p className="glass-soft rounded-2xl px-3 py-2 text-xs font-semibold text-white">
        Todo se calcula con los datos del tablero: sesiones, paquetes,
        fechas de entrega e ingresos registrados en Finanzas.
      </p>

      {/* Números grandes */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <KpiCard
          label="Sesiones"
          value={String(t.sessions)}
          sub={`${t.delivered} entregadas · ${t.pending} por entregar · ${t.no_show} no-show`}
        />
        <KpiCard
          label="Ingresos"
          value={money(t.revenue_total)}
          sub={
            t.revenue_actual > 0
              ? `${money(t.revenue_actual)} de cierre real · ${money(t.revenue_estimated)} estimado`
              : "Estimado del tablero, por fecha de sesión"
          }
        />
        <KpiCard
          label="Entregas a tiempo"
          value={pct(d.on_time, judgedDeliveries)}
          sub={
            judgedDeliveries > 0
              ? `${d.on_time} a tiempo · ${d.late} atrasadas (con fecha del tablero)`
              : "Sin entregas con fecha del tablero para comparar"
          }
        />
        <KpiCard
          label="Clientas que repiten"
          value={String(t.repeat_clients)}
          sub={`de ${t.clients} clientas en total`}
        />
        <KpiCard
          label="Fotos por sesión"
          value={t.photos_sessions > 0 ? String(t.photos_avg) : "—"}
          sub={
            t.photos_sessions > 0
              ? `${t.photos_total.toLocaleString("es-MX")} fotos en ${t.photos_sessions} sesiones contadas`
              : "Todavía no hay conteos de fotos"
          }
        />
        <KpiCard
          label="Sesiones Express"
          value={String(stats.delivery_types.express)}
          sub={`${pct(stats.delivery_types.express, knownTypes)} de las sesiones con tipo de entrega conocido`}
        />
      </div>

      {/* Sesiones por mes */}
      <section aria-label="Sesiones por mes" className={statsCardClass}>
        <h3 className={statsTitleClass}>Sesiones por mes</h3>
        {monthlyData.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Todavía no hay sesiones con fecha registrada.
          </p>
        ) : (
          <div className="mt-2 h-52 w-full" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={monthlyData}
                margin={{ top: 18, right: 4, bottom: 0, left: -18 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e7e0f7" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "#5d5670" }}
                  tickLine={false}
                  axisLine={{ stroke: "#ddd3f5" }}
                />
                <YAxis
                  domain={[0, "auto"]}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "#5d5670" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={chartTooltipStyle}
                  formatter={(value) => [value, "Sesiones"]}
                  labelFormatter={(label) => `Mes: ${label}`}
                />
                <Bar dataKey="sessions" fill="#1b1be0" radius={[6, 6, 0, 0]}>
                  <LabelList
                    dataKey="sessions"
                    position="top"
                    style={{ fontSize: 11, fontWeight: 700, fill: "#241263" }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-1 text-xs text-[var(--dim)]">
          Sesiones del mes por fecha de sesión, entregadas o no; los
          apartados de no-show no cuentan como sesión.
        </p>
      </section>

      {/* Ingresos por mes */}
      <section aria-label="Ingresos por mes" className={statsCardClass}>
        <h3 className={statsTitleClass}>Ingresos por mes</h3>
        {monthlyData.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Todavía no hay ingresos registrados.
          </p>
        ) : (
          <>
            <div className="mt-2 h-52 w-full" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={monthlyData}
                  margin={{ top: 18, right: 4, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e7e0f7" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "#5d5670" }}
                    tickLine={false}
                    axisLine={{ stroke: "#ddd3f5" }}
                  />
                  <YAxis
                    domain={[0, "auto"]}
                    tick={{ fontSize: 11, fill: "#5d5670" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) =>
                      `$${Math.round(v / 1000)}k`
                    }
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(value, _name, item) => [
                      `${money(Number(value))}${item?.payload?.is_actual ? " · cierre real" : " · estimado"}`,
                      "Ingresos",
                    ]}
                    labelFormatter={(label) => `Mes: ${label}`}
                  />
                  <Bar dataKey="revenue" radius={[6, 6, 0, 0]}>
                    {monthlyData.map((m) => (
                      <Cell
                        key={m.month}
                        fill={m.is_actual ? "#1b1be0" : "#b18fe8"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
              <span>
                <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#1b1be0]" />
                Cierre real
              </span>
              <span>
                <span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#b18fe8]" />
                Estimado del tablero (con proyección registrada)
              </span>
            </p>
          </>
        )}
      </section>

      {/* Paquetes más vendidos */}
      <section aria-label="Paquetes más vendidos" className={statsCardClass}>
        <h3 className={statsTitleClass}>Paquetes más vendidos</h3>
        {knownPackageSessions === 0 ? (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Todavía no hay sesiones con paquete registrado.
          </p>
        ) : (
          <>
            <div className="mt-2 h-48 w-full" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={packageData}
                  layout="vertical"
                  margin={{ top: 0, right: 28, bottom: 0, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e7e0f7" horizontal={false} />
                  <XAxis
                    type="number"
                    domain={[0, "auto"]}
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: "#5d5670" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={72}
                    tick={{ fontSize: 11, fill: "#17141f", fontWeight: 600 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(value) => [value, "Sesiones"]}
                  />
                  <Bar dataKey="sessions" radius={[0, 6, 6, 0]}>
                    {packageData.map((p, i) => (
                      <Cell
                        key={p.package}
                        fill={packageColors[i % packageColors.length]}
                      />
                    ))}
                    <LabelList
                      dataKey="sessions"
                      position="right"
                      style={{ fontSize: 11, fontWeight: 700, fill: "#241263" }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#ddd3f5] text-left text-[11px] tracking-wide text-[var(--dim)] uppercase">
                    <th scope="col" className="py-1.5 pr-2 font-bold">Paquete</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-bold">Sesiones</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-bold">% del total</th>
                    <th scope="col" className="py-1.5 text-right font-bold">Ingresos</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e7e0f7]">
                  {packageData.map((p) => (
                    <tr key={p.package}>
                      <td className="py-1.5 pr-2 font-semibold text-[var(--text)]">
                        {p.label}
                      </td>
                      <td className="py-1.5 pr-2 text-right text-[var(--text)]">
                        {p.sessions}
                      </td>
                      <td className="py-1.5 pr-2 text-right text-[var(--text)]">
                        {pct(p.sessions, knownPackageSessions)}
                      </td>
                      <td className="font-display py-1.5 text-right font-bold text-[var(--text)]">
                        {money(p.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {stats.packages_unknown > 0 && (
              <p className="mt-2 text-xs text-[var(--dim)]">
                {stats.packages_unknown} sesión
                {stats.packages_unknown === 1 ? "" : "es"} sin paquete
                registrado no entra{stats.packages_unknown === 1 ? "" : "n"} en
                esta tabla. Los ingresos por paquete incluyen fotos extra y
                Express de esas sesiones.
              </p>
            )}
          </>
        )}
      </section>

      {/* Entregas a tiempo + Express vs estándar */}
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <section aria-label="Entregas a tiempo y atrasadas" className={statsCardClass}>
          <h3 className={statsTitleClass}>Entregas</h3>
          {deliveryPie.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--dim)]">
              Todavía no hay entregas con fecha del tablero para comparar.
            </p>
          ) : (
            <div className="mt-1 h-44 w-full" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(value, name) => [value, name]}
                  />
                  <Pie
                    data={deliveryPie}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={2}
                    strokeWidth={0}
                  >
                    {deliveryPie.map((s) => (
                      <Cell key={s.name} fill={s.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          <ul className="mt-1 space-y-1 text-sm text-[var(--text)]">
            <li className="flex items-baseline justify-between gap-2">
              <span>
                <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-[#0a8a55]" />
                A tiempo
              </span>
              <strong className="font-display">
                {d.on_time} · {pct(d.on_time, judgedDeliveries)}
              </strong>
            </li>
            <li className="flex items-baseline justify-between gap-2">
              <span>
                <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-[#d92b4a]" />
                Atrasadas
              </span>
              <strong className="font-display">
                {d.late} · {pct(d.late, judgedDeliveries)}
              </strong>
            </li>
            <li className="flex items-baseline justify-between gap-2 border-t border-[#ddd3f5] pt-1.5">
              <span>Entregadas sin fecha del tablero</span>
              <strong className="font-display">{d.without_board_date}</strong>
            </li>
            <li className="flex items-baseline justify-between gap-2">
              <span>Pendientes ya vencidas</span>
              <strong className="font-display">{d.pending_overdue}</strong>
            </li>
          </ul>
          <p className="mt-2 text-xs text-[var(--dim)]">
            A tiempo = entregada en o antes de la fecha del tablero
            (Monday). Las vencidas se miden contra la fecha del tablero o
            la calculada desde la subida a Drive.
          </p>
        </section>

        <section aria-label="Express contra estándar" className={statsCardClass}>
          <h3 className={statsTitleClass}>Express vs. estándar</h3>
          {typePie.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--dim)]">
              Todavía no hay sesiones registradas.
            </p>
          ) : (
            <div className="mt-1 h-44 w-full" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(value, name) => [value, name]}
                  />
                  <Pie
                    data={typePie}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={2}
                    strokeWidth={0}
                  >
                    {typePie.map((s) => (
                      <Cell key={s.name} fill={s.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          <ul className="mt-1 space-y-1 text-sm text-[var(--text)]">
            <li className="flex items-baseline justify-between gap-2">
              <span>
                <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-[#d92b4a]" />
                Express
              </span>
              <strong className="font-display">
                {stats.delivery_types.express} ·{" "}
                {pct(stats.delivery_types.express, t.sessions)}
              </strong>
            </li>
            <li className="flex items-baseline justify-between gap-2">
              <span>
                <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-[#1b1be0]" />
                Estándar
              </span>
              <strong className="font-display">
                {stats.delivery_types.standard} ·{" "}
                {pct(stats.delivery_types.standard, t.sessions)}
              </strong>
            </li>
            <li className="flex items-baseline justify-between gap-2">
              <span>
                <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-[#c9bde8]" />
                Sin dato
              </span>
              <strong className="font-display">
                {stats.delivery_types.unknown} ·{" "}
                {pct(stats.delivery_types.unknown, t.sessions)}
              </strong>
            </li>
          </ul>
          <p className="mt-2 text-xs text-[var(--dim)]">
            Porcentajes sobre las {t.sessions} sesiones del tablero (sin
            contar no-shows).
          </p>
        </section>
      </div>

      {/* Clientas que más repiten */}
      <section aria-label="Clientas que más repiten" className={statsCardClass}>
        <h3 className={statsTitleClass}>Clientas que más repiten</h3>
        {stats.top_clients.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Todavía ninguna clienta tiene dos sesiones o más en el tablero.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#ddd3f5] text-left text-[11px] tracking-wide text-[var(--dim)] uppercase">
                  <th scope="col" className="py-1.5 pr-2 font-bold">Clienta</th>
                  <th scope="col" className="py-1.5 pr-2 text-right font-bold">Sesiones</th>
                  <th scope="col" className="py-1.5 pr-2 text-right font-bold">Ingresos</th>
                  <th scope="col" className="py-1.5 text-right font-bold">Última sesión</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e7e0f7]">
                {stats.top_clients.map((c) => (
                  <tr key={c.client_name}>
                    <td className="py-1.5 pr-2 font-semibold text-[var(--text)]">
                      {c.client_name}
                    </td>
                    <td className="py-1.5 pr-2 text-right text-[var(--text)]">
                      {c.sessions}
                    </td>
                    <td className="font-display py-1.5 pr-2 text-right font-bold text-[var(--text)]">
                      {money(c.revenue)}
                    </td>
                    <td className="py-1.5 text-right text-[var(--dim)]">
                      {c.last_session_date
                        ? formatDate(c.last_session_date)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-[var(--dim)]">
          Clientas con dos sesiones o más. Los ingresos suman paquete,
          fotos extra y Express de sus sesiones pagadas.
        </p>
      </section>

      {/* Fotos por sesión */}
      <section aria-label="Fotos por sesión" className={statsCardClass}>
        <h3 className={statsTitleClass}>Fotos por sesión</h3>
        {stats.photos_top.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Todavía no hay conteos de fotos registrados en las carpetas de
            Drive.
          </p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
              <p className="font-display text-3xl leading-none font-bold text-[var(--text)]">
                {t.photos_avg}
              </p>
              <p className="text-xs font-semibold text-[var(--dim)]">
                fotos en promedio por sesión ·{" "}
                {t.photos_total.toLocaleString("es-MX")} fotos en total
              </p>
            </div>
            <ul className="mt-3 divide-y divide-[#e7e0f7]">
              {stats.photos_top.map((p) => (
                <li
                  key={p.client_name}
                  className="flex items-center gap-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 text-sm font-semibold text-[var(--text)]">
                    {p.client_name}
                    {p.package_label && (
                      <span className="font-medium text-[var(--dim)]">
                        {" "}
                        · {p.package_label}
                      </span>
                    )}
                  </span>
                  <span className="font-display text-sm font-bold text-[var(--text)]">
                    {p.photo_count} fotos
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-[var(--dim)]">
              Las sesiones con más fotos en su carpeta de Drive (archivos
              RAW/CR3 de la carpeta).
            </p>
          </>
        )}
      </section>

      {/* Respuestas del formulario de edición */}
      <section
        aria-label="Respuestas del formulario de edición"
        className={statsCardClass}
      >
        <h3 className={statsTitleClass}>
          Lo que contestan las clientas en el formulario
        </h3>
        <p className="mt-1 text-xs text-[var(--dim)]">
          {stats.survey.answered} de {stats.survey.total} sesiones tienen
          respuestas del formulario de edición. Los porcentajes de cada
          pregunta son sobre quienes la contestaron.
        </p>
        {stats.survey.answered === 0 ? (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Todavía no hay respuestas del formulario en el tablero.
            Sincroniza las encuestas desde el tablero para verlas aquí.
          </p>
        ) : (
          <div className="mt-3 grid items-start gap-x-6 gap-y-4 sm:grid-cols-2">
            <SurveyBars
              title="Nivel de retoque de cara"
              entries={stats.survey.face_level}
            />
            <SurveyBars
              title="Ajustes de cuerpo"
              entries={stats.survey.body_adjustments}
            />
            <SurveyBars
              title="¿Podemos publicar sus fotos?"
              entries={[
                { value: "Sí autorizan", count: stats.survey.publish.si },
                { value: "No autorizan", count: stats.survey.publish.no },
                ...(stats.survey.publish.sin_dato > 0
                  ? [
                      {
                        value: "Sin respuesta",
                        count: stats.survey.publish.sin_dato,
                      },
                    ]
                  : []),
              ]}
            />
            <SurveyBars
              title="Motivo de la sesión"
              entries={stats.survey.motive}
            />
            <SurveyBars
              title="Qué no tocar"
              entries={stats.survey.do_not_touch}
            />
            <SurveyBars
              title="Color de fondo"
              entries={stats.survey.background_color}
            />
            <SurveyBars
              title="¿Es su primera sesión?"
              entries={[
                { value: "Sí, es su primera", count: stats.survey.first_session.si },
                { value: "Ya habían venido", count: stats.survey.first_session.no },
                ...(stats.survey.first_session.sin_dato > 0
                  ? [
                      {
                        value: "Sin respuesta",
                        count: stats.survey.first_session.sin_dato,
                      },
                    ]
                  : []),
              ]}
            />
            <SurveyBars
              title="¿Cómo nos encontraron?"
              entries={stats.survey.discovery_source}
            />
          </div>
        )}
        <p className="mt-3 text-xs text-[var(--dim)]">
          La entrega Express o estándar de cada sesión está en la gráfica
          «Express vs. estándar» de arriba.
        </p>
      </section>
    </div>
  );
}

/* ---------- main board ---------- */

type Filter = "todas" | "pendientes" | "express" | "entregadas";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "todas", label: "Todas" },
  { key: "pendientes", label: "Por entregar" },
  { key: "express", label: "Express" },
  { key: "entregadas", label: "Entregadas" },
];

const monthFmt = new Intl.DateTimeFormat("es-MX", { month: "long" });

export function App() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("todas");
  const [search, setSearch] = useState("");
  const [showPackages, setShowPackages] = useState(false);
  const [editor, setEditor] = useState<
    { mode: "new" } | { mode: "edit"; session: Session } | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [view, setView] = useState<"tablero" | "finanzas" | "estadisticas">(
    "tablero",
  );
  const [finMonth, setFinMonth] = useState(() => todayString().slice(0, 7));

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.listSessions({}),
  });

  // The board's income card reads the same finance figures as the
  // Finanzas view (registered estimate + month projection).
  const currentMonth = todayString().slice(0, 7);
  const monthFinanceQuery = useQuery({
    queryKey: ["finance", currentMonth],
    queryFn: () => api.getMonthFinance({ month: currentMonth }),
  });
  const monthFin = monthFinanceQuery.data;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    queryClient.invalidateQueries({ queryKey: ["finance"] });
    queryClient.invalidateQueries({ queryKey: ["stats"] });
  };

  const setStatus = useMutation({
    mutationFn: async (args: { id: number; status: Status }) =>
      await api.setSessionStatus({
        id: args.id,
        status: args.status,
        delivered_at: args.status === "entregada" ? todayString() : undefined,
      }),
    onSuccess: invalidate,
    onError: () =>
      setActionError("No se pudo cambiar el estado. Inténtalo de nuevo."),
  });

  const setProgress = useMutation({
    mutationFn: async (args: { id: number; patch: ProgressPatch }) =>
      await api.setProgress({ id: args.id, ...args.patch }),
    onSuccess: invalidate,
    onError: () =>
      setActionError("No se pudo actualizar el avance. Inténtalo de nuevo."),
  });

  const syncSurvey = useMutation({
    mutationFn: async () => await api.refreshSurveyAnswers({}),
    onSuccess: (res) =>
      setSyncNote(
        res.started
          ? "Sincronizando con la encuesta… las tarjetas se actualizan en unos minutos."
          : "La sincronización ya estaba en curso.",
      ),
    onError: () =>
      setSyncNote("No se pudo iniciar la sincronización de la encuesta."),
  });

  const sessions = sessionsQuery.data?.sessions ?? [];

  const counts = useMemo(() => {
    const open = sessions.filter(
      (s) => s.status !== "entregada" && s.status !== "no_show",
    );
    return {
      open: open.length,
      express: open.filter((s) => s.delivery_type === "EXPRESS").length,
      overdue: open.filter((s) => urgencyOf(s)?.level === "overdue").length,
      noDate: open.filter((s) => effectiveDelivery(s) == null).length,
      delivered: sessions.filter((s) => s.status === "entregada").length,
    };
  }, [sessions]);

  // Fallback for the income card while the finance query loads. Income
  // counts by SESSION date, never by delivery date: clients pay on the
  // day of their session, so every session held this month counts —
  // delivered or not — at its package price (package labels already
  // carry the enlargement rule) plus extra photos at $150, the $399
  // Express fee and $200 no-show deposits.
  const monthIncome = useMemo(() => {
    const prefix = todayString().slice(0, 7);
    let total = 0;
    let count = 0;
    for (const s of sessions) {
      const ref = s.session_date ?? s.delivered_at;
      // A no-show without a date still kept its $200 deposit: it counts
      // in the current month, like in Finanzas.
      if (s.status === "no_show") {
        if (ref == null || ref.startsWith(prefix)) total += 200;
        continue;
      }
      // An unpaid session is not income yet; it waits in por cobrar.
      if (s.unpaid) continue;
      if (ref == null || !ref.startsWith(prefix)) continue;
      count++;
      const pkg = matchPackage(s.package_label);
      if (pkg) total += pkg.price;
      const extras = extraPhotos(s);
      if (extras) total += extras.charge;
      if (s.delivery_type === "EXPRESS") total += 399;
    }
    return { count, total };
  }, [sessions]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (q && !s.client_name.toLowerCase().includes(q)) return false;
      if (filter === "pendientes") return s.status !== "entregada";
      if (filter === "entregadas") return s.status === "entregada";
      if (filter === "express")
        return s.delivery_type === "EXPRESS" && s.status !== "entregada";
      return true;
    });
  }, [sessions, filter, search]);

  const openSessions = useMemo(() => {
    const list = visible.filter(
      (s) => s.status !== "entregada" && s.status !== "no_show",
    );
    return list.sort((a, b) => {
      const ea = effectiveDelivery(a)?.date ?? "9999-99-99";
      const eb = effectiveDelivery(b)?.date ?? "9999-99-99";
      return ea.localeCompare(eb) || a.id - b.id;
    });
  }, [visible]);

  const deliveredSessions = visible.filter((s) => s.status === "entregada");
  const busy = setStatus.isPending || setProgress.isPending;

  const renderCard = (s: Session) => (
    <SessionCard
      key={s.id}
      session={s}
      onOpen={() => setEditor({ mode: "edit", session: s })}
      onStatus={(status) => setStatus.mutate({ id: s.id, status })}
      onProgress={(patch) => setProgress.mutate({ id: s.id, patch })}
      busy={busy}
    />
  );

  return (
    <div className="min-h-screen">
      <SafeAreaTopScrim backgroundColor="#241263" />
      <main className="mx-auto w-full max-w-3xl px-4 pt-4 pb-10">
        {/* Brand header */}
        <header className="flex items-center gap-3.5">
          <img
            src={logoLavanda}
            alt="Punto Cero — Estudio Creativo"
            className="h-16 w-16 shrink-0 rounded-2xl border border-white/50 object-cover shadow-[0_8px_20px_rgba(20,8,80,0.35)]"
          />
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-tight font-bold text-white">
              Sesiones
            </h1>
            <p className="text-sm font-medium text-[#d9b8f5]">
              Tablero de entregas · Punto Cero
            </p>
          </div>
          <button
            type="button"
            aria-label="Agregar nueva sesión"
            onClick={() => setEditor({ mode: "new" })}
            className="font-display ml-auto shrink-0 rounded-2xl bg-white px-4 py-2.5 text-sm font-bold text-[#1b1be0] shadow-[0_8px_20px_rgba(20,8,80,0.35)]"
          >
            + Nueva sesión
          </button>
        </header>

        {/* View switcher */}
        <div
          className="mt-4 grid grid-cols-3 gap-1 rounded-2xl bg-white/15 p-1"
          role="group"
          aria-label="Vista del tablero"
        >
          {(
            [
              { key: "tablero", label: "Tablero" },
              { key: "finanzas", label: "Finanzas" },
              { key: "estadisticas", label: "Estadísticas" },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              type="button"
              aria-label={`Ver ${v.label}`}
              aria-pressed={view === v.key}
              onClick={() => setView(v.key)}
              className={`font-display rounded-xl px-3 py-2 text-sm font-bold ${
                view === v.key
                  ? "bg-white text-[#1b1be0]"
                  : "text-white"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {view === "finanzas" && (
          <FinanceView
            sessions={sessions}
            month={finMonth}
            onMonthChange={setFinMonth}
          />
        )}

        {view === "estadisticas" && <StatsView />}

        {view === "tablero" && (
          <>
        {/* Summary chips */}
        <div
          className="mt-4 flex flex-wrap gap-1.5"
          aria-label="Resumen del tablero"
        >
          <span className="glass-soft rounded-full px-3 py-1 text-xs font-bold text-white">
            {counts.open} por entregar
          </span>
          {counts.express > 0 && (
            <span className="rounded-full bg-[#d92b4a] px-3 py-1 text-xs font-extrabold text-white">
              {counts.express} EXPRESS
            </span>
          )}
          {counts.overdue > 0 && (
            <span className="rounded-full bg-[#17141f] px-3 py-1 text-xs font-extrabold text-white ring-1 ring-white/60">
              {counts.overdue} vencida{counts.overdue === 1 ? "" : "s"}
            </span>
          )}
          {counts.noDate > 0 && (
            <span className="glass-soft rounded-full px-3 py-1 text-xs font-bold text-white">
              {counts.noDate} sin fecha
            </span>
          )}
          <span className="glass-soft rounded-full px-3 py-1 text-xs font-bold text-white">
            {counts.delivered} entregadas
          </span>
          <button
            type="button"
            aria-label={showPackages ? "Ocultar paquetes" : "Ver paquetes y precios"}
            aria-expanded={showPackages}
            onClick={() => setShowPackages((v) => !v)}
            className="rounded-full bg-white/90 px-3 py-1 text-xs font-bold text-[#1b1be0]"
          >
            {showPackages ? "Ocultar paquetes" : "Ver paquetes"}
          </button>
          <button
            type="button"
            aria-label="Actualizar respuestas de la encuesta"
            disabled={syncSurvey.isPending}
            onClick={() => syncSurvey.mutate()}
            className="rounded-full bg-white/90 px-3 py-1 text-xs font-bold text-[#1b1be0] disabled:opacity-60"
          >
            {syncSurvey.isPending ? "Actualizando…" : "Actualizar encuestas"}
          </button>
        </div>

        {syncNote && (
          <p className="glass-soft mt-2 rounded-2xl px-3 py-2 text-xs font-semibold text-white">
            {syncNote}
          </p>
        )}

        {/* Monthly income — by session date: clients pay the day of
            their session, so pending sessions count too. The headline
            is the month's registered estimate (or the board-computed
            total when none is registered); the note carries the full
            month with its end-of-month projection. */}
        <section
          aria-label="Ingresos del mes"
          className="glass-soft mt-3 flex flex-wrap items-baseline gap-x-3 rounded-3xl px-4 py-3 text-white"
        >
          <h2 className="font-display text-sm font-bold tracking-wide">
            Ingresos de {monthFmt.format(new Date())}
          </h2>
          <p className="font-display text-2xl leading-none font-bold">
            {money(monthFin ? monthFin.estimate_headline : monthIncome.total)}
          </p>
          <p className="text-xs text-white/85">
            {monthFin && monthFin.close.projected_sales != null
              ? `Estimado al día de hoy · mes completo con proyección: ${money(monthFin.estimate_with_projection)}`
              : "Estimado al día de hoy · paquetes, fotos extra, Express y apartados no-show, por fecha de sesión"}
          </p>
        </section>

        {showPackages && <PackagesPanel />}

        {/* Search + filters */}
        <div className="mt-4">
          <label htmlFor="board-search" className="sr-only">
            Buscar clienta o cliente
          </label>
          <input
            id="board-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre…"
            className="glass w-full rounded-2xl px-4 py-2.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--dim)]"
          />
          <div
            className="mt-2 flex flex-wrap gap-1.5"
            role="group"
            aria-label="Filtros"
          >
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-label={`Filtro: ${f.label}`}
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-3.5 py-1.5 text-sm font-bold ${
                  filter === f.key
                    ? "bg-white text-[#1b1be0]"
                    : "glass-soft text-white"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {actionError && (
          <p className="mt-3 rounded-2xl bg-[#d92b4a] px-3 py-2 text-sm font-bold text-white">
            {actionError}
          </p>
        )}

        {sessionsQuery.isPending && (
          <p className="mt-10 text-center text-sm font-medium text-white/85">
            Cargando el tablero…
          </p>
        )}
        {sessionsQuery.isError && (
          <div className="glass mt-6 rounded-3xl p-4 text-center">
            <p className="text-sm font-medium text-[var(--text)]">
              No se pudo cargar el tablero.
            </p>
            <button
              type="button"
              aria-label="Reintentar cargar el tablero"
              onClick={() => sessionsQuery.refetch()}
              className="mt-2 rounded-xl bg-[#1b1be0] px-4 py-2 text-sm font-bold text-white"
            >
              Reintentar
            </button>
          </div>
        )}

        {sessionsQuery.isSuccess && visible.length === 0 && (
          <div className="glass mt-6 rounded-3xl p-5 text-center">
            <p className="font-display text-base font-bold text-[var(--text)]">
              {sessions.length === 0
                ? "El tablero está vacío"
                : "Nada con este filtro"}
            </p>
            <p className="mt-1 text-sm text-[var(--dim)]">
              {sessions.length === 0
                ? "Agrega la primera sesión con el botón «+ Nueva sesión»."
                : "Prueba con otro nombre o cambia el filtro."}
            </p>
          </div>
        )}

        {openSessions.length > 0 && (
          <section aria-label="Sesiones por entregar" className="mt-6">
            <h2 className="font-display text-sm font-bold tracking-[0.14em] text-[#d9b8f5] uppercase">
              Por entregar · en orden de edición
            </h2>
            <div className="mt-2.5 space-y-2.5">
              {openSessions.map(renderCard)}
            </div>
          </section>
        )}

        {deliveredSessions.length > 0 && (
          <section aria-label="Sesiones entregadas" className="mt-8">
            <h2 className="font-display text-sm font-bold tracking-[0.14em] text-[#d9b8f5] uppercase">
              Entregadas
            </h2>
            <div className="mt-2.5 space-y-2.5">
              {deliveredSessions.map(renderCard)}
            </div>
          </section>
        )}
          </>
        )}
      </main>

      {editor && (
        <EditorSheet
          key={editor.mode === "edit" ? editor.session.id : "new"}
          sessionId={editor.mode === "edit" ? editor.session.id : null}
          initial={
            editor.mode === "edit"
              ? formFromSession(editor.session)
              : emptyForm()
          }
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
