import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // 1. Delete the active session (Logs them out)
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  try {
    // 2. Find all campaigns for this shop
    const shopCampaigns = await db.campaign.findMany({
      where: { shop },
      select: { id: true }
    });
    const campaignIds = shopCampaigns.map(c => c.id);

    // 3. Find all groups tied to those campaigns
    const shopGroups = await db.group.findMany({
      where: { campaignId: { in: campaignIds } },
      select: { id: true }
    });
    const groupIds = shopGroups.map(g => g.id);

    // 4. Safely delete data in reverse order of dependency!
    if (groupIds.length > 0) {
      await db.participant.deleteMany({ where: { groupId: { in: groupIds } } }); // Delete participants first
      await db.group.deleteMany({ where: { id: { in: groupIds } } });           // Then delete groups
    }
    
    if (campaignIds.length > 0) {
      await db.campaign.deleteMany({ where: { shop } });                        // Then delete campaigns
    }

    // 5. Finally, wipe their global settings
    await db.settings.deleteMany({ where: { shop } });

    console.log(`[Webhook] Cleaned up all Group Buy data for ${shop}. Clean slate ready.`);
  } catch (error) {
    console.error(`[Webhook Error] Failed to clean up data for ${shop}:`, error);
  }

  return new Response();
};