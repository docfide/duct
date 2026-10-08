# Deploying Duct in your own cloud

Duct can run as one shared server for a team, on infrastructure you control: your documents, the index and the audit log stay there. People open it in their browser and sign in with your organisation's identity provider.

What you need:

- a server or cluster with a persistent disk (2 vCPU and 4 GB of RAM is plenty for tens of thousands of documents);
- a domain name, e.g. `duct.example.com`, with its DNS pointing at the server;
- an app registered with your identity provider (below).

Two ready-made setups are in [`deploy/`](../deploy):

| Setup | Files | HTTPS |
|---|---|---|
| One server with Docker Compose | `docker-compose.yml`, `Caddyfile`, `.env.example` | Caddy gets and renews a Let's Encrypt certificate on its own |
| Kubernetes | `kubernetes/duct.yaml` | Your ingress controller and cert-manager |

## 1. Register Duct with your identity provider

Create an OpenID Connect web application (a confidential client) with:

- **Redirect URI:** `https://duct.example.com/auth/callback`
- **Scopes:** `openid email profile`

Then note the issuer URL, client ID and client secret.

| Provider | Issuer URL | Where |
|---|---|---|
| Google Workspace | `https://accounts.google.com` | Google Cloud console › APIs & Services › Credentials › OAuth client ID (Web application) |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Entra admin centre › App registrations › New registration (Web platform), then Certificates & secrets |
| Okta | `https://<your-org>.okta.com` | Applications › Create App Integration › OIDC › Web Application |
| Any other OIDC provider | Its issuer (the address before `/.well-known/openid-configuration`) | |

Duct only accepts verified email addresses. Microsoft accounts are identified by the `email` claim, or by `preferred_username` when `email` is absent; use a single-tenant registration so only your directory can sign in.

## 2. Decide who gets in

| Setting | Who |
|---|---|
| `DUCT_ADMIN_EMAILS` | Admins: settings, sources, deletes, the audit log. At least one is required. |
| `DUCT_ALLOW_DOMAINS` | Everyone with an address at these domains, as members (search, open, add documents). |
| `DUCT_ALLOW_EMAILS` | Individual members, e.g. contractors on another domain. |

Lists are comma-separated. They're checked on every request, so removing someone and restarting takes effect immediately, even for people who are already signed in.

## 3a. Docker Compose

```bash
cd deploy
cp .env.example .env        # fill in DUCT_DOMAIN, the DUCT_OIDC_* values, the people, and:
openssl rand -hex 32        # → DUCT_SESSION_SECRET
docker compose up -d --build
```

Open ports 80 and 443. Caddy fetches the certificate the first time someone visits `https://duct.example.com`.

The folder named by `DUCT_DOCS` is mounted read-only at `/docs`. To have Duct keep it in sync, add it in **Settings › Library › Watch a folder** (`/docs`, or a subfolder of it). To add more folders, add more read-only mounts under `/docs/`.

## 3b. Kubernetes

```bash
kubectl create namespace duct
kubectl -n duct create secret generic duct --from-env-file=deploy/.env
# edit deploy/kubernetes/duct.yaml: replace duct.example.com, and set your ingress class and certificate issuer
kubectl -n duct apply -f deploy/kubernetes/duct.yaml
```

Run **one replica**. The index is a SQLite database on a `ReadWriteOnce` volume, and the Deployment uses the `Recreate` strategy so two pods never write to it at once. The container runs as an unprivileged user (uid 1000) with every capability dropped. Its readiness and liveness probes use `/healthz`.

## Behind a proxy

Both setups set `DUCT_TRUST_PROXY=1`. Duct then takes each person's address from the proxy's `X-Forwarded-For` header, which the per-person rate limits rely on, and knows the connection is HTTPS. Set it to the number of proxies in front of Duct, and never set it when Duct is reachable directly.

`--allowed-host duct.example.com` makes Duct reject requests addressed to any other hostname.

## Cloud sources

On a server, Google Drive, OneDrive and SharePoint sign-ins come back to `https://duct.example.com/connectors/callback`. Your browser is sent to the provider and then returned to Duct, so the server needs no browser of its own. Register your own OAuth apps for this:

| Source | App | Settings |
|---|---|---|
| Google Drive | Google Cloud OAuth client (Web application), Drive API enabled, scope `drive.readonly` | `DUCT_GOOGLE_CLIENT_ID`, `DUCT_GOOGLE_CLIENT_SECRET` |
| OneDrive and SharePoint | Entra app registration, redirect URI under *Mobile and desktop applications*, delegated `Files.Read.All`, `Sites.Read.All`, `User.Read`, `offline_access` | `DUCT_MICROSOFT_CLIENT_ID` |
| S3 and S3-compatible stores | An access key that can only `s3:ListBucket` and `s3:GetObject` on the bucket | Entered in Settings › Library |

Connector tokens and S3 keys are kept in `connector-tokens.json` in the data volume, readable only by the Duct user. See [connectors.md](connectors.md).

## The audit log

Shared servers record:

- sign-ins;
- searches and questions;
- documents opened, added, removed and exported;
- changes made by admins.

Each entry records who did it, their role, the time and the document involved. By default the search text itself isn't recorded. To record it, add `--audit-queries`.

- Admins can read the log in **Settings › Audit log**, or download it as CSV from `GET /api/audit?format=csv`.
- Entries are kept for 365 days; change this with `--audit-days`.
- `--no-audit` turns the log off.

## Backups and upgrades

- **Back up:** everything Duct keeps is in the data volume (`/data`). Back it up with your usual volume snapshots. To copy it consistently, stop the container first (`docker compose stop duct`).
- **Upgrade:** set `DUCT_IMAGE` to the new release tag, then `docker compose pull && docker compose up -d`. In Kubernetes, change the image tag. Duct migrates its database on start. Images are at `ghcr.io/docfide/duct`: `:latest` is the newest stable release and `:next` the newest prerelease.
- **Restore:** put the volume back and start Duct.

## Also possible

- **Tokens instead of sign-in:** for scripts and integrations, set `DUCT_AUTH_TOKEN` (admin) and `DUCT_MEMBER_TOKENS`. These work alongside OIDC sign-in.
- **API keys:** the developer API (`/v1`) uses its own API keys. See [developer-api.md](developer-api.md).
- **Without Docker:** run `npx @docfide/duct serve --host 0.0.0.0 --public-url https://… --oidc-issuer …` behind any TLS-terminating proxy. Every setting above also has a command-line flag (`duct serve --help`).
