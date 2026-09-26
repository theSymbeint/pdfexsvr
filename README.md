# pdfexsvr

## Project Overview

**pdfexsvr** is a Node.js/TypeScript server for generating PDFs dynamically based on templates and user data. It exposes HTTP endpoints for creating, storing, and rendering PDF documents, with user authentication and template management handled via a PocketBase backend.

---

## Key Features

- **PDF Generation:** Uses `pdfkit` to generate PDFs from JSON-based templates and user data.
- **API Endpoints:** Provides RESTful endpoints for:
  - Creating a print token (stores template/data for later PDF generation)
  - Generating a PDF from a template and token
  - Testing PDF generation with sample data
- **Template System:** Templates define pages, fonts, images, shapes, labels, and data fields for dynamic PDF creation.
- **Authentication:** Uses API keys and PocketBase for user and template access control.
- **Static File Serving:** Serves static files from a `public` directory.
- **Healthcheck:** Simple endpoint to verify server status.

---

## Main Technologies

- **Node.js** with **TypeScript**
- **Hono** (web framework)
- **pdfkit** (PDF generation)
- **PocketBase** (backend database for users, templates, tokens)
- **Docker** (for containerization)
- **formidable** (for file uploads, if needed)
- **node-fetch** (for fetching remote resources)

---

## Project Structure

- `src/index.ts`: Main entry point. Sets up the Hono server, middleware, static file serving, and routes.
- `src/app/pdf.routes.ts`: Defines all PDF-related API endpoints.
- `src/lib/pdf.builder.ts`: Core logic for building PDFs from templates and data.
- `src/lib/types/`: Type definitions for templates, fonts, etc.
- `src/lib/db/pb.ts`: PocketBase client initialization.
- `src/data/template.data.ts`: Example template and data for testing.
- `public/`: Static assets (e.g., images, fonts).
- `Dockerfile`: For containerizing the app.
- `package.json`: Project metadata, dependencies, and scripts.

---

## How It Works

1. **Templates** are defined as JSON objects describing the layout, fonts, images, and data fields for a PDF.
2. **User Data** is submitted and stored as a "print token" via the `/token/:apikey` endpoint.
3. **PDF Generation** is triggered by requesting `/pdf/:docname/:ptoken`, which combines the template and data, builds the PDF, and streams it to the client.
4. **Authentication** is enforced using API keys and PocketBase user records.

---

## PocketBase version compatibility

The service targets **PocketBase v0.40+**.

| Call | Status on v0.40 |
|------|-----------------|
| `pb.admins.authWithPassword()` | **Removed.** v0.23 dropped `/api/admins/*`; the SDK dropped `pb.admins` in 0.22. Replaced by `authSuperuser()` in `src/lib/db/pb.ts`, which authenticates against the `_superusers` auth collection. |
| `collection(x).getFirstListItem(filter, {expand, fields})` | Supported. |
| `collection('pTokens').create()/update()` | Supported. |
| `files.getUrl()` + plain `fetch()` in `resource_loader.ts` | Works, but the fonts/images collections must have **public list + view rules** - the loader sends no auth header. |
| `collection('users').getFirstListItem('apikey = "..."')` | Supported; requires an `apikey` text field on `users` (added by the dev bootstrap). |

The `pocketbase` JS SDK is pinned at `^0.28.1` to match the v0.40 server.

---

## Environment variables

`src/lib/db/pb.ts` and `src/app/pdf.routes.ts` read three variables:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DBURL` | no | PocketBase base URL. Falls back to `https://pb-pdfex-dev.eemerg.dev/` when unset or blank. |
| `DBUSER` | **yes** | PocketBase superuser email (the `_superusers` collection), used by `authSuperuser()`. |
| `DBPASSWD` | **yes** | PocketBase superuser password. |

```bash
cp .env.example .env   # then fill in the three values
```

`.env.example` is committed; `.env` is gitignored and never committed.

`pnpm dev` loads `.env` through `--env-file-if-exists`, so the blank stubs shipped in
`.env.example` are harmless: while `DBUSER`/`DBPASSWD` are blank or whitespace the
`/token/*`, `/pdf/*` and `/pdf-test/*` routes reply `500 DATABASE CREDENTIALS NOT SET`
instead of failing later with a confusing `Database Error`.

A value already exported in your shell wins over `.env` - that is how
`pnpm dev:local` points at a local PocketBase without editing any file.

In Docker/Coolify nothing reads `.env` (the image just runs `node /app/dist/index.js`),
so `DBURL`, `DBUSER` and `DBPASSWD` must be set as container environment variables.

---

## Logging

Every request produces a request line and a completion line, and every step in
between is logged with the same `reqId`, so one failing render can be read end to
end. The id is also returned in the `x-request-id` response header, so a reported
failure can be traced to its exact log lines.

```jsonc
{"event":"http.request",   "method":"POST","path":"/token/<redacted …>","params":{…},"headers":{…},"body":{…}}
{"event":"db.request",     "method":"POST","url":"https://…/auth-with-password","body":{…}}
{"event":"db.auth.ok",     "email":"p***@pdfex.io","recordId":"…","token":"<redacted …>","durationMs":324}
{"event":"route.token.lookup_apikey","filter":"apikey = \"<redacted …>\""}
{"event":"http.response",  "status":200,"durationMs":412,"route":"/token/:apikey","responseBody":{…}}
```

| Event family | Covers |
|--------------|--------|
| `http.request` / `http.response` / `http.unmatched_route` | Method, url, query, params, headers, body, then status, duration, size, response body |
| `http.request.failed` / `http.handler_error` | Thrown errors with full stack, before the response is built |
| `guard.credentials_not_set` | The missing-credentials guard |
| `db.request` / `db.response` / `db.auth.*` | Every PocketBase call (the SDK's `beforeSend`/`afterSend` hooks), plus superuser auth results |
| `route.token.*` / `route.pdf.*` / `route.pdf_test.*` | Per-route steps: lookups with their filters, record ids, `docReqCount` changes, timings |
| `resource.*` | Font/image lookups by name, the resolved record, the file url, byte counts |
| `builder.*` | Page/font/image/shape/label/data stages, per-page timings, and warnings for template fields missing from the payload |
| `pdf.stream.finished` | Exact bytes streamed for a render |

Failures log the real cause, including for the `/pdf/...` route which previously
swallowed it: PocketBase errors carry `status`, `responseData` and the failing
`url`, and the resource loader states which `name` was missing.

Output goes to stdout (info/debug) and stderr (warn/error); Docker and Coolify
merge both. `healthcheck` is logged at `debug` since orchestrators poll it.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `debug` | `error`/`warn`/`info`/`debug`/`silent` |
| `LOG_FORMAT` | `pretty` on a TTY, else `json` | Human-readable vs machine-parseable |
| `LOG_BODIES` | `1` | Capture request/response payloads |
| `LOG_SECRETS` | `0` | **1 = write raw credentials** (see below) |
| `LOG_MAX_STRING` / `LOG_MAX_ARRAY` / `LOG_MAX_BODY` / `LOG_DEPTH` | `8000` / `50` / `1000000` / `8` | Truncation and depth limits |
| `LOG_COLORS` | on for a TTY | Colourised pretty output |

### Credentials in logs

Passwords, API keys and bearer tokens are replaced with a stable fingerprint -
readable enough to see *which* key was used and whether two requests used the
same one, without putting the value in a log store:

```text
apikey = "<redacted prefix=dev*** len=15 sha=0e32c8eb>"
```

This applies wherever a credential appears - the url path, a PocketBase filter
like `apikey = "…"`, headers, or inside an error - because each route registers
its credential and the serialiser redacts any string containing it.

The **account email is deliberately logged in full** (e.g. `pdf@your-domain.tld`): it
identifies which account authenticated, which is the first thing you want to know
when credentials are wrong. It is an identifier, not a secret. Use `maskEmail()`
from `src/lib/logger.ts` if you would rather fingerprint that too.

`LOG_SECRETS=1` disables all redaction and writes raw values, which is what you
want when you are chasing an auth problem locally:

```bash
LOG_SECRETS=1 pnpm dev
```

Be deliberate about that one: the service runs as a PocketBase **superuser**, so
a logged password or API key is equivalent to full database access for anyone who
can read the logs, and container stdout is typically shipped to a log store.

---

## Local development

Runs against a local PocketBase v0.40 instance, no external dependency.

```bash
# 1. PocketBase v0.40+ (download the darwin/linux binary from the releases page)
mkdir -p ~/pb-pdfex-local && cd ~/pb-pdfex-local
curl -sL -o pb.zip https://github.com/pocketbase/pocketbase/releases/download/v0.40.4/pocketbase_0.40.4_darwin_arm64.zip
unzip -o pb.zip
./pocketbase superuser upsert dandre@local.dev pdfexlocal123 --dir ./pb_data
./pocketbase serve --http=127.0.0.1:8090 --dir ./pb_data

# 2. Create the collections + seed data (idempotent - safe to re-run)
cd /path/to/pdfexsvr
pnpm pb:setup

# 3. Run the app against it
pnpm dev:local
```

`pnpm pb:setup` creates `apikeys`, `templates`, `pTokens`, `fonts`, `images`, adds an
`apikey` field to `users`, and seeds:

| Thing | Value |
|-------|-------|
| API key | `dev-api-key-123` |
| Template | `dev-ticket` (A4, Roboto, background images, shapes, labels, data fields) |
| User API key | `dev-user-key-123` |
| Assets | `Roboto` (font), `test.png`, `white-page.png` (generated) |

```bash
# create a print token
curl -X POST http://localhost:8080/token/dev-api-key-123 \
  -H 'Content-Type: application/json' \
  -d '{"tempId":"dev-ticket","data":{"year":"2024","make":"ford","vin":"1ftfw1e5xjfa00000","fname":"dandre","lname":"gregory"}}'

# render it (use the token from the previous response)
curl -o out.pdf http://localhost:8080/pdf/dev-ticket/<token>

# render a template's own testData
curl -o preview.pdf http://localhost:8080/pdf-test/dev-ticket/dev-user-key-123
```

Restart PocketBase with `./pocketbase serve --http=127.0.0.1:8090 --dir ./pb_data`;
delete `pb_data` for a clean slate, then re-run `pnpm pb:setup`.

---

## Container image (linux/amd64)

`scripts/build-image.sh` (or `pnpm build:image`) builds `eemergdev/pdfexsvr` for
**linux/amd64 from any host architecture**, including an Apple Silicon MacBook:

```bash
scripts/build-image.sh                  # eemergdev/pdfexsvr:latest, linux/amd64
scripts/build-image.sh --tag v1.2.0     # ...:v1.2.0, plus ...:sha-<commit>
scripts/build-image.sh --push           # push to the registry afterwards
scripts/build-image.sh --platform linux/arm64
```

How the cross-build works: every stage starts from a multi-arch base and pnpm
installs dependencies *inside* the build for the **target** platform, so the output
is a genuine amd64 image rather than an arm64 one relabelled. `docker buildx
--platform linux/amd64` runs those steps under QEMU emulation (bundled with Docker
Desktop), which makes the first build a few minutes slow and later builds fast.

The image is multi-stage - a build stage with all dependencies runs `tsc`, and the
runtime stage contains only production dependencies plus `dist/` and `public/`,
running as non-root uid 1001 (`hono`) on `EXPOSE 8080`.

`DBURL` / `DBUSER` / `DBPASSWD` are supplied at run time. No `.env` is baked in, and
the script refuses to build if `.dockerignore` is missing or does not exclude `.env`:

```bash
docker run --rm -p 8080:8080 --env-file .env eemergdev/pdfexsvr:latest
```

The script finishes by verifying the built image's platform, confirming no `.env` /
`src/` / devDependencies are inside it, and smoke-testing the real routes twice -
once with credentials present and once without, to prove nothing was baked in.

---

## Usage

```bash
npm install
npm run dev
```

- Access the app: [http://localhost:8080](http://localhost:8080)
- Healthcheck: [http://localhost:8080/healthcheck](http://localhost:8080/healthcheck)

---

If you want a more detailed breakdown of any part (e.g., API endpoints, template structure, PDF features), see the source files or open an issue/request!

```
open http://localhost:3000
```
