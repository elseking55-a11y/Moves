import React, { useEffect, useMemo, useRef, useState } from "react";

const PUBLIC_WS = "wss://ws.binaryws.com/websockets/v3";
const DEFAULT_SYMBOL = "1HZ100V";
const MARKET_OPTIONS = [
  ["1HZ100V", "Volatility 100 (1s)"],
  ["1HZ75V", "Volatility 75 (1s)"],
  ["1HZ50V", "Volatility 50 (1s)"],
  ["1HZ25V", "Volatility 25 (1s)"],
  ["1HZ10V", "Volatility 10 (1s)"]
];
const WINDOWS = [100, 500, 1000];

function digitOf(quote) {
  const digits = String(quote).replace(/\D/g, "");
  return digits ? Number(digits.at(-1)) : null;
}

function analyse(ticks, windowSize, strategy, targetDigit) {
  const sample = ticks.slice(-windowSize);
  const counts = Array(10).fill(0);
  sample.forEach((tick) => {
    const digit = digitOf(tick.quote);
    if (digit !== null) counts[digit] += 1;
  });
  const total = sample.length || 1;
  const ranked = counts.map((count, digit) => ({ digit, count, pct: count / total * 100 }))
    .sort((a, b) => b.count - a.count);
  const recent = sample.slice(-20).map((tick) => Number(tick.quote));
  let trend = "WAIT";
  if (recent.length >= 6) {
    const first = recent.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const last = recent.slice(-3).reduce((a, b) => a + b, 0) / 3;
    trend = last > first ? "UP" : last < first ? "DOWN" : "WAIT";
  }
  const targetPct = counts[targetDigit] / total * 100;
  let signal = "WAIT";
  let confidence = 0;

  if (sample.length >= 20) {
    if (strategy === "DIGITOVER") {
      confidence = counts.slice(targetDigit + 1).reduce((a, b) => a + b, 0) / total * 100;
      signal = confidence >= 50 ? "OVER" : "WAIT";
    } else if (strategy === "DIGITUNDER") {
      confidence = counts.slice(0, targetDigit).reduce((a, b) => a + b, 0) / total * 100;
      signal = confidence >= 50 ? "UNDER" : "WAIT";
    } else if (strategy === "DIGITEVEN") {
      confidence = counts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / total * 100;
      signal = confidence >= 50 ? "EVEN" : "WAIT";
    } else if (strategy === "DIGITODD") {
      confidence = counts.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / total * 100;
      signal = confidence >= 50 ? "ODD" : "WAIT";
    } else if (strategy === "DIGITMATCH") {
      confidence = targetPct;
      signal = targetPct >= 10 ? "MATCH" : "WAIT";
    } else if (strategy === "DIGITDIFF") {
      confidence = 100 - targetPct;
      signal = confidence >= 90 ? "DIFFER" : "WAIT";
    }
  }

  return {
    sample, counts, ranked, trend, signal,
    confidence: Math.min(99, Number(confidence.toFixed(1))),
    targetPct, top: ranked[0], second: ranked[1]
  };
}

export default function App() {
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [ticks, setTicks] = useState([]);
  const [status, setStatus] = useState("Disconnected");
  const [connecting, setConnecting] = useState(false);
  const [windowSize, setWindowSize] = useState(100);
  const [strategy, setStrategy] = useState("DIGITOVER");
  const [targetDigit, setTargetDigit] = useState(5);
  const [minConfidence, setMinConfidence] = useState(55);
  const [message, setMessage] = useState("");
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const manualCloseRef = useRef(false);

  const analysis = useMemo(() => analyse(ticks, windowSize, strategy, targetDigit),
    [ticks, windowSize, strategy, targetDigit]);

  const closeWs = () => {
    manualCloseRef.current = true;
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
    reconnectRef.current = null;
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
  };

  const subscribe = (socket, selectedSymbol) => {
    socket.send(JSON.stringify({ ticks: selectedSymbol, subscribe: 1, req_id: 20 }));
  };

  const connectPublic = (isReconnect = false) => {
    manualCloseRef.current = false;
    if (!isReconnect) {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    }
    setConnecting(true);
    setStatus("Connecting");
    setMessage("");
    const socket = new WebSocket(PUBLIC_WS);
    wsRef.current = socket;

    socket.onopen = () => {
      setConnecting(false);
      setStatus("Live");
      socket.send(JSON.stringify({
        ticks_history: symbol, count: 1000, end: "latest", style: "ticks", req_id: 11
      }));
      subscribe(socket, symbol);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          setMessage(data.error.message || "Deriv returned an error.");
          return;
        }
        if (data.msg_type === "history") {
          const prices = data.history?.prices || [];
          const times = data.history?.times || [];
          setTicks(prices.map((quote, i) => ({ quote, epoch: times[i] })).slice(-1000));
        }
        if (data.msg_type === "tick") {
          setTicks((old) => [...old, { quote: data.tick.quote, epoch: data.tick.epoch }].slice(-1000));
        }
      } catch {
        setMessage("Could not read the market update.");
      }
    };
    socket.onerror = () => {
      setConnecting(false);
      setStatus("Connection error");
    };
    socket.onclose = () => {
      setConnecting(false);
      setStatus("Disconnected");
      if (!manualCloseRef.current) {
        reconnectRef.current = setTimeout(() => connectPublic(true), 2500);
      }
    };
  };

  useEffect(() => {
    connectPublic();
    return closeWs;
  }, []);

  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ forget_all: "ticks" }));
      subscribe(wsRef.current, symbol);
      wsRef.current.send(JSON.stringify({
        ticks_history: symbol, count: 1000, end: "latest", style: "ticks", req_id: Date.now()
      }));
    }
  }, [symbol]);

  const signalReady = analysis.signal !== "WAIT" && analysis.confidence >= Number(minConfidence);

  return (
    <main className="app">
      <header className="site-header">
        <div>
          <div className="brand">ELISY254</div>
          <h1>Deriv Analysis</h1>
          <p>Live market data and statistical digit analysis.</p>
        </div>
        <div className="live-status">
          <span className={status === "Live" ? "status-dot live" : "status-dot"} />
          {status}
        </div>
      </header>

      {message && <div className="notice"><span>{message}</span><button onClick={() => setMessage("")}>Close</button></div>}

      <section className="entry card">
        <div>
          <span className="section-label">ENTRY</span>
          <h2>Start live analysis</h2>
          <p>No account or login is required to view public market data.</p>
        </div>
        <button className="primary-button" onClick={connectPublic} disabled={connecting}>
          {connecting ? "Connecting" : status === "Live" ? "Refresh live feed" : "Enter analysis"}
        </button>
      </section>

      <section className="card controls">
        <div className="field">
          <label>Market</label>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {MARKET_OPTIONS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Analysis window</label>
          <div className="segmented">
            {WINDOWS.map((size) => (
              <button key={size} className={windowSize === size ? "selected" : ""} onClick={() => setWindowSize(size)}>{size}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Strategy</label>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            <option value="DIGITOVER">Digit Over</option>
            <option value="DIGITUNDER">Digit Under</option>
            <option value="DIGITEVEN">Even</option>
            <option value="DIGITODD">Odd</option>
            <option value="DIGITMATCH">Matches</option>
            <option value="DIGITDIFF">Differs</option>
          </select>
        </div>
        <div className="field">
          <label>Target digit</label>
          <select value={targetDigit} onChange={(e) => setTargetDigit(Number(e.target.value))}>
            {Array.from({ length: 10 }, (_, digit) => <option key={digit} value={digit}>{digit}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Minimum confidence</label>
          <select value={minConfidence} onChange={(e) => setMinConfidence(Number(e.target.value))}>
            {[50, 55, 60, 65, 70, 75].map((value) => <option key={value} value={value}>{value}%</option>)}
          </select>
        </div>
      </section>

      <section className="stats">
        <div className="card stat"><span>Latest price</span><strong>{ticks.at(-1)?.quote ?? "Waiting"}</strong></div>
        <div className="card stat"><span>Ticks loaded</span><strong>{ticks.length}</strong></div>
        <div className="card stat"><span>Top digit</span><strong>{analysis.top?.digit ?? "Waiting"}</strong><small>{analysis.top ? analysis.top.pct.toFixed(1) + "%" : ""}</small></div>
        <div className="card stat"><span>Market direction</span><strong className={analysis.trend === "UP" ? "positive" : analysis.trend === "DOWN" ? "negative" : ""}>{analysis.trend}</strong></div>
      </section>

      <section className="signal card">
        <div>
          <span className="section-label">CURRENT SIGNAL</span>
          <h2>{analysis.signal}</h2>
          <p>{strategy.replace("DIGIT", "Digit ")} {["DIGITMATCH","DIGITDIFF","DIGITOVER","DIGITUNDER"].includes(strategy) ? "target " + targetDigit : ""}</p>
        </div>
        <div className={signalReady ? "confidence ready" : "confidence"}>
          <span>Confidence</span>
          <strong>{analysis.confidence}%</strong>
          <small>{signalReady ? "Signal meets threshold" : "Waiting for threshold"}</small>
        </div>
      </section>

      <section className="analysis-grid">
        <div className="card panel">
          <div className="panel-heading">
            <div><span className="section-label">DIGIT DISTRIBUTION</span><h2>0 to 9</h2></div>
            <span>{windowSize} ticks</span>
          </div>
          <div className="digits">
            {analysis.counts.map((count, digit) => {
              const pct = analysis.sample.length ? count / analysis.sample.length * 100 : 0;
              return <div className="digit-row" key={digit}><b>{digit}</b><div className="bar"><i style={{ width: Math.min(100, pct * 3) + "%" }} /></div><span>{pct.toFixed(1)}%</span></div>;
            })}
          </div>
        </div>

        <div className="card panel">
          <div className="panel-heading">
            <div><span className="section-label">RECENT TICKS</span><h2>Live feed</h2></div>
            <span>Latest 30</span>
          </div>
          <div className="ticks">
            {ticks.slice(-30).reverse().map((tick, index) => (
              <span key={String(tick.epoch) + "-" + index}>{Number(tick.quote).toFixed(4)}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="card panel">
        <div className="panel-heading">
          <div><span className="section-label">READING</span><h2>Current data</h2></div>
        </div>
        <div className="reading">
          <div><span>Most frequent digit</span><b>{analysis.top?.digit ?? "Waiting"}</b></div>
          <div><span>Second most frequent</span><b>{analysis.second?.digit ?? "Waiting"}</b></div>
          <div><span>Target frequency</span><b>{analysis.targetPct.toFixed(1)}%</b></div>
          <div><span>Window</span><b>{windowSize} ticks</b></div>
        </div>
      </section>

      <footer>ELISY254 · Live public Deriv market analysis · Automatic reconnect enabled</footer>
    </main>
  );
}
