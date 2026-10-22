import { useEffect, useRef, useState } from "react";
import type { Playback } from "../../hooks/usePlayback";
import { type Device, listDevices, transferPlayback } from "../../lib/playback";
import { Button } from "./Button";

// Millisecond position as m:ss (e.g. 1:07).
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function artUrl(track: any): string | null {
  return track?.album?.images?.[0]?.url ?? null;
}

// Seekable progress bar for the now-playing track.
function ProgressBar({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (ms: number) => void;
}) {
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  const seekToClientX = (clientX: number, el: HTMLElement) => {
    if (duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const frac = rect.width ? (clientX - rect.left) / rect.width : 0;
    onSeek(Math.max(0, Math.min(1, frac)) * duration);
  };
  return (
    <div
      className="seekbar"
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration / 1000)}
      aria-valuenow={Math.round(position / 1000)}
      aria-valuetext={`${clock(position)} of ${clock(duration)}`}
      onClick={(e) => seekToClientX(e.clientX, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); onSeek(Math.min(duration, position + 5000)); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); onSeek(Math.max(0, position - 5000)); }
      }}
    >
      <div className="seekbar__fill" style={{ width: `${pct}%` }} />
      <div className="seekbar__knob" style={{ left: `${pct}%` }} />
    </div>
  );
}

function VolumeControl({ pb }: { pb: Playback }) {
  const icon = pb.muted ? "🔇" : pb.volume < 0.5 ? "🔉" : "🔊";
  return (
    <div className="volume">
      <button className="iconbtn" onClick={() => pb.toggleMute()} aria-label={pb.muted ? "Unmute" : "Mute"}>
        {icon}
      </button>
      <input
        className="volume__slider"
        type="range"
        min={0}
        max={100}
        value={Math.round((pb.muted ? 0 : pb.volume) * 100)}
        aria-label="Volume"
        onChange={(e) => pb.setVolume(Number(e.target.value) / 100)}
      />
    </div>
  );
}

function DevicePicker() {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    listDevices().then(setDevices).catch(() => setDevices([]));
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const choose = async (id: string) => {
    setBusy(true);
    try {
      await transferPlayback(id, true);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="devicepicker" ref={ref}>
      <button className="iconbtn" onClick={() => setOpen((v) => !v)} aria-label="Devices" aria-expanded={open}>
        🖥
      </button>
      {open && (
        <div className="devicepicker__menu" role="menu">
          <div className="small faint" style={{ padding: "var(--space-1) var(--space-2)" }}>
            Connect to a device
          </div>
          {devices.length === 0 ? (
            <div className="small muted" style={{ padding: "var(--space-2)" }}>No devices found.</div>
          ) : (
            devices.map((d) => (
              <button
                key={d.id}
                className="devicepicker__item"
                disabled={busy}
                onClick={() => choose(d.id)}
                role="menuitem"
              >
                <span>{d.is_active ? "▶ " : ""}{d.name}</span>
                <span className="faint small">{d.type}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const REPEAT_ICON = ["🔁", "🔁", "🔂"]; // off, context, track
const REPEAT_LABEL = ["Repeat off", "Repeat all", "Repeat one"];

// Now-playing info + transport controls + seek bar. `compact` hides the volume,
// shuffle/repeat, device picker and up-next extras (used in tight placements).
export function NowPlayingBar({ pb, compact = false }: { pb: Playback; compact?: boolean }) {
  const { current, playing, duration, position, seek, togglePlay, next, prev } = pb;
  const [showQueue, setShowQueue] = useState(false);
  const art = artUrl(current);

  return (
    <div className="stack" style={{ gap: "var(--space-3)" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "var(--space-3)" }}>
        <div className="row" style={{ minWidth: 0, flex: 1, gap: "var(--space-3)" }}>
          {art && <img className="nowbar__art" src={art} alt="" width={48} height={48} />}
          <div style={{ minWidth: 0 }}>
            {current ? (
              <>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {current.name}
                </div>
                <div className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {current.artists?.map((a: any) => a.name).join(", ")}
                </div>
              </>
            ) : (
              <span className="muted small">Nothing playing yet.</span>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          {!compact && (
            <button
              className={`iconbtn ${pb.shuffle ? "iconbtn--on" : ""}`}
              disabled={!current}
              onClick={() => pb.toggleShuffle()}
              aria-label="Shuffle"
              aria-pressed={pb.shuffle}
            >🔀</button>
          )}
          <Button variant="ghost" size="sm" disabled={!current} onClick={prev} aria-label="Previous track">⏮</Button>
          <Button size="sm" disabled={!current} onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "⏸ Pause" : "▶ Play"}
          </Button>
          <Button variant="ghost" size="sm" disabled={!current} onClick={next} aria-label="Next track">⏭</Button>
          {!compact && (
            <button
              className={`iconbtn ${pb.repeatMode > 0 ? "iconbtn--on" : ""}`}
              disabled={!current}
              onClick={() => pb.cycleRepeat()}
              aria-label={REPEAT_LABEL[pb.repeatMode]}
              title={REPEAT_LABEL[pb.repeatMode]}
            >{REPEAT_ICON[pb.repeatMode]}</button>
          )}
        </div>
      </div>

      {current && (
        <div className="row" style={{ gap: "var(--space-3)" }}>
          <span className="small faint nowbar__time" style={{ textAlign: "right" }}>{clock(position)}</span>
          <ProgressBar position={position} duration={duration} onSeek={seek} />
          <span className="small faint nowbar__time">{clock(duration)}</span>
        </div>
      )}

      {!compact && current && (
        <div className="row" style={{ justifyContent: "space-between", gap: "var(--space-2)" }}>
          <VolumeControl pb={pb} />
          <div className="row" style={{ gap: "var(--space-2)" }}>
            {pb.upNext.length > 0 && (
              <button
                className={`iconbtn ${showQueue ? "iconbtn--on" : ""}`}
                onClick={() => setShowQueue((v) => !v)}
                aria-label="Up next"
                aria-pressed={showQueue}
                title="Up next"
              >≡</button>
            )}
            <DevicePicker />
          </div>
        </div>
      )}

      {!compact && showQueue && pb.upNext.length > 0 && (
        <div className="upnext">
          <div className="small faint" style={{ marginBottom: "var(--space-1)" }}>Up next</div>
          {pb.upNext.slice(0, 10).map((t: any, i: number) => (
            <div className="upnext__row" key={(t.uri || t.id || "") + i}>
              <span className="upnext__title">{t.name}</span>
              <span className="muted small">{t.artists?.map((a: any) => a.name).join(", ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
