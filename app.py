#!/usr/bin/env python3
"""Streamlit front-end for the Spotify playlist CSV tools.

Run the four scripts from buttons and inspect any exported CSV in a dashboard
with summary statistics and charts. The underlying scripts are unchanged; this
app reuses their functions for the Spotify steps and runs the enrichment steps
as subprocesses so their progress streams live.

Launch with:  streamlit run app.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import altair as alt
import pandas as pd
import spotipy
import streamlit as st
from dotenv import load_dotenv
from spotipy.oauth2 import SpotifyOAuth

import spotify_playlist_export as exporter
import create_spotify_playlist as creator

load_dotenv()

ROOT = Path(__file__).resolve().parent
EXPORTS = ROOT / "spotify_exports"
CREATE_TOKEN_CACHE = creator.TOKEN_CACHE

AUDIO_FEATURES = [
    "bpm", "energy", "loudness_db", "danceability", "valence",
    "speechiness", "instrumentalness", "liveness", "acousticness",
]

st.set_page_config(page_title="Spotify Playlist Tools", page_icon="🎧", layout="wide")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def env_ok(*names: str) -> bool:
    return all(os.getenv(name) for name in names)


def list_csvs() -> list[Path]:
    if not EXPORTS.exists():
        return []
    return sorted(EXPORTS.glob("*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)


@st.cache_data(show_spinner=False)
def load_csv(path_str: str, _mtime: float) -> pd.DataFrame:
    return pd.read_csv(path_str, encoding="utf-8-sig", dtype=str, keep_default_na=False)


def artist_list(row: pd.Series) -> list[str]:
    raw = str(row.get("artist_names_json") or "").strip()
    if raw:
        try:
            names = json.loads(raw)
            if isinstance(names, list):
                return [str(n).strip() for n in names if str(n).strip()]
        except json.JSONDecodeError:
            pass
    return [p.strip() for p in str(row.get("artists") or "").split(",") if p.strip()]


def numeric(df: pd.DataFrame, col: str) -> pd.Series:
    return pd.to_numeric(df[col], errors="coerce").dropna()


def explode_counts(series: pd.Series, sep: str) -> pd.Series:
    items = (
        series.fillna("").astype(str)
        .str.split(sep).explode().str.strip()
    )
    return items[items != ""].value_counts()


def run_script(script: str, args: list[str]) -> int:
    """Run a project script as a subprocess, streaming its output live."""
    cmd = [sys.executable, str(ROOT / script), *args]
    st.caption("$ " + " ".join(cmd))
    placeholder = st.empty()
    lines: list[str] = []
    proc = subprocess.Popen(
        cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    for line in proc.stdout:  # type: ignore[union-attr]
        lines.append(line.rstrip("\n"))
        placeholder.code("\n".join(lines[-300:]) or "...", language="text")
    proc.wait()
    return proc.returncode


# --------------------------------------------------------------------------- #
# Sidebar: environment status
# --------------------------------------------------------------------------- #
st.sidebar.title("🎧 Spotify Playlist Tools")
st.sidebar.subheader("Environment")
checks = {
    "Spotify API": env_ok("SPOTIPY_CLIENT_ID", "SPOTIPY_CLIENT_SECRET", "SPOTIPY_REDIRECT_URI"),
    "FreqBlog key": env_ok("FREQBLOG_API_KEY"),
    "MusicBrainz email": bool(os.getenv("CONTACT_EMAIL"))
    and os.getenv("CONTACT_EMAIL") != "your-email@example.com",
}
for label, ok in checks.items():
    st.sidebar.write(("✅ " if ok else "⚠️ ") + label)
if not all(checks.values()):
    st.sidebar.caption("Set the missing values in `.env`.")

run_tab, dash_tab = st.tabs(["▶️  Run pipeline", "📊  Dashboard"])


# --------------------------------------------------------------------------- #
# Run pipeline
# --------------------------------------------------------------------------- #
with run_tab:
    st.subheader("1 · Export Spotify playlists")
    if not checks["Spotify API"]:
        st.warning("Set the SPOTIPY_* variables in `.env` to export playlists.")
    elif not Path(ROOT / exporter.TOKEN_CACHE).exists():
        st.info(
            "No Spotify authorization found yet. Authorize once in a terminal with "
            "`python spotify_playlist_export.py`, then reload this page. "
            "(The browser OAuth step can't run inside Streamlit.)"
        )
    else:
        try:
            auth = SpotifyOAuth(
                client_id=os.environ["SPOTIPY_CLIENT_ID"],
                client_secret=os.environ["SPOTIPY_CLIENT_SECRET"],
                redirect_uri=os.environ["SPOTIPY_REDIRECT_URI"],
                scope=exporter.SCOPES,
                cache_path=str(ROOT / exporter.TOKEN_CACHE),
                open_browser=False,
            )
            sp = spotipy.Spotify(auth_manager=auth)
            if "playlists" not in st.session_state:
                st.session_state.playlists = exporter.get_user_playlists(sp)
            playlists = st.session_state.playlists
            labels = {
                f"{p.get('name', 'Untitled')}  ({(p.get('tracks') or {}).get('total', '?')} tracks)": p["id"]
                for p in playlists
            }
            chosen = st.multiselect("Playlists to export", list(labels))
            if st.button("Export selected", disabled=not chosen):
                EXPORTS.mkdir(exist_ok=True)
                all_tracks, done = [], 0
                prog = st.progress(0.0)
                for i, label in enumerate(chosen, start=1):
                    name, tracks = exporter.get_playlist_tracks(sp, labels[label])
                    short = "".join(c for c in labels[label] if c.isalnum())[:8] or "playlist"
                    out = EXPORTS / f"{exporter.safe_filename(name)}__{short}.csv"
                    exporter.write_csv(out, tracks)
                    all_tracks.extend(tracks)
                    done += 1
                    prog.progress(i / len(chosen))
                    st.write(f"Saved **{name}** ({len(tracks)} tracks) → `{out.name}`")
                merged = exporter.deduplicate_tracks(all_tracks)
                merged_path = EXPORTS / "merged_playlists.csv"
                exporter.write_csv(merged_path, merged, renumber=True)
                st.success(f"Exported {done} playlist(s). Merged unique tracks: {len(merged)}.")
                load_csv.clear()
        except spotipy.SpotifyException as exc:
            st.error(f"Spotify error: HTTP {exc.http_status} — {exc.msg}")
        except Exception as exc:  # noqa: BLE001 - surface any auth/network issue
            st.error(f"Could not reach Spotify: {exc}")

    st.divider()
    csvs = list_csvs()
    csv_names = [p.name for p in csvs]

    st.subheader("2 · Enrich with artist countries (MusicBrainz)")
    if not checks["MusicBrainz email"]:
        st.warning("Set `CONTACT_EMAIL` in `.env` first.")
    elif not csvs:
        st.caption("No CSVs in `spotify_exports/` yet. Export first.")
    else:
        src = st.selectbox("Input CSV", csv_names, key="countries_src")
        if st.button("Run country enrichment"):
            with st.status("Running enrich_artist_countries.py…", expanded=True):
                code = run_script("enrich_artist_countries.py", [str(EXPORTS / src)])
            (st.success if code == 0 else st.error)(
                "Done." if code == 0 else f"Exited with code {code}."
            )
            load_csv.clear()

    st.divider()
    st.subheader("3 · Enrich with audio features (FreqBlog)")
    if not checks["FreqBlog key"]:
        st.warning("Set `FREQBLOG_API_KEY` in `.env` first.")
    elif not csvs:
        st.caption("No CSVs in `spotify_exports/` yet. Export first.")
    else:
        src = st.selectbox("Input CSV", csv_names, key="features_src")
        if st.button("Run audio-feature enrichment"):
            with st.status("Running enrich_spotify_csv.py…", expanded=True):
                code = run_script("enrich_spotify_csv.py", [str(EXPORTS / src)])
            (st.success if code == 0 else st.error)(
                "Done." if code == 0 else f"Exited with code {code}."
            )
            load_csv.clear()

    st.divider()
    st.subheader("4 · Create a Spotify playlist from a CSV")
    if not checks["Spotify API"]:
        st.warning("Set the SPOTIPY_* variables in `.env` first.")
    elif not Path(ROOT / CREATE_TOKEN_CACHE).exists():
        st.info(
            "Playlist creation needs a one-time write authorization. Run "
            "`python create_spotify_playlist.py` once in a terminal to approve it, "
            "then this step will work here."
        )
    elif not csvs:
        st.caption("No CSVs to build from yet.")
    else:
        src = st.selectbox("Source CSV", csv_names, key="create_src")
        new_name = st.text_input("New playlist name")
        st.caption("Creates a private playlist in your account.")
        if st.button("Create playlist", disabled=not new_name.strip()):
            try:
                uris, skipped = creator.read_track_uris(EXPORTS / src)
                auth = SpotifyOAuth(
                    client_id=os.environ["SPOTIPY_CLIENT_ID"],
                    client_secret=os.environ["SPOTIPY_CLIENT_SECRET"],
                    redirect_uri=os.environ["SPOTIPY_REDIRECT_URI"],
                    scope=creator.SCOPE,
                    cache_path=str(ROOT / CREATE_TOKEN_CACHE),
                    open_browser=False,
                )
                sp = spotipy.Spotify(auth_manager=auth)
                pl = sp.current_user_playlist_create(
                    name=new_name.strip(), public=False,
                    description="Created from a CSV playlist export.",
                )
                for start in range(0, len(uris), creator.BATCH_SIZE):
                    sp.playlist_add_items(pl["id"], uris[start:start + creator.BATCH_SIZE])
                url = (pl.get("external_urls") or {}).get("spotify", "")
                st.success(f"Created **{new_name}** with {len(uris)} tracks ({skipped} skipped).")
                if url:
                    st.markdown(f"[Open in Spotify]({url})")
            except Exception as exc:  # noqa: BLE001 - surface API/CSV errors
                st.error(f"Could not create playlist: {exc}")


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #
def hist(df: pd.DataFrame, col: str, title: str) -> None:
    values = numeric(df, col)
    if values.empty:
        return
    chart = (
        alt.Chart(pd.DataFrame({col: values}))
        .mark_bar()
        .encode(
            alt.X(f"{col}:Q", bin=alt.Bin(maxbins=30), title=title),
            alt.Y("count()", title="Tracks"),
        )
        .properties(height=220)
    )
    st.altair_chart(chart, use_container_width=True)


def bar_counts(counts: pd.Series, x_title: str, top: int | None = None) -> None:
    if counts.empty:
        return
    data = counts.head(top) if top else counts
    frame = data.rename_axis(x_title).reset_index(name="Tracks")
    chart = (
        alt.Chart(frame)
        .mark_bar()
        .encode(
            alt.X("Tracks:Q"),
            alt.Y(f"{x_title}:N", sort="-x", title=x_title),
            tooltip=[x_title, "Tracks"],
        )
        .properties(height=min(28 * len(frame) + 20, 460))
    )
    st.altair_chart(chart, use_container_width=True)


with dash_tab:
    csvs = list_csvs()
    if not csvs:
        st.info("No CSVs found in `spotify_exports/`. Export and enrich first.")
    else:
        names = [p.name for p in csvs]
        picked = st.selectbox("CSV to inspect", names)
        path = EXPORTS / picked
        df = load_csv(str(path), path.stat().st_mtime)
        cols = set(df.columns)

        st.caption(f"`{picked}` · {len(df)} rows · {len(df.columns)} columns")

        # Overview metrics
        unique_artists = set()
        for _, row in df.iterrows():
            unique_artists.update(a.casefold() for a in artist_list(row))
        metrics = [("Tracks", f"{len(df):,}"), ("Unique artists", f"{len(unique_artists):,}")]
        if "album" in cols:
            metrics.append(("Albums", f"{df['album'].replace('', pd.NA).nunique():,}"))
        if "duration_ms" in cols:
            total_min = int(numeric(df, "duration_ms").sum() // 60000)
            metrics.append(("Total length", f"{total_min // 60}h {total_min % 60}m"))
        if "greek_artist" in cols:
            yes = (df["greek_artist"] == "Yes").sum()
            metrics.append(("Greek artists", f"{yes} ({yes / len(df) * 100:.0f}%)"))
        if "bpm" in cols:
            bpm = numeric(df, "bpm")
            if not bpm.empty:
                metrics.append(("Median BPM", f"{bpm.median():.0f}"))
        for col, (label, value) in zip(st.columns(len(metrics)), metrics):
            col.metric(label, value)

        st.divider()

        # Artists and sources
        left, right = st.columns(2)
        with left:
            st.markdown("**Top artists**")
            counts = pd.Series(
                [a for _, row in df.iterrows() for a in artist_list(row)]
            ).value_counts()
            bar_counts(counts, "Artist", top=15)
        with right:
            if "source_playlists" in cols:
                st.markdown("**Tracks per source playlist**")
                src_counts = explode_counts(
                    df["source_playlists"].str.replace(r"\s*\[[^\]]*\]", "", regex=True),
                    ";",
                )
                bar_counts(src_counts, "Playlist", top=15)

        # Country section
        if "artist_country_codes" in cols:
            st.divider()
            st.markdown("### Artist countries")
            c1, c2 = st.columns(2)
            with c1:
                st.markdown("**Top countries**")
                bar_counts(explode_counts(df["artist_country_codes"], ";"), "Country", top=15)
            with c2:
                if "greek_artist" in cols:
                    st.markdown("**Greek classification**")
                    bar_counts(df["greek_artist"].replace("", "Unknown").value_counts(), "Greek")
                if "artist_country_status" in cols:
                    st.markdown("**Lookup status**")
                    bar_counts(
                        df["artist_country_status"].replace("", "unknown").value_counts(),
                        "Status",
                    )

        # Audio features
        if "bpm" in cols or "energy" in cols:
            st.divider()
            st.markdown("### Audio features")
            if "found" in cols:
                found = (df["found"].str.lower() == "true").sum()
                st.caption(f"Matched by FreqBlog: {found}/{len(df)} tracks.")
            if "bpm" in cols:
                st.markdown("**BPM distribution**")
                hist(df, "bpm", "BPM")
            present = [f for f in AUDIO_FEATURES if f in cols and f != "bpm" and not numeric(df, f).empty]
            if present:
                chosen = st.multiselect(
                    "Feature distributions", present,
                    default=[f for f in ("energy", "danceability", "valence") if f in present],
                )
                for pair in [chosen[i:i + 2] for i in range(0, len(chosen), 2)]:
                    for col_box, feat in zip(st.columns(len(pair)), pair):
                        with col_box:
                            st.markdown(f"**{feat}**")
                            hist(df, feat, feat)
            cat1, cat2 = st.columns(2)
            with cat1:
                if "camelot" in cols:
                    st.markdown("**Camelot key**")
                    bar_counts(df["camelot"].replace("", pd.NA).dropna().value_counts(), "Camelot", top=24)
            with cat2:
                for name, title in (("genre", "Genre"), ("mood", "Mood")):
                    if name in cols:
                        st.markdown(f"**{title}**")
                        bar_counts(df[name].replace("", pd.NA).dropna().value_counts(), title, top=12)

        st.divider()
        with st.expander("Raw data"):
            st.dataframe(df, use_container_width=True, height=400)
