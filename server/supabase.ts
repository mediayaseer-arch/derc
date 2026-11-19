import { createClient, type SupabaseClient } from "@supabase/supabase-js";

declare const __BUILD_SUPABASE_URL__: string | undefined;
declare const __BUILD_SUPABASE_KEY__: string | undefined;

function resolveSupabaseConfig() {
  const buildUrl =
    typeof __BUILD_SUPABASE_URL__ !== "undefined" ? __BUILD_SUPABASE_URL__ : "";
  const buildKey =
    typeof __BUILD_SUPABASE_KEY__ !== "undefined" ? __BUILD_SUPABASE_KEY__ : "";

  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    buildUrl ||
    "https://mjydzqntxbwvnrhqfhme.supabase.co";
  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    buildKey ||
    "sb_secret_azOyf3XAcpQacxKWPDpREA_VX12l2tT";

  return { supabaseUrl, supabaseKey };
}

let cachedServerSupabase: SupabaseClient | null = null;

function getOrCreateServerSupabase(): SupabaseClient | null {
  if (cachedServerSupabase) return cachedServerSupabase;
  const { supabaseUrl, supabaseKey } = resolveSupabaseConfig();
  if (!supabaseUrl || !supabaseKey) return null;
  cachedServerSupabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: "public" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedServerSupabase;
}

// Lazy proxy so createClient() is never invoked in global scope (Workers-safe)
export const serverSupabase: SupabaseClient | null = new Proxy(
  {} as SupabaseClient,
  {
    get(_target, prop) {
      const client = getOrCreateServerSupabase();
      if (!client) return undefined;
      const value = (client as any)[prop];
      return typeof value === "function" ? value.bind(client) : value;
    },
  }
);

export function createSupabaseAuthClient() {
  const { supabaseUrl, supabaseKey } = resolveSupabaseConfig();
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey, {
    db: { schema: "public" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
