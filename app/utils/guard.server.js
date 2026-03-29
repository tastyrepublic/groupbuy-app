import { redirect } from "@remix-run/node";
import db from "../db.server";

export async function requireSetup(session, request) {
  const settings = await db.settings.findUnique({ where: { shop: session.shop } });
  
  if (!settings || !settings.isOnboarded) {
    const url = new URL(request.url);
    // throw redirect halts execution instantly and forces the route change
    throw redirect(`/app/onboarding${url.search}`); 
  }
}