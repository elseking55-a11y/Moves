import React, { useEffect, useMemo, useRef, useState } from "react";

const PUBLIC_WS = "wss://ws.binaryws.com/websockets/v3";
const API_BASE = "https://api.derivws.com";
const DEFAULT_SYMBOL = "1HZ100V";
const CLIENT_ID = import.meta.env.VITE_DERIV_CLIENT_ID || "";
const REDIRECT_URI = import.meta.env.VITE_DERIV_REDIRECT_URI || `${window.location.origin}/callback`;

const MARKET_OPTIONS = [
  ["1HZ100V", "Volatility 100 (1s)"],
  ["1HZ75V", "Volatility 75 (1s)"],
  ["1HZ50V", "Volatility 50 (1s)"],
  ["1HZ25V", "Volatility 25 (1s)"],
  ["1HZ10V", "Volatility 10 (1s)"]
];

function randomString(size = 64) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes) {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function startOAuth(signUp = false) {
  if (!CLIENT_ID) throw new Error("VITE_DERIV_CLIENT_ID is not configured.");
  const verifier = randomString(32);
  const state = randomString(24);
  const challenge = base64Url(await sha256(verifier));
  sessionStorage.setItem("deriv_pkce_verifier", verifier);
  sessionStorage.setItem("deriv_oauth_state", state);

  const url = new URL("https://auth.deriv.com/oauth2/auth");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "trade");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (signUp) url.searchParams.set("prompt", "registration");
  window.location.assign(url.toString());
}

async function exchangeCode() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const expected = sessionStorage.getItem("deriv_oauth_state");
  const verifier = sessionStorage.getItem("deriv_pkce_verifier");
  if (!code) throw new Error(params.get("error_description") || "No authorization code returned.");
  if (!state || state !== expected) throw new Error("OAuth state mismatch.");
  if (!verifier) throw new Error("OAuth verifier is missing.");

  const response = await fetch("/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || "Token exchange failed.");
  sessionStorage.setItem("deriv_access_token", data.access_token);
  if (data.expires_in) sessionStorage.setItem("deriv_token_expires", String(Date.now() + data.expires_in * 1000));
  sessionStorage.removeItem("deriv_pkce_verifier");
  sessionStorage.removeItem("deriv_oauth_state");
  window.history.replaceState({}, "", "/");
  return data.access_token;
}

function digitOf(quote) {
  const s = String(quote);
  const digits = s.replace(/\D/g, "");
  return digits ? Number(digits.at(-1)) : null;
}

function analyse(ticks) {
  const digits = Array(10).fill(0);
  ticks.forEach((t) => {
    const d = digitOf(t.quote);
    if (d !== null) digits[d] += 1;
  });
  const total = ticks.length || 1;
  const ranked = digits.map((count, digit) => ({ digit, count, pct: (count / total) * 100 }))
    .sort((a, b) => b.count - a.count);
  const recent = ticks.slice(-20).map((t) => Number(t.quote));
  let trend = "WAIT";
  if (recent.length >= 6) {
    const first = recent.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const last = recent.slice(-3).reduce((a, b) => a + b, 0) / 3;
    trend = last > first ? "UP" : last < first ? "DOWN" : "WAIT";
  }
  const top = ranked[0];
  const second = ranked[1];
  const confidence = Math.min(99, Math.round(50 + Math.abs((top.count - second.count) / total) * 100));
  return { digits, ranked, trend, confidence, top, second };
}

export default function App() {
  const [callback, setCallback] = useState(window.location.pathname === "/callback");
  const [token, setToken] = useState(() => sessionStorage.getItem("deriv_access_token") || "");
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [ticks, setTicks] = useState([]);
  const [status, setStatus] = useState("Disconnected");
  const [account, setAccount] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState("");
  const [balance, setBalance] = useState(null);
  const [currency, setCurrency] = useState("");
  const [autoTrade, setAutoTrade] = useState(false);
  const [stake, setStake] = useState(1);
  const [multiplier, setMultiplier] = useState(10);
  const [maxTrades, setMaxTrades] = useState(5);
  const [trades, setTrades] = useState([]);
  const [message, setMessage] = useState("");
  const [connecting, setConnecting] = useState(false);
  const wsRef = useRef(null);
  const tradeCountRef = useRef(0);
  const lastTradeAtRef = useRef(0);

  const analysis = useMemo(() => analyse(ticks), [ticks]);

  const send = (payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload));
  };

  const closeWs = () => {
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
  };

  const subscribeMarket = (socket, selectedSymbol) => {
    socket.send(JSON.stringify({ ticks: selectedSymbol, subscribe: 1, req_id: 20 }));
  };

  const connectPublic = () => {
    closeWs();
    setConnecting(true);
    setStatus("Connecting to live market...");
    const socket = new WebSocket(PUBLIC_WS);
    wsRef.current = socket;
    socket.onopen = () => {
      setConnecting(false);
      setStatus("Live market connected");
      socket.send(JSON.stringify({ active_symbols: "brief", product_type: "basic", req_id: 10 }));
      socket.send(JSON.stringify({ ticks_history: symbol, count: 200, end: "latest", style: "ticks", req_id: 11 }));
      subscribeMarket(socket, symbol);
    };
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) { setMessage(data.error.message || "Deriv returned an error."); return; }
      if (data.msg_type === "history") {
        const prices = data.history?.prices || [];
        const times = data.history?.times || [];
        setTicks(prices.map((quote, i) => ({ quote, epoch: times[i] })));
      }
      if (data.msg_type === "tick") {
        const tick = data.tick;
        setTicks((old) => [...old, { quote: tick.quote, epoch: tick.epoch }].slice(-1000));
      }
    };
    socket.onerror = () => { setConnecting(false); setStatus("Market connection error"); };
    socket.onclose = () => setStatus("Disconnected");
  };

  const authenticatedWs = async (id) => {
    if (!token) throw new Error("Sign in with Deriv first.");
    const response = await fetch(`${API_BASE}/trading/v1/options/accounts/${encodeURIComponent(id)}/otp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok || !data?.data?.url) throw new Error(data?.errors?.[0]?.message || "Could not create Deriv WebSocket session.");
    return data.data.url;
  };

  const connectAuthenticated = async (id = accountId) => {
    if (!id) throw new Error("Choose a Deriv account first.");
    closeWs();
    setConnecting(true);
    setStatus("Authorising trading connection...");
    const url = await authenticatedWs(id);
    const socket = new WebSocket(url);
    wsRef.current = socket;
    socket.onopen = () => {
      setConnecting(false);
      setStatus("Authenticated trading connection");
      socket.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 31 }));
      socket.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 32 }));
      socket.send(JSON.stringify({ ticks_history: symbol, count: 200, end: "latest", style: "ticks", req_id: 33 }));
    };
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) { setMessage(data.error.message || "Deriv error."); return; }
      if (data.msg_type === "balance") {
        setBalance(data.balance?.balance ?? null);
        setCurrency(data.balance?.currency || "");
      }
      if (data.msg_type === "history") {
        const prices = data.history?.prices || [];
        const times = data.history?.times || [];
        setTicks(prices.map((quote, i) => ({ quote, epoch: times[i] })));
      }
      if (data.msg_type === "tick") {
        setTicks((old) => [...old, { quote: data.tick.quote, epoch: data.tick.epoch }].slice(-1000));
      }
      if (data.msg_type === "buy") {
        const c = data.buy;
        setTrades((old) => [{ id: c.contract_id, status: "OPEN", stake: c.buy_price, profit: null, time: Date.now() }, ...old].slice(0, 30));
        send({ proposal_open_contract: 1, contract_id: c.contract_id, subscribe: 1, req_id: 700 + Number(c.contract_id || 1) });
      }
      if (data.msg_type === "proposal_open_contract") {
        const c = data.proposal_open_contract;
        if (c?.is_sold || c?.status === "sold") {
          setTrades((old) => old.map((t) => t.id === c.contract_id
            ? { ...t, status: c.profit >= 0 ? "WIN" : "LOSS", profit: c.profit }
            : t));
        }
      }
    };
    socket.onerror = () => { setConnecting(false); setStatus("Trading connection error"); };
    socket.onclose = () => setStatus("Disconnected");
  };

  const loadAccounts = async (accessToken = token) => {
    if (!accessToken) return;
    const response = await fetch(`${API_BASE}/trading/v1/options/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.errors?.[0]?.message || "Could not load Deriv accounts.");
    const list = data.data || data.accounts || [];
    setAccounts(list);
    const preferred = list.find((a) => a.account_type === "demo") || list[0];
    if (preferred) {
      setAccountId(preferred.id || preferred.account_id);
      setAccount(preferred);
    }
  };

  const requestProposalAndBuy = () => {
    if (!autoTrade || !token || !accountId) return;
    if (tradeCountRef.current >= Number(maxTrades)) return;
    if (Date.now() - lastTradeAtRef.current < 10000) return;
    if (analysis.trend === "WAIT" || analysis.confidence < 60) return;

    const contractType = analysis.trend === "UP" ? "MULTUP" : "MULTDOWN";
    const amount = Math.max(0.35, Number(stake) || 1);
    const reqId = Date.now();
    lastTradeAtRef.current = Date.now();
    send({
      proposal: 1,
      amount,
      basis: "stake",
      contract_type: contractType,
      currency: currency || account?.currency || "USD",
      duration_unit: "s",
      duration: 1,
      multiplier: Number(multiplier) || 10,
      underlying_symbol: symbol,
      req_id: reqId
    });

    const listener = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.req_id !== reqId) return;
        if (data.error) {
          setMessage(data.error.message || "Proposal failed.");
          wsRef.current?.removeEventListener("message", listener);
          return;
        }
        if (data.msg_type === "proposal" && data.proposal?.id) {
          send({ buy: data.proposal.id, price: Number(data.proposal.ask_price), req_id: reqId + 1 });
          tradeCountRef.current += 1;
          wsRef.current?.removeEventListener("message", listener);
        }
      } catch {}
    };
    wsRef.current?.addEventListener("message", listener);
  };

  useEffect(() => {
    if (callback) {
      exchangeCode()
        .then((newToken) => { setToken(newToken); setCallback(false); })
        .catch((e) => { setMessage(e.message); setCallback(false); });
      return;
    }
    connectPublic();
    return closeWs;
  }, []);

  useEffect(() => {
    if (token) loadAccounts(token).catch((e) => setMessage(e.message));
  }, [token]);

  useEffect(() => {
    if (!wsRef.current || status === "Disconnected") return;
    if (wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ forget_all: "ticks" }));
      subscribeMarket(wsRef.current, symbol);
    }
  }, [symbol]);

  useEffect(() => {
    if (!autoTrade || !token || !accountId) return;
    const timer = setInterval(requestProposalAndBuy, 1000);
    return () => clearInterval(timer);
  }, [autoTrade, token, accountId, analysis.trend, analysis.confidence, symbol, stake, multiplier, maxTrades]);

  const logout = () => {
    setToken("");
    sessionStorage.removeItem("deriv_access_token");
    closeWs();
    setAccount(null);
    setAccounts([]);
    setAccountId("");
    setBalance(null);
    tradeCountRef.current = 0;
    connectPublic();
  };

  if (callback) {
    return <main className="center"><div className="loader-card"><div className="spinner" /><h2>Connecting to Deriv…</h2><p>Completing secure sign-in.</p></div></main>;
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <div className="eyebrow">ELISY254</div>
          <h1>DERIV ANALYSIS BOT</h1>
          <p className="muted">Live ticks • statistics • optional automated trading</p>
        </div>
        <div className="auth-actions">
          {token ? (
            <button className="button ghost" onClick={logout}>Sign out</button>
          ) : (
            <>
              <button className="button" onClick={() => startOAuth(false).catch((e) => setMessage(e.message))}>Sign in</button>
              <button className="button secondary" onClick={() => startOAuth(true).catch((e) => setMessage(e.message))}>Sign up</button>
            </>
          )}
        </div>
      </header>

      {message && <div className="notice">{message}<button onClick={() => setMessage("")}>×</button></div>}

      <section className="controls card">
        <div className="field">
          <label>Market</label>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {MARKET_OPTIONS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Analysis window</label>
          <div className="value-box">{ticks.length} / 1000 ticks</div>
        </div>
        <div className="field">
          <label>Connection</label>
          <div className="value-box"><span className={status.includes("connected") || status.includes("Authenticated") ? "dot live" : "dot"} />{status}</div>
        </div>
        <div className="control-buttons">
          <button className="button" disabled={connecting} onClick={() => connectPublic()}>
            {connecting ? "Connecting…" : "Live analysis"}
          </button>
          {token && accountId && <button className="button secondary" onClick={() => connectAuthenticated(accountId).catch((e) => setMessage(e.message))}>Trading connection</button>}
        </div>
      </section>

      <section className="grid stats">
        <div className="stat card"><span>Last price</span><strong>{ticks.at(-1)?.quote ?? "—"}</strong></div>
        <div className="stat card"><span>Signal</span><strong className={analysis.trend === "UP" ? "positive" : analysis.trend === "DOWN" ? "negative" : ""}>{analysis.trend}</strong></div>
        <div className="stat card"><span>Signal strength</span><strong>{analysis.confidence}%</strong></div>
        <div className="stat card"><span>Top digit</span><strong>{analysis.top?.digit ?? "—"} <small>{analysis.top ? analysis.top.pct.toFixed(1) + "%" : ""}</small></strong></div>
      </section>

      <section className="grid main-grid">
        <div className="card panel">
          <div className="panel-title"><h2>Digit analysis</h2><span>{ticks.length} ticks</span></div>
          <div className="digits">
            {analysis.digits.map((count, digit) => {
              const pct = ticks.length ? (count / ticks.length) * 100 : 0;
              return <div className="digit-row" key={digit}>
                <b>{digit}</b><div className="bar"><i style={{ width: `${Math.min(100, pct * 3)}%` }} /></div><span>{count} · {pct.toFixed(1)}%</span>
              </div>;
            })}
          </div>
        </div>

        <div className="card panel">
          <div className="panel-title"><h2>Trading controls</h2><span>{token ? "Authorised" : "Read-only"}</span></div>
          {!token ? <div className="empty">Sign in with Deriv to enable account connection and trading.</div> : (
            <>
              <div className="account-row">
                <select value={accountId} onChange={(e) => {
                  setAccountId(e.target.value);
                  const a = accounts.find((x) => (x.id || x.account_id) === e.target.value);
                  setAccount(a || null);
                }}>
                  {accounts.map((a) => <option key={a.id || a.account_id} value={a.id || a.account_id}>{a.id || a.account_id} · {a.account_type || "account"}</option>)}
                </select>
                <div className="balance">{balance == null ? "—" : `${balance} ${currency}`}</div>
              </div>
              <div className="form-grid">
                <div className="field"><label>Stake</label><input type="number" min="0.35" step="0.1" value={stake} onChange={(e) => setStake(e.target.value)} /></div>
                <div className="field"><label>Multiplier</label><input type="number" min="1" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} /></div>
                <div className="field"><label>Max auto trades</label><input type="number" min="1" value={maxTrades} onChange={(e) => setMaxTrades(e.target.value)} /></div>
              </div>
              <div className={`auto-box ${autoTrade ? "enabled" : ""}`}>
                <div><b>Auto Trade</b><small>{autoTrade ? "ACTIVE — trades are allowed" : "OFF — analysis only"}</small></div>
                <button className={`switch ${autoTrade ? "on" : ""}`} onClick={() => {
                  if (!autoTrade) tradeCountRef.current = 0;
                  setAutoTrade((v) => !v);
                }}><span /></button>
              </div>
              <p className="warning">Auto Trade can place real-money orders on a real account. Use a demo account while testing and keep the limit low.</p>
            </>
          )}
        </div>
      </section>

      <section className="card panel">
        <div className="panel-title"><h2>Recent ticks</h2><span>Latest 30</span></div>
        <div className="ticks">{ticks.slice(-30).reverse().map((t, i) => <span key={i}>{Number(t.quote).toFixed(4)}</span>)}</div>
      </section>

      <section className="card panel">
        <div className="panel-title"><h2>Trade journal</h2><span>{trades.length} records</span></div>
        {trades.length === 0 ? <div className="empty">No trades yet.</div> : <div className="journal">
          {trades.map((t) => <div className="trade" key={t.id}><b>#{t.id}</b><span>{t.status}</span><span>{t.stake ?? "—"}</span><strong className={t.profit > 0 ? "positive" : t.profit < 0 ? "negative" : ""}>{t.profit == null ? "Open" : Number(t.profit).toFixed(2)}</strong></div>)}
        </div>}
      </section>

      <footer>ELISY254 • Deriv live market analysis</footer>
    </main>
  );
}
