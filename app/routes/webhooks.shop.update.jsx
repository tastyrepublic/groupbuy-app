import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  // 1. Authenticate the incoming webhook from Shopify
  const { topic, shop, payload } = await authenticate.webhook(request);

  // 2. Double-check we are on the right topic 
  if (topic !== "SHOP_UPDATE") {
    return new Response("Unhandled topic", { status: 400 });
  }

  // 3. Extract the new public contact email from the payload
  const newContactEmail = payload.customer_email;

  if (newContactEmail) {
    try {
      // 4. Update the Appublic database safely
      await db.settings.upsert({
        where: { shop: shop },
        update: { contactEmail: newContactEmail },
        create: { 
          shop: shop, 
          contactEmail: newContactEmail 
        },
      });
      console.log(`[Enterprise Sync] Updated contact email for ${shop}`);
    } catch (error) {
      console.error(`[Enterprise Sync] Database error for ${shop}:`, error);
      // Returning a 500 tells Shopify the database was busy, so they will try sending the webhook again later!
      return new Response("Database Error", { status: 500 });
    }
  }

  // 5. Always return a 200 OK
  return new Response("Webhook processed successfully", { status: 200 });
};