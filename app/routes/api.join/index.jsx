import { json } from "@remix-run/node";
import shopify from "../../shopify.server";
import db from "../../db.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { shop, variantId, productId, quantity, customerId, groupBuyFilterEnabled } = await request.json();

    if (!shop || !variantId || !productId) {
      return json({ error: "Shop, variant ID, and product ID are required." }, { status: 400 });
    }
    
    // Normalize IDs
    const simpleVariantId = variantId.toString().split('/').pop();
    const fullProductId = `gid://shopify/Product/${productId}`;
    const fullVariantId = `gid://shopify/ProductVariant/${simpleVariantId}`;

    // 1. Find the active campaign
    const now = new Date();
    const campaign = await db.campaign.findFirst({
      where: {
        productId: fullProductId,
        status: "ACTIVE",
        startDateTime: { lte: now },
        endDateTime: { gte: now },
      },
    });

    if (!campaign) {
      return json({ error: "No active campaign found for this product." }, { status: 404 });
    }

    // --- ✅ FIX: The "Participant Limit Check" block has been entirely removed ---
    // Our progress-counting logic in the worker and campaign API already handles
    // unique participants, so this check was only blocking sales.

    // --- 🚨 2. CONSTRUCT THE ATTRIBUTES ARRAY 🚨 ---
    // Start with the required campaign ID attribute
    const attributes = [{
      key: "_groupbuy_campaign_id",
      value: campaign.id.toString(),
    }];

    // Add the payment filter flag ONLY if it was enabled by the frontend.
    if (groupBuyFilterEnabled) {
        attributes.push({
            key: "_group_buy_checkout", 
            value: "true", // The exact value your Shopify Function is checking for
        });
    }

    const merchandiseId = fullVariantId;
    const { storefront } = await shopify.unauthenticated.storefront(shop);

    const mutation = `
      mutation cartCreate($input: CartInput!) {
        cartCreate(input: $input) {
          cart { id, checkoutUrl }
          userErrors { field, message }
        }
      }`;

    const response = await storefront.graphql(mutation, {
      variables: {
        input: {
          lines: [{ merchandiseId, quantity: quantity || 1 }],
          // 🚨 3. USE THE DYNAMICALLY BUILT ATTRIBUTES ARRAY 🚨
          attributes: attributes, 
        },
      },
    });

    const { data, errors } = await response.json();

    if (errors || !data?.cartCreate || data.cartCreate.userErrors?.length > 0) {
      console.error(
        "❌ Shopify Storefront API call failed:",
        JSON.stringify({ errors, userErrors: data?.cartCreate?.userErrors }, null, 2)
      );
      const errorMessages = data?.cartCreate?.userErrors.map((e) => e.message) || ["Could not create cart."];
      return json({ error: errorMessages.join(", ") }, { status: 500 });
    }

    const checkoutUrl = data.cartCreate.cart.checkoutUrl;
    return json({ checkoutUrl });

  } catch (error) {
    console.error("❌ Join API failed unexpectedly:", error);
    return json({ error: "An unexpected error occurred." }, { status: 500 });
  }
};