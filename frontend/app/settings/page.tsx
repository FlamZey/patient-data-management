"use client";

import ProtectedRoute from "@/components/ProtectedRoute";
import SettingsProfile from "@/components/SettingsProfile";
import Sidebar from "@/components/Sidebar";

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-14 shrink-0 items-center border-b border-border px-4 sm:px-6">
            <h1 className="font-serif text-base font-semibold text-foreground">Settings</h1>
          </div>
          <div className="overlay-scrollbar flex-1 overflow-auto">
            <SettingsProfile />
          </div>
        </main>
      </div>
    </ProtectedRoute>
  );
}
