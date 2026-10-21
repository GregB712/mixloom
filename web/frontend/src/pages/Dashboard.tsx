import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FileStats, type PlaylistInfo } from "../api/client";
import { BarList } from "../components/charts/BarList";
import { HistogramChart } from "../components/charts/HistogramChart";
import { Card, CardBody } from "../components/ui/Card";
import { ChartCard } from "../components/ui/ChartCard";
import { DataTable } from "../components/ui/DataTable";
import { Callout, EmptyState } from "../components/ui/EmptyState";
import { Select } from "../components/ui/Select";
import { MetricTile } from "../components/ui/Stat";
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

      <h2 className="section-title">Raw data</h2>
      <RawTable playlistId={playlistId} />
    </div>
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
