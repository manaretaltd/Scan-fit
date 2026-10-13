import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { configured, supabase } from "./supabase/server";
export const requireStaff = cache(async () => {
  if (!configured()) redirect("/setup");
  const db = await supabase();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  const { data: staff, error } = await db
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();
  if (error || !staff?.active) redirect("/access");
  return { db, staff, user };
});
export async function requirePermission(permission: string) {
  const context = await requireStaff();
  const { data, error } = await context.db.rpc("has_permission", {
    p_permission: permission,
  });
  if (error || !data) redirect("/forbidden");
  return context;
}
export async function permissions() {
  const { db, staff } = await requireStaff();
  const { data, error } = await db
    .from("role_permissions")
    .select("permission")
    .eq("role", staff.role);
  if (error) throw new Error("Unable to load permissions");
  return new Set(data.map((p) => p.permission));
}
