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
  albumArt: string | null;
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
  spotifyPlaylistId: string | null;
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
  albumArt: string | null;
  greek: boolean;
  playlists?: string; // comma-joined; only set in duplicate groups
};

export type SimilarResult = { seedUri: string; hasFeatures: boolean; tracks: Track[] };
export type DuplicateGroup = { isrc: string; tracks: Track[] };
export type LibraryHealth = {
  tracks: { total: number; withFeatures: number; withArt: number };
  artists: { total: number; resolved: number };
  featureSources: CountItem[];
};

export type SavedFilter = { id: number; name: string; rules: Record<string, unknown>; updatedAt?: string };

export type ResyncTrack = { uri: string; title: string; artists: string };
export type ResyncStatus = {
  spotifyId: string;
  inSync: boolean;
  dbCount: number;
  liveCount: number;
  added: ResyncTrack[];
  removed: ResyncTrack[];
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

// A track with its full hand-editable metadata, for the Tracks (metadata) tab.
export type TrackDetail = {
  id: number;
  uri: string | null;
  title: string;
  artists: string;
  album: string;
  albumArt: string | null;
  featureSource: string | null;
  missing: string[]; // core fields that are still empty
  fields: Record<string, string | number | null>; // column name -> value
};
export type TracksDetailPage = {
  tracks: TrackDetail[];
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

async function put<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE" });
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
  createPlaylist: (playlistId: number, name: string, update = false) =>
    post<{ jobId: string }>("/api/jobs/create-playlist", { playlistId, name, update }),

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
  updatePlaylistTracks: (id: number, uris: string[]) =>
    put<{ playlistId: number; count: number }>(`/api/playlists/${id}/tracks`, { uris }),
  deletePlaylist: (id: number) =>
    del<{ playlistId: number; name: string; removedTracks: number; removedArtists: number }>(
      `/api/playlists/${id}`,
    ),
  stats: (playlistId: number | null) =>
    get<FileStats>(`/api/stats${playlistId != null ? `?playlistId=${playlistId}` : ""}`),
  rows: (playlistId: number | null, offset: number, limit: number, q: string) =>
    get<RowsPage>(
      `/api/rows?offset=${offset}&limit=${limit}&q=${encodeURIComponent(q)}` +
        (playlistId != null ? `&playlistId=${playlistId}` : ""),
    ),

  tracksDetail: (playlistId: number | null, missing: boolean, q: string, offset: number, limit: number) =>
    get<TracksDetailPage>(
      `/api/tracks?offset=${offset}&limit=${limit}&missing=${missing}&q=${encodeURIComponent(q)}` +
        (playlistId != null ? `&playlistId=${playlistId}` : ""),
    ),
  updateTrack: (id: number, fields: Record<string, string | number | null>) =>
    put<TrackDetail>(`/api/tracks/${id}`, { fields }),
  trackFieldOptions: () => get<{ genre: string[]; mood: string[] }>("/api/tracks/field-options"),

  similar: (uri: string, limit = 20) =>
    get<SimilarResult>(`/api/tracks/similar?uri=${encodeURIComponent(uri)}&limit=${limit}`),
  duplicates: () => get<DuplicateGroup[]>("/api/duplicates"),
  libraryHealth: () => get<LibraryHealth>("/api/library-health"),
  resyncStatus: (playlistId: number) => get<ResyncStatus>(`/api/playlists/${playlistId}/resync`),

  savedFilters: () => get<SavedFilter[]>("/api/saved-filters"),
  saveFilter: (name: string, rules: Record<string, unknown>) =>
    post<SavedFilter>("/api/saved-filters", { name, rules }),
  deleteFilter: (id: number) => del<{ deleted: number }>(`/api/saved-filters/${id}`),
};
