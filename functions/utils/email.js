const { prisma, resend } = require("../config/init");
const { shopifyGraphQL } = require("./shopify");

const EMAIL_LOCALE_DICT = {
  "EN": {
    header: "Group Buy Update", 
    summary: "Order Summary", 
    variant: "Variant: ", 
    qty: "Qty: ", 
    ref: "Order Reference:", 
    thanks: "Thank you for shopping with us!",
    breakTitle: "💡 How your discount was calculated:",
    breakDesc: (maxQty, leaderPct, standardPct) => `As the Group Buy Leader, your first <b>${maxQty}</b> items received your <b>${leaderPct}% Leader Discount</b>! Your remaining items received the unlocked standard discount of <b>${standardPct}%</b>. These discounts have been combined into your final overall order discount.`
  },
  "ZH-TW": {
    header: "團購更新", 
    summary: "訂單摘要", 
    variant: "規格: ", 
    qty: "數量: ", 
    ref: "訂單編號：", 
    thanks: "感謝您的購買！",
    breakTitle: "💡 您的折扣計算說明：",
    breakDesc: (maxQty, leaderPct, standardPct) => `身為團購發起人，您的前 <b>${maxQty}</b> 件商品享有 <b>${leaderPct}%</b> 的專屬折扣！其餘商品則適用已解鎖的標準折扣 <b>${standardPct}%</b>。這些折扣已合併計算為您的最終訂單總折扣。`
  }
};

async function dispatchGroupBuyEmail(participant, shop, campaign, type, blendedContext = null) {
  try {
    const settings = await prisma.settings.findUnique({ where: { shop } });
    if (!settings) return;

    if (type === "SUCCESS" && !settings.sendSuccessEmail) return;
    if (type === "FAILED" && !settings.sendFailedEmail) return;

    const session = await prisma.session.findFirst({ where: { shop: shop, isOnline: false } });
    
    const orderQuery = await shopifyGraphQL(shop, session.accessToken, 
      `query getCustomerData($id: ID!) { 
        order(id: $id) { 
          name
          statusPageUrl
          email 
          customer { email locale } 
          lineItems(first: 10) {
            nodes {
              title
              variantTitle
              quantity
              variant { id }
              image { url }
            }
          }
        } 
        shop { name }
      }`,
      { id: participant.orderId }
    );
    
    const customerEmail = orderQuery.data?.order?.email || orderQuery.data?.order?.customer?.email;
    const shopName = orderQuery.data?.shop?.name || "Group Buy Updates";
    
    const orderName = orderQuery.data?.order?.name || `#${participant.orderId.split('/').pop()}`;
    const statusPageUrl = orderQuery.data?.order?.statusPageUrl || `https://${shop}/account/orders`;

    const rawLocale = orderQuery.data?.order?.customer?.locale || "en";
    const locale = rawLocale.toUpperCase().replace('_', '-'); 

    if (!customerEmail) return;

    const lineItems = orderQuery.data?.order?.lineItems?.nodes || [];
    const targetItem = lineItems.find(item => item.variant?.id === participant.productVariantId) || lineItems[0];
    
    const realTitle = targetItem?.title || (campaign ? campaign.productTitle : "Group Buy Item");
    const realVariant = targetItem?.variantTitle || "";
    const realQty = targetItem?.quantity || participant.quantity;
    const realImgUrl = targetItem?.image?.url || (campaign ? campaign.productImage : "");
    const imgElement = realImgUrl ? `<img src="${realImgUrl}" alt="${realTitle}" style="width:100%; height:100%; object-fit:cover; border-radius:4px;" />` : `🎧`;

    const parseSafe = (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } };
    
    const rawSubject = type === "SUCCESS" ? settings.successEmailSubject : settings.failedEmailSubject;
    const rawBody = type === "SUCCESS" ? settings.successEmailBody : settings.failedEmailBody;

    const subjectObj = parseSafe(rawSubject, { "EN": rawSubject });
    const bodyObj = parseSafe(rawBody, { "EN": rawBody });

    const finalSubject = subjectObj[locale] || subjectObj["EN"] || subjectObj[Object.keys(subjectObj)[0]];
    const finalBody = bodyObj[locale] || bodyObj["EN"] || bodyObj[Object.keys(bodyObj)[0]];

    const t = EMAIL_LOCALE_DICT[locale] || EMAIL_LOCALE_DICT["EN"];

    const headerColor = settings.emailHeaderColor || "#000000";
    const headerContent = settings.emailLogoUrl 
      ? `<img src="${settings.emailLogoUrl}" alt="${shopName} Logo" style="max-height: 50px; max-width: 200px;" />` 
      : `<h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 1px;">${t.header}</h1>`;

    const addressContent = settings.emailStoreAddress 
      ? `<p style="margin: 0 0 10px 0; font-size: 11px; color: #a0a5aa;">${settings.emailStoreAddress}</p>` 
      : ``;

    const variantDisplay = realVariant && realVariant !== "Default Title" 
      ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6d7175;">${t.variant}${realVariant}</p>` 
      : ``;

    const orderSummaryContent = `
      <div style="margin-top: 24px; padding: 16px; border: 1px solid #e3e3e3; border-radius: 6px; background-color: #fafafa;">
        <p style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; color: #202223; border-bottom: 1px solid #e3e3e3; padding-bottom: 8px;">
          ${t.summary}
        </p>
        <table width="100%" border="0" cellspacing="0" cellpadding="0">
          <tr>
            <td width="65" valign="middle">
              <div style="width: 50px; height: 50px; background-color: #e9ecef; border-radius: 4px; text-align: center; line-height: 50px; font-size: 20px;">
                ${imgElement}
              </div>
            </td>
            <td valign="middle">
              <p style="margin: 0; font-size: 14px; font-weight: 600; color: #202223;">${realTitle}</p>
              ${variantDisplay}
            </td>
            <td width="60" align="right" valign="middle">
              <p style="margin: 0; font-size: 14px; color: #444;">${t.qty}${realQty}</p>
            </td>
          </tr>
        </table>
      </div>
    `;

    let breakdownContent = "";
    if (blendedContext && type === "SUCCESS") {
      breakdownContent = `
        <div style="margin-top: 16px; padding: 12px; border-radius: 6px; background-color: #eaf3ff; border: 1px solid #b6d4fe; color: #084298; font-size: 13px; line-height: 1.5;">
          <strong style="display: block; margin-bottom: 4px;">${t.breakTitle}</strong>
          ${t.breakDesc(blendedContext.maxQty, blendedContext.leaderPct, blendedContext.standardPct)}
        </div>
      `;
    }

    const emailPayload = {
      from: `${shopName} <notifications@appublic.com>`,
      to: customerEmail,
      subject: finalSubject,
      html: `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f6f8; padding: 40px 20px;">
            <tr><td align="center">
              <table border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); width: 100%; max-width: 600px; margin: 0 auto;">
                <tr><td style="background-color: ${headerColor}; padding: 30px 20px; text-align: center;">
                  ${headerContent}
                </td></tr>
                <tr><td style="padding: 40px 30px; color: #202223;">
                  <h2 style="margin-top: 0; font-size: 20px; color: #202223;">${finalSubject}</h2>
                  <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px; white-space: pre-wrap; color: #444;">${finalBody}</p>
                  
                  ${orderSummaryContent}
                  ${breakdownContent}

                  <p style="margin-top: 24px; font-size: 12px; color: #888;">
                    ${t.ref} <a href="${statusPageUrl}" style="color: #005bd3; text-decoration: underline;"><strong>${orderName}</strong></a>
                  </p>
                </td></tr>
                <tr><td style="background-color: #fafafa; padding: 20px; text-align: center; border-top: 1px solid #e3e3e3;">
                  <p style="margin: 0 0 10px 0; font-size: 12px; color: #8c9196;">${t.thanks}</p>
                  ${addressContent}
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `
    };

    if (settings && settings.contactEmail) {
      emailPayload.reply_to = settings.contactEmail;
    }

    const { data, error } = await resend.emails.send(emailPayload);

    if (error) {
      console.error(`     ❌ Resend API rejected email for ${customerEmail}:`, error);
    } else {
      console.log(`     ✉️ Sent ${type} email to ${customerEmail} in language: ${locale} from ${shopName}`);
    }

  } catch (error) {
    console.error(`     ❌ Failed to execute email dispatch to ${participant?.orderId}:`, error.message);
  }
}

module.exports = { EMAIL_LOCALE_DICT, dispatchGroupBuyEmail };