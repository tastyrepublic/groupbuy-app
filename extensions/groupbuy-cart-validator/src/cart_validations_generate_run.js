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

const TRANSLATIONS = {
  "EN": "Group buy and normal item cannot be mixed. Please clear your cart before adding this item to proceed.",
  "ZH_TW": "團購與一般商品不能混合結帳。請先清空購物車，然後再將此商品加入購物車。",
  "ZH_CN": "團購與一般商品不能混合结账。请先清空购物车，然后再将此商品加入购物车。",
  "ZH": "團購與一般商品不能混合結帳。請先清空購物車，然後再將此商品加入購物車。",
};

export function run(input) {
  // 🚨 DEBUGGER: Print the exact localization object to Shopify's logs
  console.error("=== TRANSLATION DEBUG ===");
  console.error(JSON.stringify(input.localization));
  
  const lines = input.cart?.lines || [];
  
  const rawLocale = input.localization?.language?.isoCode || "EN";
  const locale = rawLocale.toUpperCase();
  
  console.error("Parsed Locale:", locale);
  
  let hasGroupBuy = false;
  let hasNormal = false;

  for (const line of lines) {
    if (line.sellingPlanAllocation?.sellingPlan?.id) {
      hasGroupBuy = true;
    } else {
      hasNormal = true;
    }
  }

  if (hasGroupBuy && hasNormal) {
    const errorMessage = TRANSLATIONS[locale] || TRANSLATIONS["EN"];
    
    console.error("Selected Error Message:", errorMessage);

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