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

exports.processGroupBuyOrder = onMessagePublished("shopify-orders-create", async (event) => {
  try {
    const message = event.data.message;
    const payloadStr = Buffer.from(message.data, 'base64').toString();
    const payload = JSON.parse(payloadStr);

    // --- 1. FINANCIAL STATUS CHECK (Trap C) ---
    if (['voided', 'refunded', 'partially_refunded'].includes(payload.financial_status)) {
      console.log(`  -> Order ${payload.id} is voided/refunded. Skipping.`);
      return;
    }

    // --- 2. EXTRACT CAMPAIGN ID FROM LINE ITEM PROPERTIES ---
    let campaignId = null;
    
    // Loop through the items in the cart to find the hidden Group Buy property
    for (const item of payload.line_items) {
      const properties = item.properties || [];
      const gbProp = properties.find(p => p.name === "_groupbuy_campaign_id");
      
      if (gbProp && gbProp.value) {
        campaignId = parseInt(gbProp.value, 10);
        break; // We found it, stop searching the cart!
      }
    }

    if (!campaignId) {
      console.log("  -> Regular order. Skipping.");
      return; 
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    
    if (!campaign) {
      console.error(`Could not find campaign with ID ${campaignId}.`);
      return; 
    }

    // --- 2. LAST-SECOND BUYER PROTECTION ---
    // Extract official Shopify creation time and compare to campaign end time
    const orderCreatedAt = new Date(payload.created_at);
    if (orderCreatedAt > new Date(campaign.endDateTime)) {
      console.log(`  -> Order ${payload.id} was placed AFTER the deadline. Skipping.`);
      // (Optional: You could trigger an auto-cancel for this user here)
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
    let hasCreatedParticipant = false;

    for (const item of payload.line_items) {
      const fullVariantId = `gid://shopify/ProductVariant/${item.variant_id}`;
      const validVariants = JSON.parse(campaign.selectedVariantIdsJson || '[]');
      
      if (validVariants.includes(fullVariantId)) {
        
        // --- THE BULLETPROOF INSERT (Upsert/Catch Method) ---
        try {
          const priorParticipation = await prisma.participant.findFirst({
            where: {
              customerId: customerId,
              orderId: { not: orderId },
              group: { campaignId: campaign.id },
              ...(campaign.scope === 'VARIANT' ? { productVariantId: fullVariantId } : {})
            }
          });

          // ✅ THE "LEADER STEAL" LOGIC
          const currentLeader = await prisma.participant.findFirst({
            where: { groupId: group.id, isLeader: true, status: "ACTIVE" } // Only look at active leaders!
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

          // ATTEMPT TO INSERT THE ACTIVE ORDER
          await prisma.participant.create({
            data: {
              orderId,
              customerId,
              groupId: group.id,
              quantity: item.quantity,
              productVariantId: fullVariantId,
              orderCreatedAt: orderCreatedAt,
              isLeader: isThisParticipantLeader,
              status: "ACTIVE" // Explicitly active
            },
          });
          
          hasCreatedParticipant = true;
          console.log(`  ✅ Saved participant for variant ${item.variant_id} (Leader: ${isThisParticipantLeader})`);
          
          // ADD THE WARNING TAG TO PREVENT MANUAL CAPTURE
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
          
          // INCREMENT FIRESTORE UI
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
          // ✅ Postgres throws 'P2002' if the row already exists!
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

// --- HELPER 1: Process Success & Apply Discounts ---
async function processParticipants(participants, finalDiscountTier, shop, accessToken, campaign, trueLeaderOrderId) {
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

      // 2. Find the correct line item to apply the discount to
      const lineItemToDiscount = calculatedOrder.lineItems.edges.find(
        (edge) => edge.node.variant.id === participant.productVariantId
      )?.node;
      
      if (lineItemToDiscount) {
        
        // ✅ THE LEADER CHECK: Does this order match the mathematically proven first buyer?
        const isLeader = (participant.orderId === trueLeaderOrderId);
        const hasLeaderDiscount = campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0;
        
        // Determine the final percentage based on whether they won the leader spot
        const discountPercentage = (isLeader && hasLeaderDiscount) 
          ? parseFloat(campaign.leaderDiscount) 
          : parseFloat(finalDiscountTier.discount);

        const discountDescription = (isLeader && hasLeaderDiscount)
          ? "Group Buy Leader Discount"
          : "Group Buy Discount";

        // 3. Apply the calculated discount
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
      
      // 4. Commit the Edit to Shopify
      await shopifyGraphQL(shop, accessToken,
        `mutation orderEditCommit($id: ID!) {
          orderEditCommit(id: $id) { order { id } }
        }`,
        { id: calculatedOrderId }
      );

      // 5. Find the Vaulted Authorization and Capture the Payment
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
      
      // Smart Search: Accepts real cards (SUCCESS) and Bogus Gateway (PENDING)
      const parentTransaction = orderData?.transactions?.find(
        txn => txn.kind === "AUTHORIZATION" && ["SUCCESS", "PENDING"].includes(txn.status)
      );

      const finalPrice = parseFloat(orderData.totalPriceSet.shopMoney.amount);
      const currency = orderData.totalPriceSet.shopMoney.currencyCode;

      // Construct the capture input dynamically
      const captureInput = {
        id: participant.orderId,
        amount: finalPrice,
        currency: currency,
      };
      
      // If we found a specific transaction, attach it. Otherwise, let Shopify use the default vault.
      if (parentTransaction) {
        captureInput.parentTransactionId = parentTransaction.id;
      }

      console.log(`     -> Attempting capture for ${finalPrice} ${currency}...`);

      const captureResult = await shopifyGraphQL(shop, accessToken,
        `mutation orderCapture($input: OrderCaptureInput!) {
          orderCapture(input: $input) { 
            transaction { id status } 
            userErrors { field message }
          }
        }`,
        { input: captureInput }
      );

      const captureErrors = captureResult.data?.orderCapture?.userErrors;
      if (captureErrors && captureErrors.length > 0) {
        console.error(`     ❌ Capture Failed for ${participant.orderId}:`, captureErrors);
        
        // ✅ NEW: ADD THE FAILED PAYMENT TAG TO THE ORDER
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsAdd($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { userErrors { message } }
          }`,
          { id: participant.orderId, tags: ["Error: Payment Failed"] }
        );
        
      } else {
        console.log(`     ✅ Captured successfully for order ${participant.orderId}!`);
        
        // Remove the warning tag and add a success tag!
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsRemove($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) { userErrors { message } }
          }`,
          { id: participant.orderId, tags: ["⚠️ DO NOT CAPTURE - GROUPBUY"] }
        );
        
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsAdd($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { userErrors { message } }
          }`,
          { id: participant.orderId, tags: ["GroupBuy: Success"] }
        );
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
        { orderId: participant.orderId, reason: "DECLINED" }
      );

      const errors = cancelJson.data?.orderCancel?.orderCancelUserErrors;

      if (errors && errors.length > 0) {
        console.error(`     ❌ Error canceling ${participant.orderId}:`, errors);
      } else {
        console.log(`     ✅ Successfully canceled order and voided authorization.`);
        
        // ✅ NEW: Swap the tags to show the campaign failed
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsRemove($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) { userErrors { message } }
          }`,
          { id: participant.orderId, tags: ["⚠️ DO NOT CAPTURE - GROUPBUY"] }
        );
        
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsAdd($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { userErrors { message } }
          }`,
          { id: participant.orderId, tags: ["GroupBuy: Failed"] }
        );
        console.log(`     🏷️ Applied 'GroupBuy: Failed' tag to order ${participant.orderId}`);
      }
    } catch (error) {
      console.error(`     ❌ Error during cancellation of ${participant.orderId}:`, error.message);
    }
  }
}

// --- HELPER 3: Clean up the Selling Plan (Security) ---
async function deleteSellingPlanGroup(sellingPlanId, shop, accessToken) {
  if (!sellingPlanId) return;
  
  console.log(`   - 🗑️ Deleting Selling Plan Group: ${sellingPlanId}...`);
  try {
    const deleteJson = await shopifyGraphQL(shop, accessToken,
      `mutation sellingPlanGroupDelete($id: ID!) {
        sellingPlanGroupDelete(id: $id) {
          deletedSellingPlanGroupId
          userErrors { field message }
        }
      }`,
      { id: sellingPlanId }
    );

    const errors = deleteJson.data?.sellingPlanGroupDelete?.userErrors;
    if (errors && errors.length > 0) {
      console.error(`     ❌ Error deleting Selling Plan:`, errors);
    } else {
      console.log(`     ✅ Successfully deleted Selling Plan Group from Shopify.`);
    }
  } catch (error) {
    console.error(`     ❌ API Error during Selling Plan deletion:`, error.message);
  }
}

// 🚀 The Upgraded Sweeper: Runs every 5 minutes
exports.campaignFinalizer = onSchedule("every 5 minutes", async (event) => {
  console.log("🧹 Sweeper waking up! Checking for expired campaigns...");
  
  // 1. THE 10-MINUTE BUFFER: Only pick up campaigns that ended at least 10m ago
  const bufferTime = new Date(Date.now() - 10 * 60 * 1000); 

  try {
    // 2. THE TARGET QUERY: Find ACTIVE campaigns that have passed the buffer
    const expiredCampaigns = await prisma.campaign.findMany({
      where: { 
        status: "ACTIVE", 
        endDateTime: { lte: bufferTime } 
      },
      include: { 
        groups: { 
          include: { 
            participants: {
              where: { status: "ACTIVE" } // ✅ NEW: Only grab people who are still alive!
            } 
          } 
        } 
      }
    });

    if (expiredCampaigns.length === 0) {
      console.log(" -> No campaigns ready for sweep yet. Sleeping.");
      return;
    }

    for (const campaign of expiredCampaigns) {
      console.log(`\n--- ⏰ Processing Campaign ID: ${campaign.id} ---`);

      // 3. THE PROCESSING LOCK: Instantly move to PROCESSING status
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "PROCESSING" }
      });

      const session = await prisma.session.findFirst({
        where: { shop: campaign.shop, isOnline: false }
      });

      if (!session) {
        console.error(` ❌ No offline session. Skipping.`);
        continue;
      }

      let anyVariantSucceeded = false;
      const allParticipants = campaign.groups.flatMap((g) => g.participants);
      
      // 4. TRUE LEADER CALCULATION: Sort by official Shopify timestamp
      // This mathematically guarantees the actual first buyer is the leader
      const sortedByOrderTime = [...allParticipants].sort((a, b) => 
        new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime()
      );
      
      const trueLeaderOrderId = sortedByOrderTime[0]?.orderId;

      // ✅ NEW: UPDATE THE DATABASE SO YOUR APP UI IS 100% ACCURATE
      if (trueLeaderOrderId) {
        await prisma.participant.updateMany({
          where: { orderId: { in: allParticipants.map(p => p.orderId) } },
          data: { isLeader: false }
        });

        await prisma.participant.updateMany({
          where: { orderId: trueLeaderOrderId },
          data: { isLeader: true }
        });
      }

      // 5. MATH & EXECUTION (Tiers Logic)
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
          await processParticipants(allParticipants, finalDiscountTier, campaign.shop, session.accessToken, campaign, trueLeaderOrderId);
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
            await processParticipants(participantsForThisVariant, finalDiscountTier, campaign.shop, session.accessToken, campaign, trueLeaderOrderId);
          } else {
            console.log(`   -> Variant ${variantId.split('/').pop()} failed. Canceling variant orders.`);
            await cancelFailedOrders(participantsForThisVariant, campaign.shop, session.accessToken);
          }
        }
      }

      // ✅ NEW: SECURE THE PRODUCT BY DELETING THE SELLING PLAN
      // (Assuming your campaign model stores the ID as 'sellingPlanId')
      if (campaign.sellingPlanGroupId) {
         await deleteSellingPlanGroup(campaign.sellingPlanGroupId, campaign.shop, session.accessToken);
      }

      // Mark Campaign as Completed in Neon DB
      const finalStatus = anyVariantSucceeded ? "SUCCESSFUL" : "FAILED";
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: finalStatus },
      });
      
      // Update Firebase one last time for the frontend widget
      await firestore.collection("campaignProgress").doc(`campaign_${campaign.id}`).set({
        status: finalStatus,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(`--- ✅ Campaign ${campaign.id} finalized: ${finalStatus} ---\n`);
    }

  } catch (error) {
    console.error("❌ Fatal error in Sweeper:", error);
  }
});

// ============================================================================
// 🚨 CANCELLATION WEBHOOK: Handles users backing out safely
// ============================================================================

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

    // ✅ NEW: Explicit log for non-groupbuy orders
    if (!campaignId) {
      console.log(`  -> Cancelled order ${orderId} is a regular store order (no campaign ID). Skipping safely.`);
      return; 
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    
    // ✅ NEW: Explicit log if campaign is deleted/missing
    if (!campaign) {
      console.log(`  -> Cancelled order ${orderId} belongs to Campaign ${campaignId}, but that campaign no longer exists in our database. Skipping.`);
      return;
    }

    // ✅ NEW: Much clearer explanation of why we ignore old orders
    if (campaign.status !== "ACTIVE") {
      console.log(`  -> Ignored late cancellation for order ${orderId}. Campaign ${campaignId} is currently '${campaign.status}'. The Sweeper has already finalized this campaign, so UI rollbacks are no longer needed.`);
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

        // UI ROLLBACK
        let progressDelta = campaign.countingMethod === 'ITEM_QUANTITY' ? existingOrder.quantity : 1;
        let docId = campaign.scope === 'VARIANT' ? `campaign_${campaign.id}_variant_${targetItem.variant_id}` : `campaign_${campaign.id}`;

        await firestore.collection("campaignProgress").doc(docId).set({
          progress: FieldValue.increment(-progressDelta),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`  📉 Rolled back progress for canceled order ${orderId}.`);

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
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("❌ Worker Error:", error);
  }
});