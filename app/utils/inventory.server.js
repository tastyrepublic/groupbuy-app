import db from "../db.server";

export async function toggleContinueSelling(admin, shop, productId, campaignId, action) {
  try {
    // 1. Check user settings
    let settings = await db.settings.findUnique({ where: { shop } });
    const autoTurnOn = settings ? settings.autoContinueSelling : true;
    const autoTurnOff = settings ? settings.disableContinueSellingOnEnd : true;

    if (action === "START" && !autoTurnOn) return;
    if (action === "END" && !autoTurnOff) return;

    // 2. Fetch the current variants from Shopify
    const getVariantsQuery = `
      query getVariants($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            nodes {
              id
              inventoryPolicy
            }
          }
        }
      }
    `;

    const response = await admin.graphql(getVariantsQuery, { variables: { id: productId } });
    const { data } = await response.json();
    const variants = data?.product?.variants?.nodes;

    if (!variants || variants.length === 0) return;

    let variantsToUpdate = [];

    // ==========================================
    // 🟢 START ACTION: Save memory, then turn ON
    // ==========================================
    if (action === "START") {
      // Create a snapshot of how the variants look right now
      const snapshot = variants.map(v => ({ id: v.id, policy: v.inventoryPolicy }));
      
      // Save the snapshot to the Campaign in the database
      await db.campaign.update({
        where: { id: campaignId },
        data: { originalInventoryState: JSON.stringify(snapshot) }
      });

      // We only need to update the variants that aren't already CONTINUE
      variantsToUpdate = variants
        .filter(v => v.inventoryPolicy !== "CONTINUE")
        .map(v => ({ id: v.id, inventoryPolicy: "CONTINUE" }));
    }

    // ==========================================
    // 🔴 END ACTION: Read memory, then restore
    // ==========================================
    if (action === "END") {
      const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
      
      if (!campaign || !campaign.originalInventoryState) {
        console.log("No memory found for this campaign, skipping revert.");
        return;
      }

      const snapshot = JSON.parse(campaign.originalInventoryState);

      // Compare current Shopify state to our saved snapshot to revert them
      variantsToUpdate = snapshot
        .filter(saved => {
          const currentVariant = variants.find(v => v.id === saved.id);
          // Only update if the current policy doesn't match the saved original policy
          return currentVariant && currentVariant.inventoryPolicy !== saved.policy;
        })
        .map(saved => ({ id: saved.id, inventoryPolicy: saved.policy }));
    }

    // 3. Run the Bulk Update if there are changes to make
    if (variantsToUpdate.length === 0) {
      console.log(`⚡ No inventory updates needed for action: ${action}`);
      return; 
    }

    const updateMutation = `
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }
    `;

    const updateResponse = await admin.graphql(updateMutation, {
      variables: { productId, variants: variantsToUpdate }
    });

    const updateData = await updateResponse.json();
    
    if (updateData.data?.productVariantsBulkUpdate?.userErrors?.length > 0) {
      console.error("❌ Failed to update inventory policy:", updateData.data.productVariantsBulkUpdate.userErrors);
    } else {
      console.log(`✅ Successfully updated ${variantsToUpdate.length} variants for action: ${action}!`);
      
      // ✨ DATA CLEANUP: If we just successfully ended the campaign and restored the variants,
      // wipe the memory bank clean. This saves database space and prevents double-restores!
      if (action === "END") {
        await db.campaign.update({
          where: { id: campaignId },
          data: { originalInventoryState: null } 
        });
        console.log("🧹 Cleaned up inventory memory bank from the database.");
      }
    }

  } catch (error) {
    console.error("🔥 Error in toggleContinueSelling:", error);
  }
}