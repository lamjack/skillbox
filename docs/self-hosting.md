# Self-hosting

Skillbox runs on your own Docker host with PostgreSQL. Source builds do not require a hosted Skillbox account, registry login, API key, public domain or host Node/Bun installation. Jev stays optional and requires your own key in Settings.

## Docker-only quick start

From a reviewed source checkout or extracted source release:

```sh
bash scripts/skillbox.sh setup
bash scripts/skillbox.sh start
bash scripts/skillbox.sh status
```

Setup runs the pinned Bun helper in a short-lived network-disabled container using your UID/GID. It generates unique `.env` credentials with mode 0600 on POSIX, never prints their values and refuses to overwrite existing configuration. Read the owner login key locally from `.env`; don't send it to a support channel. Protect equivalent file ACLs on Windows.

Open `http://127.0.0.1:4791`. A fresh library is empty. Create skills, a profile and scoped client keys. Provider settings are not required for normal library use.

## LAN or custom port

Choose the actual browser origin and explicit bind address during initial setup:

```sh
bash scripts/skillbox.sh setup --origin http://server.local:8499 --bind 0.0.0.0 --port 8499
bash scripts/skillbox.sh start
```

For existing installs, edit only the corresponding values in the protected `.env`: `SKILLBOX_ORIGIN`, `SKILLBOX_BIND_ADDRESS`, and `SKILLBOX_PORT`. Never regenerate owner/database credentials just to change a port. Restart the app deliberately after reviewing config changes.

The default bind is loopback. `0.0.0.0` exposes the app on all IPv4 interfaces; use a firewall and a trusted LAN. **HTTP transmits client credentials and content without encryption. Use HTTPS or an SSH tunnel for untrusted networks.**

The CLI refuses non-local HTTP by default. If you deliberately use a trusted LAN, opt in using `SKILLBOX_ALLOW_INSECURE_HTTP=1` or `"allowInsecureHttp": true` in that client's protected config. The optional client installer requires the same explicit JSON option for each HTTP client. This never disables HTTPS certificate validation.

The server publishes `GET /cli/checksums.json` with the SHA-256 digests of `/cli/skillbox.mjs`, `/cli/package.mjs`, and `/bootstrap/SKILL.md`. The client installer downloads these files, verifies each digest before writing anything, and aborts on any mismatch. For out-of-band pinning, pass `--expected-checksums <path>` with a checksums file obtained through a channel you trust instead of trusting the same server to vouch for its own downloads.

## Optional self-hosted GitLab import

Set `SKILLBOX_GITLAB_HOST` in `.env` to the bare hostname of your GitLab instance (optional `:port`; https only — for example `gitlab.example.com` or `gitlab.example.com:8443`). Owners then get a GitLab source on the import page and a **GitLab import** section in Settings for a personal or project access token with `read_api` and `read_repository` scopes; the token is stored encrypted and is never returned by the API. Unset the variable to disable the feature entirely. For a private CA, mount the PEM into the container read-only and set `NODE_EXTRA_CA_CERTS` to its path.

## Optional automatic HTTPS

Point a public DNS name at your host and allow incoming ports 80/443. Add `SKILLBOX_DOMAIN=skills.example.com` using **your own** domain to `.env`, then:

```sh
docker compose -f compose.yml -f deploy/compose.caddy.yml up -d --build --wait
```

The override sets the app's canonical origin to the same HTTPS domain. Caddy handles certificates, WebSockets and streaming proxy responses. Certificate state uses persistent Docker volumes. This is opt-in; it is not started by the normal setup command.

If ports 80/443 already belong to a proxy, do not start a second proxy. Use your existing Caddy, Traefik, nginx, Coolify or other ingress to reach the loopback app port, preserve the original host, and configure `SKILLBOX_ORIGIN` to match. Verify the exact published HTTPS URL with certificate validation. Private/Tailscale-only names need your own DNS/certificate approach; this example does not create DNS records or promise public certificates for `.local` names.

For subsequent helper commands using the Caddy deployment, select the same Compose files:

```sh
export COMPOSE_FILE=compose.yml:deploy/compose.caddy.yml
bash scripts/skillbox.sh status
```

## Prebuilt images / Portainer / other Docker platforms

A maintainer can publish a versioned image with `scripts/publish-image.sh` (see below). Until an image is actually published and verified, build from source; no example registry is an operational download URL.

Set `SKILLBOX_IMAGE` in `.env` to your trusted versioned image, preferably `registry/owner/skillbox:VERSION@sha256:INDEX_DIGEST`, then:

```sh
bash scripts/skillbox.sh start-image
```

This pulls and starts without a local build. The helper refuses the local-only default image. The same runtime environment, volumes, healthcheck and port definitions can be used in Portainer or another Compose-compatible platform. When entering a stack manually, remove the `build:` field, supply a real published image and all required variables, and retain private PostgreSQL networking and both persistent volumes. Never paste real `.env` values into a public stack template.

## Mounted startup secrets

For custom Docker, Kubernetes or secret-manager deployments, the server accepts `SKILLBOX_ADMIN_TOKEN_FILE` and `DATABASE_URL_FILE`. Mount those files read-only, set the `_FILE` variables, and omit their non-file equivalents. Supplying both forms is rejected. Grant the container's unprivileged UID 1000 read access through your secret manager or file ownership/ACLs; do not make secrets broadly readable. Files must be nonempty and at most 4 KiB; values and paths are not included in load errors. The stock Compose setup uses the protected `.env` instead.

This is for startup database/owner secrets. TypeSafe AI and Vercel Gateway keys still belong in Settings, separately for each provider, never in an image or global deployment key.

## Back up, recover and upgrade

```sh
bash scripts/skillbox.sh backup
```

Backups go to ignored `backups/`: a PostgreSQL custom-format dump and, when present, a matching mode-0600 `.env` sidecar. The sidecar contains secrets. Keep both private and off-host; protect separately supplied secret files too. Archive listing verifies structure, not complete recovery—test a restore in a separate instance.

To restore into the intended Compose project, first back up its current state, review the target and retain the backup's matching owner token:

```sh
bash scripts/skillbox.sh restore /absolute/path/to/backup.dump --confirm-replace-database
```

**Restore replaces that project's database.** The helper checks the archive, stops only its app, restores with errors enabled, and restarts only on success. It does not overwrite `.env`. Restore the matching configuration deliberately; a different owner token cannot decrypt old integration settings. On failure, the app stays stopped for inspection.

For source deployments, review/check out the desired release, then:

```sh
bash scripts/skillbox.sh upgrade
```

For prebuilt deployments, set the new image reference and use `upgrade-image`. Both take a backup first. No automatic Git pull, uncommitted-work overwrite or database-major upgrade is attempted by the source helper. Never change the PostgreSQL major version without a separate migration/restore plan.

`stop` preserves all data. Do not run `docker compose down -v` against an installation you want to retain.

## Revision file storage migration

From this version, revision file contents are stored content-addressed: file bytes in `blobs` (keyed by sha256, shared across revisions) and per-revision listings in `revision_files`. They no longer live in the single `revisions.files` jsonb column, which Postgres limits to 255 MiB. Pending proposals use the same layout through `proposal_files`; the legacy `proposals.files` column is backfilled and dropped the same way.

On first start after upgrading, the app backfills every existing revision from the legacy column one revision per transaction, then drops the column. The migration is idempotent: if interrupted, the next start resumes with the remaining revisions.

Rollback: restore the pre-upgrade `pg_dump` taken per the backup section and start the previous image. There is no in-place reverse migration, because the legacy column cannot hold revisions above the 255 MiB limit.

`SKILLBOX_MCP_RESOURCE_MAX_BYTES` (default `8000000`) caps the file size served inline by MCP `resources/read`; larger files require fetching the skill on the execution host with `skillbox fetch`. `SKILLBOX_READ_FILE_MAX_BYTES` (default `160000`) is the same cap for the `read_skill_file` tool and `GET /api/skills/:id/file`.

`skillbox fetch` downloads a package listing (`GET /api/skills/:id/package`) and then each file on its own (`GET /api/skills/:id/package/file`), verifying every digest against the listing checksum, so packages of any configured size are materialized one file at a time. The inline `GET /api/skills/:id/bundle` response is still served for older clients.

Publishing a revision (web editor, `upsert_skill`, `PUT /api/skills/:id`) may send unchanged files as references (`path`, `sha256`, `size`, `executable` without `content`); the server resolves them from `expectedRevision`. `SKILLBOX_REQUEST_BODY_MAX_BYTES` caps request bodies and defaults to the larger of 12 MB and roughly 1.4 × `SKILLBOX_IMPORT_MAX_BYTES`, enough for a full-content publish of the configured skill size.

## Diagnose without dumping configuration

```sh
bash scripts/skillbox.sh doctor
bash scripts/skillbox.sh logs app
```

Doctor validates Compose quietly and shows service status; it does not print expanded secrets. Containers expose `/healthz`, which checks database access. Keep logs/private backups out of public bug reports. Common failures: missing/wrong origin, occupied port, database not healthy, changed owner token, or unreadable mounted secrets.

## Publish a release image (maintainers)

From a clean, tested source commit, using your own existing registry login and a Buildx builder supporting both amd64 and arm64:

```sh
bash scripts/publish-image.sh registry/owner/skillbox:VERSION https://public-source.example/project --push
```

The script does not log in, install emulation, alter registry visibility, create builders or enable CI. It refuses a builder lacking either architecture. Test both native runtimes before claiming support. Publishing from this command is explicit and may use registry/build resources.

For Umbrel, images must also be anonymously pullable and digest-pinned. See [the Umbrel release gates](../deploy/umbrel/README.md). A successful authenticated push is not proof that other users can pull the image.
