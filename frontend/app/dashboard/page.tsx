"use client";

import NavBar from "@/components/NavBar";
import ProtectedRoute from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth-context";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function ProfileCard() {
  const { currentUser } = useAuth();

  // ProtectedRoute guarantees currentUser is set by the time this renders;
  // this is just to satisfy the type checker.
  if (!currentUser) return null;

  const fields: { label: string; value: string; capitalize?: boolean }[] = [
    { label: "Name", value: `${currentUser.first_name} ${currentUser.last_name}` },
    { label: "Email", value: currentUser.email },
    { label: "Username", value: currentUser.username },
    { label: "Role", value: currentUser.role.display_name },
    { label: "Location", value: currentUser.location.name },
    { label: "Team", value: currentUser.team ? currentUser.team.name : "Unassigned" },
    { label: "Status", value: currentUser.status, capitalize: true },
    { label: "Last login", value: formatDateTime(currentUser.last_login_at) },
    { label: "Member since", value: formatDateTime(currentUser.created_at) },
  ];

  return (
    <div className="mx-auto w-full max-w-2xl rounded-lg bg-white p-6 shadow sm:p-8">
      <h1 className="mb-6 text-xl font-bold text-gray-900">Your profile</h1>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.label}>
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
              {field.label}
            </dt>
            <dd className={`mt-1 text-sm text-gray-900 ${field.capitalize ? "capitalize" : ""}`}>
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <NavBar />
      <main className="min-h-screen bg-gray-50 px-4 py-8">
        <ProfileCard />
      </main>
    </ProtectedRoute>
  );
}
