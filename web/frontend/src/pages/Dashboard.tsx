import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FileStats, type LibraryHealth, type PlaylistInfo } from "../api/client";
import { BarList } from "../components/charts/BarList";
import { CamelotWheel } from "../components/charts/CamelotWheel";
import { HistogramChart } from "../components/charts/HistogramChart";
import { Card, CardBody } from "../components/ui/Card";
import { ChartCard } from "../components/ui/ChartCard";
import { DataTable } from "../components/ui/DataTable";
import { Callout, EmptyState } from "../components/ui/EmptyState";
import { Select } from "../components/ui/Select";
import { MetricTile } from "../components/ui/Stat";
import { TrackArt } from "../components/ui/TrackArt";
import { Badge } from "../components/ui/Badge";
import { chartColor, formatDuration, formatNumber } from "../lib/format";

const ALL = "all"; // sentinel for the whole-library view

const PAGE = 50;
const FEATURE_LABELS: Record<string, string> = {
  bpm: "BPM",
  energy: "Energy",
  loudness_db: "Loudness (dB)",
  danceability: "Danceability",
  valence: "Valence",
  speechiness: "Speechiness",
  instrumentalness: "Instrumentalness",
  liveness: "Liveness",
  acousticness: "Acousticness",
};

export function Dashboard() {
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const [picked, setPicked] = useState<string>(ALL);

  if (playlists.isLoading) return <p className="muted">Loading playlists…</p>;
  const list = playlists.data ?? [];
  if (list.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState icon="🎧" title="No playlists yet">
            Export playlists in the <strong>Run pipeline</strong> tab, then inspect them here.
          </EmptyState>
        </CardBody>
      </Card>
    );
  }

  return <DashboardBody playlists={list} picked={picked} onPick={setPicked} />;
}

function DashboardBody({
  playlists,
  picked,
  onPick,
}: {
  playlists: PlaylistInfo[];
  picked: string;
  onPick: (value: string) => void;
}) {
  const playlistId = picked === ALL ? null : Number(picked);
  const stats = useQuery({ queryKey: ["stats", picked], queryFn: () => api.stats(playlistId) });
  const info = playlists.find((p) => String(p.id) === picked);
  const options = [
    { value: ALL, label: "All playlists" },
    ...playlists.map((p) => ({
      value: String(p.id),
      label: `${p.curated ? "★ " : ""}${p.name}  ·  ${p.trackCount} tracks`,
    })),
  ];

  return (
    <div className="stack">
      <Card>
        <CardBody>
          <div className="row" style={{ alignItems: "flex-end", justifyContent: "space-between" }}>
            <div style={{ flex: 1, minWidth: 260, maxWidth: 440 }}>
              <Select label="Playlist to inspect" value={picked} options={options} onChange={onPick} />
            </div>
            {info && (
              <div className="row" style={{ gap: "var(--space-2)" }}>
                {info.withCountries > 0 && <Badge tone="accent">countries</Badge>}
                {info.withFeatures > 0 && <Badge tone="accent">audio features</Badge>}
                <span className="small faint">{info.withFeatures}/{info.trackCount} with features</span>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {stats.isLoading && <p className="muted">Computing statistics…</p>}
      {stats.isError && <Callout tone="danger">{(stats.error as Error).message}</Callout>}
      {stats.data && <StatsView data={stats.data} playlistId={playlistId} />}
    </div>
  );
}

function StatsView({ data, playlistId }: { data: FileStats; playlistId: number | null }) {
  const m = data.metrics;
  const metrics: { label: string; value: string; sub?: string }[] = [
    { label: "Tracks", value: formatNumber(m.tracks) },
  ];
  if (m.uniqueArtists !== undefined) metrics.push({ label: "Unique artists", value: formatNumber(m.uniqueArtists) });
  if (m.uniqueAlbums !== undefined) metrics.push({ label: "Unique albums", value: formatNumber(m.uniqueAlbums) });
  if (m.totalDurationMs !== undefined) metrics.push({ label: "Total duration", value: formatDuration(m.totalDurationMs) });
  if (m.greekPct !== undefined) metrics.push({ label: "Greek artists", value: `${m.greekPct}%`, sub: `${m.greekCount} tracks` });
  if (m.medianBpm !== undefined) metrics.push({ label: "Median BPM", value: `${m.medianBpm}` });

  return (
    <div className="stack">
      <div className="metrics">
        {metrics.map((t) => (
          <MetricTile key={t.label} label={t.label} value={t.value} sub={t.sub} />
        ))}
      </div>

      <div className="grid cols-2">
        <ChartCard title="Top artists">
          <BarList items={data.topArtists} max={15} />
        </ChartCard>
        {data.sourcePlaylists && (
          <ChartCard title="Tracks per source playlist">
            <BarList items={data.sourcePlaylists} max={15} />
          </ChartCard>
        )}
      </div>

      {data.countries && (
        <>
          <h2 className="section-title">Artist countries</h2>
          <div className="grid cols-2">
            {data.countries.topCountries && (
              <ChartCard title="Top country codes">
                <BarList items={data.countries.topCountries} max={15} />
              </ChartCard>
            )}
            <div className="stack">
              {data.countries.greek && (
                <ChartCard title="Greek classification">
                  <BarList items={data.countries.greek} />
                </ChartCard>
              )}
              {data.countries.status && (
                <ChartCard title="Lookup status">
                  <BarList items={data.countries.status} />
                </ChartCard>
              )}
            </div>
          </div>
        </>
      )}

      {data.audio && <AudioSection audio={data.audio} />}

      {playlistId === null && (
        <>
          <LibraryHealthSection />
          <DuplicatesSection />
        </>
      )}

      <h2 className="section-title">Raw data</h2>
      <RawTable playlistId={playlistId} />
    </div>
  );
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function CoverageMeter({ label, part, total, sub }: { label: string; part: number; total: number; sub?: string }) {
  const p = pct(part, total);
  return (
    <div className="stack" style={{ gap: "var(--space-1)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small">{label}</span>
        <span className="small faint">{part}/{total} · {p}%</span>
      </div>
      <div className="barrow__track"><div className="barrow__fill" style={{ width: `${p}%` }} /></div>
      {sub && <span className="small faint">{sub}</span>}
    </div>
  );
}

// Coverage meters: % of tracks with features / album art, % of artists with a
// resolved country, and the feature-source breakdown — the pipeline's
// "missing / total" counts in one at-a-glance view.
function LibraryHealthSection() {
  const health = useQuery({ queryKey: ["libraryHealth"], queryFn: api.libraryHealth });
  const h = health.data as LibraryHealth | undefined;
  if (!h) return null;
  return (
    <>
      <h2 className="section-title">Library health</h2>
      <div className="grid cols-2">
        <ChartCard title="Coverage">
          <div className="stack" style={{ gap: "var(--space-4)" }}>
            <CoverageMeter label="Tracks with audio features" part={h.tracks.withFeatures} total={h.tracks.total} />
            <CoverageMeter label="Tracks with album art" part={h.tracks.withArt} total={h.tracks.total} />
            <CoverageMeter label="Artists with resolved country" part={h.artists.resolved} total={h.artists.total} />
          </div>
        </ChartCard>
        <ChartCard title="Feature source">
          <BarList items={h.featureSources} max={10} />
        </ChartCard>
      </div>
    </>
  );
}

// Cross-library duplicate detection: tracks sharing an ISRC under different URIs.
function DuplicatesSection() {
  const dupes = useQuery({ queryKey: ["duplicates"], queryFn: api.duplicates });
  const groups = dupes.data ?? [];
  const [open, setOpen] = useState(false);
  if (dupes.isLoading || groups.length === 0) return null;

  const totalExtra = groups.reduce((n, g) => n + (g.tracks.length - 1), 0);
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="section-title">Duplicates</h2>
        <button className="badge" style={{ cursor: "pointer" }} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide" : "Show"} {groups.length} group{groups.length === 1 ? "" : "s"}
        </button>
      </div>
      <Card>
        <CardBody>
          <p className="small muted">
            {groups.length} recording{groups.length === 1 ? "" : "s"} appear under more than one Spotify URI
            ({totalExtra} extra cop{totalExtra === 1 ? "y" : "ies"}), grouped by ISRC.
          </p>
          {open && (
            <div className="stack" style={{ gap: "var(--space-4)" }}>
              {groups.map((g) => (
                <div key={g.isrc} className="stack" style={{ gap: "var(--space-1)" }}>
                  <span className="small faint">ISRC {g.isrc}</span>
                  {g.tracks.map((t) => (
                    <div className="row" key={t.uri} style={{ gap: "var(--space-2)" }}>
                      <TrackArt url={t.albumArt} size={28} />
                      <span className="option__name">
                        <strong>{t.title || "(untitled)"}</strong>
                        <span className="muted"> — {t.artists}</span>
                        {t.album ? <span className="faint small"> · {t.album}</span> : null}
                      </span>
                      {t.playlists && <span className="small faint">in: {t.playlists}</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}

function AudioSection({ audio }: { audio: NonNullable<FileStats["audio"]> }) {
  const featureKeys = Object.keys(audio.histograms).filter((k) => k !== "bpm");
  const [selected, setSelected] = useState<string[]>(
    ["energy", "danceability", "valence"].filter((f) => featureKeys.includes(f)),
  );

  const toggle = (feat: string) =>
    setSelected((s) => (s.includes(feat) ? s.filter((x) => x !== feat) : [...s, feat]));

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="section-title">Audio features</h2>
        {audio.matchRate !== undefined && (
          <Badge tone="accent">FreqBlog match rate {audio.matchRate}%</Badge>
        )}
      </div>

      {audio.histograms.bpm && (
        <ChartCard title="BPM distribution">
          <HistogramChart hist={audio.histograms.bpm} color={chartColor(0)} />
        </ChartCard>
      )}

      {featureKeys.length > 0 && (
        <>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <span className="small muted">Feature distributions:</span>
            {featureKeys.map((f) => (
              <button
                key={f}
                className={selected.includes(f) ? "badge badge--accent" : "badge"}
                onClick={() => toggle(f)}
                style={{ cursor: "pointer" }}
                aria-pressed={selected.includes(f)}
              >
                {FEATURE_LABELS[f] ?? f}
              </button>
            ))}
          </div>
          <div className="grid cols-2">
            {selected.map((f, i) => (
              <ChartCard key={f} title={FEATURE_LABELS[f] ?? f}>
                <HistogramChart hist={audio.histograms[f]} color={chartColor(i + 1)} />
              </ChartCard>
            ))}
          </div>
        </>
      )}

      {audio.categories?.camelot && (
        <ChartCard title="Camelot wheel (harmonic compatibility)">
          <CamelotWheel items={audio.categories.camelot} />
        </ChartCard>
      )}

      {audio.categories && (
        <div className="grid cols-2">
          {Object.entries(audio.categories).map(([name, items]) => (
            <ChartCard key={name} title={name[0].toUpperCase() + name.slice(1)}>
              <BarList items={items} max={24} />
            </ChartCard>
          ))}
        </div>
      )}
    </>
  );
}

function RawTable({ playlistId }: { playlistId: number | null }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  // Reset paging when the playlist or search term changes.
  useEffect(() => setOffset(0), [playlistId, query]);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const rows = useQuery({
    queryKey: ["rows", playlistId, offset, query],
    queryFn: () => api.rows(playlistId, offset, PAGE, query),
  });

  return (
    <Card>
      <CardBody>
        <div className="field" style={{ maxWidth: 360 }}>
          <input
            className="input"
            placeholder="Search all columns…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {rows.isLoading && <p className="muted small">Loading rows…</p>}
        {rows.data && (
          <DataTable
            columns={rows.data.columns}
            rows={rows.data.rows}
            total={rows.data.total}
            offset={rows.data.offset}
            limit={rows.data.limit}
            onPage={setOffset}
          />
        )}
      </CardBody>
    </Card>
  );
}
