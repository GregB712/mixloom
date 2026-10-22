// Small album-art thumbnail with a graceful fallback (a musical-note tile) when
// a track has no captured cover URL.
export function TrackArt({ url, size = 40 }: { url?: string | null; size?: number }) {
  if (url) {
    return (
      <img
        className="trackart"
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div className="trackart trackart--empty" aria-hidden style={{ width: size, height: size, fontSize: size * 0.45 }}>
      ♪
    </div>
  );
}
