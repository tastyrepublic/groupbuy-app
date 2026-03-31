const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { firestore, FieldValue, prisma } = require("../config/init");
const { shopifyGraphQL } = require("../utils/shopify"); // ✨ NEW: Import the GraphQL helper

exports.processOrderUpdate = onMessagePublished("shopify-orders-updated", async (event) => {
  try {
    const payload = JSON.parse(Buffer.from(event.data.message.data, 'base64').toString());
    const orderId = payload.admin_graphql_api_id;
    const customerId = payload.customer?.admin_graphql_api_id || payload.email || `guest-${orderId}`;

    console.log(`\n🔍 [DIAGNOSTIC] orders/updated triggered for ${orderId}`);

    // 1. Find the target item in the cart
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

    if (!campaignId || !targetItem) {
      console.log(`  -> 🛑 SKIPPED: No '_groupbuy_campaign_id' found in the cart.`);
      return; 
    }

    const fullVariantId = `gid://shopify/ProductVariant/${targetItem.variant_id}`;
    
    // Safely extract the live quantity, prioritizing Shopify's post-edit 'current_quantity'
    const liveQty = targetItem.current_quantity !== undefined ? targetItem.current_quantity : targetItem.quantity;
    
    // 2. Try to find the existing order
    const existingOrder = await prisma.participant.findUnique({
      where: { orderId_productVariantId: { orderId, productVariantId: fullVariantId } },
      include: { group: { include: { campaign: true } } }
    });

    const campaign = existingOrder ? existingOrder.group.campaign : await prisma.campaign.findUnique({ where: { id: campaignId } });
    
    if (!campaign) {
      console.log(`  -> 🛑 SKIPPED: Campaign ${campaignId} does not exist in the database.`);
      return;
    }
    
    if (campaign.status !== "ACTIVE") {
      console.log(`  -> 🛑 SKIPPED: Campaign ${campaignId} is no longer ACTIVE (Current status: ${campaign.status}).`);
      return;
    }

    // ========================================================================
    // 🛡️ RACE CONDITION TRAP
    // ========================================================================
    if (!existingOrder) {
      console.log(`  🔄 Race Condition Caught! Update for ${orderId} arrived before Creation. Preempting...`);
      
      let group = await prisma.group.findFirst({
        where: { campaignId, status: "OPEN" },
        orderBy: { createdAt: 'desc' }
      });
      if (!group) group = await prisma.group.create({ data: { campaignId } });

      try {
        const currentLeader = await prisma.participant.findFirst({ where: { groupId: group.id, isLeader: true, status: "ACTIVE" } });
        const isLeader = !currentLeader && campaign.startingParticipants === 0;

        await prisma.participant.create({
          data: {
            orderId,
            customerId,
            groupId: group.id,
            quantity: liveQty, 
            productVariantId: fullVariantId,
            orderCreatedAt: new Date(payload.created_at),
            isLeader: isLeader,
            status: "ACTIVE" 
          },
        });

        let initialDelta = campaign.countingMethod === 'ITEM_QUANTITY' ? liveQty : 1;
        if (initialDelta > 0) {
          let docId = campaign.scope === 'VARIANT' ? `campaign_${campaign.id}_variant_${targetItem.variant_id}` : `campaign_${campaign.id}`;
          await firestore.collection("campaignProgress").doc(docId).set({
            progress: FieldValue.increment(initialDelta),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
        console.log(`  ✅ Successfully Preempted! Created order ${orderId} with edited quantity ${liveQty}.`);

        // ✨ NEW: Tag the order in Shopify so the merchant knows it was edited right out of the gate
        try {
          const session = await prisma.session.findFirst({ where: { shop: campaign.shop, isOnline: false } });
          if (session) {
            await shopifyGraphQL(campaign.shop, session.accessToken,
              `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
              { id: orderId, tags: ["GroupBuy: Edited"] }
            );
            console.log(`  🏷️ Added 'GroupBuy: Edited' tag to preempted order ${orderId}`);
          }
        } catch (tagError) {
          console.error(`  ❌ Failed to add edited tag:`, tagError.message);
        }

      } catch (err) {
        if (err.code !== 'P2002') console.error("Database Error:", err);
      }
      return; 
    }

    // ========================================================================
    // 📐 NORMAL DELTA MATH
    // ========================================================================
    if (existingOrder.status !== "ACTIVE") {
      console.log(`  -> 🛑 SKIPPED: The order exists but is marked as ${existingOrder.status}.`);
      return;
    }

    const oldQty = existingOrder.quantity;
    const newQty = liveQty; 

    if (oldQty === newQty) {
      console.log(`  -> 🛑 SKIPPED: Quantity is unchanged (${oldQty} === ${newQty}). Stopping to prevent infinite loop.`);
      return; 
    }

    console.log(`📝 Order ${orderId} updated! Quantity changed from ${oldQty} to ${newQty}`);

    // Update the database
    await prisma.participant.update({
      where: { id: existingOrder.id },
      data: { quantity: newQty }
    });

    // Update the UI Progress Bar
    let progressDelta = 0;
    if (campaign.countingMethod === 'ITEM_QUANTITY') {
      progressDelta = newQty - oldQty; 
    } else {
      if (oldQty > 0 && newQty === 0) progressDelta = -1;
      if (oldQty === 0 && newQty > 0) progressDelta = 1;
    }

    if (progressDelta !== 0) {
      let docId = campaign.scope === 'VARIANT' ? `campaign_${campaign.id}_variant_${targetItem.variant_id}` : `campaign_${campaign.id}`;
      await firestore.collection("campaignProgress").doc(docId).set({
        progress: FieldValue.increment(progressDelta),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`  📊 Adjusted Firestore progress by ${progressDelta}`);
    }

    // ✨ NEW: Tag the order in Shopify so the merchant knows it was edited
    try {
      const session = await prisma.session.findFirst({ where: { shop: campaign.shop, isOnline: false } });
      if (session) {
        await shopifyGraphQL(campaign.shop, session.accessToken,
          `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { id: orderId, tags: ["GroupBuy: Edited"] }
        );
        console.log(`  🏷️ Added 'GroupBuy: Edited' tag to order ${orderId}`);
      }
    } catch (tagError) {
      console.error(`  ❌ Failed to add edited tag:`, tagError.message);
    }

  } catch (error) {
    console.error("❌ Update Worker Error:", error);
  }
});