// Thin fetch wrapper + shared types. All calls go through the Vite /api proxy.

export type EnvFlags = { spotify: boolean; freqblog: boolean; contactEmail: boolean };
export type AuthStatus = { read: boolean; write: boolean; player: boolean };
export type Playlist = { id: string; name: string; tracks: number };

export type PlayerTrack = {
  uri: string;
  title: string;
  artists: string;
  album: string;
  durationMs: number | null;
};

export type JobStatus = "pending" | "running" | "succeeded" | "failed";
export type Job = {
  id: string;
  type: string;
  status: JobStatus;
  args: string[];
  returncode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  lineCount: number;
};

export type CountItem = { label: string; value: number };
export type HistBin = { x0: number; x1: number; count: number };
export type Histogram = { bins: HistBin[] };

export type PlaylistInfo = {
  id: number;
  spotifyId: string | null;
  name: string;
  curated: boolean;
  trackCount: number;
  withFeatures: number;
  artistCount: number;
  artistsResolved: number;
  withCountries: number;
};

export type FileStats = {
  name: string;
  rows: number;
  columns?: string[];
  groups: { base: boolean; countries: boolean; features: boolean };
  metrics: {
    tracks: number;
    uniqueArtists: number;
    uniqueAlbums?: number;
    totalDurationMs?: number;
    greekCount?: number;
    greekPct?: number;
    medianBpm?: number;
  };
  topArtists: CountItem[];
  sourcePlaylists?: CountItem[];
  countries?: { topCountries?: CountItem[]; greek?: CountItem[]; status?: CountItem[] };
  audio?: {
    matched?: number;
    matchRate?: number;
    histograms: Record<string, Histogram>;
    categories?: Record<string, CountItem[]>;
  };
};

export type Track = {
  uri: string;
  title: string;
  artists: string;
  album: string;
  durationMs: number | null;
  bpm: number | null;
  energy: number | null;
  valence: number | null;
  danceability: number | null;
  acousticness: number | null;
  camelot: string | null;
  musicalKey: string | null;
  genre: string | null;
  mood: string | null;
  greek: boolean;
};

export type CuratePool = {
  name: string;
  hasUris: boolean;
  hasFeatures: boolean;
  tracks: Track[];
};

export type RowsPage = {
  columns: string[];
  rows: Record<string, string>[];
  total: number;
  offset: number;
  limit: number;
};

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  status: () => get<{ env: EnvFlags }>("/api/status"),
  authStatus: () => get<AuthStatus>("/api/auth/status"),
  loginUrl: (scope: "read" | "write" | "player") => `/api/auth/spotify/login?scope=${scope}`,
  playerToken: () => get<{ accessToken: string }>("/api/auth/spotify/token?scope=player"),
  spotifyPlaylists: () => get<Playlist[]>("/api/spotify/playlists"),

  jobs: () => get<Job[]>("/api/jobs"),
  job: (id: string) => get<Job & { lines: string[] }>(`/api/jobs/${id}`),
  export: (playlistIds: string[]) => post<{ jobId: string }>("/api/jobs/export", { playlistIds }),
  enrichCountries: (playlistIds: number[]) =>
    post<{ jobId: string }>("/api/jobs/enrich-countries", { playlistIds }),
  enrichFeatures: (playlistIds: number[]) =>
    post<{ jobId: string }>("/api/jobs/enrich-features", { playlistIds }),
  analyzeLocal: (audioDir: string, playlistIds: number[]) =>
    post<{ jobId: string }>("/api/jobs/analyze-local", { audioDir, playlistIds }),
  createPlaylist: (playlistId: number, name: string) =>
    post<{ jobId: string }>("/api/jobs/create-playlist", { playlistId, name }),

  curateTracks: (playlistIds: number[]) =>
    get<CuratePool>(`/api/curate/tracks${playlistIds.length ? `?playlistIds=${playlistIds.join(",")}` : ""}`),
  curateSave: (name: string, uris: string[]) =>
    post<{ playlistId: number; name: string; count: number }>("/api/curate/save", { name, uris }),

  exportArtistsMissingUrl: (playlistIds: number[]) =>
    `/api/export/artists-missing${playlistIds.length ? `?playlistIds=${playlistIds.join(",")}` : ""}`,
  exportTracksMissingUrl: (playlistIds: number[]) =>
    `/api/export/tracks-missing${playlistIds.length ? `?playlistIds=${playlistIds.join(",")}` : ""}`,

  playlists: () => get<PlaylistInfo[]>("/api/playlists"),
  playlistTracks: (id: number) => get<PlayerTrack[]>(`/api/playlists/${id}/tracks`),
  stats: (playlistId: number | null) =>
    get<FileStats>(`/api/stats${playlistId != null ? `?playlistId=${playlistId}` : ""}`),
  rows: (playlistId: number | null, offset: number, limit: number, q: string) =>
    get<RowsPage>(
      `/api/rows?offset=${offset}&limit=${limit}&q=${encodeURIComponent(q)}` +
        (playlistId != null ? `&playlistId=${playlistId}` : ""),
    ),
};
