// @ts-check
export function run(input) {
  let hasGroupBuyItem = false;

  if (input.cart.lines) {
    input.cart.lines.forEach(line => {
      if (line.sellingPlanAllocation?.sellingPlan?.id) { hasGroupBuyItem = true; }
    });
  }

  // ✨ Parse the JSON array from the Metafield
  const hiddenRatesJson = input.deliveryCustomization?.metafield?.value || "[]";
  const ratesToHide = JSON.parse(hiddenRatesJson);
  
  let operations = [];

  if (hasGroupBuyItem && input.cart.deliveryGroups) {
    input.cart.deliveryGroups.forEach(group => {
      group.deliveryOptions.forEach(option => {
        
        // ✨ Rule B: Hide it ONLY if the title is inside the merchant's checked list!
        if (ratesToHide.includes(option.title)) {
          operations.push({ deliveryOptionHide: { deliveryOptionHandle: option.handle } });
        }
        
      });
    });
  }

  return { operations };
}