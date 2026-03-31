const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { firestore, FieldValue, prisma } = require("../config/init");
const { shopifyGraphQL } = require("../utils/shopify");

exports.processGroupBuyOrder = onMessagePublished("shopify-orders-create", async (event) => {
  try {
    const message = event.data.message;
    const payloadStr = Buffer.from(message.data, 'base64').toString();
    const payload = JSON.parse(payloadStr);

    if (['voided', 'refunded', 'partially_refunded'].includes(payload.financial_status)) {
      console.log(`  -> Order ${payload.id} is voided/refunded. Skipping.`);
      return;
    }

    let campaignId = null;
    for (const item of payload.line_items) {
      const properties = item.properties || [];
      const gbProp = properties.find(p => p.name === "_groupbuy_campaign_id");
      
      if (gbProp && gbProp.value) {
        campaignId = parseInt(gbProp.value, 10);
        break; 
      }
    }

    if (!campaignId) return; 

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    
    if (!campaign) {
      console.error(`Could not find campaign with ID ${campaignId}.`);
      return; 
    }

    const orderCreatedAt = new Date(payload.created_at);
    if (orderCreatedAt > new Date(campaign.endDateTime)) {
      console.log(`  -> Order ${payload.id} was placed AFTER the deadline. Skipping.`);
      return;
    }

    console.log(`  ✅ Processing Group Buy order for campaign ${campaignId}!`);

    let group = await prisma.group.findFirst({
      where: { campaignId, status: "OPEN" },
      orderBy: { createdAt: 'desc' }
    });
    
    if (!group) {
      group = await prisma.group.create({ data: { campaignId } });
    }

    const orderId = payload.admin_graphql_api_id;
    const customerId = payload.customer?.admin_graphql_api_id || payload.email || `guest-${orderId}`; 

    for (const item of payload.line_items) {
      const fullVariantId = `gid://shopify/ProductVariant/${item.variant_id}`;
      const validVariants = JSON.parse(campaign.selectedVariantIdsJson || '[]');
      
      if (validVariants.includes(fullVariantId)) {
        try {
          const priorParticipation = await prisma.participant.findFirst({
            where: {
              customerId: customerId,
              orderId: { not: orderId },
              status: "ACTIVE", 
              group: { campaignId: campaign.id },
              ...(campaign.scope === 'VARIANT' ? { productVariantId: fullVariantId } : {})
            }
          });

          const currentLeader = await prisma.participant.findFirst({
            where: { groupId: group.id, isLeader: true, status: "ACTIVE" } 
          });

          let isThisParticipantLeader = false;

          if (!currentLeader) {
            if (campaign.startingParticipants === 0) {
              isThisParticipantLeader = true;
            }
          } else {
            const incomingTime = orderCreatedAt.getTime();
            const currentLeaderTime = new Date(currentLeader.orderCreatedAt).getTime();

            if (incomingTime < currentLeaderTime) {
              console.log(`  🔄 LEADER STEAL! Order ${orderId} was placed before the current leader. Reassigning...`);
              await prisma.participant.update({
                where: { id: currentLeader.id },
                data: { isLeader: false }
              });
              isThisParticipantLeader = true;
            }
          }

          await prisma.participant.create({
            data: {
              orderId,
              customerId,
              groupId: group.id,
              quantity: item.quantity,
              productVariantId: fullVariantId,
              orderCreatedAt: orderCreatedAt,
              isLeader: isThisParticipantLeader,
              status: "ACTIVE" 
            },
          });
          
          console.log(`  ✅ Saved participant for variant ${item.variant_id} (Leader: ${isThisParticipantLeader})`);
          
          try {
            const session = await prisma.session.findFirst({
              where: { shop: campaign.shop, isOnline: false }
            });
            
            if (session) {
              await shopifyGraphQL(campaign.shop, session.accessToken,
                `mutation tagsAdd($id: ID!, $tags: [String!]!) {
                  tagsAdd(id: $id, tags: $tags) { userErrors { message } }
                }`,
                { id: orderId, tags: ["⚠️ DO NOT CAPTURE - GROUPBUY"] }
              );
              console.log(`  🏷️ Added 'DO NOT CAPTURE' warning tag to order ${orderId}`);
            }
          } catch (tagError) {
            console.error(`  ❌ Failed to add warning tag:`, tagError.message);
          }
          
          let progressDelta = campaign.countingMethod === 'ITEM_QUANTITY' ? item.quantity : (priorParticipation ? 0 : 1);

          if (progressDelta > 0) {
            const simpleVariantId = item.variant_id;
            let docId = `campaign_${campaignId}`;
            if (campaign.scope === 'VARIANT') {
               docId = `campaign_${campaignId}_variant_${simpleVariantId}`;
            }

            await firestore.collection("campaignProgress").doc(docId).set({
              progress: FieldValue.increment(progressDelta),
              updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            
            console.log(`  🚀 Atomically incremented Firestore ${docId} by: ${progressDelta}`);
          }

        } catch (error) {
          if (error.code === 'P2002') {
            console.log(`  -> Order ${orderId} already exists (Duplicate Webhook or Canceled Early). Skipping safely.`);
          } else {
            console.error("  ❌ Database error:", error);
          }
        }
      }
    }
  } catch (error) {
    console.error("❌ Worker: Error processing message:", error);
    throw error;
  }
});