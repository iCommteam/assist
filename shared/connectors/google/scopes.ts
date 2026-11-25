// What assist asks Google for when a member connects their account, and what
// each grant lets the agent do. The README's "Google Workspace" section lists
// the same scopes; tests/connectors/google-setup.test.ts keeps the two equal.
// Each scope is the narrowest one Google's API reference accepts for its
// methods:
// - gmail.readonly: messages.list, messages.get, threads.get.
// - gmail.compose: drafts.create and messages.send (it covers sending, so
//   gmail.send is not asked for as well).
// - calendar.events: events.list and events.insert on every calendar the
//   member can see.
// - calendar.events.freebusy: freebusy.query on calendars the member has
//   access to, a colleague's included (calendar.freebusy covers only their
//   own).
// - drive.readonly: files.list, files.get, files.export, and the Sheets API's
//   spreadsheets.get and values.batchGet.
const gmailRead = "https://www.googleapis.com/auth/gmail.readonly";
const gmailCompose = "https://www.googleapis.com/auth/gmail.compose";
const calendarEvents = "https://www.googleapis.com/auth/calendar.events";
const calendarFreeBusy =
  "https://www.googleapis.com/auth/calendar.events.freebusy";
const driveRead = "https://www.googleapis.com/auth/drive.readonly";

// openid and email name the Google account in the Connectors section; they
// reach no mail, calendar or file.
const googleIdentityScopes = ["openid", "email"] as const;

// One line per ability a member can grant or untick on Google's consent
// screen. A tool is offered only while the scope it needs was granted.
export const googleAbilities = [
  {
    id: "gmail-read",
    label: "Search and read mail",
    scope: gmailRead,
    service: "Gmail",
  },
  {
    id: "gmail-write",
    label: "Write drafts, and send mail you approve",
    scope: gmailCompose,
    service: "Gmail",
  },
  {
    id: "calendar-events",
    label: "See events, and create events you approve",
    scope: calendarEvents,
    service: "Calendar",
  },
  {
    id: "calendar-free-busy",
    label: "See when people are free",
    scope: calendarFreeBusy,
    service: "Calendar",
  },
  {
    id: "drive-read",
    label: "Search and read files, Docs and Sheets",
    scope: driveRead,
    service: "Drive",
  },
] as const;

export type GoogleAbility = (typeof googleAbilities)[number]["id"];

export const googleRequestedScopes = [
  ...googleIdentityScopes,
  ...googleAbilities.map((ability) => ability.scope),
];

// The abilities a grant's scopes cover, in the order above.
export function grantedGoogleAbilities(scopes: readonly string[]) {
  const granted = new Set(scopes);
  return googleAbilities
    .filter((ability) => granted.has(ability.scope))
    .map((ability) => ability.id);
}
