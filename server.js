// Trading-Desk: Seite + API (Kurse und Nachrichten, 5 Minuten Cache)
// Läuft ohne zusätzliche Pakete auf Node.js 18 oder neuer: node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const TTL = 5 * 60 * 1000;
const UA = { "user-agent": "Mozilla/5.0 (Aktienrechner)" };

// Hier Aktien ergänzen oder entfernen. y = Yahoo-Symbol, q = Suchbegriff für Nachrichten.
const STOCKS = [
  { id: "apple", name: "Apple", ticker: "AAPL", y: "AAPL", q: "Apple Aktie" },
  { id: "microsoft", name: "Microsoft", ticker: "MSFT", y: "MSFT", q: "Microsoft Aktie" },
  { id: "nvidia", name: "NVIDIA", ticker: "NVDA", y: "NVDA", q: "NVIDIA Aktie" },
  { id: "alphabet", name: "Alphabet", ticker: "GOOGL", y: "GOOGL", q: "Alphabet Aktie" },
  { id: "sap", name: "SAP", ticker: "SAP", y: "SAP.DE", q: "SAP Aktie" },
  { id: "siemens", name: "Siemens", ticker: "SIE", y: "SIE.DE", q: "Siemens Aktie" },
  { id: "allianz", name: "Allianz", ticker: "ALV", y: "ALV.DE", q: "Allianz Aktie" },
  { id: "amazon", name: "Amazon", ticker: "AMZN", y: "AMZN", q: "Amazon Aktie" },
  { id: "tesla", name: "Tesla", ticker: "TSLA", y: "TSLA", q: "Tesla Aktie" },
  { id: "coca-cola", name: "Coca-Cola", ticker: "KO", y: "KO", q: "Coca-Cola Aktie" },
  { id: "msci-world", name: "iShares Core MSCI World ETF", ticker: "EUNL", y: "EUNL.DE", q: "MSCI World ETF" },
];

// Kursquelle: inoffizielle Yahoo-Finance-Schnittstelle (ohne Schlüssel, ca. 15 Minuten verzögert).
// Wenn du einen Anbieter mit API-Schlüssel nutzen willst, ersetze nur diese Funktion.
async function getQuote(s) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(s.y) + "?range=5d&interval=1d";
  const j = await (await fetch(url, { headers: UA })).json();
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("keine Daten");
  const closes = (r.indicators.quote[0].close || []).filter((x) => x != null);
  const price = r.meta.regularMarketPrice;
  const prev = closes.length > 1 ? closes[closes.length - 2] : r.meta.chartPreviousClose;
  return {
    price: price,
    currency: r.meta.currency,
    changePct: prev ? Math.round((price / prev - 1) * 10000) / 100 : undefined,
    asOf: new Date(r.meta.regularMarketTime * 1000).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" }) + " Uhr",
  };
}

const clean = (t) => t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

// Nachrichten: Google-News-RSS (ohne Schlüssel)
async function getNews(s, lim) {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(s.q) + "&hl=de&gl=DE&ceid=DE:de";
  const xml = await (await fetch(url, { headers: UA })).text();
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < (lim || 3)) {
    const pick = (tag) => { const x = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">").exec(m[1]); return x ? clean(x[1]) : ""; };
    const source = pick("source");
    let title = pick("title");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const link = pick("link");
    if (title && link.startsWith("https://")) items.push({ title, source, url: link });
  }
  return items;
}


// ---------- Trading-Desk: Kerzen, Scanner, KI ----------
const okSym = (s) => /^[A-Za-z0-9.^=\-]{1,12}$/.test(s || "");
const CH = new Map();
async function cached(k, ttl, fn) {
  const h = CH.get(k);
  if (h && Date.now() - h.at < ttl) return h.v;
  const v = await fn();
  CH.set(k, { at: Date.now(), v });
  if (CH.size > 300) CH.delete(CH.keys().next().value);
  return v;
}
const RANGE = { "5m": "5d", "15m": "1mo", "1d": "6mo" };
async function candles(sym, iv, range) {
  iv = RANGE[iv] ? iv : "5m";
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=" + (range || RANGE[iv]) + "&interval=" + iv;
  const j = await (await fetch(url, { headers: UA })).json();
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("keine Daten");
  const q = r.indicators.quote[0], rows = [];
  (r.timestamp || []).forEach((t, i) => {
    if (q.close[i] != null && q.open[i] != null && q.high[i] != null && q.low[i] != null)
      rows.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return { sym, currency: r.meta.currency, tz: r.meta.exchangeTimezoneName || "UTC", prevClose: r.meta.chartPreviousClose, rows };
}
async function scanOne(sym) {
  const c = await candles(sym, "5m", "1d");
  if (!c.rows.length) throw new Error("leer");
  const last = c.rows[c.rows.length - 1].c, first = c.rows.slice(0, 3);
  const hi = Math.max(...first.map((r) => r.h)), lo = Math.min(...first.map((r) => r.l));
  return {
    sym, price: last, currency: c.currency,
    chg: c.prevClose ? Math.round((last / c.prevClose - 1) * 10000) / 100 : 0,
    gap: c.prevClose ? Math.round((c.rows[0].o / c.prevClose - 1) * 10000) / 100 : 0,
    orb: c.rows.length < 4 ? "in" : last > hi ? "up" : last < lo ? "dn" : "in",
  };
}
const D = () => new Date().toISOString().slice(0, 10);
const TAIL = " Das ist keine Anlageberatung: kennzeichne Unsicherheit und nenne Quellen mit Datum.";
const PROMPTS = {
  signal: (t) => `You are a stock analyst. Today is ${D()}. For ${t}: pull the top 3-5 news events from the last 30 days with bull/bear impact labels. Include key fundamentals (P/E, growth rate, debt ratio) and a sentiment score (bullish/neutral/bearish) from social and search trends. Project a 6-month and 1-year price range based on analyst targets and event risks. Return a final signal: BUY (up >20%), HOLD (+10%), or SELL (down >20%) with a confidence percentage. Search the web for current data. Reply with ONLY structured JSON, no markdown, with fields: ticker, signal, confidence, price_6mo, price_1yr, fundamentals, sentiment, events. Write text values in German.`,
  why: (t) => `Today is ${D()}. For ticker ${t}, cover: 1. The dominant narrative on social media (X / Reddit / TikTok) - what are retail investors saying? 2. The actual catalyst - earnings, contract win, partnership, policy change, etc. Be specific with numbers and dates. 3. The institutional view - what are professional analysts saying? Recent target changes, upgrades, downgrades. Search the web if needed. Keep each bullet under 3 sentences. End with a one-line summary: "The stock is moving because [X], but [Y] is the part nobody is talking about." Answer in German.` + TAIL,
  fund: (t) => `Today is ${D()}. For ticker ${t}, give me a fundamental snapshot in 4 numbers: 1. Current price + market cap + 30-day performance. 2. Forward P/E and EV/Sales, and how these compare to the sector average. 3. Last quarter revenue growth + earnings growth. 4. Cash position vs debt + share count change YoY (dilution check). Then tell me: is the stock trading above, at, or below its fundamental fair value? Show the math. One paragraph max. Search the web for current data. Answer in German.` + TAIL,
  scen: (t) => `Today is ${D()}. For ticker ${t}, build a 4-scenario price target framework: Bear case (3-6 months): what price if the catalyst disappoints? Base case (6-12 months): what price if execution holds? Bull case (12-18 months): what price if everything works? Stretched bull (24 months): what is the absolute ceiling? Show the math for each (multiple x EPS or sales). Then end with: Entry zone (where to buy), Trim levels (where to take profits), Hard stop (where the thesis breaks). Search the web for current data. Answer in German.` + TAIL,
  congress: (t) => `Today is ${D()}. Search the web for trades in ${t} disclosed by members of the US Congress in the last 90 days. Reply with ONLY a JSON array, no markdown, items with fields: member, party, chamber, side (buy/sell), amount_range, trade_date, disclosure_date. Return [] if you find none. Never invent entries.`,
};
async function ask(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5", max_tokens: 2500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || "KI-Fehler " + r.status);
  return j.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

async function build() {
  const items = await Promise.all(STOCKS.map(async (s) => {
    const o = { id: s.id, name: s.name, ticker: s.ticker, live: "https://finance.yahoo.com/quote/" + s.y, news: [] };
    const [q, n] = await Promise.allSettled([getQuote(s), getNews(s)]);
    if (q.status === "fulfilled") Object.assign(o, q.value);
    if (n.status === "fulfilled") o.news = n.value;
    return o;
  }));
  return { updatedAt: new Date().toISOString(), items };
}

let cache = { at: 0, data: null, pending: null };
async function radar() {
  if (cache.data && Date.now() - cache.at < TTL) return cache.data;
  if (!cache.pending) {
    cache.pending = build().then((d) => { cache = { at: Date.now(), data: d, pending: null }; return d; })
      .catch((e) => { cache.pending = null; if (cache.data) return cache.data; throw e; });
  }
  return cache.pending;
}

const server = http.createServer(async (req, res) => {
  const p = req.url.split("?")[0];
  try {
    const qs = new URL(req.url, "http://x").searchParams, sy = (qs.get("s") || "").toUpperCase();
    const js = (c, o) => { res.writeHead(c, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
    if (p === "/api/candles") {
      if (!okSym(sy)) return js(400, { error: "Symbol" });
      const iv = qs.get("i") || "5m";
      return js(200, await cached("c" + sy + iv, 60000, () => candles(sy, iv)));
    }
    if (p === "/api/news") {
      if (!okSym(sy)) return js(400, { error: "Symbol" });
      return js(200, await cached("n" + sy, 300000, () => getNews({ q: sy + " Aktie" }, 8)));
    }
    if (p === "/api/scan") {
      const l = (qs.get("s") || "").split(",").map((x) => x.trim().toUpperCase()).filter(okSym).slice(0, 25);
      const r = await Promise.all(l.map((x) => cached("s" + x, 60000, () => scanOne(x)).catch(() => null)));
      return js(200, r.filter(Boolean));
    }
    if (p === "/api/ai") {
      const m = qs.get("mode");
      if (!PROMPTS[m] || !okSym(sy)) return js(400, { error: "Anfrage ungültig" });
      if (!process.env.ANTHROPIC_API_KEY) return js(200, { error: "Die KI ist noch nicht eingerichtet: Lege in Render unter Environment die Variable ANTHROPIC_API_KEY an." });
      if (!process.env.DESK_KEY) return js(200, { error: "Lege in Render zusätzlich die Variable DESK_KEY an (ein eigenes Passwort), damit niemand sonst deine KI-Kosten verursachen kann." });
      if (req.headers["x-desk-key"] !== process.env.DESK_KEY) return js(401, { error: "Schlüssel falsch" });
      return js(200, { text: await cached("a" + m + sy, 600000, () => ask(PROMPTS[m](sy))) });
    }
    if (p === "/api/radar") {
      const d = await radar();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify(d));
    }
    if (p === "/" || p === "/index.html") {
      const nm = "index.html";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const f = [path.join(__dirname, "public", nm), path.join(__dirname, nm)].find(fs.existsSync);
      return res.end(fs.readFileSync(f));
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Nicht gefunden");
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Kursdaten nicht erreichbar" }));
  }
});

if (require.main === module) server.listen(PORT, () => console.log("Trading-Desk läuft auf http://localhost:" + PORT));
module.exports = { build, getQuote, getNews };
