import type { Lead } from "@/components/lead-capture";

// Single source of truth for the opening greeting, so the text that is spoken
// (triggered from the onboarding click) is identical to the text seeded as the
// first assistant message in the chat.
export function buildGreeting(lead: Lead): string {
  const hello = lead.name ? `Hello ${lead.name}.` : "Hello, and welcome.";
  return (
    `${hello} I'm the assistant for Debashis Roy, a Product Designer at ` +
    `Singularis Ventures. He specializes in human-centered UI and UX design, ` +
    `building data-driven SaaS products across B2B and consumer domains. ` +
    `Ask me anything about his experience, his design philosophy, or the ` +
    `products he's shaped.`
  );
}
