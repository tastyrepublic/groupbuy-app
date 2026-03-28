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
    qtySuffix: "", // ✨ Added for English
    qtyUi: "Qty: 2", 
    ref: "Order Reference:", 
    thanks: "Thank you for shopping with us!",
    breakTitle: "💡 How your discount was calculated:",
    // ✨ THIS IS THE MISSING FUNCTION!
    breakDesc: (maxQty, leaderPct, standardPct) => `As the Group Buy Leader, your first <b>${maxQty}</b> items received your <b>${leaderPct}% Leader Discount</b>! Your remaining items received the unlocked standard discount of <b>${standardPct}%</b>. These discounts have been combined into your final overall order discount.`
  },
  "ZH-TW": {
    header: "團購更新", 
    summary: "訂單摘要", 
    product: "頂級無線降噪耳機",
    variant: "規格: 午夜黑", 
    qtyLabel: "數量: ", 
    qtySuffix: " 件", // ✨ Added for Chinese
    qtyUi: "數量: 2 件", 
    ref: "訂單編號：", 
    thanks: "感謝您的購買！",
    breakTitle: "💡 您的折扣計算說明：",
    // ✨ THIS IS THE MISSING FUNCTION!
    breakDesc: (maxQty, leaderPct, standardPct) => `身為團購發起人，您的前 <b>${maxQty}</b> 件商品享有 <b>${leaderPct}%</b> 的專屬折扣！其餘商品則適用已解鎖的標準折扣 <b>${standardPct}%</b>。這些折扣已合併計算為您的最終訂單總折扣。`
  }
};