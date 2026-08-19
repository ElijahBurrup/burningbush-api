# burningbush-api

Accounts + progress-sync backend for the Burning Bush Bible-memory app.

- Node/Express + Postgres, JWT auth, bcrypt passwords.
- Stores each user's progress as opaque JSON blobs (`prog_json`, `srs_json`); the client owns the schema and does union-merge on pull.

## Endpoints
- `GET  /api/health`
- `POST /api/signup {email,password}` -> `{token,email}`
- `POST /api/login  {email,password}` -> `{token,email}`
- `POST /api/forgot {email}` -> `{ok:true}` (emails a reset link if the account exists)
- `POST /api/reset  {token,password}` -> `{ok:true}`
- `GET  /api/sync` (Bearer) -> `{progJson,srsJson,updatedAt}`
- `PUT  /api/sync` (Bearer) `{progJson,srsJson,updatedAt}` -> `{ok:true}`

## Env
`DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGIN` (CSV of allowed origins), `APP_URL` (for reset links),
optional `SENDGRID_API_KEY` + `MAIL_FROM` for password-reset emails.

## Deploy
Render Blueprint (`render.yaml`) provisions the web service + free Postgres. Auto-deploys from GitHub `master`.
