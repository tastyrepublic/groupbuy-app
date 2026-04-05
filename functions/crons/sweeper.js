const { onSchedule } = require("firebase-functions/v2/scheduler"); 
const { admin, firestore, prisma } = require("../config/init");
const { shopifyGraphQL } = require("../utils/shopify");
const { dispatchGroupBuyEmail } = require("../utils/email");

async function processParticipants(winningParticipants, variantDiscountMap, shop, accessToken, campaign, trueLeaderOrderId) {
  const ordersMap = {};
  for (const p of winningParticipants) {
     if (!ordersMap[p.orderId]) ordersMap[p.orderId] = [];
     ordersMap[p.orderId].push(p);
  }

  for (const orderId of Object.keys(ordersMap)) {
    console.log(`   - Processing multi-variant order ${orderId}...`);
    const orderParticipantRows = ordersMap[orderId];
    
    try {
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
      let alreadyClaimed = 0; 
      let blendedContext = null;
      const isLeader = (orderId === trueLeaderOrderId);
      const hasLeaderDiscount = campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0;

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
              alreadyClaimed += totalQty;
            } else {
              discountPercentage = leaderPct;
              discountDescription = "Group Buy Leader Discount";
            }
          }

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
      
      await shopifyGraphQL(shop, accessToken,
        `mutation orderEditCommit($id: ID!) { orderEditCommit(id: $id) { order { id } } }`,
        { id: calculatedOrderId }
      );

      const orderJson = await shopifyGraphQL(shop, accessToken,
        `query getOrderMandate($id: ID!) { order(id: $id) { paymentCollectionDetails { vaultedPaymentMethods { id } } } }`,
        { id: orderId }
      );
      
      const mandateId = orderJson.data?.order?.paymentCollectionDetails?.vaultedPaymentMethods?.[0]?.id;
      if (!mandateId) {
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
        console.error(`     ❌ Payment capture failed for ${orderId}:`, captureErrors);
        await shopifyGraphQL(shop, accessToken,
          `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { id: orderId, tags: ["GroupBuy: Payment Failed"] }
        );
      }

      await dispatchGroupBuyEmail(orderParticipantRows[0], shop, campaign, "SUCCESS", blendedContext);

    } catch (error) {
      console.error(`     ❌ Error processing multi-variant order ${orderId}:`, error.message);
    }
  }
}

async function cancelFailedOrders(failingParticipants, shop, accessToken) {
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
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

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

async function revertInventoryPolicy(campaign, shop, accessToken) {
  console.log(`   - 📦 Checking inventory automation for campaign ${campaign.id}...`);
  try {
    const settings = await prisma.settings.findUnique({ where: { shop } });
    const autoTurnOff = settings ? settings.disableContinueSellingOnEnd : true;

    if (!autoTurnOff || !campaign.originalInventoryState) {
      return;
    }

    const snapshot = JSON.parse(campaign.originalInventoryState);

    const getVariantsQuery = `
      query getVariants($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            nodes { id inventoryPolicy }
          }
        }
      }
    `;

    const response = await shopifyGraphQL(shop, accessToken, getVariantsQuery, { id: campaign.productId });
    const variants = response.data?.product?.variants?.nodes;

    if (!variants || variants.length === 0) return;

    const variantsToUpdate = snapshot.filter(saved => {
      const currentVariant = variants.find(v => v.id === saved.id);
      return currentVariant && currentVariant.inventoryPolicy !== saved.policy;
    }).map(saved => ({ id: saved.id, inventoryPolicy: saved.policy }));

    if (variantsToUpdate.length > 0) {
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

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { originalInventoryState: null }
    });
  } catch (error) {
    console.error(`     ❌ Error during inventory reversion:`, error.message);
  }
}

exports.campaignFinalizer = onSchedule("every 5 minutes", async (event) => {
  console.log("🧹 Sweeper waking up! Checking for expired campaigns...");
  const bufferTime = new Date(Date.now() - 10 * 60 * 1000); 

  try {
    const expiredCampaigns = await prisma.campaign.findMany({
      where: { 
        status: "ACTIVE", 
        endDateTime: { lte: bufferTime } 
      },
      include: { 
        groups: { 
          include: { 
            participants: {
              where: { status: "ACTIVE" }
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
      
      const sortedByOrderTime = [...allParticipants].sort((a, b) => 
        new Date(a.orderCreatedAt).getTime() - new Date(b.orderCreatedAt).getTime()
      );
      
      const trueLeaderOrderId = sortedByOrderTime[0]?.orderId;

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

      if (winningParticipants.length > 0) {
         await processParticipants(winningParticipants, variantDiscountMap, campaign.shop, session.accessToken, campaign, trueLeaderOrderId);
      }
      
      if (failingParticipants.length > 0) {
         const winningOrderIds = new Set(winningParticipants.map(p => p.orderId));
         const trulyFailingOrders = failingParticipants.filter(p => !winningOrderIds.has(p.orderId));

         if (trulyFailingOrders.length > 0) {
            await cancelFailedOrders(trulyFailingOrders, campaign.shop, session.accessToken);
         }
      }

      if (campaign.sellingPlanGroupId) {
         await deleteSellingPlanGroup(campaign.sellingPlanGroupId, campaign.shop, session.accessToken);
      }

      await revertInventoryPolicy(campaign, campaign.shop, session.accessToken);

      // ✨ Strip the exact tag this campaign applied!
      if (campaign.appliedDiscountTag) {
        try {
          await shopifyGraphQL(campaign.shop, session.accessToken,
            `mutation tagsRemove($id: ID!, $tags: [String!]!) {
              tagsRemove(id: $id, tags: $tags) { userErrors { message } }
            }`,
            { id: campaign.productId, tags: [campaign.appliedDiscountTag] }
          );
          console.log(`   - 🏷️ Removed campaign tag: ${campaign.appliedDiscountTag}`);
        } catch (err) {
          console.error("   - ❌ Failed to remove campaign tag:", err.message);
        }
      }

      const finalStatus = anyVariantSucceeded ? "SUCCESSFUL" : "FAILED";
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: finalStatus },
      });
      
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