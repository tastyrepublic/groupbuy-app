import { PubSub } from '@google-cloud/pubsub';

// 🔑 Tell Google Cloud exactly where your VIP pass is located
process.env.GOOGLE_APPLICATION_CREDENTIALS = './service-account.json';
process.env.GOOGLE_CLOUD_PROJECT = 'groupbuy-app-635bf';

const pubsub = new PubSub();

const mockShopifyOrder = {
  admin_graphql_api_id: "gid://shopify/Order/0000000099", // Changed slightly to avoid duplicates
  email: "test-customer@example.com",
  note_attributes: [
    { name: "_groupbuy_campaign_id", value: "28" } 
  ],
  line_items: [
    {
      variant_id: "41794368929895",
      quantity: 2
    }
  ]
};

async function triggerFunction() {
  try {
    const topic = pubsub.topic('shopify-orders-create');

    console.log("Sending message to live Google Cloud...");

    // Publish the fake Shopify order directly to the LIVE queue
    const dataBuffer = Buffer.from(JSON.stringify(mockShopifyOrder));
    const messageId = await topic.publishMessage({
      data: dataBuffer,
      attributes: { "x-shopify-shop-domain": "test-store.myshopify.com" }
    });

    console.log(`✅ Message ${messageId} successfully published to LIVE Pub/Sub!`);
    console.log(`👉 Check your Shopify product page!`);

  } catch (error) {
    console.error("❌ Error publishing message:", error);
  }
}

triggerFunction();