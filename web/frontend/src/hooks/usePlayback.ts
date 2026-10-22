import { useEffect, useRef, useState } from "react";
import {
  controller,
  cycleRepeat,
  ensurePlayer,
  playUris,
  setShuffle,
  setVolume,
  toggleMute,
} from "../lib/playback";

// Subscribes a component to the shared playback controller and exposes the
// current playback state plus controls. `enabled` gates connecting the SDK —
// pass false until the player scope is authorized, so we don't trigger a token
// error before the user has connected.
export function usePlayback(enabled = true) {
  const [, force] = useState(0);
  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    controller.subscribers.add(rerender);
    if (enabled) ensurePlayer();
    return () => {
      controller.subscribers.delete(rerender);
    };
  }, [enabled]);

  const state = controller.state;
  const current = state?.track_window?.current_track ?? null;
  const upNext = (state?.track_window?.next_tracks ?? []) as any[];
  const playing = state ? !state.paused : false;
  const duration = state?.duration ?? current?.duration_ms ?? 0;
  const trackId = current?.id ?? null;
  const shuffle = !!state?.shuffle;
  const repeatMode = (state?.repeat_mode ?? 0) as number;

  // The SDK reports position only on state-change events, so extrapolate it
  // locally between events to animate the progress bar. `base` is the last
  // known position and when it was observed.
  const base = useRef({ pos: 0, at: Date.now(), paused: true });
  const [position, setPosition] = useState(0);

  useEffect(() => {
    base.current = { pos: state?.position ?? 0, at: Date.now(), paused: state ? state.paused : true };
    setPosition(state?.position ?? 0);
  }, [state?.position, state?.paused, trackId]);

  useEffect(() => {
    const id = setInterval(() => {
      const b = base.current;
      const pos = b.paused ? b.pos : b.pos + (Date.now() - b.at);
      setPosition(duration ? Math.min(pos, duration) : pos);
    }, 500);
    return () => clearInterval(id);
  }, [duration]);

  const seek = (ms: number) => {
    const clamped = Math.max(0, duration ? Math.min(ms, duration) : ms);
    controller.player?.seek(clamped);
    base.current = { ...base.current, pos: clamped, at: Date.now() };
    setPosition(clamped);
  };

  return {
    deviceId: controller.deviceId,
    error: controller.error,
    current,
    upNext,
    playing,
    duration,
    position,
    shuffle,
    repeatMode,
    volume: controller.volume,
    muted: controller.muted || controller.volume === 0,
    seek,
    play: (uris: string[], index = 0) => playUris(uris, index),
    togglePlay: () => controller.player?.togglePlay(),
    next: () => controller.player?.nextTrack(),
    prev: () => controller.player?.previousTrack(),
    setVolume: (v: number) => setVolume(v),
    toggleMute: () => toggleMute(),
    toggleShuffle: () => setShuffle(!shuffle),
    cycleRepeat: () => cycleRepeat(repeatMode),
  };
}

export type Playback = ReturnType<typeof usePlayback>;
