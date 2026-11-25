import { createHash } from "node:crypto";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
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
    "List the events of one Google calendar between two instants, recurring events expanded, earliest first. Optionally only those matching words.",
  inputSchema: z.object({
    calendarId: calendarIdSchema,
    maxResults: z.number().int().min(1).max(50).default(20),
    query: z.string().trim().min(1).max(200).optional(),
    timeMax: instantSchema,
    timeMin: instantSchema,
  }),
  label: { start: () => "Read Google Calendar" },
  async execute(input, ctx) {
    requireGoogleScope(ctx);
    const events = await withCalendar(ctx, async (client) => {
      const { data } = await client.events.list(
        {
          calendarId: input.calendarId,
          fields:
            "items(id,status,summary,description,location,start,end,organizer(email),attendees(email,responseStatus),hangoutLink,htmlLink)",
          maxResults: input.maxResults,
          orderBy: "startTime",
          q: input.query,
          singleEvents: true,
          timeMax: input.timeMax,
          timeMin: input.timeMin,
        },
        { signal: ctx.abortSignal }
      );
      return data.items ?? [];
    });
    return {
      events: events.map(eventSummary),
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

const createEventInputSchema = z.object({
  attendees: z.array(z.email()).max(50).default([]),
  calendarId: calendarIdSchema,
  description: z.string().max(8_000).optional(),
  end: instantSchema,
  location: z.string().trim().max(1_000).optional(),
  start: instantSchema,
  summary: z.string().trim().min(1).max(500),
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
    "Create an event on the member's Google calendar and invite its attendees, who get Google's invitation email. Agree the title, time and attendees with the member first; the member then approves this call in the chat before anything is created or sent.",
  inputSchema: createEventInputSchema,
  approval: {
    prompt: ({ input }) => createPrompt(input),
    request: (context) => approvalOf(context),
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

function approvalOf(context: Pick<ApprovalContext, "session">) {
  try {
    requireGoogleScope(context);
  } catch {
    return {
      reason: "Google is not available in this conversation.",
      type: "denied",
    } as const;
  }
  return "user-approval" as const;
}

function createPrompt(input: CreateEventInput) {
  const when = formatRange(input.start, input.end, input.timeZone);
  const guests =
    input.attendees.length > 0
      ? ` and invite ${input.attendees.join(", ")}`
      : "";
  return `Create “${input.summary}” on ${when}${guests} in your Google Calendar?`;
}

function formatRange(start: string, end: string, timeZone: string) {
  const day = new Intl.DateTimeFormat("en-GB", {
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
  return `${day.format(new Date(start))}–${time.format(new Date(end))} (${timeZone})`;
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
