# Moves — ELISY254 Deriv Analysis Bot

A Vite/React web app for live Deriv market analysis with an explicit, opt-in automated trading layer.

## Included

- Live public Deriv tick stream.
- 200-tick startup history and up to 1,000 ticks retained.
- Last-digit frequency analysis for 0–9.
- Simple short-window UP/DOWN signal calculation.
- Deriv OAuth 2.0 + PKCE sign-in/sign-up.
- Deriv Options account discovery.
- Authenticated WebSocket connection through Deriv's OTP flow.
- Balance streaming.
- Proposal → buy → open-contract monitoring.
- Auto Trade is **OFF by default** and has a configurable trade-count limit.
- Trade journal.

Deriv's current API documentation describes public WebSocket market data, OAuth 2.0, OTP-authenticated account WebSockets, proposal/buy operations, and open-contract monitoring. See the official documentation: https://developers.deriv.com/docs/

## Environment

Create:

```
VITE_DERIV_CLIENT_ID=YOUR_DERIV_OAUTH_CLIENT_ID
VITE_DERIV_REDIRECT_URI=https://YOUR-DOMAIN/callback
```

The redirect URI must exactly match the URI registered in the Deriv developer dashboard.

For local development:

```
VITE_DERIV_CLIENT_ID=YOUR_CLIENT_ID
VITE_DERIV_REDIRECT_URI=http://localhost:5173/callback
```

## Deploy

This repository is ready for Vercel:

- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

The `api/oauth/token.js` function performs the OAuth authorization-code exchange server-side.

## Safety

Auto Trade is intentionally opt-in. Test with a demo account before using a real account. The analysis signal is a statistical rule, not a guarantee of a future market outcome.
