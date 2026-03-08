const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const admin = require("firebase-admin");
const FieldValue = admin.firestore.FieldValue;
const { PrismaClient } = require("@prisma/client");
const { onSchedule } = require("firebase-functions/v2/scheduler"); 
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Initialize Firebase Admin for Firestore access
admin.initializeApp();
const firestore = admin.firestore();

// Initialize Prisma to connect to NeonDB
const prisma = new PrismaClient();

// ============================================================================
// 🛒 WEBHOOK: Processes orders and uses Atomic Increments for progress
// ============================================================================

// 🚀 The Firebase Function triggered by Shopify Pub/Sub
exports.processGroupBuyOrder = onMessagePublished("shopify-orders-create", async (event) => {
  try {
    const message = event.data.message;
    const payloadStr = Buffer.from(message.data, 'base64').toString();
    const payload = JSON.parse(payloadStr);

    const orderId = payload.admin_graphql_api_id;
    const customerId = payload.customer?.admin_graphql_api_id || payload.email || `guest-${orderId}`; 

    // 1. Verify this is a Group Buy order using the cart attribute we securely injected
    const noteAttributes = payload.note_attributes || [];
    const groupbuyAttribute = noteAttributes.find(
      (attr) => attr.name === "_groupbuy_campaign_id"
    );

    if (!groupbuyAttribute) {
      console.log(`  -> Regular order. Skipping.`);
      return;
    }

    const campaignId = parseInt(groupbuyAttribute.value, 10);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    
    if (!campaign) {
      console.error(`Could not find campaign with ID ${campaignId}.`);
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

    let hasProcessedAnyCampaignItem = false;
    const validVariants = JSON.parse(campaign.selectedVariantIdsJson || '[]');

    // 2. Loop through the line items and process the ones that match our campaign
    for (const item of payload.line_items) {
      const fullVariantId = `gid://shopify/ProductVariant/${item.variant_id}`;
      
      // If the variant in the cart matches the campaign's variants, count it!
      if (validVariants.includes(fullVariantId)) {
        const existingParticipant = await prisma.participant.findFirst({
          where: { orderId, productVariantId: fullVariantId }
        });

        if (!existingParticipant) {
          // 🚀 SPEED UPGRADE: Run the Reads in parallel
          const [priorParticipation, existingGroupMembers] = await Promise.all([
            prisma.participant.findFirst({
              where: {
                customerId: customerId,
                orderId: { not: orderId }, 
                group: { campaignId: campaign.id },
                ...(campaign.scope === 'VARIANT' ? { productVariantId: fullVariantId } : {})
              }
            }),
            prisma.participant.count({
              where: { groupId: group.id }
            })
          ]);

          const isLeader = existingGroupMembers === 0 && campaign.startingParticipants === 0;

          // 🛡️ BULLETPROOF UPGRADE: Save to the main database FIRST
          await prisma.participant.create({
            data: {
              orderId, customerId, isLeader,
              groupId: group.id,
              quantity: item.quantity,
              productVariantId: fullVariantId, 
            },
          });
          
          hasProcessedAnyCampaignItem = true;
          console.log(`  ✅ Saved participant for variant ${item.variant_id} (Qty: ${item.quantity})`);
          
          // 🛡️ ONLY IF Prisma succeeds, do we calculate and increment the progress bar!
          let progressDelta = 0;
          if (campaign.countingMethod === 'ITEM_QUANTITY') {
            progressDelta = item.quantity;
          } else {
            progressDelta = priorParticipation ? 0 : 1;
          }

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
            
            console.log(`  🚀 Atomically incremented Firestore document ${docId} by: ${progressDelta}`);
          } else {
            console.log(`  -> Customer already counted for this campaign. No increment needed.`);
          }

        } else {
          console.log(`  -> Participant already exists for order ${orderId}, skipping duplicate.`);
        }
      }
    }

    if (!hasProcessedAnyCampaignItem) {
      console.log("  -> Order processed, but no valid Group Buy items were found.");
    }

  } catch (error) {
    console.error("❌ Worker: Error processing message:", error);
    throw error;
  }
});

// ============================================================================
// 🚀 WEBHOOK: Auto-Release Fulfillment Hold when Payment Succeeds
// ============================================================================
exports.autoReleaseHold = onMessagePublished("shopify-orders-paid", async (event) => {
  try {
    const message = event.data.message;
    // Safely check for the shop domain attribute
    const shopDomain = message.attributes['X-Shopify-Shop-Domain'] || message.attributes['x-shopify-shop-domain'];
    
    if (!shopDomain) return;

    const payloadStr = Buffer.from(message.data, 'base64').toString();
    const payload = JSON.parse(payloadStr);
    const orderId = payload.admin_graphql_api_id;

    // 1. Verify this is a Group Buy order
    const isGroupBuy = payload.note_attributes?.some(attr => attr.name === "_groupbuy_campaign_id");
    if (!isGroupBuy) return;

    console.log(`✅ Order ${orderId} was just paid! Releasing fulfillment hold...`);

    // 2. Get the offline session to authenticate
    const session = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false }
    });

    if (!session) {
      console.error(`❌ No offline session found for shop: ${shopDomain}`);
      return;
    }

    // 3. Get the Fulfillment Orders attached to this purchase
    const fulfillmentQuery = await shopifyGraphQL(shopDomain, session.accessToken,
      `query getFulfillmentOrders($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
              }
            }
          }
        }
      }`,
      { id: orderId }
    );

    const fulfillmentOrders = fulfillmentQuery.data?.order?.fulfillmentOrders?.edges || [];

    // 4. Loop through and forcefully release any holds!
    let releasedCount = 0;
    for (const edge of fulfillmentOrders) {
      if (edge.node.status === "ON_HOLD") {
        await shopifyGraphQL(shopDomain, session.accessToken,
          `mutation releaseHold($id: ID!) {
            fulfillmentOrderReleaseHold(id: $id) {
              fulfillmentOrder { status }
              userErrors { message }
            }
          }`,
          { id: edge.node.id }
        );
        releasedCount++;
        console.log(`   🔓 Successfully released hold on FulfillmentOrder: ${edge.node.id}`);
      }
    }

    if (releasedCount === 0) {
       console.log(`   -> No holds needed releasing for order ${orderId}.`);
    }

  } catch (error) {
    console.error("❌ Error auto-releasing hold:", error.message);
  }
});

// ============================================================================
// 🧹 THE SWEEPER: Runs every 5 minutes to finalize expired campaigns
// ============================================================================

// --- HELPER: Raw Shopify GraphQL Caller ---
async function shopifyGraphQL(shop, accessToken, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/2025-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables })
  });
  
  if (!response.ok) {
    throw new Error(`Shopify API HTTP Error: ${response.status}`);
  }
  return response.json();
}

// --- HELPER 1: Process Success (Applies Discount Only) ---
async function processParticipants(participants, finalDiscountTier, shop, accessToken, campaign) {
  for (const participant of participants) {
    console.log(`   - Processing order ${participant.orderId}...`);
    try {
      // 1. Begin Order Edit
      const beginEditJson = await shopifyGraphQL(shop, accessToken, 
        `mutation orderEditBegin($id: ID!) {
          orderEditBegin(id: $id) {
            calculatedOrder {
              id
              lineItems(first: 25) { edges { node { id quantity variant { id } } } }
            }
            userErrors { field message }
          }
        }`,
        { id: participant.orderId }
      );

      const calculatedOrder = beginEditJson.data?.orderEditBegin?.calculatedOrder;
      if (!calculatedOrder) {
        console.error(`     ❌ Failed to begin edit for order ${participant.orderId}`);
        continue;
      }
      
      const calculatedOrderId = calculatedOrder.id;

      // 2. Apply Discount to Line Item
      const lineItemToDiscount = calculatedOrder.lineItems.edges.find(
        (edge) => edge.node.variant.id === participant.productVariantId
      )?.node;
      
      if (lineItemToDiscount) {
        const isEligibleForLeaderDiscount = participant.isLeader && campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0;
        
        const discountPercentage = isEligibleForLeaderDiscount 
          ? parseFloat(campaign.leaderDiscount) 
          : parseFloat(finalDiscountTier.discount);

        const discountDescription = isEligibleForLeaderDiscount
          ? "Group Buy Leader Discount"
          : "Group Buy Discount";

        await shopifyGraphQL(shop, accessToken,
          `mutation orderEditAddLineItemDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
            orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
              calculatedOrder { id }
            }
          }`,
          {
            id: calculatedOrderId,
            lineItemId: lineItemToDiscount.id,
            discount: { percentValue: discountPercentage, description: discountDescription }
          }
        );
      }
      
      // 3. Commit the Edit
      await shopifyGraphQL(shop, accessToken,
        `mutation orderEditCommit($id: ID!) {
          orderEditCommit(id: $id) { order { id } }
        }`,
        { id: calculatedOrderId }
      );
      
      console.log(`     ✅ Successfully applied discount to order ${participant.orderId}. Shopify will auto-capture in 15 minutes.`);

      // 🚨 NOTICE: We completely removed the orderCapture logic here! 
      // Shopify's native billing engine will now handle the vaulted capture automatically.

    } catch (error) {
      console.error(`     ❌ Error processing order ${participant.orderId}:`, error.message);
    }
  }
}

// --- HELPER 2: Process Failure (Cancels Orders & Voids Payment) ---
async function cancelFailedOrders(participants, shop, accessToken) {
  for (const participant of participants) {
    console.log(`   - Canceling order ${participant.orderId} (Campaign Failed)...`);
    try {
      const cancelJson = await shopifyGraphQL(shop, accessToken,
        `mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!) {
          orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: true, restock: true, refund: true) {
            job { id }
            orderCancelUserErrors { field message }
          }
        }`,
        { 
          orderId: participant.orderId, 
          reason: "DECLINED" 
        }
      );

      const errors = cancelJson.data?.orderCancel?.orderCancelUserErrors;

      if (errors && errors.length > 0) {
        console.error(`     ❌ Error canceling ${participant.orderId}:`, errors);
      } else {
        console.log(`     ✅ Successfully canceled order and voided authorization.`);
      }
    } catch (error) {
      console.error(`     ❌ Error during cancellation of ${participant.orderId}:`, error.message);
    }
  }
}

// 🚀 The Sweeper Function Trigger
exports.campaignFinalizer = onSchedule("every 5 minutes", async (event) => {
  console.log("🧹 Sweeper waking up! Checking for expired campaigns...");
  const now = new Date();

  try {
    // Find all ACTIVE campaigns where the end time has passed
    const expiredCampaigns = await prisma.campaign.findMany({
      where: { 
        status: "ACTIVE", 
        endDateTime: { lte: now } 
      },
      include: { groups: { include: { participants: true } } }
    });

    if (expiredCampaigns.length === 0) {
      console.log(" -> No expired campaigns found. Going back to sleep.");
      return;
    }

    console.log(` -> Found ${expiredCampaigns.length} campaigns to finalize!`);

    for (const campaign of expiredCampaigns) {
      console.log(`\n--- ⏰ Finalizing Campaign ID: ${campaign.id} ---`);

      // 🔑 Get the Shopify Offline Access Token from the DB
      const session = await prisma.session.findFirst({
        where: { shop: campaign.shop, isOnline: false }
      });

      if (!session) {
        console.error(` ❌ No offline session found for shop: ${campaign.shop}. Skipping.`);
        continue;
      }

      let anyVariantSucceeded = false;
      const allParticipants = campaign.groups.flatMap((g) => g.participants);
      const tiers = JSON.parse(campaign.tiersJson).sort((a, b) => b.quantity - a.quantity);

      if (campaign.scope === 'PRODUCT') {
        let finalProgress = campaign.startingParticipants;
        if (campaign.countingMethod === 'ITEM_QUANTITY') {
          finalProgress += allParticipants.reduce((sum, p) => sum + p.quantity, 0);
        } else {
          finalProgress += new Set(allParticipants.map(p => p.customerId)).size;
        }

        const finalDiscountTier = tiers.find(tier => finalProgress >= tier.quantity);
        
        if (finalDiscountTier && allParticipants.length > 0) {
          console.log(`   ✅ Success! Reached ${finalDiscountTier.quantity} for ${finalDiscountTier.discount}% off.`);
          anyVariantSucceeded = true;
          await processParticipants(allParticipants, finalDiscountTier, campaign.shop, session.accessToken, campaign);
        } else {
          console.log("   -> Campaign failed. Canceling all orders.");
          await cancelFailedOrders(allParticipants, campaign.shop, session.accessToken);
        }

      } else {
        // VARIANT Scope Logic
        const allVariantGIDsInCampaign = JSON.parse(campaign.selectedVariantIdsJson || '[]');
        
        for (const variantId of allVariantGIDsInCampaign) {
          const participantsForThisVariant = allParticipants.filter(p => p.productVariantId === variantId);
          if (participantsForThisVariant.length === 0) continue;

          let variantProgress = campaign.startingParticipants;
          if (campaign.countingMethod === 'ITEM_QUANTITY') {
            variantProgress += participantsForThisVariant.reduce((sum, p) => sum + p.quantity, 0);
          } else {
            variantProgress += new Set(participantsForThisVariant.map(p => p.customerId)).size;
          }

          const finalDiscountTier = tiers.find(tier => variantProgress >= tier.quantity);

          if (finalDiscountTier) {
            console.log(`   ✅ Variant ${variantId.split('/').pop()} Success! Applying ${finalDiscountTier.discount}% off.`);
            anyVariantSucceeded = true;
            await processParticipants(participantsForThisVariant, finalDiscountTier, campaign.shop, session.accessToken, campaign);
          } else {
            console.log(`   -> Variant ${variantId.split('/').pop()} failed. Canceling variant orders.`);
            await cancelFailedOrders(participantsForThisVariant, campaign.shop, session.accessToken);
          }
        }
      }

      // Mark Campaign as Completed
      const finalStatus = anyVariantSucceeded ? "SUCCESSFUL" : "FAILED";
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: finalStatus },
      });

      // --- 🧹 NEW: REMOVE THE SELLING PLAN FROM SHOPIFY ---
      if (campaign.sellingPlanGroupId) {
        console.log(`   🧹 Removing Selling Plan from Shopify product page...`);
        try {
          const deletePlanJson = await shopifyGraphQL(campaign.shop, session.accessToken,
            `mutation sellingPlanGroupDelete($id: ID!) {
              sellingPlanGroupDelete(id: $id) {
                deletedSellingPlanGroupId
                userErrors { field message }
              }
            }`,
            { id: campaign.sellingPlanGroupId }
          );
          
          const errors = deletePlanJson.data?.sellingPlanGroupDelete?.userErrors || [];
          if (errors.length > 0) {
            console.error(`   ❌ Shopify Error removing plan:`, errors);
          } else {
            console.log(`   ✅ Selling Plan removed successfully. Product page restored.`);
          }
        } catch (error) {
          console.error(`   ❌ Failed to remove Selling Plan:`, error.message);
        }
      }

      console.log(`--- ✅ Campaign ${campaign.id} finalized with status: ${finalStatus} ---\n`);
    }

  } catch (error) {
    console.error("❌ Fatal error in Sweeper execution:", error);
  }
});