// This file is required by the Shopify CLI to register the webhook subscription.
// However, all the actual webhook processing is handled by our dedicated
// `scripts/pubsub-worker.js` script, which listens to the Google Cloud Pub/Sub topic.

// We just need to return a successful response if Shopify ever pings this endpoint.
export const action = async ({ request }) => {
  return new Response();
};

