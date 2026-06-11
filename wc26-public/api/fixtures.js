// Primary: worldcup26.ir (free, no rate limit)
// Fallback: API-Football via RapidAPI (100 req/day free, kicks in only if primary fails)

export default async function handler(req, res) {
  const wc26Token   = process.env.WC26_TOKEN   || null;
  const rapidApiKey = process.env.RAPIDAPI_KEY || null;

  // ── Try worldcup26.ir first ──────────────────────────────────────
  try {
    const headers = { "Content-Type": "application/json" };
    if (wc26Token) headers["Authorization"] = `Bearer ${wc26Token}`;

    const upstream = await fetch("https://worldcup26.ir/get/games", {
      headers,
      signal: AbortSignal.timeout(8000)   // 8s timeout — don't hang forever
    });

    if (upstream.ok) {
      const data = await upstream.json();
      let games = [];
      if      (Array.isArray(data))           games = data;
      else if (Array.isArray(data.data))      games = data.data;
      else if (Array.isArray(data.games))     games = data.games;
      else if (Array.isArray(data.matches))   games = data.matches;

      if (games.length > 0) {
        const mapStatus = s => {
          if (!s) return "NS";
          s = String(s).toLowerCase();
          if (s === "notstarted" || s === "not_started") return "NS";
          if (s === "1h")   return "1H";
          if (s === "ht")   return "HT";
          if (s === "2h")   return "2H";
          if (s === "et")   return "ET";
          if (s === "pen")  return "P";
          if (s === "ft" || s === "finished") return "FT";
          if (s === "live") return "1H";
          return "NS";
        };
        const fixtures = games
          .filter(g => !g.type || g.type === "group")
          .map(g => ({
            gameId:     parseInt(g.id),
            home:       g.home_team?.name_en || null,
            away:       g.away_team?.name_en || null,
            home_score: g.home_score != null ? parseInt(g.home_score) : null,
            away_score: g.away_score != null ? parseInt(g.away_score) : null,
            status:     mapStatus(g.time_elapsed),
            elapsed:    g.elapsed_time ? parseInt(g.elapsed_time) : null,
            kickoff:    g.date || null,
            finished:   g.finished === true || g.finished === "true"
          }));

        res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
        return res.status(200).json({
          fixtures,
          updated: new Date().toISOString(),
          source:  "worldcup26.ir",
          count:   fixtures.length
        });
      }
    }
    // If we get here, primary returned bad data — fall through to backup
    console.log("worldcup26.ir returned bad/empty data, trying fallback");
  } catch (err) {
    // Timeout, network error, parse error — fall through to backup
    console.log("worldcup26.ir failed:", err.message, "— trying fallback");
  }

  // ── Fallback: API-Football ───────────────────────────────────────
  if (!rapidApiKey) {
    return res.status(503).json({
      error: "Primary API unavailable and RAPIDAPI_KEY not set — no fallback available"
    });
  }

  try {
    const upstream = await fetch(
      "https://api-football-v1.p.rapidapi.com/v3/fixtures?league=1&season=2026",
      {
        headers: {
          "x-rapidapi-key":  rapidApiKey,
          "x-rapidapi-host": "api-football-v1.p.rapidapi.com"
        },
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({
        error: `API-Football returned ${upstream.status}`,
        detail: body.slice(0, 200)
      });
    }

    const data = await upstream.json();
    const LIVE = new Set(["1H","HT","2H","ET","BT","P","LIVE","INT"]);
    const DONE = new Set(["FT","AET","PEN"]);

    const fixtures = (data.response || [])
      .filter(f => /group/i.test(f.league?.round || ""))
      .map(f => ({
        gameId:     null,               // API-Football uses different IDs; fall back to name match
        home:       f.teams?.home?.name,
        away:       f.teams?.away?.name,
        home_score: f.goals?.home  ?? null,
        away_score: f.goals?.away  ?? null,
        status:     f.fixture?.status?.short,
        elapsed:    f.fixture?.status?.elapsed,
        kickoff:    f.fixture?.date,
        finished:   DONE.has(f.fixture?.status?.short)
      }));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      fixtures,
      updated: new Date().toISOString(),
      source:  "api-football (fallback)",
      count:   fixtures.length
    });
  } catch (err) {
    return res.status(500).json({ error: "Both data sources failed: " + err.message });
  }
}
