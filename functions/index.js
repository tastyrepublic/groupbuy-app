const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { PrismaClient } = require("@prisma/client");

// Initialize Firebase Admin for Firestore access
admin.initializeApp();
const firestore = admin.firestore();

// Initialize Prisma to connect to NeonDB
const prisma = new PrismaClient();

// Calculates progress based on the campaign's scope
async function calculateNewProgress(campaign, fullVariantId) {
  let currentProgress = 0;
  
  if (campaign.scope === 'PRODUCT') {
    const participants = await prisma.participant.findMany({
      where: { group: { campaignId: campaign.id } }
    });
    
    if (campaign.countingMethod === 'ITEM_QUANTITY') {
      currentProgress = participants.reduce((sum, p) => sum + p.quantity, 0);
    } else {
      currentProgress = new Set(participants.map(p => p.customerId)).size;
    }
  } else { // 'VARIANT' scope
    const participants = await prisma.participant.findMany({
      where: {
        group: { campaignId: campaign.id },
        productVariantId: fullVariantId 
      }
    });
    
    if (campaign.countingMethod === 'ITEM_QUANTITY') {
      currentProgress = participants.reduce((sum, p) => sum + p.quantity, 0);
    } else {
      currentProgress = new Set(participants.map(p => p.customerId)).size;
    }
  }
  return currentProgress + campaign.startingParticipants;
}

// 🚀 The Firebase Function triggered by Shopify Pub/Sub
exports.processGroupBuyOrder = onMessagePublished("shopify-orders-create", async (event) => {
  try {
    const message = event.data.message;
    
    console.log("Raw Attributes from Shopify:", event.data.message.attributes);

    // Decode the base64 JSON payload
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

    // Find or create the active group
    let group = await prisma.group.findFirst({
      where: { campaignId, status: "OPEN" },
      orderBy: { createdAt: 'desc' }
    });
    
    if (!group) {
      group = await prisma.group.create({ data: { campaignId } });
    }

    const orderId = payload.admin_graphql_api_id;
    
    // Handle guest checkouts so they don't all clump into one "guest-customer"
    const customerId = payload.customer?.admin_graphql_api_id 
      || payload.email 
      || `guest-${orderId}`; 

    let hasCreatedParticipant = false;

    // Loop through each line item
    for (const item of payload.line_items) {
      const fullVariantId = `gid://shopify/ProductVariant/${item.variant_id}`;
      const validVariants = JSON.parse(campaign.selectedVariantIdsJson || '[]');
      
      if (validVariants.includes(fullVariantId)) {
        
        // Idempotency check to prevent duplicate entries
        const existingParticipant = await prisma.participant.findFirst({
          where: { orderId, productVariantId: fullVariantId }
        });

        if (!existingParticipant) {
          await prisma.participant.create({
            data: {
              orderId,
              customerId,
              isLeader: false,
              groupId: group.id,
              quantity: item.quantity,
              productVariantId: fullVariantId, 
            },
          });
          
          hasCreatedParticipant = true;
          console.log(`  ✅ Saved participant for variant ${item.variant_id} (Qty: ${item.quantity})`);
          
          // Calculate the new progress
          const newProgress = await calculateNewProgress(campaign, fullVariantId);
          
          // 🔥 FIREBASE UPDATE: Write the update to Firestore
          const simpleVariantId = item.variant_id;
          
          let docId = `campaign_${campaignId}`;
          if (campaign.scope === 'VARIANT') {
             docId = `campaign_${campaignId}_variant_${simpleVariantId}`;
          }

          await firestore.collection("campaignProgress").doc(docId).set({
            progress: newProgress,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          
          console.log(`  🚀 Updated Firestore document ${docId} with progress: ${newProgress}`);
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
    throw error; // Throwing tells Pub/Sub to retry this message later
  }
});