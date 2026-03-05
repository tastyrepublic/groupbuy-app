import { json } from "@remix-run/node";
import shopify from "../../shopify.server";
import db from "../../db.server";

export const action = async ({ request }) => {
  // --- Security Check (Unchanged) ---
  const secret = process.env.SCHEDULER_SECRET;
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${secret}`) {
    console.error("❌ Finalize endpoint: Invalid or missing secret token.");
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { campaignId } = await request.json();
    if (!campaignId) {
      return json({ error: "Campaign ID is required." }, { status: 400 });
    }

    console.log(`\n--- ⏰ Finalizing Campaign ID: ${campaignId} ---\n`);

    const campaign = await db.campaign.findUnique({
      where: { id: campaignId },
      include: {
        groups: {
          include: {
            participants: true,
          },
        },
      },
    });

    if (!campaign || campaign.status !== "ACTIVE") {
      console.log(`   -> Campaign ${campaignId} not found or not active. Skipping.`);
      return json({ success: true, message: "Campaign not found or not active." });
    }
    
    const { admin } = await shopify.unauthenticated.admin(campaign.shop);
    let anyVariantSucceeded = false;

    // --- ✅ NEW: SCOPE-AWARE LOGIC ---
    
    if (campaign.scope === 'PRODUCT') {
      // --- LOGIC FOR "PRODUCT-WIDE" CAMPAIGNS ---
      console.log(`   -> Scope: Product-wide. Calculating total progress...`);
      
      const allParticipants = campaign.groups.flatMap((g) => g.participants);
      let finalProgress = 0;

      if (campaign.countingMethod === 'ITEM_QUANTITY') {
        finalProgress = allParticipants.reduce((sum, p) => sum + p.quantity, 0);
      } else { // PARTICIPANT
        finalProgress = new Set(allParticipants.map(p => p.customerId)).size;
      }
      
      finalProgress += campaign.startingParticipants;
      console.log(`   Found ${finalProgress} total progress.`);

      const tiers = JSON.parse(campaign.tiersJson).sort((a, b) => b.quantity - a.quantity);
      let finalDiscountTier = tiers.find(tier => finalProgress >= tier.quantity);
      
      if (finalDiscountTier && allParticipants.length > 0) {
        console.log(`   ✅ Success! Reached tier: ${finalDiscountTier.quantity} for ${finalDiscountTier.discount}% off.`);
        anyVariantSucceeded = true;
        // Apply discount to ALL participants
        await processParticipants(allParticipants, finalDiscountTier, admin);
      } else {
        console.log("   -> Campaign failed to meet tier requirements.");
      }

    } else {
      // --- LOGIC FOR "PER-VARIANT" CAMPAIGNS ---
      console.log(`   -> Scope: Per-Variant. Calculating progress for each variant...`);
      const allParticipants = campaign.groups.flatMap((g) => g.participants);
      const allVariantGIDsInCampaign = JSON.parse(campaign.selectedVariantIdsJson || '[]');
      
      // Loop through each variant the merchant selected for this campaign
      for (const variantId of allVariantGIDsInCampaign) {
        const participantsForThisVariant = allParticipants.filter(p => p.productVariantId === variantId);
        if (participantsForThisVariant.length === 0) continue; // Skip if no one bought this variant

        console.log(`\n   -- Checking Variant ${variantId.split('/').pop()} --`);
        let variantProgress = 0;
        
        if (campaign.countingMethod === 'ITEM_QUANTITY') {
          variantProgress = participantsForThisVariant.reduce((sum, p) => sum + p.quantity, 0);
        } else { // PARTICIPANT
          variantProgress = new Set(participantsForThisVariant.map(p => p.customerId)).size;
        }

        variantProgress += campaign.startingParticipants;
        console.log(`      Found ${variantProgress} progress for this variant.`);
        
        const tiers = JSON.parse(campaign.tiersJson).sort((a, b) => b.quantity - a.quantity);
        let finalDiscountTier = tiers.find(tier => variantProgress >= tier.quantity);

        if (finalDiscountTier) {
          console.log(`      ✅ Success for this variant! Applying ${finalDiscountTier.discount}% off.`);
          anyVariantSucceeded = true;
          // Apply discount ONLY to participants who bought THIS variant
          await processParticipants(participantsForThisVariant, finalDiscountTier, admin);
        } else {
          console.log(`      -> This variant failed to meet tier requirements.`);
        }
      }
    }

    // --- Final Status Update ---
    const finalStatus = anyVariantSucceeded ? "SUCCESSFUL" : "FAILED";
    await db.campaign.update({
      where: { id: campaignId },
      data: { status: finalStatus },
    });
    console.log(`\n--- ✅ Campaign ${campaignId} finalized with status: ${finalStatus} ---\n`);

    return json({ success: true, status: finalStatus });

  } catch (error) {
    console.error("❌ Error during campaign finalization:", error);
    return json({ error: "An unexpected error occurred." }, { status: 500 });
  }
};


/**
 * ✅ NEW HELPER FUNCTION
 * This function contains the logic to edit orders, apply discounts, and capture payments.
 * It's now a reusable function we can call for all participants or just a subset.
 * @param {Array} participants - The list of participant records to process.
 * @param {object} finalDiscountTier - The tier object with 'quantity' and 'discount'.
 * @param {object} admin - The Shopify admin API client.
 */
async function processParticipants(participants, finalDiscountTier, admin) {
  for (const participant of participants) {
    console.log(`   - Processing order ${participant.orderId}...`);
    try {
      // --- 1. Begin Order Edit ---
      const beginEditResponse = await admin.graphql(
        `#graphql
        mutation orderEditBegin($id: ID!) {
          orderEditBegin(id: $id) {
            calculatedOrder {
              id
              lineItems(first: 25) {
                edges {
                  node {
                    id
                    quantity
                    # We need to know which variant this line item is for
                    variant { id } 
                  }
                }
              }
            }
            userErrors { field, message }
          }
        }`,
        { variables: { id: participant.orderId } },
      );

      const beginEditJson = await beginEditResponse.json();
      const calculatedOrder = beginEditJson.data.orderEditBegin.calculatedOrder;
      if (!calculatedOrder || beginEditJson.data.orderEditBegin.userErrors.length > 0) {
        console.error(`     ❌ Failed to begin edit for order ${participant.orderId}:`, beginEditJson.data.orderEditBegin.userErrors);
        continue;
      }
      
      const calculatedOrderId = calculatedOrder.id;

      // --- 2. Apply Discount to the Correct Line Item ---
      const lineItemToDiscount = calculatedOrder.lineItems.edges.find(
        (edge) => edge.node.variant.id === participant.productVariantId
      )?.node;
      
      if (!lineItemToDiscount) {
          console.warn(`     -> Could not find matching line item for variant ${participant.productVariantId} in order ${participant.orderId}. Skipping discount.`);
      } else {
        console.log(`     - Applying discount to line item ${lineItemToDiscount.id}...`);
        await admin.graphql(
          `#graphql
          mutation orderEditAddLineItemDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
            orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
              calculatedOrder { id }
              userErrors { field, message }
            }
          }`,
          {
            variables: {
              id: calculatedOrderId,
              lineItemId: lineItemToDiscount.id,
              discount: {
                percentValue: parseFloat(finalDiscountTier.discount),
                description: "Group Buy Campaign Discount",
              },
            },
          },
        );
      }
      
      // --- 3. Commit the Edit ---
      const commitResponse = await admin.graphql(
        `#graphql
        mutation orderEditCommit($id: ID!) {
          orderEditCommit(id: $id) {
            order { id }
            userErrors { field, message }
          }
        }`,
        { variables: { id: calculatedOrderId } },
      );
      // ... (Error handling for commit)

      // --- 4. Capture Payment ---
      const orderResponse = await admin.graphql(
        `#graphql
        query getOrderTransactions($id: ID!) {
          order(id: $id) {
            totalPriceSet { shopMoney { amount, currencyCode } }
            transactions(first: 5) { id, kind, status }
          }
        }`,
        { variables: { id: participant.orderId } },
      );
      
      const orderJson = await orderResponse.json();
      const orderData = orderJson.data.order;
      const parentTransaction = orderData?.transactions?.find(
        (txn) => txn.kind === "AUTHORIZATION" && txn.status === "SUCCESS",
      );

      if (!parentTransaction) {
        console.error(`     ❌ Could not find an AUTHORIZATION transaction for order ${participant.orderId}. Skipping capture.`);
        continue;
      }

      const finalPrice = parseFloat(orderData.totalPriceSet.shopMoney.amount);
      const currency = orderData.totalPriceSet.shopMoney.currencyCode;

      await admin.graphql(
        `#graphql
        mutation orderCapture($input: OrderCaptureInput!) {
          orderCapture(input: $input) {
            transaction { id }
            userErrors { field, message }
          }
        }`,
        {
          variables: {
            input: {
              id: participant.orderId,
              parentTransactionId: parentTransaction.id,
              amount: finalPrice,
              currency: currency,
            },
          },
        },
      );
      console.log(`     ✅ Captured ${finalPrice.toFixed(2)} ${currency}. Order ${participant.orderId} should be 'Paid'.`);

    } catch (error) {
      console.error(`     ❌ An unexpected error occurred while processing order ${participant.orderId}:`, error);
    }
  }
}