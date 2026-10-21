import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthStatus, type EnvFlags, type PlaylistInfo } from "../api/client";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Callout } from "../components/ui/EmptyState";
import { LogPanel } from "../components/ui/LogPanel";
import { MultiSelect } from "../components/ui/MultiSelect";
import { Select } from "../components/ui/Select";
import { Badge } from "../components/ui/Badge";
import { useToast } from "../components/ui/Toast";
import { useJobStream } from "../hooks/useJobStream";

// Per-card job controller: starts a job, streams it, reports completion.
function useJobRunner(onDone: (ok: boolean) => void) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stream = useJobStream(jobId, onDone);
  const running = starting || (jobId !== null && !stream.done);

  const run = async (starter: () => Promise<{ jobId: string }>) => {
    setError(null);
    setStarting(true);
    try {
      const { jobId } = await starter();
      setJobId(jobId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return { jobId, stream, running, error, run };
}

export function RunPipeline({ env, auth }: { env: EnvFlags; auth: AuthStatus }) {
  const qc = useQueryClient();
  const toast = useToast();
  const playlists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });

  // Refresh playlist list and any open dashboard data after a job writes the DB.
  const refreshData = () => {
    qc.invalidateQueries({ queryKey: ["playlists"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
    qc.invalidateQueries({ queryKey: ["rows"] });
    qc.invalidateQueries({ queryKey: ["curate"] });
  };

  const list = playlists.data ?? [];

  return (
    <div className="stack">
      <ExportCard env={env} auth={auth} onExported={() => { refreshData(); toast.notify("Export finished."); }} />
      <EnrichCard
        step={2}
        title="Enrich artist countries"
        subtitle="MusicBrainz · ~1.1s per artist, long runs are normal"
        disabled={!env.contactEmail}
        disabledReason="Set CONTACT_EMAIL in .env to use MusicBrainz lookups."
        playlists={list}
        coverage={(p) => `${p.artistCount - p.artistsResolved} artists w/o country / ${p.artistCount} artists`}
        starter={(ids) => api.enrichCountries(ids)}
        downloadHref={(ids) => api.exportArtistsMissingUrl(ids)}
        downloadLabel="Download artists w/o country (JSON)"
        onDone={() => { refreshData(); toast.notify("Country enrichment finished."); }}
      />
      <EnrichCard
        step={3}
        title="Enrich audio features"
        subtitle="FreqBlog bulk lookup"
        disabled={!env.freqblog}
        disabledReason="Set FREQBLOG_API_KEY in .env to use audio-feature enrichment."
        playlists={list}
        coverage={(p) => `${p.trackCount - p.withFeatures} tracks w/o features / ${p.trackCount} tracks`}
        starter={(ids) => api.enrichFeatures(ids)}
        downloadHref={(ids) => api.exportTracksMissingUrl(ids)}
        downloadLabel="Download tracks w/o features (JSON)"
        onDone={() => { refreshData(); toast.notify("Audio-feature enrichment finished."); }}
      />
      <AnalyzeLocalCard
        step={4}
        playlists={list}
        onDone={() => { refreshData(); toast.notify("Local audio analysis finished."); }}
      />
      <CreatePlaylistCard env={env} auth={auth} playlists={list} />
    </div>
  );
}

function ConnectSpotify({ scope }: { scope: "read" | "write" }) {
  return (
    <Button variant="primary" onClick={() => { window.location.href = api.loginUrl(scope); }}>
      Connect Spotify ({scope})
    </Button>
  );
}

// -------- Step 1: Export (Spotify -> database) ------------------------------ //
function ExportCard({ env, auth, onExported }: { env: EnvFlags; auth: AuthStatus; onExported: () => void }) {
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const runner = useJobRunner((ok) => { if (ok) { setSelected([]); onExported(); } else toast.notify("Export failed. See the log.", "danger"); });

  const playlists = useQuery({
    queryKey: ["spotifyPlaylists"],
    queryFn: api.spotifyPlaylists,
    enabled: env.spotify && auth.read,
  });

  return (
    <Card>
      <CardHeader
        step={1}
        title="Export Spotify playlists"
        subtitle="Download the selected playlists' track data straight into the database (no merge)"
        right={
          <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
            {env.spotify && auth.read && (
              <Button variant="ghost" size="sm" loading={playlists.isFetching} onClick={() => playlists.refetch()}>
                ↻ Refresh
              </Button>
            )}
            {auth.read ? <Badge tone="ok">Connected</Badge> : <Badge tone="warn">Not connected</Badge>}
          </div>
        }
      />
      <CardBody>
        {!env.spotify ? (
          <Callout tone="warn">Set the SPOTIPY_* variables in <code>.env</code> to export playlists.</Callout>
        ) : !auth.read ? (
          <div className="row">
            <span className="muted small">Authorize read access to list your playlists.</span>
            <ConnectSpotify scope="read" />
          </div>
        ) : playlists.isLoading ? (
          <p className="muted small">Loading your playlists…</p>
        ) : playlists.isError ? (
          <Callout tone="danger">{(playlists.error as Error).message}</Callout>
        ) : (
          <>
            <MultiSelect
              label="Playlists to export"
              options={(playlists.data ?? []).map((p) => ({
                value: p.id,
                label: p.name,
                meta: `${p.tracks} tracks`,
              }))}
              selected={selected}
              onChange={setSelected}
            />
            <div className="row">
              <Button disabled={selected.length === 0} loading={runner.running} onClick={() => runner.run(() => api.export(selected))}>
                Export {selected.length || ""} selected
              </Button>
            </div>
          </>
        )}
        {runner.error && <Callout tone="danger">{runner.error}</Callout>}
        {runner.jobId && <LogPanel lines={runner.stream.lines} status={runner.stream.status} />}
      </CardBody>
    </Card>
  );
}

// -------- Steps 2 & 3: Enrichment (by playlist) ----------------------------- //
function EnrichCard({
  step,
  title,
  subtitle,
  disabled,
  disabledReason,
  playlists,
  coverage,
  starter,
  downloadHref,
  downloadLabel,
  onDone,
}: {
  step: number;
  title: string;
  subtitle: string;
  disabled: boolean;
  disabledReason: string;
  playlists: PlaylistInfo[];
  coverage: (p: PlaylistInfo) => string;
  starter: (playlistIds: number[]) => Promise<{ jobId: string }>;
  downloadHref: (playlistIds: number[]) => string;
  downloadLabel: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const runner = useJobRunner((ok) => { if (ok) onDone(); else toast.notify(`${title} failed. See the log.`, "danger"); });
  const ids = selected.map(Number);

  return (
    <Card>
      <CardHeader step={step} title={title} subtitle={subtitle} />
      <CardBody>
        {disabled ? (
          <Callout tone="warn">{disabledReason}</Callout>
        ) : playlists.length === 0 ? (
          <Callout>No playlists in the database yet. Export playlists first.</Callout>
        ) : (
          <>
            <MultiSelect
              label="Playlists to enrich (none = all)"
              options={playlists.map((p) => ({
                value: String(p.id),
                label: `${p.curated ? "★ " : ""}${p.name}`,
                meta: coverage(p),
              }))}
              selected={selected}
              onChange={setSelected}
            />
            <div className="row">
              <Button loading={runner.running} onClick={() => runner.run(() => starter(ids))}>
                {ids.length ? `Run on ${ids.length} playlist${ids.length > 1 ? "s" : ""}` : "Run on all playlists"}
              </Button>
              <a className="btn btn--ghost btn--sm" href={downloadHref(ids)} download>⇩ {downloadLabel}</a>
            </div>
          </>
        )}
        {runner.error && <Callout tone="danger">{runner.error}</Callout>}
        {runner.jobId && <LogPanel lines={runner.stream.lines} status={runner.stream.status} />}
      </CardBody>
    </Card>
  );
}

// -------- Step 4: Analyse local audio files --------------------------------- //
function AnalyzeLocalCard({
  step,
  playlists,
  onDone,
}: {
  step: number;
  playlists: PlaylistInfo[];
  onDone: () => void;
}) {
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [audioDir, setAudioDir] = useState("");
  const runner = useJobRunner((ok) => { if (ok) onDone(); else toast.notify("Local analysis failed. See the log.", "danger"); });
  const ids = selected.map(Number);

  return (
    <Card>
      <CardHeader
        step={step}
        title="Analyse downloaded files"
        subtitle="librosa · fills features for tracks the APIs missed, from the audio itself"
      />
      <CardBody>
        {playlists.length === 0 ? (
          <Callout>No playlists in the database yet. Export playlists first.</Callout>
        ) : (
          <>
            <MultiSelect
              label="Playlists to analyse (none = all)"
              options={playlists.map((p) => ({
                value: String(p.id),
                label: `${p.curated ? "★ " : ""}${p.name}`,
                meta: `${p.trackCount - p.withFeatures} tracks w/o features`,
              }))}
              selected={selected}
              onChange={setSelected}
            />
            <div className="field" style={{ maxWidth: 440 }}>
              <label className="label" htmlFor="audio-dir">Folder with downloaded tracks</label>
              <input
                id="audio-dir"
                className="input"
                value={audioDir}
                placeholder="/path/to/downloads"
                onChange={(e) => setAudioDir(e.target.value)}
              />
            </div>
            <div className="row">
              <Button loading={runner.running} disabled={!audioDir.trim()} onClick={() => runner.run(() => api.analyzeLocal(audioDir.trim(), ids))}>
                {ids.length ? `Analyse ${ids.length} playlist${ids.length > 1 ? "s" : ""}` : "Analyse all feature-less tracks"}
              </Button>
              <span className="small faint">Only tracks with no features are analysed. Perceptual fields are estimates.</span>
            </div>
          </>
        )}
        {runner.error && <Callout tone="danger">{runner.error}</Callout>}
        {runner.jobId && <LogPanel lines={runner.stream.lines} status={runner.stream.status} />}
      </CardBody>
    </Card>
  );
}

// -------- Step 5: Create playlist (from a DB playlist) ---------------------- //
function CreatePlaylistCard({
  env,
  auth,
  playlists,
}: {
  env: EnvFlags;
  auth: AuthStatus;
  playlists: PlaylistInfo[];
}) {
  const toast = useToast();
  const [picked, setPicked] = useState("");
  const [name, setName] = useState("");
  const runner = useJobRunner((ok) => {
    if (ok) { toast.notify("Playlist created on Spotify."); setName(""); }
    else toast.notify("Playlist creation failed. See the log.", "danger");
  });
  const chosen = picked || (playlists[0] ? String(playlists[0].id) : "");
  const options = playlists.map((p) => ({ value: String(p.id), label: `${p.curated ? "★ " : ""}${p.name}  ·  ${p.trackCount} tracks` }));

  return (
    <Card>
      <CardHeader
        step={5}
        title="Create a Spotify playlist"
        subtitle="Build a new private playlist from a playlist in the database"
        right={auth.write ? <Badge tone="ok">Write access</Badge> : <Badge tone="warn">No write access</Badge>}
      />
      <CardBody>
        {!env.spotify ? (
          <Callout tone="warn">Set the SPOTIPY_* variables in <code>.env</code> first.</Callout>
        ) : !auth.write ? (
          <div className="row">
            <span className="muted small">Playlist creation needs a one-time write authorization.</span>
            <ConnectSpotify scope="write" />
          </div>
        ) : playlists.length === 0 ? (
          <Callout>No playlists to build from yet.</Callout>
        ) : (
          <>
            <div className="grid cols-2">
              <Select label="Source playlist" value={chosen} options={options} onChange={setPicked} />
              <div className="field">
                <label className="label" htmlFor="pl-name">New playlist name (optional)</label>
                <input id="pl-name" className="input" value={name} placeholder="defaults to the source name" onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
            <div className="row">
              <Button loading={runner.running} disabled={!chosen} onClick={() => runner.run(() => api.createPlaylist(Number(chosen), name.trim()))}>
                Create private playlist
              </Button>
              <span className="small faint">Creates a new private playlist in your account.</span>
            </div>
          </>
        )}
        {runner.error && <Callout tone="danger">{runner.error}</Callout>}
        {runner.jobId && <LogPanel lines={runner.stream.lines} status={runner.stream.status} />}
      </CardBody>
    </Card>
  );
}
