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

One Railway service builds the repository's Dockerfile and runs a single
replica, with a volume mounted at `/app/.eve/.workflow-data` for durable
sessions and Postgres on Railway's private network. The service's pre-deploy
command, `pnpm db:migrate`, applies the committed migrations before each
release. Set `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `KERNEL_API_KEY`,
`ANTHROPIC_API_KEY`, `BETTER_AUTH_URL` (the public https origin), and both
installation secrets:

```bash
BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

The vault key encrypts saved secrets: losing it loses them, and rotating it
requires re-encrypting existing vault values. Application migrations live in
`db/`; see [`db/README.md`](db/README.md) for existing-database adoption.

### Team sign-in

Sign-in is an email, a password of at least 12 characters, and a required
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
memory and vault, and each task appears in the owner's chat history. A site
can read only the tasks it created. Every call sends
`Authorization: Bearer <token>`:

| Call                           | Answer                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /api/site/ping`           | `200 {"ok":true,"site":"teemiq"}`                                                                      |
| `POST /api/site/tasks`         | body `{"message": "..."}`, 1 to 8000 characters; `202 {"taskId": "..."}`                               |
| `GET /api/site/tasks/{taskId}` | `200 {"taskId","status","reply","error"}`, status `running`, `completed`, `failed` or `awaiting-input` |

A missing or wrong token answers `401 {"error":"unauthorized"}`, an invalid
body `400 {"error":"invalid_request"}`, and a task that is not the site's
`404 {"error":"not_found"}`. The reply is the agent's final message; a failed
task carries a short error without internal details. Poll a running task
every few seconds.

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
