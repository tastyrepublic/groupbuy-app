import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  try {
    // 1. Authenticate the incoming webhook
    const { topic, shop, payload } = await authenticate.webhook(request);

    // 2. Capture the exact millisecond your app received this
    const receivedTime = new Date();
    const readableReceived = receivedTime.toLocaleTimeString() + '.' + receivedTime.getMilliseconds().toString().padStart(3, '0');

    console.log("\n========================================");
    console.log(`🔔 WEBHOOK SUCCESSFULLY RECEIVED`);
    console.log(`📦 Topic:        ${topic}`);
    console.log(`🏪 Store Domain: ${shop}`);

    // 3. Extract Order details and calculate the speed!
    if (payload && payload.id) {
      console.log(`📝 Order ID:     ${payload.id}`);
      
      if (payload.created_at) {
        // Parse Shopify's official creation time
        const createdTime = new Date(payload.created_at);
        const readableCreated = createdTime.toLocaleTimeString() + '.' + createdTime.getMilliseconds().toString().padStart(3, '0');
        
        // Calculate the difference in seconds
        const delayMs = receivedTime.getTime() - createdTime.getTime();
        const delaySeconds = (delayMs / 1000).toFixed(2);

        console.log(`🛒 Order Time:   ${readableCreated}`);
        console.log(`🕒 Receive Time: ${readableReceived}`);
        console.log(`⚡ Delivery Lag: ${delaySeconds} seconds`);
      }
    } else {
      console.log(`🕒 Receive Time: ${readableReceived}`);
    }
    
    console.log("========================================\n");

    // 4. Return 200 OK so Shopify stops sending 404 retries
    return new Response("Webhook processed", { status: 200 });

  } catch (error) {
    console.error("❌ Webhook Error:", error.message);
    return new Response("Webhook error but stopping retries", { status: 200 });
  }
};