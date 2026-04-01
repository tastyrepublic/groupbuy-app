import { json } from "@remix-run/node";
import db from "../../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");
  const variantId = url.searchParams.get("variantId");
  const shop = url.searchParams.get("shop");

  if (!productId || !variantId || !shop) {
    return json({ error: "Product, Variant, and Shop are required" }, { status: 400 });
  }

  const fullProductId = `gid://shopify/Product/${productId}`;
  const fullVariantId = `gid://shopify/ProductVariant/${variantId}`;
  const simpleVariantId = variantId.split('/').pop();
  const now = new Date();
  
  // Look back 30 days to catch recently ended campaigns
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    // 1. Fetch ALL campaigns in the last 30 days (Active, Scheduled, and Ended)
    const potentialCampaigns = await db.campaign.findMany({
      where: {
        productId: fullProductId,
        shop: shop,
        endDateTime: { gte: thirtyDaysAgo },
      }
    });

    if (potentialCampaigns.length === 0) {
      return json({ campaign: null, productHasCampaign: false }); 
    }

    // 2. Filter down to ONLY campaigns that include this specific variant
    const matchingCampaigns = potentialCampaigns.filter(c => {
      const selectedIds = JSON.parse(c.selectedVariantIdsJson || '[]');
      return selectedIds.includes(fullVariantId);
    });

    if (matchingCampaigns.length === 0) {
      return json({ campaign: null, productHasCampaign: true, message: "Variant not included" });
    }

    // 3. Helper function to determine the exact live status of a campaign
    const getStatus = (c) => {
      if (new Date(c.startDateTime) > now) return "SCHEDULED";
      if (new Date(c.endDateTime) < now || c.status !== "ACTIVE") return "ENDED";
      return "ACTIVE";
    };

    // 4. Sort by Priority! (ACTIVE > SCHEDULED > ENDED)
    matchingCampaigns.sort((a, b) => {
      const statusA = getStatus(a);
      const statusB = getStatus(b);
      const priority = { "ACTIVE": 1, "SCHEDULED": 2, "ENDED": 3 };
      
      if (priority[statusA] !== priority[statusB]) {
        return priority[statusA] - priority[statusB]; // Highest priority wins
      }
      // If they have the exact same status, show the one ending furthest in the future
      return new Date(b.endDateTime) - new Date(a.endDateTime);
    });

    // 5. Grab the undisputed winner
    const campaign = matchingCampaigns[0];
    const campaignStatus = getStatus(campaign);
    
    let finalProgress = campaign.startingParticipants; 

    // ✨ FIX: Fetch Firebase data for BOTH Active and Ended campaigns!
    // We only skip SCHEDULED campaigns because they haven't started accumulating real orders yet.
    if (campaignStatus === "ACTIVE" || campaignStatus === "ENDED") {
      let docId = `campaign_${campaign.id}`;
      if (campaign.scope === 'VARIANT') {
         docId = `campaign_${campaign.id}_variant_${simpleVariantId}`;
      }

      const projectId = "groupbuy-app-635bf"; 
      const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/campaignProgress/${docId}`;

      try {
        const fsResponse = await fetch(firestoreUrl);
        if (fsResponse.ok) {
          const fsData = await fsResponse.json();
          if (fsData.fields && fsData.fields.progress) {
            const liveDelta = parseInt(fsData.fields.progress.integerValue || 0, 10);
            finalProgress += liveDelta; 
          }
        }
      } catch (e) {
        console.error("Non-fatal: Could not fetch initial Firestore delta via REST", e);
      }
    }

    return json({
      campaign: {
        id: campaign.id,
        tiers: JSON.parse(campaign.tiersJson),
        timezone: campaign.timezone,
        startDateTime: campaign.startDateTime,
        endDateTime: campaign.endDateTime,
        scope: campaign.scope,
        countingMethod: campaign.countingMethod,
        status: campaignStatus,
        selectedVariantIdsJson: campaign.selectedVariantIdsJson,
        startingParticipants: campaign.startingParticipants, 
        sellingPlanId: campaign.sellingPlanId || "",
        leaderDiscount: campaign.leaderDiscount,
        leaderMaxQty: campaign.leaderMaxQty,
      },
      currentProgress: finalProgress, 
    });
    
  } catch (error) {
    console.error("Failed to fetch campaign for storefront:", error);
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
};