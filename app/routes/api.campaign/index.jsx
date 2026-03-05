import { json } from "@remix-run/node";
import db from "../../db.server";

/**
 * ✅ NEW: This function correctly calculates progress based on scope
 */
async function getCampaignProgress(campaign, fullVariantId) {
  let currentProgress = 0;
  
  if (campaign.scope === 'PRODUCT') {
    const participants = await db.participant.findMany({
      where: { group: { campaignId: campaign.id } }
    });
    if (campaign.countingMethod === 'ITEM_QUANTITY') {
      currentProgress = participants.reduce((sum, p) => sum + p.quantity, 0);
    } else {
      currentProgress = new Set(participants.map(p => p.customerId)).size;
    }
  } else { // 'VARIANT' scope
    const participants = await db.participant.findMany({
      where: {
        group: { campaignId: campaign.id },
        productVariantId: fullVariantId // Filter by the specific variant
      }
    });
    if (campaign.countingMethod === 'ITEM_QUANTITY') {
      currentProgress = participants.reduce((sum, p) => sum + p.quantity, 0);
    } else {
      currentProgress = new Set(participants.map(p => p.customerId)).size;
    }
  }
  return currentProgress + campaign.startingParticipants;
}

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

    if (potentialCampaigns.length === 0) {
      return json({ campaign: null }, { status: 404 });
    }

    let campaign = potentialCampaigns.find(c => {
      const selectedIds = JSON.parse(c.selectedVariantIdsJson || '[]');
      return selectedIds.includes(fullVariantId);
    });

    if (!campaign) {
      return json({ campaign: null }, { status: 404 });
    }

    const campaignStatus = new Date(campaign.startDateTime) > now ? "SCHEDULED" : "ACTIVE";
    let finalProgress = 0;

    if (campaignStatus === "ACTIVE") {
      finalProgress = await getCampaignProgress(campaign, fullVariantId);
    } else {
      finalProgress = campaign.startingParticipants;
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
      },
      currentProgress: finalProgress,
    });
    
  } catch (error) {
    console.error("Failed to fetch campaign for storefront:", error);
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
};