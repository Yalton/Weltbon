# Put Weltbon behind HTTPS

Use the [Caddy example](Caddyfile.example) or [nginx example](nginx.conf.example) for a Weltbon instance listening on port 3000. Both proxy the app and API through one upstream.

1. Replace `welt.example.com` with your domain.
2. Point the proxy upstream to `localhost:3000`, or to `app:3000` if the proxy shares Weltbon's Compose network.
3. Set `WELTBON_PUBLIC_ORIGIN=https://welt.example.com` and `WELTBON_TRUST_PROXY=true` in Weltbon's `.env`, run `docker compose up -d app` to apply the new environment, then reload the proxy.
4. Open `https://welt.example.com` and check `https://welt.example.com/health`.

Caddy obtains and renews a TLS certificate automatically when the domain reaches it. For nginx, configure a valid certificate and key in the example before enabling the site. Keep the forwarded-header settings from the examples: they prevent a client from supplying a false public origin.

`WELTBON_TRUST_PROXY=true` tells Weltbon to take the visitor's address from `X-Forwarded-For`, which the public invitation-request form uses for rate limiting. Without it, every visitor looks like the proxy and shares one limit. Only set it when a proxy that overwrites the header, like the examples, is the only way to reach the app.
