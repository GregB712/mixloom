import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api/client";
import { Badge } from "./components/ui/Badge";
import { Button } from "./components/ui/Button";
import { Callout } from "./components/ui/EmptyState";
import { GlobalNowPlaying } from "./components/ui/GlobalNowPlaying";
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

  const navItems = [
    { id: "run", icon: "▶", label: "Run pipeline" },
    { id: "curate", icon: "🎚", label: "Curate" },
    { id: "dash", icon: "📊", label: "Dashboard" },
    { id: "player", icon: "🎧", label: "Player" },
  ];

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Primary">
        <div className="sidebar__brand">
          <div className="sidebar__logo" aria-hidden>♪</div>
          Mixloom
        </div>

        <div className="nav" role="tablist">
          {navItems.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-current={tab === item.id}
              aria-selected={tab === item.id}
              className="navitem"
              onClick={() => setTab(item.id)}
            >
              <span className="navitem__icon" aria-hidden>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="main">
        <div className="topbar">
          <div className="topbar__spacer" />
          <div className="topbar__env">
            <Badge tone={env.spotify ? "ok" : "warn"}>Spotify {env.spotify ? "✓" : "✗"}</Badge>
            <Badge tone={env.freqblog ? "ok" : "warn"}>FreqBlog {env.freqblog ? "✓" : "✗"}</Badge>
            <Badge tone={env.contactEmail ? "ok" : "warn"}>MB email {env.contactEmail ? "✓" : "✗"}</Badge>
          </div>
          <Button variant="secondary" size="sm" onClick={toggle} aria-label="Toggle color theme">
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </Button>
        </div>

        <div className="content stack">
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
      </main>

      <GlobalNowPlaying env={env} auth={authState} />
    </div>
  );
}
