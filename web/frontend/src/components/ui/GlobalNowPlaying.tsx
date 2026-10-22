import { useEffect, useState } from "react";
import type { AuthStatus, EnvFlags } from "../../api/client";
import { usePlayback } from "../../hooks/usePlayback";
import { NowPlayingBar } from "./NowPlayingBar";

// Ignore shortcuts while the user is typing in a form control.
function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

// A floating now-playing panel rendered at the app root, so playback controls
// and the seek bar are available on every tab. Collapsed to a small chip by
// default; expands on hover/focus (or tap) to the full bar with the seek bar.
// Also registers the global playback keyboard shortcuts.
export function GlobalNowPlaying({ env, auth }: { env: EnvFlags; auth: AuthStatus }) {
  const enabled = env.spotify && auth.player;
  const pb = usePlayback(enabled);
  const [open, setOpen] = useState(false);

  // Keyboard shortcuts: Space = play/pause, ←/→ = seek, ↑/↓ = volume.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case " ":
          if (pb.current) { e.preventDefault(); pb.togglePlay(); }
          break;
        case "ArrowLeft":
          if (pb.current) { e.preventDefault(); pb.seek(Math.max(0, pb.position - 5000)); }
          break;
        case "ArrowRight":
          if (pb.current) { e.preventDefault(); pb.seek(Math.min(pb.duration, pb.position + 5000)); }
          break;
        case "ArrowUp":
          e.preventDefault(); pb.setVolume(Math.min(1, pb.volume + 0.05));
          break;
        case "ArrowDown":
          e.preventDefault(); pb.setVolume(Math.max(0, pb.volume - 0.05));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, pb]);

  // Nothing to show until the player is connected and a track is loaded.
  if (!enabled || !pb.current) return null;

  const pct = pb.duration > 0 ? Math.min(100, (pb.position / pb.duration) * 100) : 0;

  return (
    <div
      className="miniplayer"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
    >
      <div className="miniplayer__panel">
        {open ? (
          <div className="miniplayer__full">
            <button className="miniplayer__collapse" onClick={() => setOpen(false)} aria-label="Collapse player">▾</button>
            <NowPlayingBar pb={pb} />
          </div>
        ) : (
          <>
            <button
              className="miniplayer__peek"
              onClick={() => setOpen(true)}
              aria-label="Show player"
              aria-expanded={false}
            >
              <span className="miniplayer__icon" aria-hidden>{pb.playing ? "🔊" : "🎧"}</span>
              <span className="miniplayer__title">{pb.current.name}</span>
            </button>
            <div className="miniplayer__bar" aria-hidden>
              <div className="miniplayer__bar-fill" style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
