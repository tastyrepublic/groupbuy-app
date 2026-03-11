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
        group: {
          campaignId: campaign.id,
        },
      },
    });

    let hasJoined = !!participant;
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
            if (order.cancelledAt) {
              console.log(`[Check-Status API] 🚫 Skipping Order ${order.name} (Status: Cancelled)`);
              continue;
            }

            console.log(`[Check-Status API] 🔍 Inspecting line items for Order ${order.name}...`);
            
            const hasCampaignItem = order.lineItems.nodes.some(item => {
              // This log will print the properties of every item it checks!
              console.log(`   -> Item properties:`, JSON.stringify(item.customAttributes));
              
              return item.customAttributes.some(attr => 
                // ✅ FIX: Force both to be strings so they match perfectly! (e.g. "129" === "129")
                attr.key === "_groupbuy_campaign_id" && String(attr.value) === String(campaign.id)
              );
            });

            if (hasCampaignItem) {
              console.log(`[Check-Status API] 🎉 BINGO! Found group buy item in Order ${order.name}! Overriding DB.`);
              hasJoined = true;
              break; 
            } else {
              console.log(`[Check-Status API] ❌ Checked Order ${order.name}: No match.`);
            }
          }
        } else {
          console.log("[Check-Status API] ⚠️ Warning: Failed to authenticate App Proxy for Shopify query.");
        }
      } catch (shopifyError) {
        console.error("[Check-Status API] 💥 Shopify API Fallback Error:", shopifyError);
      }
    }

    console.log(`[Check-Status API] 🏁 FINAL RESULT: Returning hasJoined = ${hasJoined} to storefront.`);
    console.log("-------------------------------------------------");
    
    return json({ 
      hasJoined: hasJoined, 
      scope: campaign.scope,
      countingMethod: campaign.countingMethod 
    }); 

  } catch (error) {
    console.error("[Check-Status API] 💥 CRITICAL ERROR:", error);
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
};