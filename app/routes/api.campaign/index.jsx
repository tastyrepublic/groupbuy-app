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

  try {
    const potentialCampaigns = await db.campaign.findMany({
      where: {
        productId: fullProductId,
        shop: shop,
        status: "ACTIVE",
        endDateTime: { gte: now },
      },
    });

    if (potentialCampaigns.length === 0) return json({ campaign: null }, { status: 404 });

    let campaign = potentialCampaigns.find(c => {
      const selectedIds = JSON.parse(c.selectedVariantIdsJson || '[]');
      return selectedIds.includes(fullVariantId);
    });

    if (!campaign) return json({ campaign: null }, { status: 404 });

    const campaignStatus = new Date(campaign.startDateTime) > now ? "SCHEDULED" : "ACTIVE";
    
    // Start with your fake count (the baseline)
    let finalProgress = campaign.startingParticipants; 

    // ✅ THE PLATINUM FIX: Lightweight REST Fetch instead of firebase-admin
    if (campaignStatus === "ACTIVE") {
      let docId = `campaign_${campaign.id}`;
      if (campaign.scope === 'VARIANT') {
         docId = `campaign_${campaign.id}_variant_${simpleVariantId}`;
      }

      // We know your Firebase project ID from your frontend code
      const projectId = "groupbuy-app-635bf"; 
      const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/campaignProgress/${docId}`;

      try {
        const fsResponse = await fetch(firestoreUrl);
        if (fsResponse.ok) {
          const fsData = await fsResponse.json();
          // Firestore REST API returns numbers inside specific type keys
          if (fsData.fields && fsData.fields.progress) {
            const liveDelta = parseInt(fsData.fields.progress.integerValue || 0, 10);
            finalProgress += liveDelta; // Add live sales to the fake count!
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
        startingParticipants: campaign.startingParticipants, // Passed to frontend
        sellingPlanId: campaign.sellingPlanId || "",
      },
      currentProgress: finalProgress, // Sent perfectly pre-calculated!
    });
    
  } catch (error) {
    console.error("Failed to fetch campaign for storefront:", error);
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
};