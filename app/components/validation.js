/**
 * Validates the campaign tiers with multi-language support.
 * @param {Array} tiers - The array of tier objects to validate.
 * @param {Object} i18n - Dictionary of translated error strings.
 * @returns {Array} An array of error objects corresponding to each tier.
 */
export function validateTiers(tiers, i18n = {}) {
  const errors = [];
  
  // Extract translations or fallback to English
  const msgMinQty = i18n.minQty || 'Must be > 0.';
  const msgMinDiscount = i18n.minDiscount || 'Must be > 0.';
  const msgMaxDiscount = i18n.maxDiscount || 'Max 100.';
  const msgGreaterQty = i18n.greaterThanQty || 'Must be >';
  const msgGreaterDiscount = i18n.greaterThanDiscount || 'Must be >';

  tiers.forEach((tier, index) => {
    const tierErrors = {};
    const quantity = parseInt(tier.quantity, 10);
    const discount = parseInt(tier.discount, 10);

    // Validate quantity
    if (isNaN(quantity) || quantity <= 0) {
      tierErrors.quantity = msgMinQty;
    }

    // Validate discount
    if (isNaN(discount) || discount <= 0) {
      tierErrors.discount = msgMinDiscount;
    } else if (discount > 100) {
      tierErrors.discount = msgMaxDiscount;
    }

    // Validate against the previous tier
    if (index > 0) {
      const prevTier = tiers[index - 1];
      const prevQuantity = parseInt(prevTier.quantity, 10);
      const prevDiscount = parseInt(prevTier.discount, 10);

      if (!isNaN(quantity) && !isNaN(prevQuantity) && quantity <= prevQuantity) {
        tierErrors.quantity = `${msgGreaterQty} ${prevTier.quantity}`;
      }
      if (!isNaN(discount) && !isNaN(prevDiscount) && discount <= prevDiscount) {
        tierErrors.discount = `${msgGreaterDiscount} ${prevTier.discount}%`;
      }
    }

    if (Object.keys(tierErrors).length > 0) {
      errors[index] = tierErrors;
    }
  });
  return errors;
}