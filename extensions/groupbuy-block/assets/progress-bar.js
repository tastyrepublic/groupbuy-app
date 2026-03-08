import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

let firestoreUnsubscribe = null;

const activeConnections = {};

function clearConnections(container) {
  const timerIdKey = container?.dataset.productId;
  if (!timerIdKey) return;
  if (activeConnections[timerIdKey]?.timers) {
    activeConnections[timerIdKey].timers.forEach(clearInterval);
  }
  // 🔥 FIREBASE UPDATE: Call the unsubscribe function instead of socket disconnect
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

// 🔥 FIREBASE UPDATE: Replace storeSocket with storeUnsubscribe
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
  
  // 1. Initialize Firebase (only once globally)
  if (!window.firebaseApp) {
    window.firebaseApp = initializeApp({ projectId: projectId });
    window.firebaseDb = getFirestore(window.firebaseApp);
  }
  
  const db = window.firebaseDb;

  // 2. Determine which document to listen to
  const simpleVariantId = productVariantId.split('/').pop();
  let docId = `campaign_${campaignId}`;
  if (campaignData.scope === 'VARIANT') {
     docId = `campaign_${campaignId}_variant_${simpleVariantId}`;
  }

  // 3. Listen for real-time updates!
  const docRef = doc(db, "campaignProgress", docId);
  const unsubscribe = onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      
      // ✅ NEW: Add the starting participants to the raw Firestore delta
      const rawFirestoreProgress = data.progress || 0;
      const startingParticipants = Number(campaignData.startingParticipants) || 0;
      const totalDisplayProgress = rawFirestoreProgress + startingParticipants;
      
      console.log(`🔥 Firebase Raw: ${rawFirestoreProgress} | Total Displayed: ${totalDisplayProgress}`);
      
      const progressBarContainer = container.querySelector('.progress-bar-container');
      if (progressBarContainer) {
        // Pass the calculated total instead of just the raw data
        updateProgressUI(progressBarContainer, campaignData, totalDisplayProgress);
      }
    }
  });

  // 4. Store the unsubscribe function so we can clean it up when the variant changes
  storeUnsubscribe(container, unsubscribe);
}

// --- UI Update Functions ---
function updateProgressUI(container, campaignData, newProgress) {
  // ... (this function is unchanged)
  if (!container) return;
  const textContainerElement = container.querySelector('.progress-bar-text');
  const segments = container.querySelectorAll('.bar-segment-fill');
  if (!textContainerElement || !segments) return;

  const tiers = campaignData.tiers.sort((a, b) => a.quantity - b.quantity);
  const finalGoal = tiers.length > 0 ? tiers[tiers.length - 1].quantity : 0;
  const isQuantityCounting = campaignData.countingMethod === 'ITEM_QUANTITY';
  const progressTextLabel = isQuantityCounting ? 'Items Sold' : 'Participants';

  textContainerElement.textContent = `${newProgress} / ${finalGoal} ${progressTextLabel}`;

  let previousTierGoal = 0;
  tiers.forEach((tier, index) => {
    const segment = segments[index];
    if (!segment) return;
    const currentTierGoal = tier.quantity;
    let fillPercent = 0;
    if (newProgress >= currentTierGoal) fillPercent = 100;
    else if (newProgress > previousTierGoal) {
      const progressInTier = newProgress - previousTierGoal;
      const tierRange = currentTierGoal - previousTierGoal;
      fillPercent = (tierRange > 0) ? (progressInTier / tierRange) * 100 : 0;
    }
    segment.style.transition = 'width 0.5s ease-in-out';
    segment.style.width = fillPercent + '%';
    previousTierGoal = currentTierGoal;
  });
}

/**
 * Fetches campaign data for a specific variant and renders the correct widget.
 */
function fetchAndRenderCampaign(container, variantId) {
  const productId = container.dataset.productId;
  const shop = container.dataset.shop;
  clearConnections(container); 
  
  const simpleVariantId = variantId.toString().split('/').pop();

  if (!productId || !simpleVariantId || !shop) {
    container.innerHTML = ''; return;
  }
  
  container.dataset.variantId = simpleVariantId;
  container.innerHTML = `<div class="gb-loading-container"><p>Loading Group Buy Deal...</p></div>`;
  const loadingContainer = container.querySelector('.gb-loading-container');
  const apiUrl = `/apps/gbs/campaign?productId=${productId}&variantId=${simpleVariantId}&shop=${shop}`;

  fetch(apiUrl)
    .then(response => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('API request failed.');
      return response.json();
    })
    .then(data => {
      if (loadingContainer) loadingContainer.classList.add('gb-fade-out');
      
      setTimeout(() => {
        if (data && data.campaign) {
          // A campaign was found! Set it up:
          container.dataset.campaignId = data.campaign.id;
          container.dataset.scope = data.campaign.scope || 'PRODUCT';
          container.dataset.validVariants = data.campaign.selectedVariantIdsJson || '[]';

          if (data.campaign.status === 'ACTIVE') {
            renderActiveCampaign(container, data);
            connectToFirebase(container, data.campaign);
          } else if (data.campaign.status === 'SCHEDULED') {
            renderScheduledCampaign(container, data.campaign);
          }
        } else {
          // NO CAMPAIGN FOUND: Log the helpful message from the backend!
          if (data && data.message) {
             console.log(`🛍️ Group Buy Widget: ${data.message}`);
          }
          // Smoothly erase the widget
          container.innerHTML = ''; 
        }
      }, 300);
    })
    .catch(error => {
      console.log(`Group Buy App: ${error.message}`);
      if (loadingContainer) loadingContainer.classList.add('gb-fade-out');
      setTimeout(() => container.innerHTML = '', 300);
    });
}


let lastEventTime = 0;
const debounceTime = 100;

function onVariantSelected(widgetContainer, newVariantId) {
  const now = Date.now();
  if (now - lastEventTime < debounceTime) return;
  lastEventTime = now;
  
  if (!widgetContainer) return;

  if (!newVariantId) {
    clearConnections(widgetContainer);
    widgetContainer.innerHTML = '';
    return;
  }
  
  const simpleVariantId = newVariantId.toString().split('/').pop();
  
  fetchAndRenderCampaign(widgetContainer, simpleVariantId);
}

function attachGlobalListeners() {
  document.addEventListener('variant:change', (event) => {
    try {
      const variant = event.detail.variant;
      const productForm = event.target.closest('form[action*="/cart/add"]');
      if (!productForm) return;
      const productSection = productForm.closest('.shopify-section');
      if (!productSection) return;
      const container = productSection.querySelector('.gb-widget');
      onVariantSelected(container, variant ? variant.id : null);
    } catch (e) { console.log('Group Buy: Error in "variant:change" listener.', e); }
  });

  document.addEventListener('change', (event) => {
    try {
      const target = event.target;
      const newVariantId = target.dataset.variantId || (target.name === 'id' ? target.value : null);
      if (!newVariantId) return;
      const productSection = target.closest('.shopify-section');
      if (!productSection) return;
      const container = productSection.querySelector('.gb-widget');
      onVariantSelected(container, newVariantId);
    } catch (e) { console.log('Group Buy: Error in "change" listener.', e); }
  });
  
  setTimeout(() => {
    try {
      if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined' && PUB_SUB_EVENTS.variantChange) {
        subscribe(PUB_SUB_EVENTS.variantChange, (eventData) => {
          if (eventData && eventData.data && eventData.data.variant) {
            const variant = eventData.data.variant;
            const productId = variant.product_id ? variant.product_id.toString() : null;
            if (!productId) return;
            const container = document.querySelector(`.gb-widget[data-product-id="${productId}"]`);
            onVariantSelected(container, variant.id);
          }
        });
      }
    } catch (e) { console.log('Group Buy: Error trying to use "subscribe":', e.message); }
  }, 500);

  document.addEventListener('DOMContentLoaded', initializeAllWidgets);
  document.addEventListener('shopify:section:load', initializeAllWidgets);
}


function initializeGroupBuyWidget(container) {
  const initialVariantId = container.dataset.variantId;
  if (initialVariantId) {
    const simpleVariantId = initialVariantId.split('/').pop();
    container.dataset.variantId = simpleVariantId;
    fetchAndRenderCampaign(container, simpleVariantId);
  }
}

function initializeAllWidgets() {
  const containers = document.querySelectorAll('.gb-widget');
  containers.forEach(initializeGroupBuyWidget);
}

attachGlobalListeners();

function renderActiveCampaign(container, data) {
  const { campaign, currentProgress } = data;
  const quantitySelectorHTML = `
  <div class="gb-quantity-selector">
    <label for="gb-quantity">Qty:</label>
    <input type="number" id="gb-quantity" name="quantity" min="1" value="1">
  </div>
`;
  container.innerHTML = `
    <div class="progress-bar-container" data-progress="${currentProgress}">
      <div class="progress-bar-top-labels"></div>
      <div class="progress-bar-track"></div>
      <div class="progress-bar-text"></div>
      <div class="countdown-container" style="margin: 10px 0;">
        Deal ends in: <span class="countdown-timer"></span>
      </div>
      ${quantitySelectorHTML}
      <div class="gb-info-message"></div> 
      <button class="gb-join-button">Loading...</button>
    </div>
  `;
  runProgressBarLogic(container.querySelector('.progress-bar-container'), campaign, currentProgress);
  initializeJoinButton(container);
}

function renderScheduledCampaign(container, campaign) {
  container.innerHTML = `
    <div class="gb-scheduled-container">
      <h3>🔥 A Group Buy is starting soon!</h3>
      <p>Starts in: <span class="gb-countdown-timer"></span></p>
      <button class="gb-notify-button" title="Get Notified">
        <svg viewBox="0 0 20 20" class="gb-notify-icon" focusable="false" aria-hidden="true">
          <path d="M10 19a2 2 0 0 1-2-2h4a2 2 0 0 1-2 2zm6-6v-4c0-3.31-2.69-6-6-6s-6 2.69-6 6v4l-2 2v1h16v-1l-2-2z"></path>
        </svg>
      </button>
    </div>
  `;
  const countdownTimerEl = container.querySelector('.gb-countdown-timer');
  const startTime = new Date(campaign.startDateTime).getTime();
  const interval = setInterval(() => {
    const now = new Date().getTime();
    const distance = startTime - now;
    if (distance < 0) {
      clearInterval(interval);
      window.location.reload();
      return;
    }
    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);
    countdownTimerEl.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }, 1000);
  storeTimer(container, interval);
}

function runProgressBarLogic(container, campaignData, currentProgress) {
  const tiers = campaignData.tiers.sort((a, b) => a.quantity - b.quantity);
  if (tiers.length === 0) return;
  const animationDuration = 450;
  const trackElement = container.querySelector('.progress-bar-track');
  const labelsElement = container.querySelector('.progress-bar-top-labels');
  const textContainerElement = container.querySelector('.progress-bar-text');
  const countdownTimerEl = container.querySelector('.countdown-timer');
  if (!trackElement || !labelsElement || !textContainerElement || !countdownTimerEl) return;
  trackElement.innerHTML = '';
  labelsElement.innerHTML = '';
  tiers.forEach(tier => {
    const labelDiv = document.createElement('div');
    labelDiv.className = 'label';
    labelDiv.textContent = `${tier.discount}% off`;
    labelsElement.appendChild(labelDiv);
    const segmentDiv = document.createElement('div');
    segmentDiv.className = 'bar-segment';
    const fillDiv = document.createElement('div');
    fillDiv.className = 'bar-segment-fill';
    segmentDiv.appendChild(fillDiv);
    trackElement.appendChild(segmentDiv);
  });
  
  updateProgressUI(container, campaignData, currentProgress);

  const endTime = new Date(campaignData.endDateTime).getTime();
  const countdownInterval = setInterval(() => {
    const now = new Date().getTime();
    const distance = endTime - now;
    if (distance < 0) {
      clearInterval(countdownInterval);
      countdownTimerEl.textContent = 'Deal Expired';
      clearConnections(container.closest('.gb-widget'));
      return;
    }
    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);
    countdownTimerEl.textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }, 1000);
  storeTimer(container.closest('.gb-widget'), countdownInterval);
}

function initializeJoinButton(container) {
  const joinButton = container.querySelector('.gb-join-button');
  if (!joinButton) return;

  const isLoggedIn = container.dataset.isLoggedIn === 'true';
  const shop = container.dataset.shop;
  const productId = container.dataset.productId;
  const customerId = container.dataset.customerId;
  const infoMessageEl = container.querySelector('.gb-info-message');

  const setupButton = (text) => {
    const newJoinButton = joinButton.cloneNode(true);
    newJoinButton.textContent = text; 
    joinButton.parentNode.replaceChild(newJoinButton, joinButton);

    newJoinButton.addEventListener('click', () => {
      newJoinButton.textContent = 'Creating Checkout...';
      newJoinButton.disabled = true;
      const quantityInput = container.querySelector('#gb-quantity');
      const quantity = quantityInput ? parseInt(quantityInput.value, 10) : 1;
      const currentVariantId = container.dataset.variantId; 

      fetch('/apps/gbs/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            variantId: currentVariantId, 
            shop, 
            productId, 
            quantity, 
            customerId
            // ✅ REMOVED: groupBuyFilterEnabled (The backend handles the Selling Plan natively now!)
        }), 
      })
      .then(response => {
        if (!response.ok) {
          return response.json().then(err => { throw new Error(err.error || 'API Error') });
        }
        return response.json();
      })
      .then(data => {
        if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
        } else {
          throw new Error('Checkout URL not found.');
        }
      })
      .catch(error => {
        console.error("Group Buy Error:", error.message);
        newJoinButton.textContent = error.message; 
        newJoinButton.disabled = false;
      });
    });
  };

  if (isLoggedIn) {
    const checkStatusUrl = `/apps/gbs/check-status?productId=${productId}&customerId=${customerId}`;
    
    fetch(checkStatusUrl)
      .then(res => res.json())
      .then(statusData => {
        
        if (statusData.hasJoined && statusData.countingMethod === 'PARTICIPANT') {
          if (infoMessageEl) {
            infoMessageEl.textContent = "You've already joined this group buy! Your new purchase will get the discount, but won't count as a new participant.";
          }
          setupButton('Buy Another');
        
        } else if (statusData.hasJoined && statusData.countingMethod === 'ITEM_QUANTITY') {
          if (infoMessageEl) {
            infoMessageEl.textContent = "Welcome back! Every item you buy helps reach the goal.";
          }
          setupButton('Buy Again');

        } else {
          if (infoMessageEl) {
            infoMessageEl.textContent = '';
          }
          setupButton('Join Group Buy');
        }
      })
      .catch(err => {
        console.error("Could not check participant status:", err);
        setupButton('Join Group Buy');
      });
    
  } else {
    const newJoinButton = joinButton.cloneNode(true);
    newJoinButton.textContent = 'Login or Create Account to Join';
    joinButton.parentNode.replaceChild(newJoinButton, joinButton);
    
    newJoinButton.addEventListener('click', () => {
      const loginUrl = container.dataset.loginUrl;
      window.location.href = loginUrl;
    });
  }
}