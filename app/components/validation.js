/**
 * Validates the campaign tiers.
 * @param {Array} tiers - The array of tier objects to validate.
 * @returns {Array} An array of error objects corresponding to each tier.
 */
export function validateTiers(tiers) {
  const errors = [];
  tiers.forEach((tier, index) => {
    const tierErrors = {};
    const quantity = parseInt(tier.quantity, 10);
    const discount = parseInt(tier.discount, 10);

    // Validate quantity
    if (isNaN(quantity) || quantity <= 0) {
      tierErrors.quantity = 'Must be > 0.';
    }

    // Validate discount
    if (isNaN(discount) || discount <= 0) {
      tierErrors.discount = 'Must be > 0.';
    } else if (discount > 100) {
      tierErrors.discount = 'Max 100.';
    }

    // Validate against the previous tier
    if (index > 0) {
      const prevTier = tiers[index - 1];
      const prevQuantity = parseInt(prevTier.quantity, 10);
      const prevDiscount = parseInt(prevTier.discount, 10);

      if (!isNaN(quantity) && !isNaN(prevQuantity) && quantity <= prevQuantity) {
        tierErrors.quantity = `Must be > ${prevTier.quantity}`;
      }
      if (!isNaN(discount) && !isNaN(prevDiscount) && discount <= prevDiscount) {
        tierErrors.discount = `Must be > ${prevTier.discount}%`;
      }
    }

    if (Object.keys(tierErrors).length > 0) {
      errors[index] = tierErrors;
    }
  });
  return errors;
}