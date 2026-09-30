export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { client_id, code, code_verifier, redirect_uri } = req.body || {};
    if (!client_id || !code || !code_verifier || !redirect_uri) {
      return res.status(400).json({ error: "Missing OAuth parameters" });
    }

    const upstream = await fetch("https://auth.deriv.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        code,
        code_verifier,
        redirect_uri
      })
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message || "OAuth exchange failed" });
  }
}