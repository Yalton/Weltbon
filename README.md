# Weltbon

Self-hosted worldbuilding: write entries, link them, explore the graph, and export your work.

## Run with Docker

Requires Docker Compose and access to the Gitea repository. The SSH URL below needs a key registered with Gitea.

```bash
git clone git@repo.billbert.co:yalt/Weltbon.git Weltbon
cd Weltbon
cp .env.example .env
```

In `.env`, set `JWT_SECRET` (run `openssl rand -hex 32`), `POSTGRES_PASSWORD` (also replace the password in `DATABASE_URL`), and an `INVITE_CODE` of at least 16 characters. For sync or saved LLM keys, also set `LLM_KEY_ENCRYPTION_KEY` to a separate `openssl rand -hex 32` value. Paste generated values literally.

```bash
docker compose up --build -d
curl http://localhost:3000/health
```

Open `http://localhost:3000/register` and use your invite code. Back up `.env`, the PostgreSQL database, and the `uploads` volume before updating.

## More

- [Desktop app](docs/desktop-app.md)
- [HTTPS reverse proxy](docs/reverse-proxy/README.md)
- [License](LICENSE)
