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
    console.log("Raw Attributes from Shopify:", event.data.message.attributes);

    const payloadStr = Buffer.from(message.data, 'base64').toString();
    const payload = JSON.parse(payloadStr);

    const noteAttributes = payload.note_attributes || [];
    const groupbuyAttribute = noteAttributes.find(
      (attr) => attr.name === "_groupbuy_campaign_id"
    );

    if (!groupbuyAttribute) {
      console.log("  -> Regular order. Skipping.");
      return; 
    }

    const campaignId = parseInt(groupbuyAttribute.value, 10);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    
    if (!campaign) {
      console.error(`Could not find campaign with ID ${campaignId}.`);
      return; 
    }

    console.log(`  ✅ This is a Group Buy order for campaign ${campaignId}!`);

    let group = await prisma.group.findFirst({
      where: { campaignId, status: "OPEN" },
      orderBy: { createdAt: 'desc' }
    });
    
    if (!group) {
      group = await prisma.group.create({ data: { campaignId } });
    }

    const orderId = payload.admin_graphql_api_id;
    const customerId = payload.customer?.admin_graphql_api_id || payload.email || `guest-${orderId}`; 
    let hasCreatedParticipant = false;

    for (const item of payload.line_items) {
      const fullVariantId = `gid://shopify/ProductVariant/${item.variant_id}`;
      const validVariants = JSON.parse(campaign.selectedVariantIdsJson || '[]');
      
      if (validVariants.includes(fullVariantId)) {
        const existingParticipant = await prisma.participant.findFirst({
          where: { orderId, productVariantId: fullVariantId }
        });

        if (!existingParticipant) {
          // Check if this is the customer's first time participating to avoid double-counting "PARTICIPANTS"
          const priorParticipation = await prisma.participant.findFirst({
            where: {
              customerId: customerId,
              orderId: { not: orderId }, // Ignore the order we are processing right now
              group: { campaignId: campaign.id },
              ...(campaign.scope === 'VARIANT' ? { productVariantId: fullVariantId } : {})
            }
          });

          const existingGroupMembers = await prisma.participant.count({
            where: { groupId: group.id }
          });
          const isLeader = existingGroupMembers === 0 && campaign.startingParticipants === 0;

          await prisma.participant.create({
            data: {
              orderId,
              customerId,
              isLeader: isLeader,
              groupId: group.id,
              quantity: item.quantity,
              productVariantId: fullVariantId, 
            },
          });
          
          hasCreatedParticipant = true;
          console.log(`  ✅ Saved participant for variant ${item.variant_id} (Qty: ${item.quantity})`);
          
          // 1. Calculate how much to add (The Delta)
          let progressDelta = 0;
          if (campaign.countingMethod === 'ITEM_QUANTITY') {
            progressDelta = item.quantity;
          } else {
            // Only add 1 if they haven't bought into this campaign/variant before
            progressDelta = priorParticipation ? 0 : 1;
          }

          if (progressDelta > 0) {
            const simpleVariantId = item.variant_id;
            let docId = `campaign_${campaignId}`;
            if (campaign.scope === 'VARIANT') {
               docId = `campaign_${campaignId}_variant_${simpleVariantId}`;
            }

            // 2. Use Firestore Atomic Increment to prevent Race Conditions
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

    if (!hasCreatedParticipant) {
      console.log("  -> Order was for campaign, but no matching variants found.");
    }

  } catch (error) {
    console.error("❌ Worker: Error processing message:", error);
    throw error;
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

// --- HELPER 1: Process Success ---
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
        // ✅ 2. Determine which discount to apply
        const isEligibleForLeaderDiscount = participant.isLeader && campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0;
        
        const discountPercentage = isEligibleForLeaderDiscount 
          ? parseFloat(campaign.leaderDiscount) 
          : parseFloat(finalDiscountTier.discount);

        const discountDescription = isEligibleForLeaderDiscount
          ? "Group Buy Leader Discount"
          : "Group Buy Discount";

        // ✅ 3. Apply the calculated discount
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

      // 4. Find Authorization and Capture Payment
      const orderJson = await shopifyGraphQL(shop, accessToken,
        `query getOrderTransactions($id: ID!) {
          order(id: $id) {
            totalPriceSet { shopMoney { amount currencyCode } }
            transactions(first: 5) { id kind status }
          }
        }`,
        { id: participant.orderId }
      );
      
      const orderData = orderJson.data?.order;
      const parentTransaction = orderData?.transactions?.find(txn => txn.kind === "AUTHORIZATION" && txn.status === "SUCCESS");

      if (parentTransaction) {
        const finalPrice = parseFloat(orderData.totalPriceSet.shopMoney.amount);
        const currency = orderData.totalPriceSet.shopMoney.currencyCode;

        await shopifyGraphQL(shop, accessToken,
          `mutation orderCapture($input: OrderCaptureInput!) {
            orderCapture(input: $input) { 
              transaction { id } 
              userErrors { field message }
            }
          }`,
          { 
            input: { 
              id: participant.orderId, 
              parentTransactionId: parentTransaction.id, 
              amount: finalPrice, 
              currency: currency,
            } 
          }
        );
        console.log(`     ✅ Captured ${finalPrice.toFixed(2)} ${currency} for order ${participant.orderId}`);
      } else {
        console.log(`     -> No authorized payment found to capture for order ${participant.orderId}`);
      }
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
      console.log(`--- ✅ Campaign ${campaign.id} finalized with status: ${finalStatus} ---\n`);
    }

  } catch (error) {
    console.error("❌ Fatal error in Sweeper execution:", error);
  }
});