import { json } from "@remix-run/node";
import db from "../../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const productId = `gid://shopify/Product/${url.searchParams.get("productId")}`;
  const customerId = url.searchParams.get("customerId");

  if (!productId || !customerId || customerId === "null") {
    return json({ hasJoined: false });
  }
  
  const fullCustomerId = `gid://shopify/Customer/${customerId}`;

  try {
    // 1. Find the active campaign
    const campaign = await db.campaign.findFirst({
      where: { productId: productId, status: "ACTIVE" },
      select: { id: true, scope: true, countingMethod: true } // ✅ Get countingMethod
    });

    if (!campaign) {
      return json({ hasJoined: false });
    }

    // 2. Check if a participant record exists
    const participant = await db.participant.findFirst({
      where: {
        customerId: fullCustomerId,
        group: {
          campaignId: campaign.id,
        },
      },
    });

    // 3. Return all the data our storefront needs
    return json({ 
      hasJoined: !!participant, 
      scope: campaign.scope,
      countingMethod: campaign.countingMethod // ✅ Return countingMethod
    }); 

  } catch (error) {
    console.error("Check status error:", error);
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
};