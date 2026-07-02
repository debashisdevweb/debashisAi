import type { NextRequest } from "next/server";

// Lead capture endpoint.
//
// SCAFFOLDING: For now this validates the payload, logs it to the server
// console, and echoes back a generated id. When real database credentials are
// available, replace the `persistLead` body with the actual insert (e.g.
// Postgres/Prisma/Drizzle) — the route contract above it stays the same.

export type LeadPayload = {
  name?: string;
  profession?: string;
  contact?: string;
  isGuest?: boolean;
};

export type LeadRecord = LeadPayload & {
  id: string;
  createdAt: string;
};

async function persistLead(lead: LeadRecord): Promise<void> {
  // TODO: swap for a real DB write once credentials are wired up.
  // e.g. await db.insert(leads).values(lead)
  console.log("[lead] captured:", lead);
}

function generateId(): string {
  // Avoids Math.random()/Date.now() restrictions in some runtimes by leaning
  // on the Web Crypto API, which is available in the Next.js runtime.
  return crypto.randomUUID();
}

export async function POST(request: NextRequest) {
  let body: LeadPayload;

  try {
    body = (await request.json()) as LeadPayload;
  } catch {
    return Response.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const name = body.name?.trim() || "";
  const profession = body.profession?.trim() || "";
  const contact = body.contact?.trim() || "";
  const isGuest = Boolean(body.isGuest);

  // Guests skip the form entirely; non-guests must give at least a name.
  if (!isGuest && !name) {
    return Response.json(
      { error: "Name is required unless continuing as a guest." },
      { status: 422 },
    );
  }

  const record: LeadRecord = {
    id: generateId(),
    name,
    profession,
    contact,
    isGuest,
    createdAt: new Date().toISOString(),
  };

  await persistLead(record);

  return Response.json({ ok: true, lead: record }, { status: 201 });
}
