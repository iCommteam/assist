<div align="center">

<img src=".github/logo.png" alt="OpenInstinct" width="420">

**A personal iMessage assistant that can use a browser like you.**

It can do your chores, book movie tickets, or handle your groceries.
You stay in control of your passwords, credit cards, and context.

It's open source and self-hostable. This fork runs on Railway with both
agents on Anthropic's Claude Opus 5.5.

<img src=".github/demo.png" alt="OpenInstinct booking movie tickets over iMessage — it walks Fandango to checkout and reports the theater, showtime, seat, and total" width="640">

</div>

## Why self-host?

Personal agents are much more useful when they can sign in, book, buy, and act
on your behalf. OpenInstinct runs in your own infrastructure. Saved vault secrets
are encrypted before they reach your database, and browser autofill keeps saved
passwords out of the model's context. You can read the code to see how it works.

## Deployment on Railway

One Railway service builds the repository's `Dockerfile`. The container runs
`scripts/start.ts`, which checks the configuration, starts `next start`, and
lets Next spawn the eve server beside it on `127.0.0.1:4274`, which is never
exposed. Postgres is a separate Railway service on the private network, with
its public TCP proxy turned off.

### Service settings

| Setting           | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Builder           | Dockerfile, at the repository root                        |
| Start command     | none: the image's own command runs `scripts/start.ts`     |
| Pre-deploy        | `pnpm db:migrate`, which applies the committed migrations |
| Health check path | `/eve/v1/health`, with a timeout of 300 seconds           |
| Volume            | mounted at exactly `/app/.eve/.workflow-data`             |
| Replicas          | 1                                                         |
| Restart policy    | on failure                                                |
| Public domain     | `https://assist.icommteam.com` only                       |

The volume holds eve's sessions and runs. It also holds each chat's sandbox
files (its uploads and screenshots), which stay until eve ends that session,
so the volume grows with the open sessions. Mounting it at `/app/.eve` instead
would hide the build output. Keep exactly one replica: the session store
accepts a single process, and a deploy must stop the old container before the
new one starts. The health check passes only once both Next and the eve
server answer. Delete the generated `*.up.railway.app` domain once the custom
domain works, because sign-in trusts one origin. Teemiq, in the same project,
calls the site API over the private network at
`http://assist.railway.internal:8080`; set `PORT=8080` as a service variable so
that address stays stable.

`scripts/start.ts` refuses to start when the configuration is unsafe, and the
log names every problem without printing any value. It exits when the eve
server stops answering, because nothing else restarts it, and Railway's
restart policy then starts a fresh container. The container starts as root
only to hand the root-owned volume to the `node` user; both servers run as
`node`.

### Environment variables

| Variable                                | Secret | Value                                                    |
| --------------------------------------- | ------ | -------------------------------------------------------- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | yes    | references to the Postgres service's private URL         |
| `BETTER_AUTH_URL`                       | no     | `https://assist.icommteam.com`; also read at build time  |
| `BETTER_AUTH_SECRET`                    | yes    | `openssl rand -base64 32`, at least 32 characters        |
| `SECRET_ENCRYPTION_KEY`                 | yes    | `openssl rand -base64 32`, exactly 32 bytes once decoded |
| `SCHEDULED_RUN_SECRET`                  | yes    | `openssl rand -base64 32`, at least 32 characters        |
| `ANTHROPIC_API_KEY`                     | yes    | the team's Anthropic key; both agents use it             |
| `KERNEL_API_KEY`                        | yes    | the team's Kernel project key                            |
| `ASSIST_ALLOWED_EMAILS`                 | no     | the team's emails; see [Team sign-in](#team-sign-in)     |
| `ASSIST_ADMIN_EMAILS`                   | no     | the administrators among them; optional                  |
| `ASSIST_SIGNUP_CODE`                    | yes    | at least 16 characters                                   |
| `ASSIST_SITE_TOKEN_<SITE>`              | yes    | one per site; see [Connected sites](#connected-sites)    |
| `ASSIST_SITE_OWNER_<SITE>`              | no     | one per site                                             |
| `PORT`                                  | no     | `8080`, set explicitly; Teemiq's private address uses it |

Generate each secret locally and paste it straight into Railway as a sealed
variable. `SCHEDULED_RUN_SECRET` authenticates the scheduled-run callbacks that
the eve server makes to itself over loopback; nothing outside the container
uses it. The image sets `NODE_ENV=production`. These must stay unset, and the
start check refuses them: `VERCEL` and every `VERCEL_*`, `EVE_DEV`,
`EVE_NEXT_PRODUCTION_ORIGIN`, `EVE_NEXT_PRODUCTION_PORT`,
`EVE_SCHEDULES_DISABLED`, `WORKFLOW_LOCAL_BASE_URL`, `WORKFLOW_POSTGRES_URL`,
`BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID`, `AI_GATEWAY_API_KEY`,
`ANTHROPIC_BASE_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_SECRETS`,
`KERNEL_BASE_URL`, `STRIPE_PUBLISHABLE_KEY`, `TEST`, and every `LINK_*`,
`LINQ_*` and `OTEL_EXPORTER_*`.

The vault key encrypts saved secrets: losing it loses them, and rotating it
requires re-encrypting existing vault values. Application migrations live in
`db/`; see [`db/README.md`](db/README.md) for existing-database adoption.

### Team sign-in

Sign-in is an email, a password of at least 8 characters, and a required
authenticator-app code. Only the team may sign up or stay signed in:

- `ASSIST_ALLOWED_EMAILS`: the team's emails, comma-separated and
  case-insensitive. An email removed from the list loses its session on the
  next request, and its schedules stop dispatching.
- `ASSIST_ADMIN_EMAILS`: the administrators among them.
- `ASSIST_SIGNUP_CODE`: a shared code of at least 16 characters that every new
  account must enter, so nobody can register a team email first.

Leaving a variable unset closes sign-in. A new member creates an account at
`/sign-up`, then scans a QR code at `/two-factor` and saves ten one-time backup
codes. Every session lasts up to 24 hours of inactivity, and each sign-in needs
a fresh authenticator or backup code. There is no email delivery, so there is
no self-serve recovery:

- A member who loses both the authenticator and the backup codes keeps their
  data. An operator deletes that user's `twoFactor` row and `session` rows and
  sets `twoFactorEnabled` to false; the next password sign-in then lands on
  `/two-factor` to enrol again.
- A forgotten password has no reset. An operator can delete the `user` row so
  the member signs up again, but the new account gets a new, empty workspace:
  the old vault items, schedules and history stay behind, unreachable.

### Connected sites

A server, such as Teemiq or the iCommSync agents app, can hand the agent a task
over a small JSON API. Each site gets its own pair of variables, named by an
upper-case suffix that becomes the site's name:

- `ASSIST_SITE_TOKEN_<SITE>`: the site's bearer token, at least 32 characters
  (`openssl rand -base64 48`). An empty value turns the site off, and two
  sites sharing a token are both refused.
- `ASSIST_SITE_OWNER_<SITE>`: the email of the member the site acts for. It
  must be on `ASSIST_ALLOWED_EMAILS`, have an account and have its
  authenticator enrolled; otherwise every call from the site answers 403 and
  the reason goes to the server log.

A site works inside its owner's personal workspace, with the owner's tools,
and each task appears in the owner's chat history. A site task neither reads
nor changes the owner's Personal Info or workstreams, and its browser worker
reaches only the browsers it opened. A site reads only the tasks and logins it
created itself. The owner can follow a site task in the chat but cannot answer
its code question there; only the site can.

#### Calls

Every call sends `Authorization: Bearer <token>` and every answer carries
`cache-control: no-store`. An error is `{"error":"<code>"}` and never echoes
what the caller sent.

| Call                                          | Answer                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/site/ping`                          | `200 {"ok":true,"site":"teemiq"}`                                                                                                                 |
| `POST /api/site/logins`                       | body `{"origin","label","identifier","password","totp"}`; `201 {"login":{"loginId","label","origin","hasTotp","createdAt"}}`                      |
| `GET /api/site/logins`                        | `200 {"logins":[{"loginId","label","origin","hasTotp","createdAt"}]}`, the site's own logins, newest first                                        |
| `DELETE /api/site/logins/{loginId}`           | `204`, also deleting the login's browser profile; `409 {"error":"login_busy"}` while a task pinned to it is open                                  |
| `POST /api/site/tasks`                        | body `{"message","loginId"}`, `loginId` optional; `202 {"taskId"}`; `409 {"error":"login_busy","taskId"}`; `429 {"error":"rate_limited"}`         |
| `GET /api/site/tasks?loginId=...`             | `200 {"tasks":[{"taskId","status","createdAt"}]}`, the site's tasks pinned to that login, newest first, at most 5                                 |
| `GET /api/site/tasks/{taskId}`                | `200 {"taskId","status","question","questionId","outcome","error","reply"}`                                                                       |
| `POST /api/site/tasks/{taskId}/input`         | body `{"text"}`, the one-time code; `202 {"taskId"}`; `409 {"error":"not_waiting"}`                                                               |
| `POST /api/site/tasks/{taskId}/cancel`        | no body; `202 {"taskId"}`, also for a task that has already ended                                                                                 |
| `GET /api/site/tasks/{taskId}/files`          | `200 {"files":[{"fileId","filename","mediaType","byteSize","sha256","createdAt"}]}`, oldest first                                                 |
| `GET /api/site/tasks/{taskId}/files/{fileId}` | `200` the PDF's bytes, with `content-type: application/pdf`, `content-length` and `x-content-sha256`; `404 {"error":"not_found"}` once it is gone |

A missing or wrong token answers `401 {"error":"unauthorized"}`, a site whose
owner is not ready `403 {"error":"forbidden"}`, an invalid body or query
`400 {"error":"invalid_request"}`, and a task, login or file that is not the
site's, or an id of the wrong form, `404 {"error":"not_found"}`. Any call can
answer `503 {"error":"unavailable"}` while the database or the agent runtime
cannot be reached; it is transient, so retry later. Times are ISO 8601 UTC
with milliseconds, such as `2026-11-23T10:00:00.000Z`.

#### Logins

A site saves the logins its tasks use. `POST /api/site/logins` keeps a login
in the owner's vault, encrypted like any saved login and marked with the site
that saved it; `/vault` shows "Saved by" that site beside it, and its website
where an owner's login shows a masked username, and the copy button on its row
copies its id. The username, password and key are never returned, logged or
put in an error, and assist never hands them to the model. A page the task
opens may still show the username, such as "Signed in as ...", and the model
reads that page.

- `origin`: the `https:` URL of the sign-in page, such as
  `https://login.vendor.com/sign-in`, of which only the origin is kept;
  surrounding spaces are trimmed. Another scheme, an IP address, `localhost` or
  any `*.localhost` host, a single-label host, a bare public suffix such as
  `co.uk`, a trailing dot, a port (also `:443`), a username or password in the
  URL, a control character, or more than 2048 characters answers
  `invalid_request`.
- `label`: 1 to 60 characters once trimmed, with no control characters. A
  second login of the site whose label differs only in case answers
  `409 {"error":"duplicate_label"}`; this holds within one running service.
- `identifier`: 1 to 200 characters once trimmed. `password`: 1 to 500
  characters, kept as sent. Lengths count UTF-16 code units, so an emoji counts
  as two.
- `totp`: optional, an authenticator app's base32 setup key or its
  `otpauth://totp/` link, passed as the site received it. A blank string or
  `null` saves no key (`hasTotp` false); a key that cannot be read answers
  `400 {"error":"invalid_totp"}`; anything but a string, or more than 2000
  characters, answers `invalid_request`.
- A body over 16 KB answers `invalid_request`.

`GET /api/site/logins` lists only the logins the site saved. `DELETE` removes
one and its Kernel browser profile, never the owner's own logins or another
site's (those answer 404). While one of the site's five newest tasks pinned to
the login runs or waits for a code, it answers `409 {"error":"login_busy"}`;
a task past its 45 minutes is cancelled first and no longer counts. A start and
a delete for the same login run one at a time. Removing a login and saving it
again gives it a new id and a new, signed-out profile.

#### Tasks pinned to a login

A task may be pinned to one login by its `loginId`, which must be a login this
site saved; any other id, the owner's own logins included, answers
`invalid_request`. The worker then sees and fills only that login, and its
browser opens only:

- the login's host and every host under the same registrable domain, so
  `login.vendor.com` also opens `vendor.com` and `billing.vendor.com`; a
  private suffix counts as a public one, so `acme.myshopify.com` does not open
  the other shops there;
- Stripe's hosted invoice pages, each exact host only: `invoice.stripe.com`,
  `pay.stripe.com`, `files.stripe.com` and `billing.stripe.com`, since many
  suppliers bill through Stripe.

Both Chrome's URL policy and every tool that opens or fetches a URL enforce
this; Amazon sites stay blocked for every task. The password, the
authenticator code and a relayed code are filled only on the exact origin the
login was saved with, over https for a relayed code, so save the origin of the
sign-in form itself, such as `https://login.vendor.com`. A portal whose sign-in
lives on another registrable domain, such as a separate identity provider,
cannot be used. A task without a pin sees no saved login, its browsers keep no
cookies, and it cannot save files.

A pinned task's browsers keep their cookies in a Kernel profile of that login
alone, so two accounts on one portal never share a session, and different
logins can sign in at the same time. A sign-in made from the owner's chat is
saved to the workspace profile instead, so a login's first pinned task starts
signed out and signs in itself.

A login runs one task at a time: while one of the site's five newest tasks
pinned to it runs or waits for a code, another start for that `loginId`
answers `409 {"error":"login_busy","taskId":"..."}` with the open task's id.
`GET /api/site/tasks?loginId=...` lists those five tasks with their status, so
a site that lost the answer to a start can find the task; an unknown or
foreign `loginId` lists none, and a missing one, or one over 200 characters,
answers `invalid_request`. A site may start 10 tasks in any 10 minutes; the
next start answers `429 {"error":"rate_limited"}` with `Retry-After` in
seconds, the count resets when the service restarts, and a `login_busy` or
`invalid_request` start does not count. A start that answered 503 may still
run: list the login's tasks before starting it again. A start whose task could
not be recorded is not listed and may keep running in the agent runtime, but
its browsers cannot use the login.

#### Status

`GET /api/site/tasks/{taskId}` follows the turn the site started; a message
the owner adds in the chat starts a later turn that does not change it. Poll
a running task every few seconds.

- `status`: `running`, `awaiting-input`, `completed` or `failed`.
- `question` and `questionId`: set only while `awaiting-input`; the question
  is one line of plain text of at most 300 characters.
- `outcome`: set only while `completed`: `files` when the task keeps at least
  one saved file, `nothing_found` otherwise. It is counted from the files the
  task stored, never from what the agent wrote. After a file's 7 days it is
  gone, so an older task that saved files reads `nothing_found`. A task that
  failed may have saved files before it failed, so list a task's files once it
  has ended, whether it reads `completed` or `failed`.
- `error`: set only while `failed`, one of these codes:
  - `login_failed`: the website refused the saved username or password.
  - `code_failed`: the website refused a relayed code or found it expired,
    or an authenticator code could not be filled. A task that asked for a
    relayed code and never got one reads `timed_out` instead.
  - `blocked`: the website wants something only a person can do, such as a
    CAPTCHA, a bot check, a device approval, a passkey or a new-device email
    link, or the task needs a sign-in it has no pinned login for.
  - `off_site`: what the task needs, such as the invoice file, is on a website
    the login's fence does not open.
  - `timed_out`: the task passed its 45 minutes, or its wait for a code ran
    out.
  - `usage_limit`: the task reached the $10 usage limit's continue prompt.
  - `needs_person`: the task stopped at a request a site cannot answer, such
    as a tool approval or any question other than the code.
  - `cancelled`: the site, or the owner in the chat, cancelled the task.
  - `failed`: anything else, such as a runtime failure.
- `reply`: the agent's last message as plain text, set once the site's turn
  has completed, also when the task then reads `failed`; it is null while the
  task runs or waits, and for a turn that was cancelled, stopped or failed in
  the runtime. A link in it may need the owner's portal session. Do not show
  or store it as the reason, use `outcome` and `error`.

The agent ends every site task by calling `end_site_task` with one fixed
result: `done` or `nothing_found` complete the task, and `login_failed`,
`code_failed`, `blocked`, `off_site` and `failed` fail it with that code. The
last result of the site's turn counts; a turn that ends without the tool reads
`completed`. A code question that ended without its code, because the 20
minutes ran out, fails the task as `timed_out`. That holds also when the agent
reported `code_failed`, unless an earlier code of the same task reached the
worker: the website refused that code, so the task reads `code_failed`.
Another failure code the agent gave, such as `blocked`, stands.

#### One-time codes

A pinned task may pause for one thing only: a one-time code the login's
website sent by email or text message. The worker's `fill_code_from_site` asks
the site for it, and the status turns `awaiting-input` with a `questionId` and
the question, such as `Enter the one-time code that login.vendor.com just sent
by email for the saved login "Vendor".`. The site posts the code to the task's
`input` as `{"text":"..."}`, 1 to 64 characters on one line; the API seals it
before eve sees it, and only the worker's fill step opens it and types it into
the code field, one character per box when the field is split, so no model,
log, trace or eve record holds the code itself. A `202` means the code reached
the task, not that the website accepted it. An input for a task that is not
`awaiting-input` answers `409 {"error":"not_waiting"}`, also once the code has
been sent and while it is on its way, for a second delivery of the same code,
and past the task's 45 minutes, when the code is never typed. When the website
refuses the code or it cannot be filled, the worker may ask once more: the
status turns `awaiting-input` again with a new `questionId` and a question that
starts `The code sent before could not be used`. Treat each new `questionId`
as a new request for a code.

An authenticator app's code is never asked for: when the login holds a setup
key, the worker's `fill_totp_from_vault` computes the current code on the
server and types it into the focused code field, and the model never sees the
key or the code. An authenticator code the vault cannot fill ends the task
with `code_failed`.

#### Files

A pinned task brings files back through the worker's `save_file`, the only way
a site gets one. For an invoice job the agent signs in, opens the account's
billing or invoices page, and saves the PDF of every invoice or receipt dated
in the requested period, preferring the supplier's own Download PDF link and
opening Stripe's hosted invoice page when that is where the link goes; it
never pays, buys, upgrades, cancels, submits or changes anything else, and ends
with `done` when it saved files or `nothing_found` when there were none.

`save_file` opens the file in a background tab of the task's own signed-in
browser, so the request carries that browser's cookies, and keeps it only
when:

- the URL is `https:`, on the login's fence or one of Stripe's four invoice
  hosts, and so is every redirect, at most 5: the tab bypasses the site's
  service workers, so the browser holds each request before it is sent, and
  `save_file` lets it go only once it has checked it, with Chrome's URL policy
  checking it too. A hop to any other host is never sent, and the task ends
  with `off_site`;
- the answer is a `200` whose bytes start with `%PDF-`, of at most 20 MB,
  that arrives within 60 seconds: a larger declared length is refused before
  the bytes are read, and reading stops once they pass 20 MB;
- the task keeps fewer than 10 files and its 45 minutes have not passed.

`save_file` takes a link's address. A PDF that only a button running a script
or sending a form produces, with no address, cannot be saved; the task then
ends `failed`, not `nothing_found`.

A file whose bytes the task already keeps is not stored twice. Its `filename`
is plain: no path, no control characters, at most 200 characters, ending in
`.pdf`, taken from the name the agent gives, else the answer's
`Content-Disposition`, else the URL's last segment when that names a PDF, else
`document.pdf`. `sha256` is the lower-case hex of the exact bytes. The tool
answers the model with only the file's id, name and size, never the bytes or
the URL; no log line holds either, and the browser trace keeps the URL without
its query or fragment. The URL the model passed stays in its own session
record.

A file is kept for 7 days from when the task saved it. After that it is no
longer listed and its download answers 404. An hourly sweep deletes expired
files, also when no site calls, and saves, lists and downloads delete them a
batch at a time as well. The file routes answer only for the
site's own tasks, like the status: another site's task answers 404.

#### Lifetimes and cancelling

- A task has 45 minutes. One whose turn still runs or waits for a code after
  that, or ended later, reads `failed` with `timed_out`, and the API cancels it
  when it next reads it, lists it or checks its login. When that cancel cannot
  reach the agent runtime the read answers 503 instead.
- A wait for a relayed code lasts 20 minutes; the worker then deletes its
  browser and the task fails with `timed_out`, with `code_failed` when the
  website refused a code sent earlier in the task, or with another failure
  code the agent gave such as `blocked`, never `completed`.
- A site task's browsers idle out after 30 minutes, so they outlive the code
  wait.
- A saved file is kept for 7 days.

A site stops a task itself with `POST /api/site/tasks/{taskId}/cancel`: a
running or waiting task then reads `failed` with `cancelled` within moments,
and a task that has ended is left as it is. Before the task's turn has started
the cancel answers 503, so retry it. Cancelling does not delete the task's
browsers, which idle out after 30 minutes. The next start of that login, once
none of its tasks is open, closes a browser an ended task left saving the
login's sign-in, so the new task can sign in; the new task also wins over a
later chat turn of an old task. A start answered `429` leaves the login's
browsers alone; one answered `503` may already have closed them.

The database also stores `workstreams`: goals, decisions, observations, and
unfinished steps the agent can recall across conversations. They are scoped to
the authenticated workspace. Each scope holds up to 100 records, with the eight
most recently updated active or waiting records recalled first; older records
remain searchable. Saving a workstream does not start a job, create a schedule,
or authorize an action.

<details>
<summary>Eve version and active-session compatibility</summary>

This repository pins Eve `1.0.0-rc.1`. Browser work uses
the resumable `run_browser` task: the coordinator continues a worker by its
`taskId` and stops one with `eve__task_cancel`.

Sessions started on Eve 0.69 through 0.83 move to a 1.0 deployment on their
own when they next receive a message, and Eve compacts their earlier
conversation. Sessions started on this repository's previous Eve `0.66.3`
deployment predate 0.69 and never move: keep that deployment running until
they finish, and start a new conversation for new work. A scheduled run that
was waiting for the user's answer when you deploy stores the old request
format; re-run it after the upgrade.

</details>

## Local development

Local development requires:

- Node.js 24 and pnpm 11.24.0
- Docker Desktop or another running Docker Compose installation
- A [Kernel API key](https://kernel.sh)
- An Anthropic API key

First clone and install the application:

```bash
git clone https://github.com/Merit-Systems/OpenInstinct.git
cd OpenInstinct
pnpm install --frozen-lockfile
```

Copy the environment template and add your Kernel and Anthropic keys:

```bash
cp .env.example .env.local

# Set KERNEL_API_KEY and ANTHROPIC_API_KEY in .env.local, plus your own email
# in ASSIST_ALLOWED_EMAILS and a local ASSIST_SIGNUP_CODE to create an account.
```

Then start OpenInstinct:

```bash
pnpm dev
```

`pnpm dev` starts PostgreSQL from `compose.yaml`, applies the committed database
migrations, and starts the application. Stopping the development process also
stops and removes the PostgreSQL container; its data remains in the
`postgres-data` volume for the next run. Run `pnpm dev:app` when intentionally
using an externally managed database instead. If `KERNEL_API_KEY` is missing,
`pnpm dev` stops before starting Docker and points to the `.env.local` setup.

Local development otherwise uses the same vault, Kernel browser, and Anthropic
models as production. Better Auth and vault encryption use stable local-only
defaults when their variables are unset; production requires explicit secrets.

> [!WARNING]
> This is not software intended for production use.

---

<div align="center">

Built on [eve](https://eve.dev) · [Kernel](https://kernel.sh) · [Anthropic](https://www.anthropic.com) · [Railway](https://railway.com)

</div>
