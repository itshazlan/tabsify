import type { Tab } from "@tabsify/engine";

export interface SongSummary {
  id: string;
  title: string;
  artist?: string;
  tempo: number;
  tuningName: string;
  noteCount: number;
  updatedAt: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const api = {
  listSongs: () => request<{ songs: SongSummary[] }>("/api/songs").then((data) => data.songs),

  getSong: (id: string) => request<{ song: Tab }>(`/api/songs/${id}`).then((data) => data.song),

  createSong: (input: Partial<Tab>) =>
    request<{ song: Tab }>("/api/songs", jsonInit("POST", input)).then((data) => data.song),

  saveSong: (tab: Tab, message?: string) =>
    request<{ song: Tab }>(`/api/songs/${tab.id}`, jsonInit("PUT", { ...tab, message })).then(
      (data) => data.song,
    ),

  deleteSong: (id: string) =>
    request<{ ok: boolean }>(`/api/songs/${id}`, { method: "DELETE" }),

  importGuitarPro: async (file: File) => {
    const response = await fetch(`/api/import/gp?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    const data = (await response.json()) as { song: Tab };
    return data.song;
  },

  download: async (id: string, format: "gp" | "midi" | "alphatex" | "json", filename: string) => {
    const response = await fetch(`/api/songs/${id}/export/${format}`);
    if (!response.ok) throw new Error(`Export gagal (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
};
