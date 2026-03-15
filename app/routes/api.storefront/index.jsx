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

  const settings = await db.settings.findUnique({
    where: { shop },
    select: { enableBadge: true, enableTimer: true }
  });

  let responseData = {
    settings: settings || { enableBadge: false, enableTimer: false },
    hasActiveCampaign: false,
    campaignData: null,
    activeCampaignsByHandle: {} 
  };

  // Scenario 1: Product Page App Block
  if (productId) {
    const activeCampaign = await db.campaign.findFirst({
      where: { shop, productId: `gid://shopify/Product/${productId}`, status: "ACTIVE" }
    });
    if (activeCampaign) {
      responseData.hasActiveCampaign = true;
      responseData.campaignData = { endDateTime: activeCampaign.endDateTime };
    }
  }

  // Scenario 2: Collection Page App Embed (Global Script)
  if (handlesParam) {
    const handlesArray = handlesParam.split(',').map(h => h.trim());
    
    // ✨ FAST LOOKUP: Instantly find all active campaigns matching these handles directly in your DB!
    const activeCampaigns = await db.campaign.findMany({
      where: { 
        shop, 
        status: "ACTIVE",
        productHandle: { in: handlesArray } // Only pull the ones on the page
      },
      select: { productHandle: true, endDateTime: true }
    });

    if (activeCampaigns.length > 0) {
      for (const campaign of activeCampaigns) {
        if (campaign.productHandle) {
          responseData.activeCampaignsByHandle[campaign.productHandle] = {
            endDateTime: campaign.endDateTime
          };
        }
      }
    }
  }

  return json(responseData);
};