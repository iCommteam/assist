import { createHash } from "node:crypto";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import {
  googleApproval,
  shownLine,
  shownText,
} from "@agent/lib/google/approval";
import { googleApiStatus, withGoogle } from "@agent/lib/google/client";
import { boundedText, untrustedNotice } from "@agent/lib/google/content";
import { requireGoogleScope } from "@agent/lib/google/offer";
import { googleToolsFor } from "@agent/lib/google/tools";

const service = "Google Calendar";

const instantSchema = z.iso
  .datetime({ offset: true })
  .describe(
    "An ISO 8601 date and time with its offset, such as 2026-12-02T10:00:00+02:00."
  );

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isTimeZone, "Use an IANA time zone, such as Asia/Jerusalem.");

const calendarIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .default("primary")
  .describe(
    "primary for the member's own calendar, or a calendar's ID, which for a person is their email address."
  );

const calendarListEvents = defineTool({
  availableInSubagents: false,
  description:
    "List the events of one Google calendar between two instants, recurring events expanded, earliest first. Optionally only those matching words. When nextPageToken is not null, more events fall in the range: pass it as pageToken for the next page before saying what the range holds.",
  inputSchema: z.object({
    calendarId: calendarIdSchema,
    maxResults: z.number().int().min(1).max(50).default(20),
    pageToken: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .optional()
      .describe("The nextPageToken of an earlier call, for the next page."),
    query: z.string().trim().min(1).max(200).optional(),
    timeMax: instantSchema,
    timeMin: instantSchema,
  }),
  label: { start: () => "Read Google Calendar" },
  async execute(input, ctx) {
    requireGoogleScope(ctx);
    const listed = await withCalendar(ctx, async (client) => {
      const { data } = await client.events.list(
        {
          calendarId: input.calendarId,
          fields:
            "nextPageToken,items(id,status,summary,description,location,start,end,organizer(email),attendees(email,responseStatus),hangoutLink,htmlLink)",
          maxResults: input.maxResults,
          orderBy: "startTime",
          pageToken: input.pageToken,
          q: input.query,
          singleEvents: true,
          timeMax: input.timeMax,
          timeMin: input.timeMin,
        },
        { signal: ctx.abortSignal }
      );
      return data;
    });
    return {
      events: (listed.items ?? []).map(eventSummary),
      nextPageToken: listed.nextPageToken ?? null,
      notice: untrustedNotice,
    };
  },
});

const calendarFreeBusy = defineTool({
  availableInSubagents: false,
  description:
    "Check when people are busy between two instants: the member's own calendar (primary) and colleagues' calendars by their email addresses. Returns only busy periods, never what the events are.",
  inputSchema: z.object({
    calendars: z
      .array(z.string().trim().min(1).max(320))
      .min(1)
      .max(20)
      .default(["primary"]),
    timeMax: instantSchema,
    timeMin: instantSchema,
    timeZone: timeZoneSchema.default("UTC"),
  }),
  label: { start: () => "Check free and busy times" },
  async execute(input, ctx) {
    requireGoogleScope(ctx);
    const answer = await withCalendar(ctx, async (client) => {
      const { data } = await client.freebusy.query(
        {
          requestBody: {
            items: input.calendars.map((id) => ({ id })),
            timeMax: input.timeMax,
            timeMin: input.timeMin,
            timeZone: input.timeZone,
          },
        },
        { signal: ctx.abortSignal }
      );
      return data;
    });
    return {
      calendars: Object.entries(answer.calendars ?? {}).map(([id, entry]) => ({
        busy: (entry.busy ?? []).map(({ end, start }) => ({
          end: end ?? null,
          start: start ?? null,
        })),
        calendar: id,
        // A colleague whose calendar the member may not see reads as an
        // error here, not as free.
        unavailable:
          (entry.errors ?? []).map((error) => error.reason ?? "unknown")[0] ??
          null,
      })),
      timeZone: input.timeZone,
    };
  },
});

// Everything an event carries to other people is shown whole in its
// approval, so each text is capped at what the approval shows and holds only
// what the member can see.
const createEventInputSchema = z.object({
  attendees: z.array(z.email()).max(50).default([]),
  calendarId: calendarIdSchema,
  description: shownText(2_000).optional(),
  end: instantSchema,
  location: shownLine(300).optional(),
  start: instantSchema,
  summary: shownLine(200),
  timeZone: timeZoneSchema.describe(
    "The IANA time zone the event is shown in, such as Asia/Jerusalem."
  ),
});

type CreateEventInput = z.infer<typeof createEventInputSchema>;

// The member approves every new event in the chat before it is created and
// invitations go out.
const calendarCreateEvent = defineTool({
  availableInSubagents: false,
  description:
    "Create an event on a Google calendar the member can write to (primary is their own) and invite its attendees, who get Google's invitation email with the title, time, location and description (at most 2,000 characters). Agree all of them with the member first; the member then approves this call in the chat, which shows all of it, before anything is created or sent.",
  inputSchema: createEventInputSchema,
  approval: {
    prompt: ({ input }) => createPrompt(input),
    request: (context) => googleApproval(context),
  },
  label: { start: ({ summary }) => `Create “${summary}” in Google Calendar` },
  async execute(input, ctx) {
    requireGoogleScope(ctx);
    if (Date.parse(input.end) <= Date.parse(input.start)) {
      throw new Error("The event must end after it starts.");
    }
    // The same call always asks for the same event ID, so a call that runs
    // again finds the event it created instead of making a second one.
    const eventId = createHash("sha256")
      .update(`${ctx.session.id}:${ctx.callId}`)
      .digest("hex")
      .slice(0, 32);
    const event = await withCalendar(ctx, async (client) => {
      try {
        const { data } = await client.events.insert(
          {
            calendarId: input.calendarId,
            requestBody: {
              attendees: input.attendees.map((email) => ({ email })),
              description: input.description,
              end: { dateTime: input.end, timeZone: input.timeZone },
              id: eventId,
              location: input.location,
              start: { dateTime: input.start, timeZone: input.timeZone },
              summary: input.summary,
            },
            sendUpdates: input.attendees.length > 0 ? "all" : "none",
          },
          { signal: ctx.abortSignal }
        );
        return data;
      } catch (error) {
        if (googleApiStatus(error) !== 409) throw error;
        const { data } = await client.events.get(
          { calendarId: input.calendarId, eventId },
          { signal: ctx.abortSignal }
        );
        return data;
      }
    });
    return { created: true, event: eventSummary(event) };
  },
});

export default defineDynamic((context) =>
  googleToolsFor(context, {
    calendar_create_event: {
      ability: "calendar-events",
      tool: calendarCreateEvent,
    },
    calendar_free_busy: {
      ability: "calendar-free-busy",
      tool: calendarFreeBusy,
    },
    calendar_list_events: {
      ability: "calendar-events",
      tool: calendarListEvents,
    },
  })
);

// The approval shows all that the event carries. The calendar it lands on
// and every guest Google emails come first, then its time; the title,
// location and description, which the model wrote, come last, the
// description at the very end, so nothing in them can pass for a guest or
// the calendar.
function createPrompt(input: CreateEventInput) {
  return [
    input.calendarId === "primary"
      ? "Create this event in your own Google Calendar?"
      : `Create this event in the Google calendar ${input.calendarId}?`,
    input.attendees.length > 0
      ? `Guests, each emailed an invitation with everything below: ${input.attendees.join(", ")}`
      : "Guests: none",
    `When: ${formatRange(input.start, input.end, input.timeZone)}`,
    `Title: ${input.summary}`,
    ...(input.location === undefined ? [] : [`Where: ${input.location}`]),
    ...(input.description === undefined
      ? []
      : ["Description:", input.description]),
  ].join("\n");
}

// The start's day and time, and the end's time, or its day as well when it
// falls on another day in the event's time zone.
function formatRange(start: string, end: string, timeZone: string) {
  const dayAndTime = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone,
    weekday: "short",
    year: "numeric",
  });
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone });
  const [from, to] = [new Date(start), new Date(end)];
  return date.format(from) === date.format(to)
    ? `${dayAndTime.format(from)}–${time.format(to)} (${timeZone})`
    : `${dayAndTime.format(from)} to ${dayAndTime.format(to)} (${timeZone})`;
}

function isTimeZone(value: string) {
  try {
    return (
      Intl.DateTimeFormat("en-GB", { timeZone: value }).resolvedOptions()
        .timeZone.length > 0
    );
  } catch {
    return false;
  }
}

function withCalendar<T>(
  ctx: ToolContext,
  call: (client: ReturnType<typeof calendar>) => Promise<T>
) {
  return withGoogle(ctx, service, (auth) =>
    call(calendar({ auth, version: "v3" }))
  );
}

function eventSummary(event: calendar_v3.Schema$Event) {
  return {
    attendees: (event.attendees ?? []).map((attendee) => ({
      email: attendee.email ?? null,
      response: attendee.responseStatus ?? null,
    })),
    description:
      event.description === undefined || event.description === null
        ? null
        : boundedText(event.description, 2_000).text,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    id: event.id ?? null,
    link: event.htmlLink ?? null,
    location: event.location ?? null,
    meetLink: event.hangoutLink ?? null,
    organizer: event.organizer?.email ?? null,
    start: event.start?.dateTime ?? event.start?.date ?? null,
    status: event.status ?? null,
    summary: event.summary ?? null,
  };
}
