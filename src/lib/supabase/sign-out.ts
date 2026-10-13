import "server-only";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types";
// Called only in mutations, where response cookies can be cleared.
export async function endSession(
  db: SupabaseClient<Database>,
  scope: "local" | "global" = "local",
) {
  const { error } = await db.auth.signOut({ scope });
  const store = await cookies();
  for (const cookie of store.getAll()) {
    if (
      /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name) ||
      cookie.name === "easysee-password-grant"
    )
      store.delete(cookie.name);
  }
  return !error;
}
