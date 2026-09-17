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
- `POST /api/auth/google {credential}` -> `{token,email,provider,hasPassword,how}`
- `GET  /api/legal` (Bearer) -> `{version,accepted,history}`
- `POST /api/legal/accept` (Bearer) `{version,source}` -> `{ok:true,...}`
- `GET  /api/sync` (Bearer) -> `{progJson,srsJson,updatedAt}`
- `PUT  /api/sync` (Bearer) `{progJson,srsJson,updatedAt}` -> `{ok:true}`

## Sign in with Google
`google-auth.js`. The browser sends the token Google gave it; it is verified here against
`GOOGLE_CLIENT_IDS` before it counts as anybody. **One email address is one account**: an existing
password account is linked rather than duplicated, and an account made through Google has
`pw_hash` NULL. Anything that used to re-ask for the password — deleting an account — accepts a
fresh Google token instead (`confirmIdentity`).

## Accepting the terms
`legal.js`. `TERMS_VERSION` here must match `LEGAL_VERSION` in `src/index.html`. The version, time,
account and IP are written to `legal_accept`, one row per account per version, and **`/api/checkout`
refuses with 428 until that row exists** — the tick in the paywall is a gate, not decoration.

## Env
`DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGIN` (CSV of allowed origins), `APP_URL` (for reset links),
optional `SENDGRID_API_KEY` + `MAIL_FROM` for password-reset emails, optional `GOOGLE_CLIENT_IDS`
(CSV of OAuth client ids; without it Google sign-in answers 503 and the app shows no button).

## Tests
`node test/content.test.js`, `node test/report.test.js`, `node test/google-auth.test.js`,
`node test/legal.test.js` — none of them touches a database, a network or Google.

## Deploy
Render Blueprint (`render.yaml`) provisions the web service + free Postgres. Auto-deploys from GitHub `master`.
