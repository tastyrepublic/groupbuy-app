import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

let firestoreUnsubscribe = null;
const activeConnections = {};

function clearConnections(container) {
  const timerIdKey = container?.dataset.productId;
  if (!timerIdKey) return;
  if (activeConnections[timerIdKey]?.timers) {
    activeConnections[timerIdKey].timers.forEach(clearInterval);
  }
  if (activeConnections[timerIdKey]?.unsubscribe) {
    activeConnections[timerIdKey].unsubscribe();
  }
  delete activeConnections[timerIdKey];
}

function storeTimer(container, intervalId) {
  const timerIdKey = container?.dataset.productId;
  if (!timerIdKey) return;
  if (!activeConnections[timerIdKey]) activeConnections[timerIdKey] = { timers: [], unsubscribe: null };
  activeConnections[timerIdKey].timers.push(intervalId);
}

function storeUnsubscribe(container, unsubscribe) {
  const timerIdKey = container?.dataset.productId;
  if (!timerIdKey) return;
  if (!activeConnections[timerIdKey]) activeConnections[timerIdKey] = { timers: [], unsubscribe: null };
  activeConnections[timerIdKey].unsubscribe = unsubscribe;
}

function connectToFirebase(container, campaignData) {
  const campaignId = container.dataset.campaignId;
  const productVariantId = container.dataset.variantId;
  const projectId = container.dataset.fbProjectid; 
  
  if (!window.firebaseApp) {
    window.firebaseApp = initializeApp({ projectId: projectId });
    window.firebaseDb = getFirestore(window.firebaseApp);
  }
  
  const db = window.firebaseDb;
  const simpleVariantId = productVariantId.split('/').pop();
  let docId = `campaign_${campaignId}`;
  if (campaignData.scope === 'VARIANT') {
     docId = `campaign_${campaignId}_variant_${simpleVariantId}`;
  }

  let isInitialLoad = true; // ✅ Tracks the very first Firebase connection

  const docRef = doc(db, "campaignProgress", docId);
  const unsubscribe = onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      const rawFirestoreProgress = data.progress || 0;
      const startingParticipants = Number(campaignData.startingParticipants) || 0;
      
      // Save the raw progress from the database
      container.dataset.rawProgress = rawFirestoreProgress + startingParticipants;
      
      // ✅ THE FIX: If Firebase updates AFTER the initial load, it means a webhook finished!
      // We wipe out the "fake" pending contribution so it perfectly matches the real database.
      if (!isInitialLoad && Number(container.dataset.pendingContribution) > 0) {
        container.dataset.pendingContribution = 0;
      }
      isInitialLoad = false;
      
      const pending = Number(container.dataset.pendingContribution) || 0;
      const totalDisplayProgress = Number(container.dataset.rawProgress) + pending;
      
      const targetContainer = container.classList.contains('progress-bar-container') ? container : container.querySelector('.progress-bar-container');
      if (targetContainer) {
        updateProgressUI(targetContainer, campaignData, totalDisplayProgress);
      }
    }
  });

  storeUnsubscribe(container, unsubscribe);
}

function updateProgressUI(container, campaignData, newProgress) {
  if (!container) return;
  
  const trackElement = container.querySelector('.gb-segmented-track');
  const progressTextElement = container.querySelector('.gb-progress-text');
  if (!trackElement || !progressTextElement) return;

  const tiers = campaignData.tiers.sort((a, b) => a.quantity - b.quantity);
  const maxGoal = tiers.length > 0 ? Number(tiers[tiers.length - 1].quantity) : 0;
  
  const isQuantityCounting = campaignData.countingMethod === 'ITEM_QUANTITY';
  const progressTextLabel = isQuantityCounting ? 'Items Sold' : 'Participants';
  progressTextElement.textContent = `${newProgress} / ${maxGoal > 0 ? maxGoal : '∞'} ${progressTextLabel}`;

  const progressFormat = container.dataset.progressFormat || 'percentage';
  const currencySymbol = container.dataset.currencySymbol || '$';
  const basePrice = parseFloat(container.dataset.productPrice || 0);

  // ✅ NEW: Check if the bar is already drawn to avoid the "reload" flicker!
  const existingSegments = trackElement.children;
  const isUpdate = existingSegments.length === tiers.length;

  if (!isUpdate) {
    trackElement.innerHTML = ''; // Only clear if it's the very first time
  }
  
  if (maxGoal > 0) {
    tiers.forEach((tier, index) => {
      const previousTierQty = index === 0 ? 0 : Number(tiers[index - 1].quantity);
      const tierGoal = Number(tier.quantity);
      const tierCapacity = tierGoal - previousTierQty;

      const totalInThisBlock = Math.max(0, Math.min(newProgress - previousTierQty, tierCapacity));
      const fillPercent = (totalInThisBlock / tierCapacity) * 100;
      const isAchieved = newProgress >= tierGoal;

      if (isUpdate) {
        // ✅ SMART UPDATE: Just slide the existing bar instead of redrawing!
        const segmentWrapper = existingSegments[index];
        const fillBar = segmentWrapper.querySelector('.gb-fill-bar');
        const discountLabel = segmentWrapper.querySelector('.gb-discount-label');
        
        if (fillBar) fillBar.style.width = `${fillPercent}%`;
        if (discountLabel) discountLabel.style.color = isAchieved ? '#2ecc71' : '#8a8a8a';
      } else {
        // Build it from scratch for the first time
        const isFirst = index === 0;
        const isLast = index === tiers.length - 1;

        const segmentWrapper = document.createElement('div');
        segmentWrapper.style.flex = tierCapacity;
        segmentWrapper.style.display = 'flex';
        segmentWrapper.style.flexDirection = 'column';
        segmentWrapper.style.borderRight = isLast ? 'none' : '2px solid transparent';

        const segmentBar = document.createElement('div');
        segmentBar.style.width = '100%';
        segmentBar.style.height = 'var(--gb-progress-height, 8px)';
        segmentBar.style.background = 'var(--gb-progress-bg-color, #e3e3e3)'; 
        segmentBar.style.borderTopLeftRadius = isFirst ? 'var(--gb-progress-radius, 4px)' : '0';
        segmentBar.style.borderBottomLeftRadius = isFirst ? 'var(--gb-progress-radius, 4px)' : '0';
        segmentBar.style.borderTopRightRadius = isLast ? 'var(--gb-progress-radius, 4px)' : '0';
        segmentBar.style.borderBottomRightRadius = isLast ? 'var(--gb-progress-radius, 4px)' : '0';
        segmentBar.style.display = 'flex';
        segmentBar.style.overflow = 'hidden';

        const fillBar = document.createElement('div');
        fillBar.className = 'gb-fill-bar'; // Tagged to find later
        fillBar.style.width = '0%';
        fillBar.style.background = 'var(--gb-progress-color, #005bd3)'; 
        fillBar.style.transition = 'width 0.5s ease-in-out';
        segmentBar.appendChild(fillBar);

        const labelContainer = document.createElement('div');
        labelContainer.style.marginTop = '8px';
        labelContainer.style.textAlign = 'center';
        
        let progressLabelText = `${tier.discount}% off`;
        if (progressFormat === 'price' && basePrice > 0) {
          const discountedPrice = basePrice * (1 - (tier.discount / 100));
          progressLabelText = `${currencySymbol}${discountedPrice.toFixed(2)}`;
        }

        const discountLabel = document.createElement('span');
        discountLabel.className = 'gb-discount-label'; // Tagged to find later
        discountLabel.style.display = 'block';
        discountLabel.style.fontSize = '12px';
        discountLabel.style.lineHeight = '16px';
        discountLabel.style.fontWeight = 'bold';
        discountLabel.style.color = isAchieved ? '#2ecc71' : '#8a8a8a';
        discountLabel.textContent = progressLabelText;

        const qtyLabel = document.createElement('span');
        qtyLabel.style.display = 'block';
        qtyLabel.style.fontSize = '11px';
        qtyLabel.style.color = '#8a8a8a';
        qtyLabel.textContent = tier.quantity;

        labelContainer.appendChild(discountLabel);
        labelContainer.appendChild(qtyLabel);

        segmentWrapper.appendChild(segmentBar);
        segmentWrapper.appendChild(labelContainer);
        trackElement.appendChild(segmentWrapper);

        // Force instant browser paint, then animate!
        void fillBar.offsetWidth; 
        fillBar.style.width = `${fillPercent}%`;
      }
    });
  }
}

const handleNativeSellingPlanUI = () => {
  if (window.Shopify && window.Shopify.designMode) return; 

  if (!document.getElementById('gb-hide-selling-plans-css')) {
    const style = document.createElement('style');
    style.id = 'gb-hide-selling-plans-css';
    style.innerHTML = `
      .shopify-selling-plan-group, shopify-payment-terms, .product-form__input--selling-plan, product-subscriptions { display: none !important; }
      fieldset:has(input[name="selling_plan"]), div:has(> input[name="selling_plan"]) { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  const disableInputs = () => {
    const inputs = document.querySelectorAll('input[name="selling_plan"], select[name="selling_plan"], input[name="purchase_option"]');
    inputs.forEach(input => input.disabled = true);
  };

  disableInputs();
  const observer = new MutationObserver(() => disableInputs());
  observer.observe(document.body, { childList: true, subtree: true });

  const productForms = document.querySelectorAll('form[action*="/cart/add"]');
  productForms.forEach(form => {
    form.addEventListener('submit', () => {
      const hiddenSpInput = form.querySelector('input[name="selling_plan"]');
      if (hiddenSpInput && !hiddenSpInput.value) {
        hiddenSpInput.disabled = true; 
      }
    });
  });
};

function performAnimatedSwap(container, renderCallback) {
  const oldWrapper = container.querySelector('.gb-wrapper');
  const oldHeight = oldWrapper ? oldWrapper.offsetHeight : 0;
  const wasEmpty = oldHeight === 0;

  renderCallback();

  const newWrapper = container.querySelector('.gb-wrapper');
  if (!newWrapper) return;

  if (wasEmpty) {
      newWrapper.classList.add('gb-fade-in-up');
      return;
  }

  newWrapper.style.opacity = '1';
  newWrapper.classList.remove('gb-fade-in-up');

  newWrapper.style.transition = 'none';
  newWrapper.style.height = 'auto';
  const newHeight = newWrapper.offsetHeight;
  
  if (Math.abs(oldHeight - newHeight) > 5) {
      newWrapper.style.height = oldHeight + 'px';
      newWrapper.style.overflow = 'hidden';
      
      newWrapper.offsetHeight; 
      
      newWrapper.style.transition = 'height 0.3s ease-in-out';
      
      requestAnimationFrame(() => {
          newWrapper.style.height = newHeight + 'px';
      });

      setTimeout(() => {
          if (container.querySelector('.gb-wrapper') === newWrapper) {
              newWrapper.style.height = 'auto';
              newWrapper.style.overflow = '';
              newWrapper.style.transition = '';
          }
      }, 300);
  } else {
      newWrapper.style.height = 'auto';
  }
}

function collapseContainer(container) {
  const currentWrapper = container.querySelector('.gb-wrapper');
  if (currentWrapper) {
      currentWrapper.style.height = currentWrapper.offsetHeight + 'px';
      currentWrapper.style.overflow = 'hidden';
      currentWrapper.offsetHeight; 
      currentWrapper.style.transition = 'height 0.3s ease, margin 0.3s ease, padding 0.3s ease, opacity 0.3s ease, border-width 0.3s ease';
      
      requestAnimationFrame(() => {
          currentWrapper.style.height = '0px';
          currentWrapper.style.marginTop = '0px';
          currentWrapper.style.marginBottom = '0px';
          currentWrapper.style.paddingTop = '0px';
          currentWrapper.style.paddingBottom = '0px';
          currentWrapper.style.borderWidth = '0px';
          currentWrapper.style.opacity = '0';
      });
      setTimeout(() => { container.innerHTML = ''; }, 300);
  } else {
      container.innerHTML = '';
  }
}

const shareButtonSVG = `
  <button class="gb-share-btn" style="background: none; border: none; cursor: pointer; color: var(--gb-title-color, #202223); padding: 0; display: flex; align-items: center; justify-content: center; opacity: 0.5; transition: opacity 0.2s; width: 24px; height: 24px;" title="Share this deal">
    <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle>
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
    </svg>
  </button>
`;

function setupShareButton(container) {
  const shareBtn = container.querySelector('.gb-share-btn');
  if (!shareBtn) return;
  shareBtn.addEventListener('click', () => {
    if (navigator.share) {
      navigator.share({ title: 'Join this Group Buy!', url: window.location.href }).catch(() => {});
    } else {
      navigator.clipboard.writeText(window.location.href);
      const oldHTML = shareBtn.innerHTML;
      shareBtn.innerHTML = '<span style="font-size: 10px; font-weight: bold; color: var(--gb-progress-color, #005bd3);">Copied!</span>';
      setTimeout(() => shareBtn.innerHTML = oldHTML, 2000);
    }
  });
}

function renderNotIncludedCampaign(container) {
  const notIncludedText = container.dataset.notIncludedText || 'This variant is not included in the current group buy.';
  
  container.innerHTML = `
    <div class="progress-bar-container gb-wrapper" style="background: var(--gb-bg-color, #fafafa); padding: 20px; border-radius: var(--gb-box-radius, 8px); border: var(--gb-border, 1px solid #e3e3e3); margin-top: 20px; box-sizing: border-box; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center;">
      <svg viewBox="0 0 24 24" width="28" height="28" stroke="var(--gb-desc-color, #5c5f62)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 12px; opacity: 0.6;">
         <circle cx="12" cy="12" r="10"></circle>
         <line x1="12" y1="16" x2="12" y2="12"></line>
         <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <p style="margin: 0; font-size: var(--gb-desc-size, 13px); font-weight: var(--gb-desc-weight, 400); font-style: var(--gb-desc-style, normal); color: var(--gb-desc-color, #5c5f62); line-height: 1.4;">${notIncludedText}</p>
    </div>
  `;
}

function fetchAndRenderCampaign(container, variantId) {
  const productId = container.dataset.productId;
  const shop = container.dataset.shop;
  clearConnections(container); 
  
  const simpleVariantId = variantId.toString().split('/').pop();
  if (!productId || !simpleVariantId || !shop) { container.innerHTML = ''; return; }
  
  if (window.Shopify && window.Shopify.designMode) {
    const previewState = container.dataset.editorPreview || 'ACTIVE';
    
    // Shared dummy data for all preview states
    const dummyCampaign = {
      startDateTime: new Date(Date.now() + 86400000).toISOString(), // Starts tomorrow (for Scheduled)
      endDateTime: new Date(Date.now() + 172800000).toISOString(),   // Ends in 2 days
      tiers: [
        { quantity: 5, discount: 10 },
        { quantity: 15, discount: 15 },
        { quantity: 25, discount: 20 }
      ],
      countingMethod: 'ITEM_QUANTITY',
      leaderDiscount: "25.0" 
    };

    // Render the correct card based on the Theme Editor dropdown
    if (previewState === 'SCHEDULED') {
      renderScheduledCampaign(container, dummyCampaign);
    } else if (previewState === 'ENDED') {
      renderEndedCampaign(container, dummyCampaign);
    } else {
      renderActiveCampaign(container, {
        campaign: dummyCampaign,
        currentProgress: 2
      });
    }
    return;
  }

  container.dataset.variantId = simpleVariantId;
  
  const currentWrapper = container.querySelector('.gb-wrapper');
  if (currentWrapper) {
      currentWrapper.style.position = 'relative';
      if (!currentWrapper.querySelector('.gb-loading-overlay')) {
          const overlay = document.createElement('div');
          overlay.className = 'gb-loading-overlay';
          overlay.innerHTML = '<div class="gb-spinner"></div>';
          currentWrapper.appendChild(overlay);
      }
  }
  
  const apiUrl = `/apps/gbs/campaign?productId=${productId}&variantId=${simpleVariantId}&shop=${shop}`;

  fetch(apiUrl)
    .then(response => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('API request failed.');
      return response.json();
    })
    .then(data => {
      if (data && data.campaign) {
        container.dataset.hasAnyCampaign = 'true';
        container.dataset.campaignId = data.campaign.id;
        container.dataset.scope = data.campaign.scope || 'PRODUCT';
        container.dataset.validVariants = data.campaign.selectedVariantIdsJson || '[]';
        container.dataset.sellingPlanId = data.campaign.sellingPlanId || '';

        handleNativeSellingPlanUI();

        performAnimatedSwap(container, () => {
          if (data.campaign.status === 'ACTIVE') {
            renderActiveCampaign(container, data);
            connectToFirebase(container, data.campaign); 
          } else if (data.campaign.status === 'SCHEDULED') {
            renderScheduledCampaign(container, data.campaign);
          } else if (data.campaign.status === 'ENDED') {
            renderEndedCampaign(container, data.campaign);
          }
        });
      } else {
        const isProductLevelCampaign = data && data.productHasCampaign;
        if (container.dataset.hasAnyCampaign === 'true' || isProductLevelCampaign) {
           performAnimatedSwap(container, () => {
               renderNotIncludedCampaign(container);
           });
        } else {
           collapseContainer(container);
        }
      }
    })
    .catch(error => {
      console.log(`Group Buy App: ${error.message}`);
      collapseContainer(container);
    });
}

function renderActiveCampaign(container, data) {
  const { campaign, currentProgress } = data;
  const tiers = campaign.tiers.sort((a, b) => a.quantity - b.quantity);

  const customTitleText = container.dataset.titleText || 'Unlock Group Discounts';
  const badgeFormat = container.dataset.badgeFormat || 'percentage';
  const clockLayout = container.dataset.clockLayout || 'boxes';
  const isClockFullWidth = container.dataset.clockFullWidth === 'true';
  const currencySymbol = container.dataset.currencySymbol || '$';
  const basePrice = parseFloat(container.dataset.productPrice || 0);

  const isQuantity = campaign.countingMethod === 'ITEM_QUANTITY';
  const countLabel = isQuantity ? 'items' : 'people';

  const tierBadgesHTML = tiers.map((tier) => {
    let badgeLabelText = `${tier.discount}% off`;
    if (badgeFormat === 'price' && basePrice > 0) {
      const discountedPrice = basePrice * (1 - (tier.discount / 100));
      badgeLabelText = `${currencySymbol}${discountedPrice.toFixed(2)}`;
    }

    return `
      <div style="background-color: var(--gb-badge-bg, #E1F3FF); color: var(--gb-badge-text, #005bd3); padding: 4px 10px; border-radius: var(--gb-badge-radius, 12px); border: var(--gb-badge-border, none); font-size: var(--gb-badge-size, 12px); font-weight: bold; white-space: nowrap;">
        ${tier.quantity} ${countLabel} ➔ ${badgeLabelText}
      </div>
    `;
  }).join('');

  const maxTier = tiers.length > 0 ? tiers[tiers.length - 1] : null;
  let descriptionTextHTML = '';
  
  if (maxTier) {
    const requirementTerm = isQuantity ? 'items or more are bought' : 'people or more join the group buy';
    descriptionTextHTML = `
      <p style="display: var(--gb-desc-display, block); margin-top: 0; margin-bottom: 15px; font-size: var(--gb-desc-size, 13px); font-weight: var(--gb-desc-weight, 400); font-style: var(--gb-desc-style, normal); color: var(--gb-desc-color, #5c5f62); text-align: var(--gb-title-align, center);">
        When ${maxTier.quantity} ${requirementTerm}, you will get ${maxTier.discount}% off!
      </p>
    `;
  }

  // ✅ NEW: Draw the Gold Leader Banner with Calculated Price!
  let leaderBannerHTML = '';
  if (campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0) {
    const leaderDiscountNum = parseFloat(campaign.leaderDiscount);
    let leaderDisplay = `${leaderDiscountNum}% off`;
    
    // Calculate the final price if we have the base price!
    if (basePrice > 0) {
      const leaderPrice = basePrice * (1 - (leaderDiscountNum / 100));
      leaderDisplay = `${leaderDiscountNum}% off (Only ${currencySymbol}${leaderPrice.toFixed(2)})`;
    }

    leaderBannerHTML = `
      <div style="background-color: var(--gb-leader-bg, #FFFBEB); border: var(--gb-leader-border, 1px solid #FCEB9F); color: var(--gb-leader-text, #8A6D3B); padding: 8px 12px; border-radius: var(--gb-leader-radius, 6px); font-size: 13px; font-weight: bold; margin-bottom: 15px; text-align: center; line-height: 1.4; width: 100%; box-sizing: border-box;">
        👑 Group Leader Bonus:<br>The first buyer gets ${leaderDisplay}!
      </div>
    `;
  }

  container.innerHTML = `
    <div class="progress-bar-container gb-wrapper" style="background: var(--gb-bg-color, #fafafa); padding: 20px; border-radius: var(--gb-box-radius, 8px); border: var(--gb-border, 1px solid #e3e3e3); margin-top: 20px; box-sizing: border-box;">
      
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; width: 100%;">
        <div style="width: 24px;"></div> <h3 style="display: var(--gb-title-display, block); margin:0; font-size: var(--gb-title-size, 16px); font-weight: var(--gb-title-weight, 700); font-style: var(--gb-title-style, normal); text-transform: uppercase; letter-spacing: 0.5px; color: var(--gb-title-color, #202223); text-align: var(--gb-title-align, center); flex: 1;">${customTitleText}</h3>
        ${shareButtonSVG}
      </div>
      
      ${descriptionTextHTML}
      ${leaderBannerHTML}

      <div style="display: var(--gb-badge-display, flex); flex-wrap: wrap; justify-content: center; gap: 8px; margin-bottom: 20px;">
        ${tierBadgesHTML}
      </div>

      <div style="display: flex; justify-content: space-between; margin-bottom: 10px; color: var(--gb-progress-text-color, #202223);">
        <span style="font-size: 14px; font-weight: 600;">Progress</span>
        <span class="gb-progress-text" style="font-size: 14px; font-weight: bold;"></span>
      </div>
      
      <div class="gb-segmented-track" style="display: flex; width: 100%; margin-bottom: 25px;"></div>

      <div class="countdown-container" style="display: flex; flex-direction: column; align-items: center; margin-bottom: 25px;">
        <div style="font-size: 14px; font-weight: 600; color: #202223; margin-bottom: 8px;">Ends in:</div>
        <div class="countdown-timer-wrap" style="width: 100%; display: flex; justify-content: center;">
           <div class="countdown-timer" style="display: flex; align-items: flex-start; justify-content: center; gap: 8px;"></div>
        </div>
      </div>
      
      <div class="gb-quantity-selector" style="margin-bottom: 20px; display: flex; align-items: center; gap: 15px;">
        <span style="font-size: 14px; font-weight: 600; color: #202223;">Quantity</span>
        <div style="display: flex; align-items: center; background: #fff; border: 1px solid #dfe3e8; border-radius: 4px; height: var(--gb-qty-height, 46px); overflow: hidden;">
          <button type="button" class="gb-qty-minus" style="background: transparent; border: none; padding: 0 15px; font-size: 20px; cursor: pointer; color: #5c5f62; height: 100%; outline: none; box-shadow: none;">−</button>
          <input type="text" id="gb-quantity" name="quantity" value="1" readonly style="width: 40px; text-align: center; border: none; background: transparent; font-size: 16px; font-weight: bold; color: #202223; padding: 0; outline: none !important; box-shadow: none !important; -webkit-appearance: none;">
          <button type="button" class="gb-qty-plus" style="background: transparent; border: none; padding: 0 15px; font-size: 20px; cursor: pointer; color: #5c5f62; height: 100%; outline: none; box-shadow: none;">+</button>
        </div>
      </div>
      
      <div class="gb-info-message" style="font-size: 13px; color: #5c5f62; margin-bottom: 15px; line-height: 1.4;"></div> 
      
      <button class="gb-join-button" style="width: 100%; background: var(--gb-btn-bg, #000); color: var(--gb-btn-text-color, #fff); border: none; padding: var(--gb-btn-padding, 14px); font-size: calc(var(--gb-btn-padding, 14px) + 2px); font-weight: bold; border-radius: var(--gb-btn-radius, 4px); cursor: pointer; transition: opacity 0.2s;">
        Loading...
      </button>
    </div>
  `;
  
  const qtyInput = container.querySelector('#gb-quantity');
  const btnMinus = container.querySelector('.gb-qty-minus');
  const btnPlus = container.querySelector('.gb-qty-plus');

  if (qtyInput && btnMinus && btnPlus) {
    btnMinus.addEventListener('click', () => {
      let current = parseInt(qtyInput.value, 10) || 1;
      if (current > 1) qtyInput.value = current - 1;
    });
    btnPlus.addEventListener('click', () => {
      let current = parseInt(qtyInput.value, 10) || 1;
      qtyInput.value = current + 1;
    });
  }

  const countdownTimerEl = container.querySelector('.countdown-timer');
  const endTime = new Date(campaign.endDateTime).getTime();
  let countdownInterval;
  
  const updateTimer = () => {
    const distance = endTime - new Date().getTime();
    if (distance < 0) {
      if (countdownInterval) clearInterval(countdownInterval);
      countdownTimerEl.innerHTML = '<span style="color: #202223; font-weight: bold;">Deal Expired</span>';
      return;
    }
    
    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    const pad = (num) => num.toString().padStart(2, '0');

    let wrapperStyle = "display: flex; flex-direction: column; align-items: center;";
    let blockStyle = "";
    
    const fullWidthCSS = isClockFullWidth ? "width: 100%; box-sizing: border-box;" : "";

    if (clockLayout === 'card') {
      countdownTimerEl.style.cssText = `display: flex; align-items: flex-start; justify-content: center; gap: 8px; background: var(--gb-clock-bg-color, #fff); border: var(--gb-clock-border, 1px solid #dfe3e8); border-radius: var(--gb-clock-radius, 8px); box-shadow: var(--gb-clock-shadow, none); padding: 10px 20px; ${fullWidthCSS}`;
      blockStyle = "background: transparent; color: var(--gb-clock-text-color, #202223); width: var(--gb-clock-size, 48px); height: var(--gb-clock-size, 48px); display: flex; align-items: center; justify-content: center; font-size: calc(var(--gb-clock-size, 48px) * 0.45); font-weight: bold; box-sizing: border-box;";
    } else if (clockLayout === 'box_in_box') {
      countdownTimerEl.style.cssText = `display: flex; align-items: flex-start; justify-content: center; gap: 12px; background: var(--gb-clock-wrapper-bg, #f4f4f4); border: var(--gb-clock-wrapper-border, none); border-radius: var(--gb-clock-wrapper-radius, 8px); box-shadow: var(--gb-clock-shadow, none); padding: 15px 20px; ${fullWidthCSS}`;
      blockStyle = "background: var(--gb-clock-bg-color, #fff); border: var(--gb-clock-border, 1px solid #dfe3e8); color: var(--gb-clock-text-color, #202223); border-radius: var(--gb-clock-radius, 8px); width: var(--gb-clock-size, 48px); height: var(--gb-clock-size, 48px); display: flex; align-items: center; justify-content: center; font-size: calc(var(--gb-clock-size, 48px) * 0.45); font-weight: bold; box-sizing: border-box;";
    } else {
      countdownTimerEl.style.cssText = `display: flex; align-items: flex-start; justify-content: center; gap: 8px; ${fullWidthCSS}`;
      blockStyle = "background: var(--gb-clock-bg-color, #fff); border: var(--gb-clock-border, 1px solid #dfe3e8); color: var(--gb-clock-text-color, #202223); border-radius: var(--gb-clock-radius, 8px); width: var(--gb-clock-size, 48px); height: var(--gb-clock-size, 48px); display: flex; align-items: center; justify-content: center; font-size: calc(var(--gb-clock-size, 48px) * 0.45); font-weight: bold; box-shadow: var(--gb-clock-shadow, none); box-sizing: border-box;";
    }
    
    const labelWrapperStyle = "width: 0px; display: flex; justify-content: center; overflow: visible;";
    const labelStyle = "font-size: 11px; color: #5c5f62; font-weight: 500; margin-top: 6px; white-space: nowrap;";
    const separatorStyle = "font-size: calc(var(--gb-clock-size, 48px) * 0.45); font-weight: bold; color: var(--gb-clock-text-color, #202223); height: var(--gb-clock-size, 48px); display: flex; align-items: center;";

    countdownTimerEl.innerHTML = `
      <div style="${wrapperStyle}">
        <div style="${blockStyle}">${pad(days)}</div>
        <div style="${labelWrapperStyle}"><span style="${labelStyle}">Days</span></div>
      </div>
      <div style="${separatorStyle}">:</div>
      
      <div style="${wrapperStyle}">
        <div style="${blockStyle}">${pad(hours)}</div>
        <div style="${labelWrapperStyle}"><span style="${labelStyle}">Hours</span></div>
      </div>
      <div style="${separatorStyle}">:</div>
      
      <div style="${wrapperStyle}">
        <div style="${blockStyle}">${pad(minutes)}</div>
        <div style="${labelWrapperStyle}"><span style="${labelStyle}">Minutes</span></div>
      </div>
      <div style="${separatorStyle}">:</div>
      
      <div style="${wrapperStyle}">
        <div style="${blockStyle}">${pad(seconds)}</div>
        <div style="${labelWrapperStyle}"><span style="${labelStyle}">Seconds</span></div>
      </div>
    `;
  };

  updateTimer();
  countdownInterval = setInterval(updateTimer, 1000);
  storeTimer(container, countdownInterval);

  updateProgressUI(container, campaign, currentProgress);
  initializeJoinButton(container, campaign); // ✅ Passing the campaign data here!

  setupShareButton(container);
}

function renderScheduledCampaign(container, campaign) {
  const tiers = campaign.tiers ? campaign.tiers.sort((a, b) => a.quantity - b.quantity) : [];
  const maxTier = tiers.length > 0 ? tiers[tiers.length - 1] : null;
  const customTitleText = container.dataset.titleText || 'A Group Buy is starting soon!';
  const clockLayout = container.dataset.clockLayout || 'boxes';
  const isClockFullWidth = container.dataset.clockFullWidth === 'true';
  
  const isQuantity = campaign.countingMethod === 'ITEM_QUANTITY';
  
  let descriptionTextHTML = '';
  if (maxTier) {
    const requirementTerm = isQuantity ? 'items or more are bought' : 'people or more join the group buy';
    descriptionTextHTML = `
      <p style="display: var(--gb-desc-display, block); margin-top: 0; margin-bottom: 15px; font-size: var(--gb-desc-size, 13px); font-weight: var(--gb-desc-weight, 400); font-style: var(--gb-desc-style, normal); color: var(--gb-desc-color, #5c5f62); text-align: var(--gb-title-align, center);">
        When ${maxTier.quantity} ${requirementTerm}, you will get ${maxTier.discount}% off!
      </p>
    `;
  }

  // ✅ NEW: Get Price Variables & Badge Settings
  const currencySymbol = container.dataset.currencySymbol || '$';
  const basePrice = parseFloat(container.dataset.productPrice || 0);
  const badgeFormat = container.dataset.badgeFormat || 'percentage';
  const countLabel = isQuantity ? 'items' : 'people';
  const showScheduledBadges = container.dataset.scheduledBadges === 'true';

  // ✅ NEW: Generate the Badges for Scheduled Campaigns
  let tierBadgesHTML = '';
  if (showScheduledBadges && tiers.length > 0) {
    const badgesString = tiers.map((tier) => {
      let badgeLabelText = `${tier.discount}% off`;
      if (badgeFormat === 'price' && basePrice > 0) {
        const discountedPrice = basePrice * (1 - (tier.discount / 100));
        badgeLabelText = `${currencySymbol}${discountedPrice.toFixed(2)}`;
      }

      return `
        <div style="background-color: var(--gb-badge-bg, #E1F3FF); color: var(--gb-badge-text, #005bd3); padding: 4px 10px; border-radius: var(--gb-badge-radius, 12px); border: var(--gb-badge-border, none); font-size: var(--gb-badge-size, 12px); font-weight: bold; white-space: nowrap;">
          ${tier.quantity} ${countLabel} ➔ ${badgeLabelText}
        </div>
      `;
    }).join('');

    tierBadgesHTML = `
      <div style="display: var(--gb-badge-display, flex); flex-wrap: wrap; justify-content: center; gap: 8px; margin-bottom: 20px;">
        ${badgesString}
      </div>
    `;
  }

  // ✅ NEW: Draw the Gold Leader Banner for Scheduled Campaigns!
  let leaderBannerHTML = '';
  if (campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0) {
    const leaderDiscountNum = parseFloat(campaign.leaderDiscount);
    let leaderDisplay = `${leaderDiscountNum}% off`;
    
    if (basePrice > 0) {
      const leaderPrice = basePrice * (1 - (leaderDiscountNum / 100));
      leaderDisplay = `${leaderDiscountNum}% off (Only ${currencySymbol}${leaderPrice.toFixed(2)})`;
    }

    leaderBannerHTML = `
      <div style="background-color: var(--gb-leader-bg, #FFFBEB); border: var(--gb-leader-border, 1px solid #FCEB9F); color: var(--gb-leader-text, #8A6D3B); padding: 8px 12px; border-radius: var(--gb-leader-radius, 6px); font-size: 13px; font-weight: bold; margin-bottom: 15px; text-align: center; line-height: 1.4; width: 100%; box-sizing: border-box;">
        👑 Group Leader Bonus:<br>The first buyer gets ${leaderDisplay}!
      </div>
    `;
  }

  container.innerHTML = `
    <div class="gb-scheduled-container gb-wrapper" style="background: var(--gb-scheduled-bg, var(--gb-bg-color, #fafafa)); padding: 20px; border-radius: var(--gb-box-radius, 8px); border: var(--gb-scheduled-border, var(--gb-border, 1px solid #e3e3e3)); margin-top: 20px; display: flex; flex-direction: column; align-items: center; text-align: center; box-sizing: border-box;">
      
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; width: 100%;">
        <div style="width: 24px;"></div> <h3 style="display: var(--gb-title-display, block); margin:0; font-size: var(--gb-title-size, 16px); font-weight: var(--gb-title-weight, 700); font-style: var(--gb-title-style, normal); text-transform: uppercase; letter-spacing: 0.5px; color: var(--gb-title-color, #202223); text-align: var(--gb-title-align, center); flex: 1;">🔥 ${customTitleText}</h3>
        ${shareButtonSVG}
      </div>
      
      ${descriptionTextHTML}
      ${tierBadgesHTML} ${leaderBannerHTML} <div style="font-size: 14px; font-weight: 600; color: #5c5f62; margin-top: 15px; margin-bottom: 8px;">Starts in:</div>
      <div class="countdown-timer-wrap" style="width: 100%; display: flex; justify-content: center;">
         <div class="gb-countdown-timer"></div>
      </div>
    </div>
  `;
  
  const countdownTimerEl = container.querySelector('.gb-countdown-timer');
  const startTime = new Date(campaign.startDateTime).getTime();
  let interval;
  
  const updateTimer = () => {
    const distance = startTime - new Date().getTime();
    if (distance < 0) {
      if (interval) clearInterval(interval);
      window.location.reload();
      return;
    }
    
    const d = Math.floor(distance / (1000 * 60 * 60 * 24));
    const h = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const m = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((distance % (1000 * 60)) / 1000);
    
    const pad = (num) => num.toString().padStart(2, '0');

    let wrapperStyle = "display: flex; flex-direction: column; align-items: center;";
    let blockStyle = "";
    
    const fullWidthCSS = isClockFullWidth ? "width: 100%; box-sizing: border-box;" : "";

    if (clockLayout === 'card') {
      countdownTimerEl.style.cssText = `display: flex; align-items: flex-start; justify-content: center; gap: 8px; background: var(--gb-clock-bg-color, #fff); border: var(--gb-clock-border, 1px solid #dfe3e8); border-radius: var(--gb-clock-radius, 8px); box-shadow: var(--gb-clock-shadow, none); padding: 10px 20px; ${fullWidthCSS}`;
      blockStyle = "background: transparent; color: var(--gb-clock-text-color, #202223); width: var(--gb-clock-size, 48px); height: var(--gb-clock-size, 48px); display: flex; align-items: center; justify-content: center; font-size: calc(var(--gb-clock-size, 48px) * 0.45); font-weight: bold; box-sizing: border-box;";
    } else if (clockLayout === 'box_in_box') {
      countdownTimerEl.style.cssText = `display: flex; align-items: flex-start; justify-content: center; gap: 12px; background: var(--gb-clock-wrapper-bg, #f4f4f4); border: var(--gb-clock-wrapper-border, none); border-radius: var(--gb-clock-wrapper-radius, 8px); box-shadow: var(--gb-clock-shadow, none); padding: 15px 20px; ${fullWidthCSS}`;
      blockStyle = "background: var(--gb-clock-bg-color, #fff); border: var(--gb-clock-border, 1px solid #dfe3e8); color: var(--gb-clock-text-color, #202223); border-radius: var(--gb-clock-radius, 8px); width: var(--gb-clock-size, 48px); height: var(--gb-clock-size, 48px); display: flex; align-items: center; justify-content: center; font-size: calc(var(--gb-clock-size, 48px) * 0.45); font-weight: bold; box-sizing: border-box;";
    } else {
      countdownTimerEl.style.cssText = `display: flex; align-items: flex-start; justify-content: center; gap: 8px; ${fullWidthCSS}`;
      blockStyle = "background: var(--gb-clock-bg-color, #fff); border: var(--gb-clock-border, 1px solid #dfe3e8); color: var(--gb-clock-text-color, #202223); border-radius: var(--gb-clock-radius, 8px); width: var(--gb-clock-size, 48px); height: var(--gb-clock-size, 48px); display: flex; align-items: center; justify-content: center; font-size: calc(var(--gb-clock-size, 48px) * 0.45); font-weight: bold; box-shadow: var(--gb-clock-shadow, none); box-sizing: border-box;";
    }
    
    const labelWrapperStyle = "width: 0px; display: flex; justify-content: center; overflow: visible;";
    const labelStyle = "font-size: 11px; color: #5c5f62; font-weight: 500; margin-top: 6px; white-space: nowrap;";
    const separatorStyle = "font-size: calc(var(--gb-clock-size, 48px) * 0.45); font-weight: bold; color: var(--gb-clock-text-color, #202223); height: var(--gb-clock-size, 48px); display: flex; align-items: center;";

    countdownTimerEl.innerHTML = `
      <div style="${wrapperStyle}">
        <div style="${blockStyle}">${pad(d)}</div>
        <div style="${labelWrapperStyle}"><span style="${labelStyle}">Days</span></div>
      </div>
      <div style="${separatorStyle}">:</div>
      
      <div style="${wrapperStyle}">
        <div style="${blockStyle}">${pad(h)}</div>
        <div style="${labelWrapperStyle}"><span style="${labelStyle}">Hours</span></div>
      </div>
      <div style="${separatorStyle}">:</div>
      
      <div style="${wrapperStyle}">
        <div style="${blockStyle}">${pad(m)}</div>
        <div style="${labelWrapperStyle}"><span style="${labelStyle}">Minutes</span></div>
      </div>
      <div style="${separatorStyle}">:</div>
      
      <div style="${wrapperStyle}">
        <div style="${blockStyle}">${pad(s)}</div>
        <div style="${labelWrapperStyle}"><span style="${labelStyle}">Seconds</span></div>
      </div>
    `;
  };

  updateTimer();
  interval = setInterval(updateTimer, 1000);
  storeTimer(container, interval);

  // ✅ NEW: Initialize the share button for Scheduled Campaigns!
  setupShareButton(container);
}

function renderEndedCampaign(container, campaign) {
  const customTitleText = container.dataset.titleText || 'Group Buy Ended';
  
  container.innerHTML = `
    <div class="gb-ended-container gb-wrapper" style="background: var(--gb-scheduled-bg, var(--gb-bg-color, #fafafa)); padding: 20px; border-radius: var(--gb-box-radius, 8px); border: var(--gb-scheduled-border, var(--gb-border, 1px solid #e3e3e3)); margin-top: 20px; box-sizing: border-box; text-align: center; display: flex; flex-direction: column; align-items: center;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; width: 100%;">
        <div style="width: 24px;"></div> <h3 style="display: var(--gb-title-display, block); margin:0; font-size: var(--gb-title-size, 16px); font-weight: var(--gb-title-weight, 700); font-style: var(--gb-title-style, normal); text-transform: uppercase; letter-spacing: 0.5px; color: var(--gb-title-color, #202223); text-align: var(--gb-title-align, center); flex: 1;">
          
          <span style="display: inline-flex; align-items: center; justify-content: center; gap: 8px;">
            <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="21 8 21 21 3 21 3 8"></polyline>
              <rect x="1" y="3" width="22" height="5"></rect>
              <line x1="10" y1="12" x2="14" y2="12"></line>
            </svg>
            ${customTitleText}
          </span>
          
        </h3>
        ${shareButtonSVG}
      </div>
      <p style="margin-top: 10px; margin-bottom: 0; font-size: var(--gb-desc-size, 13px); color: var(--gb-desc-color, #5c5f62);">This group buy has officially ended. Stay tuned for the next one!</p>
    </div>
  `;
  setupShareButton(container);
}

function initializeJoinButton(container, campaign) { 
  const joinButton = container.querySelector('.gb-join-button');
  const infoMessageEl = container.querySelector('.gb-info-message'); // Moved up so the Editor can use it!
  if (!joinButton) return;

  if (window.Shopify && window.Shopify.designMode) {
    // ✅ NEW: Simulate the Leader Crown in the Theme Editor!
    if (campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0) {
      const lDisc = parseFloat(campaign.leaderDiscount);
      const pPrice = parseFloat(container.dataset.productPrice || 0);
      const cSym = container.dataset.currencySymbol || '$';
      
      let securedText = `${lDisc}% off`;
      if (pPrice > 0) {
        const finalLockedPrice = pPrice * (1 - (lDisc / 100));
        securedText = `${lDisc}% off (${cSym}${finalLockedPrice.toFixed(2)})`;
      }
      
      let leaderText = `<div style="background-color: var(--gb-leader-msg-bg, transparent); color: var(--gb-leader-msg-color, #D48806); font-size: var(--gb-leader-msg-size, 13px); font-style: var(--gb-leader-msg-style, normal); font-weight: bold; border: var(--gb-leader-msg-border, none); padding: var(--gb-leader-msg-padding, 0 0 8px 0); border-radius: var(--gb-leader-msg-radius, 6px); margin-bottom: 10px;">👑 You are the Group Leader! ${securedText} secured.</div>`;
      
      if (infoMessageEl) {
        infoMessageEl.innerHTML = leaderText + "Welcome back! Every item you buy helps reach the goal.<br><span style='font-size: 11px; opacity: 0.7; display: block; margin-top: 4px;'>*Note: The progress bar may take a minute to fully sync with our servers.</span>";
      }
      joinButton.textContent = 'Buy Again';
    } else {
      if (infoMessageEl) infoMessageEl.innerHTML = '';
      joinButton.textContent = 'Join Group Buy';
    }
    return;
  }

  const isLoggedIn = container.dataset.isLoggedIn === 'true';
  const productId = container.dataset.productId;
  const customerId = container.dataset.customerId;

  const setupButton = (text) => {
    const newJoinButton = joinButton.cloneNode(true);
    newJoinButton.textContent = text;
    joinButton.parentNode.replaceChild(newJoinButton, joinButton);

    newJoinButton.addEventListener('click', () => {
      newJoinButton.textContent = 'Adding to Cart...';
      newJoinButton.disabled = true;
      const quantityInput = container.querySelector('#gb-quantity');
      const quantity = quantityInput ? parseInt(quantityInput.value, 10) : 1;
      
      const currentVariantId = container.dataset.variantId.split('/').pop(); 
      const sellingPlanId = container.dataset.sellingPlanId; 

      if (!sellingPlanId) {
        newJoinButton.textContent = 'Error: No Selling Plan Found';
        newJoinButton.disabled = false;
        return;
      }

      let formData = {
        'items': [{
          'id': currentVariantId,
          'quantity': quantity,
          'selling_plan': sellingPlanId.split('/').pop(),
          'properties': {
            '_groupbuy_campaign_id': container.dataset.campaignId
          }
        }]
      };

      fetch(window.Shopify.routes.root + 'cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      .then(res => {
        if (!res.ok) throw new Error('Could not add to cart');
        return res.json();
      })
      .then(() => window.location.href = '/checkout')
      .catch(err => {
        newJoinButton.textContent = 'Error Adding to Cart'; 
        newJoinButton.disabled = false;
      });
    });
  };

  if (isLoggedIn) {
    fetch(`/apps/gbs/check-status?productId=${productId}&customerId=${customerId}`)
      .then(res => res.json())
      .then(statusData => {
        
        // ✅ THE FIX: We found the pendingContribution! Instantly push the bar forward!
        if (statusData.pendingContribution > 0) {
          container.dataset.pendingContribution = statusData.pendingContribution;
          const currentRaw = Number(container.dataset.rawProgress) || (Number(campaign.startingParticipants) || 0);
          
          // Make sure we target the correct inner wrapper to draw the UI!
          const targetContainer = container.classList.contains('progress-bar-container') ? container : container.querySelector('.progress-bar-container');
          if (targetContainer) {
            updateProgressUI(targetContainer, campaign, currentRaw + statusData.pendingContribution);
          }
        }

        let leaderText = "";
          if (statusData.isLeader && campaign.leaderDiscount && parseFloat(campaign.leaderDiscount) > 0) {
            const lDisc = parseFloat(campaign.leaderDiscount);
            const pPrice = parseFloat(container.dataset.productPrice || 0);
            const cSym = container.dataset.currencySymbol || '$';
            
            let securedText = `${lDisc}% off`;
            if (pPrice > 0) {
              const finalLockedPrice = pPrice * (1 - (lDisc / 100));
              securedText = `${lDisc}% off (${cSym}${finalLockedPrice.toFixed(2)})`;
            }
            
            leaderText = `<div style="background-color: var(--gb-leader-msg-bg, transparent); color: var(--gb-leader-msg-color, #D48806); font-size: var(--gb-leader-msg-size, 13px); font-style: var(--gb-leader-msg-style, normal); font-weight: bold; border: var(--gb-leader-msg-border, none); padding: var(--gb-leader-msg-padding, 0 0 8px 0); border-radius: 6px; margin-bottom: 10px;">👑 You are the Group Leader! ${securedText} secured.</div>`;
          }

        // ✅ We add `leaderText + ` to the front of the messages!
        if (statusData.hasJoined && statusData.countingMethod === 'PARTICIPANT') {
          if (infoMessageEl) infoMessageEl.innerHTML = leaderText + "You've already joined this group buy! Your new purchase will get the discount, but won't count as a new participant.<br><span style='font-size: 11px; opacity: 0.7; display: block; margin-top: 4px;'>*Note: The progress bar may take a minute to fully sync with our servers.</span>";
          setupButton('Buy Another');
        } else if (statusData.hasJoined && statusData.countingMethod === 'ITEM_QUANTITY') {
          if (infoMessageEl) infoMessageEl.innerHTML = leaderText + "Welcome back! Every item you buy helps reach the goal.<br><span style='font-size: 11px; opacity: 0.7; display: block; margin-top: 4px;'>*Note: The progress bar may take a minute to fully sync with our servers.</span>";
          setupButton('Buy Again');
        } else {
          if (infoMessageEl) infoMessageEl.innerHTML = '';
          setupButton('Join Group Buy');
        }
      })
      .catch(() => setupButton('Join Group Buy'));
  } else {
    const newJoinButton = joinButton.cloneNode(true);
    newJoinButton.textContent = 'Login or Create Account to Join';
    joinButton.parentNode.replaceChild(newJoinButton, joinButton);
    newJoinButton.addEventListener('click', () => {
      window.location.href = container.dataset.loginUrl;
    });
  }
}

class GroupBuyWidget extends HTMLElement {
  connectedCallback() {
    const initialVariantId = this.dataset.variantId;
    if (initialVariantId) {
      const simpleVariantId = initialVariantId.split('/').pop();
      this.dataset.variantId = simpleVariantId;
      fetchAndRenderCampaign(this, simpleVariantId);
    }
  }
}

if (!customElements.get('group-buy-widget')) {
  customElements.define('group-buy-widget', GroupBuyWidget);
}

function attachGlobalListeners() {
  document.addEventListener('variant:change', (event) => {
    try {
      const variant = event.detail.variant;
      const productForm = event.target.closest('form[action*="/cart/add"]');
      if (!productForm) return;
      const container = productForm.closest('.shopify-section')?.querySelector('.gb-widget');
      if (!container) return;
      
      const now = Date.now();
      if (now - lastEventTime < debounceTime) return;
      lastEventTime = now;

      clearConnections(container);
      if (!variant) {
        container.innerHTML = '';
        return;
      }
      
      const simpleVariantId = variant.id.toString().split('/').pop();
      fetchAndRenderCampaign(container, simpleVariantId);
    } catch (e) {}
  });

  document.addEventListener('change', (event) => {
    try {
      const target = event.target;
      const newVariantId = target.dataset.variantId || (target.name === 'id' ? target.value : null);
      if (!newVariantId) return;
      
      const container = target.closest('.shopify-section')?.querySelector('.gb-widget');
      if (!container) return;
      
      const now = Date.now();
      if (now - lastEventTime < debounceTime) return;
      lastEventTime = now;

      clearConnections(container);
      const simpleVariantId = newVariantId.toString().split('/').pop();
      fetchAndRenderCampaign(container, simpleVariantId);
    } catch (e) {}
  });
}

let lastEventTime = 0;
const debounceTime = 100;
attachGlobalListeners();