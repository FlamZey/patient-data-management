"use client";

import { useEffect, useState } from "react";

type Item = {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    fetch(`${API_URL}/items/`)
      .then((res) => {
        if (!res.ok) throw new Error("Request failed");
        return res.json();
      })
      .then((data: Item[]) => {
        setItems(data);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-bold">Next.js + FastAPI + PostgreSQL</h1>

      {status === "loading" && <p>Loading items from API...</p>}
      {status === "error" && (
        <p className="text-red-600">
          Couldn&apos;t reach the API at {API_URL}. Is the backend running?
        </p>
      )}
      {status === "ready" && items.length === 0 && (
        <p>No items yet -- POST to {API_URL}/items/ to create one.</p>
      )}
      {status === "ready" && items.length > 0 && (
        <ul className="list-disc text-left">
          {items.map((item) => (
            <li key={item.id}>{item.name}</li>
          ))}
        </ul>
      )}
    </main>
  );
}

