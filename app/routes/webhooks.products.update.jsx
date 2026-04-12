import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  // 1. Authenticate the incoming webhook
  const { topic, shop, payload } = await authenticate.webhook(request);

  // 2. Double-check we are on the right topic
  if (topic !== "PRODUCTS_UPDATE") {
    return new Response("Unhandled topic", { status: 400 });
  }

  // 3. Format the Product ID to match your database
  const graphqlProductId = `gid://shopify/Product/${payload.id}`;

  // 4. Extract the updated fields we care about
  const newHandle = payload.handle;
  const newTitle = payload.title;
  
  // Safely extract the first image (Shopify sends an array of images)
  let newImage = null;
  if (payload.images && payload.images.length > 0) {
    newImage = payload.images[0].src;
  }

  try {
    // 5. Build the data object to update
    const updateData = {
      productHandle: newHandle,
      productTitle: newTitle,
    };
    
    // Only overwrite the image if the product actually has one
    if (newImage) {
      updateData.productImage = newImage;
    }

    // 6. Update the database safely
    const updateResult = await db.campaign.updateMany({
      where: {
        shop: shop,
        productId: graphqlProductId,
      },
      data: updateData,
    });

    if (updateResult.count > 0) {
      console.log(`[Campaign Sync] Updated title, handle, and image for ${updateResult.count} campaigns on ${shop}`);
    }
  } catch (error) {
    console.error(`[Campaign Sync] Database error for ${shop}:`, error);
    // Returning a 500 tells Shopify the database was busy, so they will try sending the webhook again later!
    return new Response("Database Error", { status: 500 });
  }

  // 7. Always return a 200 OK
  return new Response("Webhook processed successfully", { status: 200 });
};