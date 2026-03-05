import { json } from "@remix-run/node";
import { authenticate } from "../../shopify.server";
import db from "../../db.server";

// This is a resource route. It only exists to return data.
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("id");

  if (!productId) {
    return json({ error: "Product ID is required" }, { status: 400 });
  }

  // 1. Check for an existing active campaign
  const existingCampaign = await db.campaign.findFirst({
    where: { productId: productId, status: 'ACTIVE' },
  });

  if (existingCampaign) {
    // Return the full object so the fetcher always has the same shape
    return json({ hasActiveCampaign: true, isDiscounted: false }); 
  }

  // 2. Check if the product is already discounted
  const response = await admin.graphql(
    `#graphql
      query getProductVariantPrice($id: ID!) {
        product(id: $id) {
          variants(first: 1) {
            nodes {
              price
              compareAtPrice
            }
          }
        }
      }`,
    { variables: { id: productId } }
  );

  const responseJson = await response.json();
  const variant = responseJson.data.product?.variants.nodes[0];

  if (!variant) {
    return json({ error: "Product variant not found" }, { status: 404 });
  }

  const price = parseFloat(variant.price);
  const compareAtPrice = variant.compareAtPrice ? parseFloat(variant.compareAtPrice) : 0;
  const isDiscounted = compareAtPrice > price;
  
  return json({ isDiscounted, hasActiveCampaign: false });
};
