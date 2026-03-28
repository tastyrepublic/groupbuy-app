// @ts-check

/**
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 */

/**
 * @type {FunctionRunResult}
 */
const EMPTY_RESULT = {
  operations: [],
};

// Error for Rule 1: Mixing Group Buy with Normal items
const TRANSLATIONS_MIXED_NORMAL = {
  "EN": "Group buy and normal items cannot be mixed. Please clear your cart or check out separately.",
  "ZH_TW": "團購與一般商品不能混合結帳。請分開結帳或先清空購物車。",
  "ZH_CN": "团购与一般商品不能混合结账。请分开结账或先清空购物车。",
  "ZH": "團購與一般商品不能混合結帳。請分開結帳或先清空購物車。",
};

// Error for Rule 2: Mixing DIFFERENT Group Buy campaigns
const TRANSLATIONS_MIXED_CAMPAIGNS = {
  "EN": "You cannot mix items from different Group Buy campaigns in the same cart. Please check out separately.",
  "ZH_TW": "您不能在同一個購物車中混合不同團購活動的商品。請分開結帳。",
  "ZH_CN": "您不能在同一个购物车中混合不同团购活动的商品。请分开结账。",
  "ZH": "您不能在同一個購物車中混合不同團購活動的商品。請分開結帳。",
};

export function run(input) {
  const lines = input.cart?.lines || [];
  
  const rawLocale = input.localization?.language?.isoCode || "EN";
  const locale = rawLocale.toUpperCase();
  
  let hasNormal = false;
  const campaignIds = new Set(); // ✨ Memory bank for unique campaign IDs

  // 1. Scan the cart lines
  for (const line of lines) {
    // Check if the item has our hidden campaign ID property attached
    const campaignId = line.attribute?.value;
    
    if (campaignId) {
      campaignIds.add(campaignId); 
    } else {
      hasNormal = true; // No campaign ID means it's a normal store item
    }
  }

  let errorMessage = null;

  // 2. Enforce the Rules
  if (campaignIds.size > 0 && hasNormal) {
    // Rule 1 Violation: Mixed Normal + Group Buy
    errorMessage = TRANSLATIONS_MIXED_NORMAL[locale] || TRANSLATIONS_MIXED_NORMAL["EN"];
    
  } else if (campaignIds.size > 1) {
    // Rule 2 Violation: Multiple Different Campaigns
    errorMessage = TRANSLATIONS_MIXED_CAMPAIGNS[locale] || TRANSLATIONS_MIXED_CAMPAIGNS["EN"];
  }

  // 3. Block Checkout if a rule was broken
  if (errorMessage) {
    return {
      operations: [
        {
          validationAdd: {
            errors: [
              {
                message: errorMessage,
                target: "$.cart"
              }
            ]
          }
        }
      ]
    };
  }

  return EMPTY_RESULT;
}