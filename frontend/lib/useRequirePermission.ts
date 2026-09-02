"use client";

import { useEffect } from "react";

import { useAuth } from "./auth-context";
import { hasPermission, type PermissionCode } from "./permissions";
import { useAppRouter } from "./useAppRouter";

// Shared by every permission-gated page (dashboard, manage-users, audit-log,
// data-analysis): redirects to /home once auth has resolved and the user
// lacks the given permission.
export function useRequirePermission(code: PermissionCode): boolean {
  const { currentUser } = useAuth();
  const router = useAppRouter();
  const allowed = hasPermission(currentUser, code);

  useEffect(() => {
    if (currentUser && !allowed) router.replace("/home");
  }, [currentUser, allowed, router]);

  return !!currentUser && allowed;
}
