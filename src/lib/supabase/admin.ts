import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types";
export function authAdminConfigured() {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.APP_URL);
}
// Never import from a client component. Callers must authorize before using this client.
export function authAdmin() {
  if (!authAdminConfigured())
    throw new Error("Staff email administration is not configured.");
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
export function appUrl(path: string) {
  const url = new URL(process.env.APP_URL!);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("APP_URL must use HTTPS outside local development.");
  return new URL(path, url.origin).toString();
}
