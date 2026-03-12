import { json } from "@remix-run/node";
import db from "../../db.server";
import { authenticate } from "../../shopify.server"; 

export const loader = async ({ request }) => {
  console.log("-------------------------------------------------");
  console.log("[Check-Status API] 🟢 STARTING STATUS CHECK");
  
  const url = new URL(request.url);
  const productId = `gid://shopify/Product/${url.searchParams.get("productId")}`;
  const customerId = url.searchParams.get("customerId");

  console.log(`[Check-Status API] 📦 Params received - Product: ${productId}, Customer: ${customerId}`);

  if (!productId || !customerId || customerId === "null") {
    console.log("[Check-Status API] 🛑 Missing params. Returning hasJoined: false.");
    console.log("-------------------------------------------------");
    return json({ hasJoined: false });
  }
  
  const fullCustomerId = `gid://shopify/Customer/${customerId}`;

  try {
    console.log("[Check-Status API] 🔍 Step 1: Querying local NeonDB for Active Campaign...");
    const campaign = await db.campaign.findFirst({
      where: { productId: productId, status: "ACTIVE" },
      select: { id: true, scope: true, countingMethod: true } 
    });

    if (!campaign) {
      console.log("[Check-Status API] 🛑 No active campaign found in DB. Returning hasJoined: false.");
      console.log("-------------------------------------------------");
      return json({ hasJoined: false });
    }
    
    console.log(`[Check-Status API] ✅ Campaign Found! ID: ${campaign.id}`);

    console.log(`[Check-Status API] 🔍 Step 2: Querying local NeonDB for Participant record...`);
    const participant = await db.participant.findFirst({
      where: {
        customerId: fullCustomerId,
        status: "ACTIVE", // ✅ NEW: Ignore cancelled records!
        group: {
          campaignId: campaign.id,
        },
      },
    });

    let hasJoined = !!participant;
    let isLeader = participant ? participant.isLeader : false;
    let pendingContribution = 0; 
    
    console.log(`[Check-Status API] 📊 DB Participant Check Result: hasJoined = ${hasJoined}`);

    // The Webhook Gap Fix: Live check Shopify API if DB says false!
    if (!hasJoined) {
      console.log("[Check-Status API] ⚡ Step 3: DB says false. Initiating Shopify API Fallback Check...");
      try {
        const { admin } = await authenticate.public.appProxy(request);
        
        if (admin) {
          console.log("[Check-Status API] 🔐 App Proxy Authenticated. Fetching last 5 orders...");
          
          const response = await admin.graphql(
            `#graphql
            query getCustomerRecentOrders($customerId: ID!) {
              customer(id: $customerId) {
                orders(first: 5, sortKey: CREATED_AT, reverse: true) {
                  nodes {
                    name
                    cancelledAt
                    lineItems(first: 20) {
                      nodes {
                        quantity
                        customAttributes {
                          key
                          value
                        }
                      }
                    }
                  }
                }
              }
            }`,
            {
              variables: {
                customerId: fullCustomerId,
              },
            }
          );

          const responseJson = await response.json();
          const orders = responseJson.data?.customer?.orders?.nodes || [];
          
          console.log(`[Check-Status API] 🛒 Found ${orders.length} recent orders to scan.`);

          for (const order of orders) {
            console.log(`[Check-Status API] 🔍 Evaluating Order ${order.name} | Cancelled At: ${order.cancelledAt || 'Not Cancelled'}`);

            if (order.cancelledAt) {
              console.log(`[Check-Status API] 🚫 Skipping Order ${order.name} (Status: Cancelled)`);
              continue;
            }

            let foundQuantity = 0;
            
            const hasCampaignItem = order.lineItems.nodes.some(item => {
              console.log(`   -> Item attributes:`, JSON.stringify(item.customAttributes));
              
              const isMatch = item.customAttributes.some(attr => 
                attr.key === "_groupbuy_campaign_id" && String(attr.value) === String(campaign.id)
              );
              
              if (isMatch) {
                 foundQuantity = item.quantity;
                 console.log(`   -> 🎯 MATCH FOUND! Current Campaign ID (${campaign.id}) matches attribute.`);
              }
              return isMatch;
            });

            if (hasCampaignItem) {
              hasJoined = true;
              pendingContribution = campaign.countingMethod === "ITEM_QUANTITY" ? foundQuantity : 1;
              console.log(`[Check-Status API] 🎉 BINGO! Overriding DB because we found Campaign ${campaign.id} in Order ${order.name}!`);
              break; 
            } else {
              console.log(`[Check-Status API] ❌ Checked Order ${order.name}: No match for Campaign ID ${campaign.id}.`);
            }
          }
        } else {
          console.log("[Check-Status API] ⚠️ Warning: Failed to authenticate App Proxy for Shopify query.");
        }
      } catch (shopifyError) {
        console.error("[Check-Status API] 💥 Shopify API Fallback Error:", shopifyError);
      }
    }
    
    console.log(`[Check-Status API] 🏁 FINAL RESULT: Returning hasJoined = ${hasJoined}, pendingContribution = ${pendingContribution} to storefront.`);
    console.log("-------------------------------------------------");

    return json({ 
      hasJoined: hasJoined,
      isLeader: isLeader, 
      scope: campaign.scope,
      countingMethod: campaign.countingMethod,
      pendingContribution: pendingContribution 
    }); 

  } catch (error) {
    console.error("[Check-Status API] 💥 CRITICAL ERROR:", error);
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
};