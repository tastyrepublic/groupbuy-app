const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const admin = require("firebase-admin");
const FieldValue = admin.firestore.FieldValue;
const { PrismaClient } = require("@prisma/client");
const { onSchedule } = require("firebase-functions/v2/scheduler"); 
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { Resend } = require("resend"); // ✨ NEW: Import Resend

// Initialize Firebase Admin for Firestore access
admin.initializeApp();
const firestore = admin.firestore();

// Initialize Prisma to connect to NeonDB
const prisma = new PrismaClient();

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// ✨ SCALABILITY: Dictionary Pattern for Real Emails
const EMAIL_LOCALE_DICT = {
  "EN": {
    header: "Group Buy Update", 
    summary: "Order Summary", 
    variant: "Variant: ", 
    qty: "Qty: ", 
    ref: "Order Reference:", 
    thanks: "Thank you for shopping with us!",
    breakTitle: "💡 How your discount was calculated:",
    breakDesc: (maxQty, leaderPct, standardPct) => `As the Group Buy Leader, your first <b>${maxQty}</b> items received your <b>${leaderPct}% Leader Discount</b>! Your remaining items received the unlocked standard discount of <b>${standardPct}%</b>. These discounts have been combined into your final overall order discount.`
  },
  "ZH-TW": {
    header: "團購更新", 
    summary: "訂單摘要", 
    variant: "規格: ", 
    qty: "數量: ", 
    ref: "訂單編號：", 
    thanks: "感謝您的購買！",
    breakTitle: "💡 您的折扣計算說明：",
    breakDesc: (maxQty, leaderPct, standardPct) => `身為團購發起人，您的前 <b>${maxQty}</b> 件商品享有 <b>${leaderPct}%</b> 的專屬折扣！其餘商品則適用已解鎖的標準折扣 <b>${standardPct}%</b>。這些折扣已合併計算為您的最終訂單總折扣。`
  }
};

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
              status: "ACTIVE", // ✅ THE FIX: Ignore their cancelled orders!
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
async function processParticipants(winningParticipants, variantDiscountMap, shop, accessToken, campaign, trueLeaderOrderId) {
  
  // ✨ NEW: Group all participant rows by their Order ID
  const ordersMap = {};
  for (const p of winningParticipants) {
     if (!ordersMap[p.orderId]) ordersMap[p.orderId] = [];
     ordersMap[p.orderId].push(p);
  }

  // Loop through unique ORDERS, not individual variant rows
  for (const orderId of Object.keys(ordersMap)) {
    console.log(`   - Processing multi-variant order ${orderId}...`);
    const orderParticipantRows = ordersMap[orderId];
    
    try {
      // 1. Begin Order Edit ONCE per order
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
        { id: orderId }
      );

      const calculatedOrder = beginEditJson.data?.orderEditBegin?.calculatedOrder;
      if (!calculatedOrder) continue;
      
      const calculatedOrderId = calculatedOrder.id;
      let alreadyClaimed = 0; // ✨ Shared limit tracker for the entire order
      let blendedContext = null;
      const isLeader = (orderId === trueLeaderOrderId);
      const hasLeaderDiscount = campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0;

      // 2. Loop through the winning variants inside this specific order
      for (const participant of orderParticipantRows) {
        const finalDiscountTier = variantDiscountMap[participant.productVariantId];
        if (!finalDiscountTier) continue;

        const lineItemToDiscount = calculatedOrder.lineItems.edges.find(
          (edge) => edge.node.variant.id === participant.productVariantId
        )?.node;

        if (lineItemToDiscount) {
          let discountPercentage = parseFloat(finalDiscountTier.discount) || 0;
          let discountDescription = "Group Buy Discount";

          if (isLeader && hasLeaderDiscount) {
            const leaderPct = parseFloat(campaign.leaderDiscount);
            const totalQty = lineItemToDiscount.quantity;
            const maxLeaderQty = campaign.leaderMaxQty || 0; 

            if (maxLeaderQty > 0) {
              const availableLeaderSlots = Math.max(0, maxLeaderQty - alreadyClaimed);
              const leaderQtyForThisItem = Math.min(totalQty, availableLeaderSlots);
              const standardQtyForThisItem = totalQty - leaderQtyForThisItem;
              const standardPct = parseFloat(finalDiscountTier.discount) || 0;

              if (leaderQtyForThisItem === 0) {
                discountPercentage = standardPct;
                discountDescription = "Group Buy Discount";
              } else if (standardQtyForThisItem > 0) {
                discountPercentage = ((leaderQtyForThisItem * leaderPct) + (standardQtyForThisItem * standardPct)) / totalQty;
                discountPercentage = Math.round(discountPercentage * 100) / 100;
                discountDescription = `Group Buy Leader Discount (Max ${maxLeaderQty} items limit)`;
                blendedContext = { maxQty: maxLeaderQty, leaderPct, standardPct };
              } else {
                discountPercentage = leaderPct;
                discountDescription = "Group Buy Leader Discount";
              }
              alreadyClaimed += totalQty; // ✨ Add to the memory bank for the next variant loop
            } else {
              discountPercentage = leaderPct;
              discountDescription = "Group Buy Leader Discount";
            }
          }

          // Apply discount mutation to this specific line item
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
      }
      
      // 3. Commit the Edit ONCE
      await shopifyGraphQL(shop, accessToken,
        `mutation orderEditCommit($id: ID!) { orderEditCommit(id: $id) { order { id } } }`,
        { id: calculatedOrderId }
      );

      // 4. Capture the Payment ONCE
      const orderJson = await shopifyGraphQL(shop, accessToken,
        `query getOrderMandate($id: ID!) { order(id: $id) { paymentCollectionDetails { vaultedPaymentMethods { id } } } }`,
        { id: orderId }
      );
      
      const mandateId = orderJson.data?.order?.paymentCollectionDetails?.vaultedPaymentMethods?.[0]?.id;
      if (!mandateId) {
        // ✨ THE FIX: Log if there is no vaulted card!
        console.error(`     ❌ No vaulted payment method found for ${orderId}. Skipping capture and email.`);
        continue;
      }

      const numericOrderId = orderId.split('/').pop();
      const idempotencyKey = `capture-${numericOrderId}-${Date.now()}`;

      const captureResult = await shopifyGraphQL(shop, accessToken,
        `mutation orderCreateMandatePayment($id: ID!, $mandateId: ID!, $idempotencyKey: String!) {
          orderCreateMandatePayment(autoCapture: true, id: $id, mandateId: $mandateId, idempotencyKey: $idempotencyKey) { job { id } userErrors { field message } }
        }`,
        { id: orderId, mandateId: mandateId, idempotencyKey: idempotencyKey }
      );

      const captureErrors = captureResult.data?.orderCreateMandatePayment?.userErrors;
      
      if (!captureErrors || captureErrors.length === 0) {
        // ✨ PAYMENT SUCCESS PATH
        console.log(`     ✅ Successfully captured payment for ${orderId}.`);
        
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsRemove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
          { id: orderId, tags: ["⚠️ DO NOT CAPTURE - GROUPBUY"] }
        );
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { id: orderId, tags: ["GroupBuy: Success"] }
        );
        
      } else {
        // ✨ PAYMENT FAILED PATH
        console.error(`     ❌ Payment capture failed for ${orderId}:`, captureErrors);
        
        // Add a special tag so the merchant can easily find orders that need manual follow-up!
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { id: orderId, tags: ["GroupBuy: Payment Failed"] }
        );
      }

      // ✨ THE FIX: Move the email trigger OUTSIDE the if/else block.
      await dispatchGroupBuyEmail(orderParticipantRows[0], shop, campaign, "SUCCESS", blendedContext);

    } catch (error) {
      console.error(`     ❌ Error processing multi-variant order ${orderId}:`, error.message);
    }
  }
}

// --- HELPER 2: Process Failure (Cancels Orders & Voids Payment) ---
async function cancelFailedOrders(failingParticipants, shop, accessToken) {
  
  // Filter out duplicate order IDs so we only cancel/email once
  const uniqueOrders = [];
  const seenOrders = new Set();
  for (const p of failingParticipants) {
    if (!seenOrders.has(p.orderId)) {
      seenOrders.add(p.orderId);
      uniqueOrders.push(p);
    }
  }

  for (const participant of uniqueOrders) {
    console.log(`   - Canceling order ${participant.orderId} (Campaign Failed)...`);
    try {
      const cancelJson = await shopifyGraphQL(shop, accessToken,
        `mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!) {
          orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: false, restock: true, refund: true) {
            job { id }
            orderCancelUserErrors { field message }
          }
        }`,
        { orderId: participant.orderId, reason: "DECLINED" }
      );

      const errors = cancelJson.data?.orderCancel?.orderCancelUserErrors;

      if (errors && errors.length > 0) {
        // ✨ If Shopify fails, we log it clearly
        console.error(`     ❌ Shopify API Error canceling ${participant.orderId}:`, errors);
      } else {
        console.log(`     ✅ Successfully canceled order and voided authorization.`);
        
        await dispatchGroupBuyEmail(participant, shop, null, "FAILED"); 
        
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
      }
    } catch (error) {
      console.error(`     ❌ Fetch Error during cancellation of ${participant.orderId}:`, error.message);
    }

    // ✨ THE FIX: Wait 500ms before sending the next cancellation to prevent Shopify Rate Limiting!
    await new Promise(resolve => setTimeout(resolve, 500));
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

// --- HELPER 4: Revert Inventory Policy (The Automation) ---
async function revertInventoryPolicy(campaign, shop, accessToken) {
  console.log(`   - 📦 Checking inventory automation for campaign ${campaign.id}...`);
  try {
    // 1. Check user settings
    const settings = await prisma.settings.findUnique({ where: { shop } });
    const autoTurnOff = settings ? settings.disableContinueSellingOnEnd : true;

    if (!autoTurnOff) {
      console.log(`     -> Inventory automation disabled in settings. Skipping.`);
      return;
    }

    if (!campaign.originalInventoryState) {
      console.log(`     -> No memory bank found for this campaign. Skipping.`);
      return;
    }

    const snapshot = JSON.parse(campaign.originalInventoryState);

    // 2. Fetch the current variants from Shopify
    const getVariantsQuery = `
      query getVariants($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            nodes {
              id
              inventoryPolicy
            }
          }
        }
      }
    `;

    const response = await shopifyGraphQL(shop, accessToken, getVariantsQuery, { id: campaign.productId });
    const variants = response.data?.product?.variants?.nodes;

    if (!variants || variants.length === 0) return;

    // 3. Compare current state to memory
    const variantsToUpdate = snapshot.filter(saved => {
      const currentVariant = variants.find(v => v.id === saved.id);
      return currentVariant && currentVariant.inventoryPolicy !== saved.policy;
    }).map(saved => ({ id: saved.id, inventoryPolicy: saved.policy }));

    // 4. Run the Bulk Update
    if (variantsToUpdate.length === 0) {
      console.log(`     ⚡ No inventory updates needed. Variants already match memory.`);
    } else {
      const updateMutation = `
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors { field message }
          }
        }
      `;

      const updateResponse = await shopifyGraphQL(shop, accessToken, updateMutation, {
        productId: campaign.productId,
        variants: variantsToUpdate
      });

      if (updateResponse.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
        console.error("     ❌ Failed to revert inventory policy:", updateResponse.data.productVariantsBulkUpdate.userErrors);
      } else {
        console.log(`     ✅ Successfully reverted ${variantsToUpdate.length} variants to their original state!`);
      }
    }

    // 5. DATA CLEANUP: Wipe the memory bank to save space and prevent double-runs
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { originalInventoryState: null }
    });
    console.log("     🧹 Cleaned up inventory memory bank from the database.");

  } catch (error) {
    console.error(`     ❌ Error during inventory reversion:`, error.message);
  }
}

// --- HELPER 5: Send Custom Transactional Emails ---
async function dispatchGroupBuyEmail(participant, shop, campaign, type, blendedContext = null) {
  try {
    const { Resend } = require("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);

    const settings = await prisma.settings.findUnique({ where: { shop } });
    if (!settings) return;

    if (type === "SUCCESS" && !settings.sendSuccessEmail) return;
    if (type === "FAILED" && !settings.sendFailedEmail) return;

    const session = await prisma.session.findFirst({ where: { shop: shop, isOnline: false } });
    
    // ✨ NEW: Added `name` and `statusPageUrl` to the GraphQL Query
    const orderQuery = await shopifyGraphQL(shop, session.accessToken, 
      `query getCustomerData($id: ID!) { 
        order(id: $id) { 
          name
          statusPageUrl
          email 
          customer { email locale } 
          lineItems(first: 10) {
            nodes {
              title
              variantTitle
              quantity
              variant { id }
              image { url }
            }
          }
        } 
        shop { name }
      }`,
      { id: participant.orderId }
    );
    
    const customerEmail = orderQuery.data?.order?.email || orderQuery.data?.order?.customer?.email;
    const shopName = orderQuery.data?.shop?.name || "Group Buy Updates";
    
    // ✨ NEW: Grab the human-readable order name and the secret status page link!
    const orderName = orderQuery.data?.order?.name || `#${participant.orderId.split('/').pop()}`;
    const statusPageUrl = orderQuery.data?.order?.statusPageUrl || `https://${shop}/account/orders`;

    const rawLocale = orderQuery.data?.order?.customer?.locale || "en";
    const locale = rawLocale.toUpperCase().replace('_', '-'); 

    if (!customerEmail) return;

    const lineItems = orderQuery.data?.order?.lineItems?.nodes || [];
    const targetItem = lineItems.find(item => item.variant?.id === participant.productVariantId) || lineItems[0];
    
    const realTitle = targetItem?.title || (campaign ? campaign.productTitle : "Group Buy Item");
    const realVariant = targetItem?.variantTitle || "";
    const realQty = targetItem?.quantity || participant.quantity;
    const realImgUrl = targetItem?.image?.url || (campaign ? campaign.productImage : "");
    const imgElement = realImgUrl ? `<img src="${realImgUrl}" alt="${realTitle}" style="width:100%; height:100%; object-fit:cover; border-radius:4px;" />` : `🎧`;

    const parseSafe = (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } };
    
    const rawSubject = type === "SUCCESS" ? settings.successEmailSubject : settings.failedEmailSubject;
    const rawBody = type === "SUCCESS" ? settings.successEmailBody : settings.failedEmailBody;

    const subjectObj = parseSafe(rawSubject, { "EN": rawSubject });
    const bodyObj = parseSafe(rawBody, { "EN": rawBody });

    const finalSubject = subjectObj[locale] || subjectObj["EN"] || subjectObj[Object.keys(subjectObj)[0]];
    const finalBody = bodyObj[locale] || bodyObj["EN"] || bodyObj[Object.keys(bodyObj)[0]];

    const t = EMAIL_LOCALE_DICT[locale] || EMAIL_LOCALE_DICT["EN"];

    const headerColor = settings.emailHeaderColor || "#000000";
    const headerContent = settings.emailLogoUrl 
      ? `<img src="${settings.emailLogoUrl}" alt="${shopName} Logo" style="max-height: 50px; max-width: 200px;" />` 
      : `<h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 1px;">${t.header}</h1>`;

    const addressContent = settings.emailStoreAddress 
      ? `<p style="margin: 0 0 10px 0; font-size: 11px; color: #a0a5aa;">${settings.emailStoreAddress}</p>` 
      : ``;

    const variantDisplay = realVariant && realVariant !== "Default Title" 
      ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6d7175;">${t.variant}${realVariant}</p>` 
      : ``;

    const orderSummaryContent = `
      <div style="margin-top: 24px; padding: 16px; border: 1px solid #e3e3e3; border-radius: 6px; background-color: #fafafa;">
        <p style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; color: #202223; border-bottom: 1px solid #e3e3e3; padding-bottom: 8px;">
          ${t.summary}
        </p>
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <td width="65" valign="middle">
              <div style="width: 50px; height: 50px; background-color: #e9ecef; border-radius: 4px; text-align: center; line-height: 50px; font-size: 20px;">
                ${imgElement}
              </div>
            </td>
            <td valign="middle">
              <p style="margin: 0; font-size: 14px; font-weight: 600; color: #202223;">${realTitle}</p>
              ${variantDisplay}
            </td>
            <td width="60" align="right" valign="middle">
              <p style="margin: 0; font-size: 14px; color: #444;">${t.qty}${realQty}</p>
            </td>
          </tr>
        </table>
      </div>
    `;

    let breakdownContent = "";
    if (blendedContext && type === "SUCCESS") {
      breakdownContent = `
        <div style="margin-top: 16px; padding: 12px; border-radius: 6px; background-color: #eaf3ff; border: 1px solid #b6d4fe; color: #084298; font-size: 13px; line-height: 1.5;">
          <strong style="display: block; margin-bottom: 4px;">${t.breakTitle}</strong>
          ${t.breakDesc(blendedContext.maxQty, blendedContext.leaderPct, blendedContext.standardPct)}
        </div>
      `;
    }

    const emailPayload = {
      from: `${shopName} <notifications@appublic.com>`,
      to: customerEmail,
      subject: finalSubject,
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 20px;">
            <tr><td align="center">
              <table border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); width: 100%; max-width: 600px; margin: 0 auto;">
                <tr><td style="background-color: ${headerColor}; padding: 30px 20px; text-align: center;">
                  ${headerContent}
                </td></tr>
                <tr><td style="padding: 40px 30px; color: #202223;">
                  <h2 style="margin-top: 0; font-size: 20px; color: #202223;">${finalSubject}</h2>
                  <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px; white-space: pre-wrap; color: #444;">${finalBody}</p>
                  
                  ${orderSummaryContent}
                  ${breakdownContent}

                  <p style="margin-top: 24px; font-size: 12px; color: #888;">
                    ${t.ref} <a href="${statusPageUrl}" style="color: #005bd3; text-decoration: underline;"><strong>${orderName}</strong></a>
                  </p>
                </td></tr>
                <tr><td style="background-color: #fafafa; padding: 20px; text-align: center; border-top: 1px solid #e3e3e3;">
                  <p style="margin: 0 0 10px 0; font-size: 12px; color: #8c9196;">${t.thanks}</p>
                  ${addressContent}
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `
    };

    if (settings && settings.contactEmail) {
      emailPayload.reply_to = settings.contactEmail;
    }

    const { data, error } = await resend.emails.send(emailPayload);

    if (error) {
      console.error(`     ❌ Resend API rejected email for ${customerEmail}:`, error);
    } else {
      console.log(`     ✉️ Sent ${type} email to ${customerEmail} in language: ${locale} from ${shopName}`);
    }

  } catch (error) {
    console.error(`     ❌ Failed to execute email dispatch to ${participant?.orderId}:`, error.message);
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
      let winningParticipants = [];
      let failingParticipants = [];
      let variantDiscountMap = {};

      if (campaign.scope === 'PRODUCT') {
        let finalProgress = campaign.startingParticipants;
        if (campaign.countingMethod === 'ITEM_QUANTITY') {
          finalProgress += allParticipants.reduce((sum, p) => sum + p.quantity, 0);
        } else {
          finalProgress += new Set(allParticipants.map(p => p.customerId)).size;
        }

        // ✨ NEW: Debug Log for the Math!
        console.log(`   📊 Math Check (PRODUCT Scope):`);
        console.log(`      - Starting Base: ${campaign.startingParticipants}`);
        console.log(`      - Actual Database Rows Counted: ${finalProgress - campaign.startingParticipants}`);
        console.log(`      - Final Total Progress: ${finalProgress}`);
        console.log(`      - Lowest Tier Needed: ${tiers[tiers.length - 1]?.quantity || 'None'}`);

        const finalDiscountTier = tiers.find(tier => finalProgress >= tier.quantity);
        
        if (finalDiscountTier && allParticipants.length > 0) {
          console.log(`   ✅ Success! Reached ${finalDiscountTier.quantity} for ${finalDiscountTier.discount}% off.`);
          anyVariantSucceeded = true;
          winningParticipants = allParticipants;
          const allVariantGIDsInCampaign = JSON.parse(campaign.selectedVariantIdsJson || '[]');
          allVariantGIDsInCampaign.forEach(vid => variantDiscountMap[vid] = finalDiscountTier);
        } else {
          console.log("   -> ❌ Campaign failed to reach lowest tier. Canceling all orders.");
          failingParticipants = allParticipants;
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

          // ✨ NEW: Debug Log for Variant Math!
          console.log(`   📊 Math Check (Variant ${variantId.split('/').pop()}): Final Progress = ${variantProgress}`);

          const finalDiscountTier = tiers.find(tier => variantProgress >= tier.quantity);

          if (finalDiscountTier) {
            console.log(`   ✅ Variant ${variantId.split('/').pop()} Success!`);
            anyVariantSucceeded = true;
            winningParticipants.push(...participantsForThisVariant);
            variantDiscountMap[variantId] = finalDiscountTier;
          } else {
            console.log(`   -> ❌ Variant ${variantId.split('/').pop()} failed.`);
            failingParticipants.push(...participantsForThisVariant);
          }
        }
      }

      // ✨ NEW: Grouping execution to prevent duplicate processing
      if (winningParticipants.length > 0) {
         await processParticipants(winningParticipants, variantDiscountMap, campaign.shop, session.accessToken, campaign, trueLeaderOrderId);
      }
      
      if (failingParticipants.length > 0) {
         // Prevent canceling an order if it has at least one winning variant (Variant Scope protection)
         const winningOrderIds = new Set(winningParticipants.map(p => p.orderId));
         const trulyFailingOrders = failingParticipants.filter(p => !winningOrderIds.has(p.orderId));

         if (trulyFailingOrders.length > 0) {
            await cancelFailedOrders(trulyFailingOrders, campaign.shop, session.accessToken);
         }
      }

      // ✅ NEW: SECURE THE PRODUCT BY DELETING THE SELLING PLAN
      if (campaign.sellingPlanGroupId) {
         await deleteSellingPlanGroup(campaign.sellingPlanGroupId, campaign.shop, session.accessToken);
      }

      // ✨ NEW: REVERT THE INVENTORY POLICY
      await revertInventoryPolicy(campaign, campaign.shop, session.accessToken);

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

        // ✅ THE FIX: SMART UI ROLLBACK
        let progressDelta = 0;
        
        if (campaign.countingMethod === 'ITEM_QUANTITY') {
          progressDelta = existingOrder.quantity;
        } else {
          // It is PARTICIPANT mode. Does this user have ANY OTHER active orders?
          const remainingActiveOrders = await prisma.participant.count({
            where: {
              customerId: existingOrder.customerId,
              status: "ACTIVE",
              group: { campaignId: campaign.id }
            }
          });
          
          // If they have other active orders, subtract 0. If this was their last one, subtract 1.
          progressDelta = remainingActiveOrders > 0 ? 0 : 1;
        }

        if (progressDelta > 0) {
          let docId = campaign.scope === 'VARIANT' ? `campaign_${campaign.id}_variant_${targetItem.variant_id}` : `campaign_${campaign.id}`;

          await firestore.collection("campaignProgress").doc(docId).set({
            progress: FieldValue.increment(-progressDelta),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });

          console.log(`  📉 Rolled back progress for canceled order ${orderId} by -${progressDelta}.`);
        } else {
          console.log(`  📉 Skipped rollback for ${orderId}: User still has other active orders.`);
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
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("❌ Worker Error:", error);
  }
});