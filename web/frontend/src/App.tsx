import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api/client";
import { Badge } from "./components/ui/Badge";
import { Button } from "./components/ui/Button";
import { Callout } from "./components/ui/EmptyState";
import { Tabs } from "./components/ui/Tabs";
import { useToast } from "./components/ui/Toast";
import { useTheme } from "./hooks/useTheme";
import { Curate } from "./pages/Curate";
import { Dashboard } from "./pages/Dashboard";
import { Player } from "./pages/Player";
import { RunPipeline } from "./pages/RunPipeline";

const AUTH_MESSAGES: Record<string, { text: string; ok: boolean }> = {
  connected: { text: "Spotify connected.", ok: true },
  denied: { text: "Spotify authorization was denied.", ok: false },
  error: { text: "Spotify authorization failed.", ok: false },
  missing_code: { text: "Spotify did not return an authorization code.", ok: false },
};

export function App() {
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState("run");
  const qc = useQueryClient();
  const toast = useToast();

  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const auth = useQuery({ queryKey: ["authStatus"], queryFn: api.authStatus });

  // Handle the OAuth redirect back from the backend callback.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("status");
    if (params.get("auth") && result) {
      const msg = AUTH_MESSAGES[result] ?? { text: `Spotify: ${result}`, ok: false };
      toast.notify(msg.text, msg.ok ? "ok" : "danger");
      qc.invalidateQueries({ queryKey: ["authStatus"] });
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const env = status.data?.env ?? { spotify: false, freqblog: false, contactEmail: false };
  const authState = auth.data ?? { read: false, write: false, player: false };

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__brand">
          <div className="appbar__logo" aria-hidden>♪</div>
          Spotify Playlist Tools
        </div>
        <div className="appbar__spacer" />
        <div className="appbar__env">
          <Badge tone={env.spotify ? "ok" : "warn"}>Spotify {env.spotify ? "✓" : "✗"}</Badge>
          <Badge tone={env.freqblog ? "ok" : "warn"}>FreqBlog {env.freqblog ? "✓" : "✗"}</Badge>
          <Badge tone={env.contactEmail ? "ok" : "warn"}>MB email {env.contactEmail ? "✓" : "✗"}</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle color theme">
          {theme === "dark" ? "☀ Light" : "☾ Dark"}
        </Button>
      </header>

      <div className="container stack">
        <Tabs
          items={[
            { id: "run", label: "▶  Run pipeline" },
            { id: "curate", label: "🎚  Curate" },
            { id: "dash", label: "📊  Dashboard" },
            { id: "player", label: "🎧  Player" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {status.isError && (
          <Callout tone="danger">
            Cannot reach the backend API. Start it with <code>web/dev.sh</code> or uvicorn on port 8888.
          </Callout>
        )}

        {tab === "run" && <RunPipeline env={env} auth={authState} />}
        {tab === "curate" && <Curate env={env} auth={authState} />}
        {tab === "dash" && <Dashboard />}
        {tab === "player" && <Player env={env} auth={authState} />}
      </div>
    </div>
  );
}
