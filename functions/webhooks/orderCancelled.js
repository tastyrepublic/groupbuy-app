const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { firestore, FieldValue, prisma } = require("../config/init");
const { shopifyGraphQL } = require("../utils/shopify"); // ✨ NEW: Import the GraphQL helper

// ✨ UPGRADED: Helper function to clean up and apply tags
async function tagCancelledOrder(shop, orderId) {
  try {
    const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
    if (session) {
      // 1. Remove the DO NOT CAPTURE warning AND the Edited tag!
      await shopifyGraphQL(shop, session.accessToken,
        `mutation tagsRemove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
        { id: orderId, tags: ["⚠️ DO NOT CAPTURE - GROUPBUY", "GroupBuy: Edited"] } // ✨ Added "GroupBuy: Edited" here
      );
      
      // 2. Add the Cancelled tag
      await shopifyGraphQL(shop, session.accessToken,
        `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
        { id: orderId, tags: ["GroupBuy: Cancelled"] }
      );
      console.log(`  🏷️ Cleaned up old tags and applied 'GroupBuy: Cancelled' to order ${orderId}`);
    }
  } catch (err) {
    console.error(`  ❌ Failed to update tags for cancelled order:`, err.message);
  }
}

exports.processOrderCancellation = onMessagePublished("shopify-orders-cancelled", async (event) => {
  try {
    const payload = JSON.parse(Buffer.from(event.data.message.data, 'base64').toString());
    const orderId = payload.admin_graphql_api_id;
    const customerId = payload.customer?.admin_graphql_api_id || payload.email || `guest-${orderId}`;

    let campaignId = null;
    let targetItem = null;
    for (const item of payload.line_items) {
      const gbProp = (item.properties || []).find(p => p.name === "_groupbuy_campaign_id");
      if (gbProp) {
        campaignId = parseInt(gbProp.value, 10);
        targetItem = item;
        break;
      }
    }

    if (!campaignId) {
      console.log(`  -> Cancelled order ${orderId} is a regular store order. Skipping safely.`);
      return; 
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    
    if (!campaign) return;

    if (campaign.status !== "ACTIVE") {
      console.log(`  -> Ignored late cancellation for order ${orderId}. Campaign ${campaignId} is currently '${campaign.status}'.`);
      return;
    }

    const group = await prisma.group.findFirst({
      where: { campaignId, status: "OPEN" },
      orderBy: { createdAt: 'desc' }
    });
    
    const fullVariantId = `gid://shopify/ProductVariant/${targetItem.variant_id}`;

    try {
      // ATTEMPT 1: The Cancel arrived FIRST. Create a Tombstone.
      await prisma.participant.create({
        data: {
          orderId,
          customerId,
          groupId: group.id,
          quantity: targetItem.quantity,
          productVariantId: fullVariantId,
          orderCreatedAt: new Date(payload.created_at),
          status: "CANCELLED"
        }
      });
      console.log(`  💀 Cancel arrived first. Created Tombstone for ${orderId}. UI unchanged.`);
      
      // ✨ NEW: Tag the order
      await tagCancelledOrder(campaign.shop, orderId);

    } catch (error) {
      // ATTEMPT 2: The Create already happened! We need to kill the active order.
      if (error.code === 'P2002') {
        const existingOrder = await prisma.participant.findUnique({
          where: { orderId_productVariantId: { orderId, productVariantId: fullVariantId } }
        });

        if (!existingOrder || existingOrder.status === "CANCELLED") return; 

        // Update to Cancelled
        await prisma.participant.update({
          where: { id: existingOrder.id },
          data: { status: "CANCELLED", isLeader: false }
        });

        // SMART UI ROLLBACK
        let progressDelta = 0;
        if (campaign.countingMethod === 'ITEM_QUANTITY') {
          progressDelta = existingOrder.quantity;
        } else {
          const remainingActiveOrders = await prisma.participant.count({
            where: {
              customerId: existingOrder.customerId,
              status: "ACTIVE",
              group: { campaignId: campaign.id }
            }
          });
          progressDelta = remainingActiveOrders > 0 ? 0 : 1;
        }

        if (progressDelta > 0) {
          let docId = campaign.scope === 'VARIANT' ? `campaign_${campaign.id}_variant_${targetItem.variant_id}` : `campaign_${campaign.id}`;

          await firestore.collection("campaignProgress").doc(docId).set({
            progress: FieldValue.increment(-progressDelta),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });

          console.log(`  📉 Rolled back progress for canceled order ${orderId} by -${progressDelta}.`);
        }

        // LEADER SHIFT: Pass the crown if the leader canceled
        if (existingOrder.isLeader) {
          const nextLeader = await prisma.participant.findFirst({
            where: { groupId: existingOrder.groupId, status: "ACTIVE" },
            orderBy: { orderCreatedAt: 'asc' }
          });

          if (nextLeader) {
            await prisma.participant.update({
              where: { id: nextLeader.id },
              data: { isLeader: true }
            });
            console.log(`  👑 Crown passed to new Leader: ${nextLeader.orderId}`);
          }
        }

        // ✨ NEW: Tag the order
        await tagCancelledOrder(campaign.shop, orderId);

      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("❌ Worker Error:", error);
  }
});