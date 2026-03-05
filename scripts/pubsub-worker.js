// This is pubsub-worker.js
import 'dotenv/config';
import { PubSub } from '@google-cloud/pubsub';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const pubSubClient = new PubSub();

const orderSubscriptionName = 'shopify-orders-create-sub';
const updateTopicName = 'campaign-progress-updates';

function findAttributeIgnoreCase(attributes, keyToFind) {
  if (!attributes) return undefined;
  const lowerCaseKey = keyToFind.toLowerCase();
  const foundKey = Object.keys(attributes).find(k => k.toLowerCase() === lowerCaseKey);
  return foundKey ? attributes[foundKey] : undefined;
}

/**
 * ✅ NEW: This function is now variant-aware
 * It calculates progress based on the campaign's scope.
 * @param {object} campaign - The full campaign object
 * @param {string} fullVariantId - The GID of the variant (gid://shopify/ProductVariant/123)
 */
async function calculateNewProgress(campaign, fullVariantId) {
  let currentProgress = 0;
  
  if (campaign.scope === 'PRODUCT') {
    // For PRODUCT scope, get all participants for the whole campaign
    const participants = await db.participant.findMany({
      where: { group: { campaignId: campaign.id } }
    });
    
    if (campaign.countingMethod === 'ITEM_QUANTITY') {
      currentProgress = participants.reduce((sum, p) => sum + p.quantity, 0);
    } else {
      // Count unique customers across the whole campaign
      currentProgress = new Set(participants.map(p => p.customerId)).size;
    }
  } else { // 'VARIANT' scope
    // For VARIANT scope, get only participants for this specific variant
    const participants = await db.participant.findMany({
      where: {
        group: { campaignId: campaign.id },
        productVariantId: fullVariantId // Filter by the specific variant
      }
    });
    
    if (campaign.countingMethod === 'ITEM_QUANTITY') {
      currentProgress = participants.reduce((sum, p) => sum + p.quantity, 0);
    } else {
      // Count unique customers *for this variant only*
      currentProgress = new Set(participants.map(p => p.customerId)).size;
    }
  }
  return currentProgress + campaign.startingParticipants;
}

function listenForMessages() {
  const subscription = pubSubClient.subscription(orderSubscriptionName);

  const messageHandler = async (message) => {
    console.log(`Worker: Received Pub/Sub message ${message.id}:`);
    let acknowledged = false;
    
    try {
      const shop = findAttributeIgnoreCase(message.attributes, 'x-shopify-shop-domain');
      if (!shop) {
        console.log(" -> Message missing shop domain. Skipping.");
        message.ack();
        return; 
      }

      const payload = JSON.parse(Buffer.from(message.data, 'base64').toString());
      const noteAttributes = payload.note_attributes || [];
      const groupbuyAttribute = noteAttributes.find(
        (attr) => attr.name === "_groupbuy_campaign_id"
      );

      if (!groupbuyAttribute) {
        console.log("  -> Regular order. Skipping.");
        message.ack();
        return;
      }

      const campaignId = parseInt(groupbuyAttribute.value, 10);
      const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign) {
        throw new Error(`Could not find campaign with ID ${campaignId}.`);
      }

      console.log(`  ✅ This is a Group Buy order for campaign ${campaignId}!`);

      let group = await db.group.findFirst({
        where: { campaignId, status: "OPEN" },
        orderBy: { createdAt: 'desc' }
      });
      if (!group) {
        group = await db.group.create({ data: { campaignId } });
      }

      const orderId = payload.admin_graphql_api_id;
      const customerId = payload.customer ? payload.customer.admin_graphql_api_id : 'guest-customer';
      let hasCreatedParticipant = false;

      // ✅ --- NEW: Loop through each line item ---
      for (const item of payload.line_items) {
        const fullVariantId = `gid://shopify/ProductVariant/${item.variant_id}`;

        // Check if this specific variant is part of our campaign
        const validVariants = JSON.parse(campaign.selectedVariantIdsJson || '[]');
        if (validVariants.includes(fullVariantId)) {
          
          await db.participant.create({
            data: {
              orderId,
              customerId,
              isLeader: false, // Simplifying this
              groupId: group.id,
              quantity: item.quantity,
              productVariantId: fullVariantId, // ✅ Store the variant ID
            },
          });
          
          hasCreatedParticipant = true;
          console.log(`  ✅ Saved participant for variant ${item.variant_id} (Qty: ${item.quantity})`);
          
          // --- Publish update FOR THIS VARIANT ---
          const newProgress = await calculateNewProgress(campaign, fullVariantId);
          
          // Publish all info the socket server will need
          await pubSubClient.topic(updateTopicName).publishMessage({
            json: { 
              campaignId: campaign.id, 
              campaignScope: campaign.scope,
              productVariantId: fullVariantId, // Send the variant ID
              newProgress: newProgress 
            }
          });
          console.log(`  🚀 Published progress for ${fullVariantId}: ${newProgress}`);
        }
      }

      if (!hasCreatedParticipant) {
        console.log("  -> Order was for campaign, but no matching variants found.");
      }

      message.ack();
      acknowledged = true;

    } catch (error) {
      console.error("❌ Worker: Error processing message:", error);
      if (!acknowledged) message.nack();
    }
  };

  subscription.on('message', messageHandler);
  console.log(`🚀 Worker is listening for messages on "${orderSubscriptionName}".`);
}

listenForMessages();