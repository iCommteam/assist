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
| `TEEMIQ_FINANCE_MCP_URL`                | no     | TEEMIQ's finance tools; see [Site chats](#site-chats)    |
| `TWILIO_ACCOUNT_SID`                    | no     | the Twilio account; see [WhatsApp](#whatsapp)            |
| `TWILIO_AUTH_TOKEN`                     | yes    | that account's auth token                                |
| `TWILIO_WHATSAPP_FROM`                  | no     | `whatsapp:+<number>`, the number assist answers from     |
| `ASSIST_WHATSAPP_NUMBERS`               | no     | who may write to it; see [WhatsApp](#whatsapp)           |
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
its code question there; only the site can. A site may also hold chats with
its own people; see [Site chats](#site-chats).

#### Calls

Every call sends `Authorization: Bearer <token>` and every answer carries
`cache-control: no-store`. An error is `{"error":"<code>"}` and never echoes
what the caller sent.

| Call                                          | Answer                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/site/ping`                          | `200 {"ok":true,"site":"teemiq"}`                                                                                                                                                                             |
| `POST /api/site/logins`                       | body `{"origin","label","identifier","password","totp","alsoHosts"}`; `201 {"login":{"loginId","label","origin","alsoHosts","hasTotp","createdAt"}}`; `400 {"error":"identity_provider"}`                     |
| `GET /api/site/logins`                        | `200 {"logins":[{"loginId","label","origin","alsoHosts","hasTotp","createdAt"}]}`, the site's own logins, newest first                                                                                        |
| `DELETE /api/site/logins/{loginId}`           | `204`, also deleting the login's browser profile; `409 {"error":"login_busy"}` while a task pinned to it is open                                                                                              |
| `POST /api/site/tasks`                        | body `{"message","loginId","kind","note"}`, all but `message` optional; `202 {"taskId"}`; `400 {"error":"invalid_input"}` for a `note`; `409 {"error":"login_busy","taskId"}`; `429 {"error":"rate_limited"}` |
| `GET /api/site/tasks?loginId=...`             | `200 {"tasks":[{"taskId","status","createdAt"}]}`, the site's tasks pinned to that login, newest first, at most 5                                                                                             |
| `GET /api/site/tasks/{taskId}`                | `200 {"taskId","kind","status","question","questionId","outcome","error","signInOrigin","reply"}`                                                                                                             |
| `POST /api/site/tasks/{taskId}/input`         | body `{"text"}`, the one-time code; `202 {"taskId"}`; `409 {"error":"not_waiting"}`                                                                                                                           |
| `POST /api/site/tasks/{taskId}/cancel`        | no body; `202 {"taskId"}`, also for a task that has already ended                                                                                                                                             |
| `GET /api/site/tasks/{taskId}/files`          | `200 {"files":[{"fileId","filename","mediaType","byteSize","sha256","createdAt"}]}`, oldest first                                                                                                             |
| `GET /api/site/tasks/{taskId}/files/{fileId}` | `200` the PDF's bytes, with `content-type: application/pdf`, `content-length` and `x-content-sha256`; `404 {"error":"not_found"}` once it is gone                                                             |

A missing or wrong token answers `401 {"error":"unauthorized"}`, a site whose
owner is not ready `403 {"error":"forbidden"}`, an invalid body or query
`400 {"error":"invalid_request"}`, a task's `note` that fails
`400 {"error":"invalid_input"}` (see [Owner's note](#owners-note)), and a
task, login or file that is not the
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
  `invalid_request`. An identity provider's sign-in answers
  `400 {"error":"identity_provider"}`, saving nothing: any host under
  `google.com`, `googleapis.com`, `microsoftonline.com`, `live.com`,
  `okta.com`, `auth0.com` or `onelogin.com`, and `login.microsoft.com`,
  `appleid.apple.com`, `idmsa.apple.com` and `account.apple.com`. A login
  there would hand the agent a company's whole identity.
- `alsoHosts`: optional, at most 3 hosts the supplier's site also uses outside
  the origin's registrable domain, such as `chatgpt.com` for a login at
  `https://auth.openai.com`: lower case, with no scheme, port or path, each a
  named host with a registrable domain as the origin's host is. A host under
  the origin's own registrable domain, one of Stripe's four invoice hosts, an
  Amazon host or anything else answers `invalid_request`; an identity provider
  answers `identity_provider`. A host sent twice is kept once, and leaving
  the field out, `null` or `[]` keeps none. A pinned task may open each host,
  that exact host alone; nothing is ever filled there.
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
  suppliers bill through Stripe;
- each of the login's `alsoHosts`, that exact host only, not its subdomains.

Both Chrome's URL policy and every tool that opens or fetches a URL enforce
this; Amazon sites stay blocked for every task. The password, the
authenticator code and a relayed code are filled only on the exact origin the
login was saved with, over https for a relayed code, so save the origin of the
sign-in form itself, such as `https://login.vendor.com`. A portal whose sign-in
lives on an identity provider cannot be saved. When the website asks for the
password on another page of the login's own site, under its registrable domain
or on one of its `alsoHosts`, the fill is refused there and the server records
that page's https origin for the task. The worker then opens the saved origin
and signs in there; only when it offers no sign-in, or leads back to such a
page, does the task end `sign_in_elsewhere` with that origin as its
`signInOrigin`, and the site saves the login again for that origin if it
chooses. Nothing ever moves a saved password to another origin. A task
without a pin sees no saved login, its browsers keep no cookies, and it
cannot save files.

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
seconds, the count resets when the service restarts, and a `login_busy`,
`invalid_request` or `invalid_input` start does not count. A start that answered 503 may still
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
- `kind`: `fetch`, or `look` for a task started as one; see [Looks](#looks).
- `outcome`: set only while `completed`: `files` when the task keeps at least
  one saved file, `nothing_found` otherwise. It is counted from the files the
  task stored, never from what the agent wrote. After a file's 7 days it is
  gone, so an older task that saved files reads `nothing_found`. A task that
  failed may have saved files before it failed, so list a task's files once it
  has ended, whether it reads `completed` or `failed`. A look reads `listed`
  when the agent ended it done, or `nothing_found` when the agent ended it
  so; one it did not end reads `failed`.
- `error`: set only while `failed`, one of these codes:
  - `login_failed`: the website refused the saved username or password.
  - `sign_in_elsewhere`: the website asks for the password on a different
    page of the same site than the saved one; `signInOrigin` names it. A
    task the agent ended so with no page recorded reads `login_failed`.
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
  - `failed`: anything else, such as a runtime failure, or a look the agent
    did not end with its result.
- `signInOrigin`: set only with `sign_in_elsewhere`: the https origin of the
  page where the browser worker's fill of the login was refused, as the
  server read it from the browser, never from what the agent wrote. It is on
  the login's own site, under its registrable domain or one of its
  `alsoHosts`, never one of Stripe's hosts, never an identity provider's
  sign-in host, even under the login's own domain, and never on a port, so a
  site can save a login there. A fill refused on several such pages records
  the last. A later fill that succeeds on the saved origin, or one refused on
  a page of the login's site no login can be saved on, such as an identity
  provider's, clears it, so a task then ended `sign_in_elsewhere` reads
  `login_failed`.
- `reply`: the agent's last message as plain text, set once the site's turn
  has completed, also when the task then reads `failed`; it is null while the
  task runs or waits, and for a turn that was cancelled, stopped or failed in
  the runtime. A link in it may need the owner's portal session. Do not show
  or store it as the reason, use `outcome` and `error`.

The agent ends every site task by calling `end_site_task` with one fixed
result: `done` or `nothing_found` complete the task, and `login_failed`,
`sign_in_elsewhere`, `code_failed`, `blocked`, `off_site` and `failed` fail it
with that code. The last result of the site's turn counts; a turn that ends
without the tool reads `completed`. A code question that ended without its
code, because the 20 minutes ran out, fails the task as `timed_out`. That holds
also when the agent reported `code_failed`, unless an earlier code of the same
task reached the worker: the website refused that code, so the task reads
`code_failed`. Another failure code the agent gave, such as `blocked`, stands.

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

The worker passes `save_file` the ref of the PDF's link from its page snapshot,
and `save_file` reads that link's address in the browser itself, so the model
never types, guesses or copies an address. Browser Loop's snapshots show a
link's role and name but not its address, so `patches/` adds a `linkAddress`
method that resolves a ref through Browser Loop's own checks, in the tab the
ref came from. A ref whose page has since changed is refused, never matched to
another link: that covers a new page, a link removed or replaced, a ref a
click or snapshot re-pointed to another link of the same name, and a page that
changes while the address is read. A link with no address of its own (an
empty href, or only a `#` fragment, as a script's often is) is refused as
having none. A `url` is still taken for an address the browser showed, such as
a tab's.

`save_file` opens the file in a background tab of the task's own signed-in
browser, so the request carries that browser's cookies, and keeps it only
when:

- the URL is `https:`, on the login's fence or one of Stripe's four invoice
  hosts, and so is every redirect, at most 5: the tab bypasses the site's
  service workers, so the browser holds each request before it is sent, and
  `save_file` lets it go only once it has checked it, with Chrome's URL policy
  checking it too. A hop to any other host is not sent, and the task ends
  with `off_site`. If the browser connection drops in the moment between that
  check and the browser being told, Chrome lets the held request go, and its
  URL policy alone stops it;
- the answer is a `200` whose bytes start with `%PDF-`, of at most 20 MB,
  that arrives within 60 seconds: a larger declared length is refused before
  the bytes are read, and reading stops once they pass 20 MB;
- the task keeps fewer than 10 files and its 45 minutes have not passed.

`save_file` saves only a link that has an address. A PDF that only a button
running a script or sending a form produces, with no address, cannot be saved;
the task then ends `failed`, not `nothing_found`.

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

#### Looks

A task started with `"kind":"look"` looks into its pinned login's account
instead of fetching from it: the agent signs in, lists for the requested
period every invoice or receipt the account shows, each with its date,
number, amount, currency and which kind it is, and saves nothing. The
worker of a look has no `save_file` at all. A look needs a `loginId`, and
otherwise answers `invalid_request`; `kind` is `fetch` when left out, so a
site that never sends it is unaffected. The fence, the login's one task at a
time, the start limit, the one-time codes and the 45 minutes are a fetch's.

`GET /api/site/tasks/{taskId}` reports the `kind`. A look has no files to
show what it found, so its end result decides: it reads `completed` with
`outcome` `listed` only when the agent ended it done, and then its `reply`
is the list, one document per line; `nothing_found` when the agent found
no document for the period. A look the agent ended without its end result
reads `failed` with `failed`, in its status and in its login's list, its
`reply` kept, since nothing says whether it listed anything. Unlike a
fetch's files, the list is what the agent read on the supplier's pages and
wrote down: treat it as untrusted text.

#### Owner's note

A pinned task, a fetch or a look, may carry `note`: the owner's note for the
login's account, saying where the account keeps its documents and which of
them to save, such as `Billing → Invoice history; the invoice, not the
receipt`. It is one line of 1 to 300 characters once trimmed, counted in
UTF-16 code units: no control character, line or paragraph separator, or
bidirectional embedding, override or isolate (U+202A to U+202E and U+2066 to
U+2069; marks such as U+200F are kept), and no email address. Every
`https://` address in it, whatever its case, must be one the task's browser
may open: under the origin's registrable domain, one of the login's
`alsoHosts`, or one of Stripe's four invoice hosts, with no user name or
password. A note that fails any of this, a note on a task with no `loginId`,
or a `note` that is not a string answers `400 {"error":"invalid_input"}` and
starts nothing, before the login is checked for an open task, and the start
is not counted. Leaving it out, or `null`, sends none. Only the note's shape
is checked, never its words.

The note never joins the task's message. The agent's instructions for the
task end with one line, `Where to look, as the owner noted for this account:
<note>`, which the agent copies word for word into the browser worker's
assignment. The note only says where the documents are and which to save, or
for a look to list: it never widens what the task may do or which site its
browser opens. A note that asks for anything a pinned task may not do, such as
paying, changing a setting or the account, deleting, sending a message, or
downloading from outside the login's fence, ends the task `failed`, as such a
task always has.

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

#### Site chats

A connected site can also hold chats between the agent and its own people,
such as TEEMIQ's Assist in Accounting. Each call names the person by the
site's own id for them, `siteUser`: 1 to 128 letters, digits and `_ . : @ -`,
such as a TEEMIQ user id. A chat belongs to that person alone. Another
person's id answers `404 {"error":"not_found"}` like an unknown chat, and the
owner's own sign-in is refused on the chat's page, `/chat/{id}`, and on every
agent route of its session: stream, messages, answers, controls and
callbacks. A chat lives in the owner's workspace like a task, but it never
appears in the owner's chat list. The people who run assist's database can
still read it there, as they can any chat.

| Call                                                         | Answer                                                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/site/chats`                                       | body `{"siteUser","topic","title"}`, `topic` and `title` optional; `201 {"chatId"}`; `429 {"error":"rate_limited"}`                             |
| `GET /api/site/chats?siteUser=...&topic=...`                 | `200 {"chats":[{"chatId","title","topic","createdAt"}]}`, the person's chats, newest first, at most 50, only that topic's when it is given      |
| `POST /api/site/chats/{chatId}/messages`                     | body `{"siteUser","text","context","kind","teemiqToken"}`, `context` and `kind` optional; `202 {"chatId"}`; `429 {"error":"rate_limited"}`      |
| `POST /api/site/chats/{chatId}/answers`                      | body `{"siteUser","interactionId","optionId","teemiqToken"}`, or `text` in place of `optionId`; `202 {"chatId"}`; `409 {"error":"not_waiting"}` |
| `POST /api/site/chats/{chatId}/token`                        | body `{"siteUser","teemiqToken"}`; `204`                                                                                                        |
| `GET /api/site/chats/{chatId}/stream?siteUser=...&after=...` | `200` NDJSON, below; `after` optional                                                                                                           |
| `POST /api/site/chats/{chatId}/cancel`                       | body `{"siteUser"}`; `202 {"chatId"}`, also when no turn is under way                                                                           |

A chat whose agent session has ended, after 30 idle days, answers
`410 {"error":"chat_ended"}` to its messages and its stream: open a new chat.
A message or an answer while the session is still starting can answer
`409 {"error":"not_ready"}`: send it again.

- `topic`: an opaque key of 1 to 200 printable characters without spaces,
  such as `txn:<uuid>` for a transaction's own chat. The site finds the chat
  again with `GET /api/site/chats?siteUser=...&topic=...`, so it keeps no
  table of its own; several chats may share a topic, the newest listed first.
  `title`: 1 to 200 characters on one line.
- `text`: 1 to 8000 characters. A message sent while a turn runs joins it.
- `context`: what the person has open, such as
  `About: OpenAI · 3 Nov · $20.00`, at most 2000 characters. The agent reads
  it for that turn only; it is never stored in the chat.
- `kind`: `message`, the default, for the person's words, or `result` for the
  outcome of a look or a fetch the chat started, which the site posts on the
  person's behalf once it ends: the look's list, or the fetch's summary and
  the documents filed. The agent receives a result as a result, framed so
  that the person's own text can never pass for one, and continues from it
  without being asked: it cross-checks the documents against the transaction.
- `teemiqToken`: the site's short-lived token for its own tools, 16 to 4096
  printable characters, opaque to assist. Every message and answer carries
  one, and `/token` replaces it while a long turn runs, every 5 minutes for
  TEEMIQ. It is kept only on the chat's row, encrypted for that chat, used for
  at most 15 minutes from when it arrived, and cleared when the turn that
  took its message ends, or when the session ends; it never reaches the
  model, the session's records or a log. A token that arrives after a turn
  took its last message, such as one sent with a result posted as the turn
  ends, or a `/token` renewal sent later in the turn, outlives that turn: the
  next turn's end, or its own 15 minutes, clears it.

The agent of a chat is an Accounting assistant for the company. It answers,
searches the web and asks the person questions; it has no browser, vault,
schedules, Personal Info or workstreams. With `TEEMIQ_FINANCE_MCP_URL` set,
such as `https://team.icommteam.com/api/mcp/finance`, a turn whose chat holds
a live token gets TEEMIQ's finance tools, as that person, through an MCP
connection that sends the token; without the variable or a token it has none,
and it is never asked to sign in. Every visit to a supplier's site is a look
or a fetch it starts through those tools, on a saved account the person names
by its nickname; it never pairs a document itself, it proposes.

A person may start 30 turns in any hour and 200 in any day, results
included, and open 30 chats in any hour; the next answers
`429 {"error":"rate_limited"}` with `Retry-After`, and the counts reset when
the service restarts. The $10 usage limit's continue prompt is answered no:
the turn stops and the stream reports `usage_limit`. The chat stays over its
limit after that, so open a new one.

#### Chat stream

Each line of the stream is one JSON object with `"v":1`. Every line but a
heartbeat also carries `cursor`, the agent session's line it came from. The
stream replays the chat from its start, or from after the `after` cursor,
then follows it live; it closes after 10 minutes or when the chat ends, and
the site opens it again with the last cursor it read.

A chat opened without a message has nothing to replay until its first
message, so its stream answers `200` within about 2 seconds, starts with a
heartbeat, and follows the chat live from there. A refusal or an expired
chat, which the agent runtime answers at once, answers with its status, such
as `410`. While the runtime is still starting or cannot be reached, the
stream also opens with a heartbeat, keeps trying for about 40 seconds, and
then closes: open it again after a short wait.

| `type`      | Fields                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `message`   | `from`: `person`, `result` or `assistant`; `text`                                                              |
| `progress`  | `label`: `Searching the web`, `Starting a look` or `Starting a fetch`                                          |
| `question`  | `id`, `text`, `options` (`[{"id","label"}]`, empty for a free answer); answer it with `/answers`               |
| `fetch`     | `fetchId`: a look or a fetch the agent started through TEEMIQ's tools                                          |
| `account`   | `supplierName`; `guessedSite`, `txnId` and `alsoHosts` when TEEMIQ gave them: no saved account to use          |
| `proposal`  | `txnId`, `documentId`, `why`: a pairing the agent proposed, for a person to confirm                            |
| `way`       | `wayId`, `why`: a way a supplier's invoice comes that the agent proposed, for a person to save                 |
| `done`      | a turn ended                                                                                                   |
| `error`     | `code`: `usage_limit`, `needs_person` (stopped at an approval or a sign-in), `cancelled`, `failed`, or `ended` |
| `heartbeat` | none; sent first when the chat has no message yet, and after 15 quiet seconds                                  |

An `account` line comes from a look or a fetch that TEEMIQ answered
`{"needs_account":{"supplierName":"…","guessedSite":"…","txnId":"…","alsoHosts":["…"]}}`
instead of starting it; the site shows the person its Add an account form,
for that line when `txnId` is given. The name and the site are each one line
of plain text, at most 200 and 300 characters; `txnId` is an id, and
`alsoHosts` at most three bare host names, the other sites the guess said the
supplier's billing uses, which the form shows before saving.

A `way` line comes from TEEMIQ's `finance_propose_invoice_way`, which stores
a proposal of how an existing supplier's invoice comes and answers
`{"wayId":"…","why":"…"}`. `wayId` is an id and `why` one line of plain text
of at most 500 characters; an answer without both, or whose `why` is empty
once made one line, yields no line. The site draws the proposal's card from
the way it stored under that id, never from the agent's words. No tool's
input or output leaves assist beyond those fields.

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

### WhatsApp

Team members can write to assist on WhatsApp, through Twilio. Each listed
member's number reaches assist as that member, in a narrow business mode: it
replies, asks a question with numbered options, and searches the web, and it
has no browser, vault, schedules, Personal Info, saved notes, supplier sites or
Accounting tools. Replies are short text for a phone, split at Twilio's 1,600
characters per message, and each attachment goes as a message of its own.

| Variable                  | Value                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`      | the Twilio account's SID, `AC` and 32 hex digits                             |
| `TWILIO_AUTH_TOKEN`       | that account's auth token, sealed; it checks every webhook's signature       |
| `TWILIO_WHATSAPP_FROM`    | the WhatsApp number assist answers from, such as `whatsapp:+14155238886`     |
| `ASSIST_WHATSAPP_NUMBERS` | each member's number and assist email, `+15551234567=member@example.com,...` |

Leaving any of the three `TWILIO_` variables unset closes the channel: every
webhook is refused. `ASSIST_WHATSAPP_NUMBERS` is read on every message; a
number listed for two emails, or an entry that does not parse, reaches nobody,
and the log says so without the values. A member must also pass assist's own
sign-in rules: on `ASSIST_ALLOWED_EMAILS`, registered, and enrolled in an
authenticator. A message from anyone else gets an empty reply and reaches
nothing, and so does a call.

Set the webhook that Twilio posts each incoming message to (HTTP POST):

```text
https://assist.icommteam.com/eve/v1/whatsapp/messages
```

- Twilio Sandbox: Messaging > Try it out > WhatsApp > Sandbox settings, "When
  a message comes in". Each member first joins the sandbox from their phone
  with its join code.
- Production: the WhatsApp sender's webhook for incoming messages.

The signature is checked against that public URL, built from
`BETTER_AUTH_URL`, so the webhook must use exactly that origin and path.

Each member has one chat on their number. Replying `/new` ends it, and the
next message starts a fresh one; a message more than 8 hours after the chat's
last activity starts a new chat by itself. A chat belongs to its member as well
as its number: when a number is listed for someone else, their messages start a
chat of their own, and the earlier member's chat no longer sends its replies to
that number (a question it asks, or eve's notice of a failed turn, still can).
A sender's messages reach their chat one at a time, in the order assist
receives them. A member may send 30 messages in any hour and 200 in any day;
past that, messages are dropped and assist says so once an hour. Only a member
who can sign in is counted or told. A message Twilio posts twice reaches the
agent once. These counts live in memory and reset when the service restarts.
WhatsApp chats also appear in the member's chat list in assist's web app.

Meta's WhatsApp Business terms bar general-purpose AI assistants on the
platform since 15 January 2026; an assistant for the company's own business is
allowed. assist keeps to business work on WhatsApp and declines anything else,
and WhatsApp allows free-form replies only within 24 hours of the member's last
message.

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
