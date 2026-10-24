import { useEffect, useRef, useState } from "react";
import { api, gifProxyUrl, type GifResult } from "./api.ts";

export type GifProvider = "giphy" | "tenor";

// Asked once per page load: the server only reports a provider whose API key it has verified.
let searchProvider: Promise<GifProvider | null> | undefined;

/** The GIF search provider, null if search isn't available, undefined while checking. */
export function useGifSearch() {
  const [provider, setProvider] = useState<GifProvider | null | undefined>(undefined);
  useEffect(() => {
    searchProvider ??= api.gifConfig().then(
      ({ search }) => search,
      () => null,
    );
    let current = true;
    void searchProvider.then((p) => current && setProvider(p));
    return () => {
      current = false;
    };
  }, []);
  return provider;
}

/** GIF search. Picking a GIF sends its link, which chat renders as the GIF. */
export function GifTab({ provider, onPick }: { provider: GifProvider; onPick: (url: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const search = async (q: string, pos: string | null) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.gifSearch(q, pos);
      if (id !== requestId.current) return; // a newer search started meanwhile
      setResults((prev) => (pos ? [...prev, ...page.results] : page.results));
      setNext(page.next);
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  // Trending when empty; search as you type (debounced).
  useEffect(() => {
    const timer = setTimeout(() => void search(query.trim(), null), query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [query, provider]);

  // Two-column masonry: each GIF goes to the shorter column.
  const columns: GifResult[][] = [[], []];
  const heights = [0, 0];
  for (const r of results) {
    const col = heights[0]! <= heights[1]! ? 0 : 1;
    columns[col]!.push(r);
    heights[col]! += r.height / r.width;
  }

  return (
    <div className="gif-tab">
      <input
        className="gif-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={provider === "tenor" ? "Search Tenor" : "Search GIPHY"}
        autoFocus
      />
      <div className="gif-results">
        {error && <p className="gif-picker-message">{error}</p>}
        {!error && !loading && results.length === 0 && <p className="gif-picker-message">No GIFs found.</p>}
        <div className="gif-columns">
          {columns.map((col, i) => (
            <div key={i} className="gif-column">
              {col.map((r) => (
                <button
                  key={r.id}
                  className="gif-result"
                  title={r.title}
                  onClick={() => onPick(r.url)}
                  style={{ aspectRatio: `${r.width} / ${r.height}` }}
                >
                  <video src={gifProxyUrl(r.preview)} autoPlay loop muted playsInline />
                </button>
              ))}
            </div>
          ))}
        </div>
        {next && !loading && (
          <button className="secondary gif-more" onClick={() => void search(query.trim(), next)}>
            Load more
          </button>
        )}
        {loading && <p className="gif-picker-message">Loading…</p>}
      </div>
      <div className="gif-attribution">{provider === "tenor" ? "Via Tenor" : "Powered by GIPHY"}</div>
    </div>
  );
}
