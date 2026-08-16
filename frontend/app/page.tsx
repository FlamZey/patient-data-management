"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth-context";

export default function Home() {
  const { currentUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    router.replace(currentUser ? "/dashboard" : "/login");
  }, [isLoading, currentUser, router]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <p className="text-sm text-gray-500">Loading...</p>
    </main>
  );
}
