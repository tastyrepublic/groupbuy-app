export const SUPPORTED_LANGUAGES = [
  { code: "EN", label: "English" },
  { code: "ZH-TW", label: "繁體中文" }
];

export const EMAIL_LOCALE_DICT = {
  "EN": {
    header: "Group Buy Update", 
    summary: "Order Summary", 
    product: "Premium Wireless Headphones",
    variant: "Variant: Midnight Black", 
    qtyLabel: "Qty: ", 
    qtySuffix: "", 
    qtyUi: "Qty: 2", 
    ref: "Order Reference:", 
    thanks: "Thank you for shopping with us!",
    breakTitle: "💡 How your discount was calculated:",
    breakDesc: (maxQty, leaderPct, standardPct) => `As the Group Buy Leader, your first <b>${maxQty}</b> items received your <b>${leaderPct}% Leader Discount</b>! Your remaining items received the unlocked standard discount of <b>${standardPct}%</b>. These discounts have been combined into your final overall order discount.`
  },
  "ZH-TW": {
    header: "團購更新", 
    summary: "訂單摘要", 
    product: "頂級無線降噪耳機",
    variant: "規格: 午夜黑", 
    qtyLabel: "數量: ", 
    qtySuffix: " 件", 
    qtyUi: "數量: 2 件", 
    ref: "訂單編號：", 
    thanks: "感謝您的購買！",
    breakTitle: "💡 您的折扣計算說明：",
    breakDesc: (maxQty, leaderPct, standardPct) => `身為團購發起人，您的前 <b>${maxQty}</b> 件商品享有 <b>${leaderPct}%</b> 的專屬折扣！其餘商品則適用已解鎖的標準折扣 <b>${standardPct}%</b>。這些折扣已合併計算為您的最終訂單總折扣。`
  }
};

// ✨ NEW: The Single Source of Truth for Default Templates!
export const DEFAULT_EMAIL_TEMPLATES = {
  successSubject: { 
    "EN": "Great news! Your Group Buy succeeded 🎉", 
    "ZH-TW": "好消息！您的團購已成功 🎉" 
  },
  successBody: { 
    "EN": "Your group buy reached its goal! Your payment will be captured shortly, and your order is currently being processed for shipping.", 
    "ZH-TW": "您的團購已達標！我們即將為您進行扣款，訂單目前正在處理中，商品到貨後將為您出貨。" 
  },
  failedSubject: { 
    "EN": "Update on your Group Buy", 
    "ZH-TW": "關於您的團購更新" 
  },
  failedBody: { 
    "EN": "Unfortunately, the group buy did not reach its goal this time. We have canceled your order and voided the payment authorization. No funds were captured.", 
    "ZH-TW": "很遺憾，本次團購未達目標。我們已取消您的訂單，並取消了您的信用卡授權，不會向您收取任何費用。" 
  }
};