"use client";

import { CheckCircleIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";

// How the last connect or disconnect went, as the connector routes report it
// (app/api/connectors/google). One sentence, and what to press next.
const outcomes = {
  connected: {
    description: "You can ask assist about your mail, calendar and Drive.",
    title: "Google connected",
    variant: "success",
  },
  denied: {
    description: "Nothing was connected. Press Connect Google to try again.",
    title: "Google access was not granted",
    variant: "warning",
  },
  disconnected: {
    description: "Google revoked assist's access, and its tokens are deleted.",
    title: "Google disconnected",
    variant: "information",
  },
  expired: {
    description: "Press Connect Google to start again.",
    title: "That Google sign-in expired",
    variant: "warning",
  },
  failed: {
    description: "Nothing was connected. Press Connect Google to try again.",
    title: "Google could not finish connecting",
    variant: "warning",
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

export function ConnectorOutcome() {
  const outcome = useSearchParams().get("google");
  const shown = Object.entries(outcomes).find(([key]) => key === outcome)?.[1];
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
