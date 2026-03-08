import { json } from "@remix-run/node";
import shopify from "../../shopify.server";
import db from "../../db.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    // We removed groupBuyFilterEnabled because we don't need it anymore!
    const { shop, variantId, productId, quantity, customerId } = await request.json();

    if (!shop || !variantId || !productId) {
      return json({ error: "Shop, variant ID, and product ID are required." }, { status: 400 });
    }
    
    // Normalize IDs
    const simpleVariantId = variantId.toString().split('/').pop();
    const fullProductId = `gid://shopify/Product/${productId}`;
    const fullVariantId = `gid://shopify/ProductVariant/${simpleVariantId}`;

    // 1. Find the active campaign in your database
    const now = new Date();
    const campaign = await db.campaign.findFirst({
      where: {
        productId: fullProductId,
        status: "ACTIVE",
        startDateTime: { lte: now },
        endDateTime: { gte: now },
      },
    });

    if (!campaign || !campaign.sellingPlanGroupId) {
      return json({ error: "No active group buy found for this product." }, { status: 404 });
    }

    // --- ✅ NEW: 2. FETCH THE SPECIFIC SELLING PLAN ID ---
    // We have the Group ID in the database, but the Cart needs the specific Plan ID
    const { admin } = await shopify.unauthenticated.admin(shop);
    
    const planQuery = await admin.graphql(
      `#graphql
      query getSellingPlan($id: ID!) {
        sellingPlanGroup(id: $id) {
          sellingPlans(first: 1) {
            edges {
              node {
                id
              }
            }
          }
        }
      }`,
      { variables: { id: campaign.sellingPlanGroupId } }
    );
    
    const planData = await planQuery.json();
    const sellingPlanId = planData.data?.sellingPlanGroup?.sellingPlans?.edges[0]?.node?.id;

    if (!sellingPlanId) {
       return json({ error: "Could not locate the deferred payment plan." }, { status: 500 });
    }

    // --- ✅ NEW: 3. CREATE CART WITH THE SELLING PLAN ---
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
          // The Selling Plan ID goes DIRECTLY into the line item!
          lines: [{ 
            merchandiseId: fullVariantId, 
            quantity: quantity || 1,
            sellingPlanId: sellingPlanId 
          }],
          // We keep the campaign ID as a cart attribute just so it's easy for you 
          // to see in the Shopify Admin Order page, but it's no longer the "only" link!
          attributes: [{
            key: "_groupbuy_campaign_id",
            value: campaign.id.toString(),
          }]
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