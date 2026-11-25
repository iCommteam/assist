"use client";

import { CheckCircleIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";

// How the last connect or disconnect went, as the connector routes report it
// (app/api/connectors/google). One sentence, naming no button the row may
// not show.
const outcomes = {
  connected: {
    description: "You can ask assist about your mail, calendar and Drive.",
    title: "Google connected",
    variant: "success",
  },
  denied: {
    description: "Nothing was connected. You can try again here.",
    title: "Google access was not granted",
    variant: "warning",
  },
  disconnected: {
    description: "Google revoked assist's access, and its tokens are deleted.",
    title: "Google disconnected",
    variant: "information",
  },
  expired: {
    description: "Nothing was connected. You can start again here.",
    title: "That Google sign-in expired",
    variant: "warning",
  },
  failed: {
    description: "Nothing was connected. You can try again here.",
    title: "Google could not finish connecting",
    variant: "warning",
  },
  "nothing-allowed": {
    description:
      "Every box on Google's screen was left unticked, so assist kept nothing. To connect, try again and tick what assist may use.",
    title: "Nothing was allowed",
    variant: "warning",
  },
  partial: {
    description:
      "Some of what assist asked for was not allowed; it is marked below. To allow it, press Reconnect and tick it on Google's screen.",
    title: "Google connected, with limited access",
    variant: "information",
  },
  unavailable: {
    description: "An administrator has not set up Google for assist yet.",
    title: "Google is not set up",
    variant: "warning",
  },
  unrevoked: {
    description:
      "assist deleted its tokens, but Google did not confirm the revoke. To be sure, remove assist at myaccount.google.com/permissions.",
    title: "Google disconnected here",
    variant: "warning",
  },
} as const;

const icons = {
  information: InfoIcon,
  success: CheckCircleIcon,
  warning: TriangleAlertIcon,
} as const;

// The outcome is read from the address once and kept while the page stays
// open; the address loses it, so a reload or Back never shows it again over
// a row that has since changed.
export function ConnectorOutcome() {
  const reported = outcomeNamed(useSearchParams().get("google"));
  const [shown, setShown] = useState(reported);
  if (reported !== undefined && reported !== shown) setShown(reported);
  useEffect(() => {
    if (reported === undefined) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("google");
    window.history.replaceState(null, "", url);
  }, [reported]);
  if (!shown) return null;
  const { description, title, variant } = shown;
  const Icon = icons[variant];
  return (
    <Alert variant={variant}>
      <Icon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

function outcomeNamed(name: string | null) {
  return Object.entries(outcomes).find(([key]) => key === name)?.[1];
}
