import { json } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import db from "../../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "Unauthorized" }, { status: 401 });

  const shop = session.shop;
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const handlesParam = url.searchParams.get("handles");

  let responseData = {
    hasActiveCampaign: false,
    campaignData: null,
    activeCampaignsByHandle: {} 
  };

  // Scenario 1: Product Page App Block
  if (productId) {
    const activeCampaign = await db.campaign.findFirst({
      where: { 
        shop, 
        productId: `gid://shopify/Product/${productId}`, 
        status: { in: ["ACTIVE", "SCHEDULED"] } // ✨ Allow both Active and Scheduled
      }
    });
    if (activeCampaign) {
      responseData.hasActiveCampaign = true;
      responseData.campaignData = { 
        startDateTime: activeCampaign.startDateTime, // ✨ Send Start Time
        endDateTime: activeCampaign.endDateTime 
      };
    }
  }

  // Scenario 2: Collection Page App Embed (Global Script)
  if (handlesParam) {
    const handlesArray = handlesParam.split(',').map(h => h.trim());
    
    const activeCampaigns = await db.campaign.findMany({
      where: { 
        shop, 
        status: { in: ["ACTIVE", "SCHEDULED"] }, // ✨ Allow both Active and Scheduled
        productHandle: { in: handlesArray } 
      },
      select: { productHandle: true, startDateTime: true, endDateTime: true } // ✨ Select Start Time
    });

    if (activeCampaigns.length > 0) {
      for (const campaign of activeCampaigns) {
        if (campaign.productHandle) {
          responseData.activeCampaignsByHandle[campaign.productHandle] = {
            startDateTime: campaign.startDateTime, // ✨ Pass Start Time to frontend
            endDateTime: campaign.endDateTime
          };
        }
      }
    }
  }

  return json(responseData);
};