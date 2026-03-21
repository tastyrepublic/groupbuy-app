// @ts-check

export function run(input) {
  let hasGroupBuyItem = false;

  // 1. Check if ANY item in the cart is a Group Buy item
  if (input.cart.lines) {
    input.cart.lines.forEach(line => {
      if (line.sellingPlanAllocation?.sellingPlan?.id) {
        hasGroupBuyItem = true;
      }
    });
  }

  let operations = [];

  // 2. If a Group Buy item exists, act as the Bouncer: HIDE FREE SHIPPING.
  if (hasGroupBuyItem && input.cart.deliveryGroups) {
    input.cart.deliveryGroups.forEach(group => {
      group.deliveryOptions.forEach(option => {
        const shippingCost = parseFloat(option.cost.amount);
        
        // If Shopify tries to give them a $0.00 rate, delete it.
        if (shippingCost === 0) {
          operations.push({ 
            deliveryOptionHide: { deliveryOptionHandle: option.handle } 
          });
        }
      });
    });
  }

  return { operations };
}