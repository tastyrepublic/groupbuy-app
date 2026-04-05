import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useBlocker } from "@remix-run/react"; // ✨ Added useBlocker
import {
  Page, Layout, Card, Checkbox, BlockStack, InlineStack, Text, TextField, Box, FormLayout, Button, Icon, Banner
} from "@shopify/polaris";
import { InfoIcon, CheckCircleIcon, AlertCircleIcon, ShieldCheckMarkIcon } from '@shopify/polaris-icons';
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react"; // ✨ Added SaveBar
import { getI18n } from "../utils/i18n.server.js";
import { Resend } from "resend"; 
import EmailSettingsCard from "../components/EmailSettingsCard";
import { EMAIL_LOCALE_DICT, DEFAULT_EMAIL_TEMPLATES } from "../utils/emailDictionary";
import { requireSetup } from "../utils/guard.server.js";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // ✨ Deploy the Guard!
  await requireSetup(session, request);

  const { t } = await getI18n(request);

  let dbSettings = await db.settings.findUnique({ where: { shop: session.shop } });

  const response = await admin.graphql(`
    #graphql
    query checkLiveRules {
      shopifyFunctions(first: 25) { nodes { id title } }
      validations(first: 10) { nodes { enabled shopifyFunction { id } } }
      deliveryCustomizations(first: 10) { nodes { enabled shopifyFunction { id } } }
      shop {
        billingAddress { address1 city country zip }
        contactEmail
      }
      # ✨ OPTIMIZED: Reduced limits to 5 profiles, 10 zones, and 15 methods to bypass the 1000 limit!
      deliveryProfiles(first: 5) {
        nodes {
          name
          profileLocationGroups {
            locationGroupZones(first: 10) {
              nodes {
                methodDefinitions(first: 15) {
                  nodes {
                    name
                    description
                    methodConditions {
                      field
                      operator
                      conditionCriteria {
                        ... on Weight { value unit }
                        ... on MoneyV2 { amount currencyCode }
                      }
                    }
                    rateProvider {
                      ... on DeliveryRateDefinition {
                        price { amount currencyCode }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const { data } = await response.json();
  
  // ✨ UPGRADED PARSER: Translates GraphQL conditions into human-readable text
  const groupedRates = data?.deliveryProfiles?.nodes?.map(profile => {
    const rateMap = new Map();
    
    profile.profileLocationGroups?.forEach(group => {
      group.locationGroupZones?.nodes?.forEach(zone => {
        zone.methodDefinitions?.nodes?.forEach(method => {
          if (!rateMap.has(method.name)) {
            
            // 1. Parse the Cost
            let costStr = "";
            if (method.rateProvider?.price) {
              const amount = parseFloat(method.rateProvider.price.amount);
              // ✨ Translated "Free"
              costStr = amount === 0 ? t("Settings.shipping.free", "Free") : `${method.rateProvider.price.currencyCode} ${amount.toFixed(2)}`;
            }

            // 2. ✨ NEW: Parse the Conditions!
            let conditionStr = "";
            if (method.methodConditions && method.methodConditions.length > 0) {
              let minWeight, maxWeight, minPrice, maxPrice, weightUnit, priceCur;
              
              method.methodConditions.forEach(cond => {
                const isWeight = cond.field === 'TOTAL_WEIGHT';
                const isPrice = cond.field === 'TOTAL_PRICE';
                
                const weightVal = cond.conditionCriteria?.value;
                const wUnit = cond.conditionCriteria?.unit;
                
                const priceVal = cond.conditionCriteria?.amount;
                const pUnit = cond.conditionCriteria?.currencyCode;

                if (isWeight && weightVal !== undefined) {
                  weightUnit = wUnit;
                  if (cond.operator && cond.operator.includes('GREATER_THAN')) minWeight = weightVal;
                  if (cond.operator && cond.operator.includes('LESS_THAN')) maxWeight = weightVal;
                }
                
                if (isPrice && priceVal !== undefined) {
                  priceCur = pUnit;
                  if (cond.operator && cond.operator.includes('GREATER_THAN')) minPrice = priceVal;
                  if (cond.operator && cond.operator.includes('LESS_THAN')) maxPrice = priceVal;
                }
              });

              const parts = [];
              const tWeight = t("Settings.shipping.weight", "Weight");
              const tOrders = t("Settings.shipping.orders", "Orders");
              const tOver = t("Settings.shipping.over", "Over");
              const tUpTo = t("Settings.shipping.upTo", "Up to");

              // ✨ Translated Conditions!
              if (minWeight !== undefined && maxWeight !== undefined) parts.push(`${tWeight}: ${minWeight} - ${maxWeight} ${weightUnit || ''}`);
              else if (minWeight !== undefined) parts.push(`${tWeight}: ${tOver} ${minWeight} ${weightUnit || ''}`);
              else if (maxWeight !== undefined) parts.push(`${tWeight}: ${tUpTo} ${maxWeight} ${weightUnit || ''}`);

              if (minPrice !== undefined && maxPrice !== undefined) parts.push(`${tOrders}: ${minPrice} - ${maxPrice} ${priceCur || ''}`);
              else if (minPrice !== undefined) parts.push(`${tOrders}: ${tOver} ${minPrice} ${priceCur || ''}`);
              else if (maxPrice !== undefined) parts.push(`${tOrders}: ${tUpTo} ${maxPrice} ${priceCur || ''}`);

              conditionStr = parts.join(" | ");
            }
            
            // 3. Save it to the Map
            rateMap.set(method.name, {
              label: method.name,
              value: method.name,
              description: method.description,
              condition: conditionStr, 
              cost: costStr
            });
          }
        });
      });
    });

    return {
      title: profile.name,
      options: Array.from(rateMap.values())
    };
  }).filter(group => group.options.length > 0) || [];
  
  const liveContactEmail = data?.shop?.contactEmail;

  // ✨ NEW: The Self-Healing Sync
  if (liveContactEmail && dbSettings?.contactEmail !== liveContactEmail) {
    dbSettings = await db.settings.upsert({
      where: { shop: session.shop },
      update: { contactEmail: liveContactEmail },
      create: { shop: session.shop, contactEmail: liveContactEmail },
    });
    console.log(`[Self-Healing] Backfilled contactEmail for ${session.shop}`);
  }

  // ✨ Notice how the hardcoded strings are completely gone!
  const addr = data?.shop?.billingAddress;
  const fallbackAddress = addr ? [addr.address1, addr.city, addr.country, addr.zip].filter(Boolean).join(', ') : "";

  const settings = {
    autoContinueSelling: dbSettings?.autoContinueSelling ?? true,
    disableContinueSellingOnEnd: dbSettings?.disableContinueSellingOnEnd ?? true,
    sendSuccessEmail: dbSettings?.sendSuccessEmail ?? false,
    sendFailedEmail: dbSettings?.sendFailedEmail ?? false,
    successEmailSubject: dbSettings?.successEmailSubject ?? JSON.stringify(DEFAULT_EMAIL_TEMPLATES.successSubject),
    successEmailBody: dbSettings?.successEmailBody ?? JSON.stringify(DEFAULT_EMAIL_TEMPLATES.successBody),
    failedEmailSubject: dbSettings?.failedEmailSubject ?? JSON.stringify(DEFAULT_EMAIL_TEMPLATES.failedSubject),
    failedEmailBody: dbSettings?.failedEmailBody ?? JSON.stringify(DEFAULT_EMAIL_TEMPLATES.failedBody),
    emailLogoUrl: dbSettings?.emailLogoUrl ?? "",
    emailStoreAddress: dbSettings?.emailStoreAddress ?? fallbackAddress,
    emailHeaderColor: dbSettings?.emailHeaderColor ?? "#000000",
    contactEmail: dbSettings?.contactEmail || liveContactEmail,
    enableAutoTagging: dbSettings?.enableAutoTagging ?? false,
    autoDiscountTag: dbSettings?.autoDiscountTag ?? "group-buy-active",
    hiddenDeliveryRates: dbSettings?.hiddenDeliveryRates ?? "[]", 
  };

  const enforcerFunctionId = data?.shopifyFunctions?.nodes?.find(f => f.title.includes("Cart Enforcer"))?.id;
  const guardianFunctionId = data?.shopifyFunctions?.nodes?.find(f => f.title.includes("Shipping Guardian"))?.id;

  const isEnforcerActive = data?.validations?.nodes?.some((rule) => rule.shopifyFunction?.id === enforcerFunctionId && rule.enabled === true) || false;
  const isGuardianActive = data?.deliveryCustomizations?.nodes?.some((cust) => cust.shopifyFunction?.id === guardianFunctionId && cust.enabled === true) || false;

  return json({ 
    settings, isEnforcerActive, isGuardianActive, groupedRates,
    shopEmail: session.shop.replace('.myshopify.com', '@gmail.com'),
    translations: {
      title: t("Settings.title", "Settings"),
      saveButton: t("Settings.save", "Save"),
      discardButton: t("Settings.discard", "Discard"),
      toastSaved: t("Settings.saved", "Settings saved"),
      inventory: t("Settings.inventory", { returnObjects: true }),
      integrations: t("Settings.integrations", { returnObjects: true }), // ✨ ADDED THIS LINE!
      checkout: t("Settings.checkout", { returnObjects: true }),
      shipping: t("Settings.shipping", { returnObjects: true }),
      email: t("Settings.email", { returnObjects: true }),
      orderConfirm: t("Settings.orderConfirm", { returnObjects: true })
    }
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request); 
  const formData = await request.formData();
  const actionType = formData.get("_action")
  
  if (actionType === "save_general") {
    const hiddenDeliveryRatesStr = formData.get("hiddenDeliveryRates") || "[]";
    const dataObj = {
      autoContinueSelling: formData.get("autoContinueSelling") === "true", 
      disableContinueSellingOnEnd: formData.get("disableContinueSellingOnEnd") === "true",
      sendSuccessEmail: formData.get("sendSuccessEmail") === "true",
      sendFailedEmail: formData.get("sendFailedEmail") === "true",
      successEmailSubject: formData.get("successEmailSubject"),
      successEmailBody: formData.get("successEmailBody"),
      failedEmailSubject: formData.get("failedEmailSubject"),
      failedEmailBody: formData.get("failedEmailBody"),
      emailLogoUrl: formData.get("emailLogoUrl"),
      emailStoreAddress: formData.get("emailStoreAddress"),
      emailHeaderColor: formData.get("emailHeaderColor"),
      enableAutoTagging: formData.get("enableAutoTagging") === "true",
      autoDiscountTag: formData.get("autoDiscountTag"),
      hiddenDeliveryRates: hiddenDeliveryRatesStr
    };

    await db.settings.upsert({
      where: { shop: session.shop },
      update: dataObj,
      create: { shop: session.shop, ...dataObj },
    });

    // ✨ Find the Guardian function and save the Metafield directly to it!
    const extResponse = await admin.graphql(`query { deliveryCustomizations(first: 25) { nodes { id shopifyFunction { title } } } }`);
    const extData = await extResponse.json();
    const guardianId = extData.data?.deliveryCustomizations?.nodes?.find(f => f.shopifyFunction?.title.includes("Shipping Guardian"))?.id;

    if (guardianId) {
    await admin.graphql(`
        mutation {
          deliveryCustomizationUpdate(id: "${guardianId}", deliveryCustomization: {
            metafields: [{ namespace: "$app:groupbuy", key: "hidden_rates", type: "single_line_text_field", value: ${JSON.stringify(hiddenDeliveryRatesStr)} }]
          }) { userErrors { message } }
        }
      `);
    }
    return json({ success: true, action: "save" });
  }

  // ... [test_email action stays exactly the same as you provided]
  if (actionType === "test_email") {
    try {
      const shopQuery = await admin.graphql(`{ shop { name } }`);
      const shopData = await shopQuery.json();
      const shopName = shopData.data?.shop?.name || "Group Buy Updates";
      const resend = new Resend(process.env.RESEND_API_KEY);
      
      const targetEmail = formData.get("testEmail");
      const subject = formData.get("subject");
      const body = formData.get("body");
      const logoUrl = formData.get("emailLogoUrl");
      const storeAddress = formData.get("emailStoreAddress");
      const headerColor = formData.get("emailHeaderColor") || "#000000";
      const activeLang = formData.get("activeLang") || "EN";

      const t = EMAIL_LOCALE_DICT[activeLang] || EMAIL_LOCALE_DICT["EN"];

      const headerContent = logoUrl 
        ? `<img src="${logoUrl}" alt="Store Logo" style="max-height: 50px; max-width: 200px;" />` 
        : `<h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 1px;">${t.header}</h1>`;

      const addressContent = storeAddress 
        ? `<p style="margin: 0 0 10px 0; font-size: 11px; color: #a0a5aa;">${storeAddress}</p>` 
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
                  🎧
                </div>
              </td>
              <td valign="middle">
                <p style="margin: 0; font-size: 14px; font-weight: 600; color: #202223;">${t.product}</p>
                <p style="margin: 4px 0 0 0; font-size: 12px; color: #6d7175;">${t.variant}</p>
              </td>
              <td width="60" align="right" valign="middle">
                <p style="margin: 0; font-size: 14px; color: #444;">${t.qtyUi}</p>
              </td>
            </tr>
          </table>
        </div>
      `;

      // ✨ NEW: Grab the passed variables
      const previewRole = formData.get("previewRole") || "MEMBER";
      const isSuccessTab = formData.get("isSuccessTab") === "true";

      // ✨ NEW: Build the breakdown box if applicable
      let breakdownContent = "";
      if (isSuccessTab && previewRole === "LEADER") {
        breakdownContent = `
          <div style="margin-top: 16px; padding: 12px; border-radius: 6px; background-color: #eaf3ff; border: 1px solid #b6d4fe; color: #084298; font-size: 13px; line-height: 1.5;">
            <strong style="display: block; margin-bottom: 4px;">${t.breakTitle}</strong>
            ${t.breakDesc(2, 50, 20)}
          </div>
        `;
      }

      await resend.emails.send({
        from: `${shopName} <notifications@appublic.com>`,
        to: targetEmail,
        subject: `[TEST] ${subject}`,
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
                    <h2 style="margin-top: 0; font-size: 20px; color: #202223;">${subject}</h2>
                    <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px; white-space: pre-wrap; color: #444;">${body}</p>
                    
                    ${orderSummaryContent}
                    ${breakdownContent}

                    <p style="margin-top: 24px; font-size: 12px; color: #888;">
                    ${t.ref} <a href="#" style="color: #005bd3; text-decoration: underline;"><strong>#1001</strong></a>
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
      });
      return json({ success: true, action: "test" });
    } catch (error) {
      return json({ success: false, action: "test", error: error.message });
    }
  }
  return json({ success: false });
};

export default function SettingsPage() {
  const { settings, isEnforcerActive, isGuardianActive, shopEmail, translations, groupedRates } = useLoaderData();
  const fetcher = useFetcher();
  const app = useAppBridge();

  const [autoContinueSelling, setAutoContinueSelling] = useState(settings.autoContinueSelling);
  const [disableContinueSellingOnEnd, setDisableContinueSellingOnEnd] = useState(settings.disableContinueSellingOnEnd);

  // ✨ THE RIGHT WAY: Dedicated state for Integration Settings, initialized instantly!
  const [enableAutoTagging, setEnableAutoTagging] = useState(settings.enableAutoTagging);
  const [autoDiscountTag, setAutoDiscountTag] = useState(settings.autoDiscountTag);
  const [hiddenDeliveryRates, setHiddenDeliveryRates] = useState(JSON.parse(settings.hiddenDeliveryRates || "[]"));

  const [emailData, setEmailData] = useState({ isDirty: false, data: {} }); 
  
  // ✨ Added a reset key to wipe child components when "Discard" is clicked
  const [resetKey, setResetKey] = useState(0); 

  // ✨ Update the dirty checker to watch the new variables
  const isGeneralDirty = 
    autoContinueSelling !== settings.autoContinueSelling || 
    disableContinueSellingOnEnd !== settings.disableContinueSellingOnEnd ||
    enableAutoTagging !== settings.enableAutoTagging ||
    autoDiscountTag !== settings.autoDiscountTag ||
    JSON.stringify(hiddenDeliveryRates) !== settings.hiddenDeliveryRates;
  const isPageDirty = isGeneralDirty || emailData.isDirty;

  // ✨ Handle Discard Action
  const handleDiscard = () => {
    setAutoContinueSelling(settings.autoContinueSelling);
    setDisableContinueSellingOnEnd(settings.disableContinueSellingOnEnd);
    setEnableAutoTagging(settings.enableAutoTagging);
    setAutoDiscountTag(settings.autoDiscountTag);
    setHiddenDeliveryRates(JSON.parse(settings.hiddenDeliveryRates || "[]"));
    setEmailData({ isDirty: false, data: {} });
    setResetKey(prev => prev + 1); 
  };

  // ✨ Handle Save Action (Clean and straightforward!)
  const handleSave = () => {
    fetcher.submit({ 
      _action: "save_general", 
      autoContinueSelling: String(autoContinueSelling), 
      disableContinueSellingOnEnd: String(disableContinueSellingOnEnd),
      enableAutoTagging: String(enableAutoTagging),
      autoDiscountTag: autoDiscountTag,
      hiddenDeliveryRates: JSON.stringify(hiddenDeliveryRates),
      ...emailData.data 
    }, { method: "post" });
  };

  // ✨ Display SaveBar when dirty
  useEffect(() => {
    if (isPageDirty) {
      app.saveBar.show('settings-save-bar');
    } else {
      app.saveBar.hide('settings-save-bar');
    }
  }, [isPageDirty, app]);

  // ✨ Prevent user from leaving if they have unsaved changes
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isPageDirty && currentLocation.pathname !== nextLocation.pathname
  );

  useEffect(() => {
    if (blocker.state === "blocked") {
      app.saveBar.leaveConfirmation()
        .then((confirmed) => confirmed ? blocker.proceed() : blocker.reset());
    }
  }, [blocker, app]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && fetcher.data.action === "save") {
      app.toast.show(translations.toastSaved);
      setEmailData(prev => ({ ...prev, isDirty: false })); // Reset dirty state on save
    }
  }, [fetcher.state, fetcher.data, app, translations]);

  return (
    <Page
      title={translations.title} 
      backAction={{ url: "/app" }}
    >
      {/* ✨ Translated SaveBar */}
      <SaveBar id="settings-save-bar">
        <button 
          variant="primary" 
          onClick={handleSave}
          loading={fetcher.state !== "idle" ? "" : undefined}
        >
          {translations.saveButton}
        </button>
        <button onClick={handleDiscard}>
          {translations.discardButton}
        </button>
      </SaveBar>

      <Box paddingBlockEnd="800">
        <BlockStack gap="500">
          <Layout>
            <Layout.AnnotatedSection title={translations.inventory?.title || "Inventory Automation"} description={translations.inventory?.description}>
              <Card>
                <FormLayout>
                  <Checkbox label={translations.inventory?.enableLabel} helpText={translations.inventory?.enableHelp} checked={autoContinueSelling} onChange={setAutoContinueSelling} />
                  <Checkbox label={translations.inventory?.disableLabel} helpText={translations.inventory?.disableHelp} checked={disableContinueSellingOnEnd} onChange={setDisableContinueSellingOnEnd} />
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            {/* ✨ TRANSLATED: Integration Settings UI */}
            <Layout.AnnotatedSection 
              title={translations.integrations?.title || "Integrations & Automations"} 
              description={translations.integrations?.description}
            >
              <Card>
                <BlockStack gap="400">
                  <Checkbox
                    label={translations.integrations?.enableTagLabel}
                    checked={enableAutoTagging}
                    onChange={setEnableAutoTagging}
                    helpText={translations.integrations?.enableTagHelp}
                  />

                  <TextField
                    label={translations.integrations?.tagNameLabel}
                    value={autoDiscountTag}
                    onChange={setAutoDiscountTag}
                    disabled={!enableAutoTagging}
                  />
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            {/* ✨ Add resetKey so the component completely clears its unsaved state on Discard */}
            <EmailSettingsCard 
              key={resetKey}
              settings={settings} 
              shopEmail={shopEmail} 
              translations={translations} 
              onStateChange={setEmailData} 
            />

            {/* ✨ NEW: The Foolproof Setup Guide (Translate & Adapt Compatible) */}
            <Layout.AnnotatedSection 
              title={translations.orderConfirm?.title} 
              description={translations.orderConfirm?.description}
            >
              <Card>
                <BlockStack gap="400">
                  {/* --- STEP 1: ENGLISH TEMPLATE --- */}
                  <Text variant="headingMd" as="h2">{translations.orderConfirm?.boxTitle}</Text>
                  <Text as="p" tone="subdued">{translations.orderConfirm?.boxDesc}</Text>
                  
                  <div style={{ paddingLeft: '16px', color: 'var(--p-color-text)' }}>
                    <ol style={{ margin: 0, padding: 0, listStylePosition: 'inside', lineHeight: '1.6' }}>
                      <li>{translations.orderConfirm?.step1}</li>
                      <li>{translations.orderConfirm?.step2_1}<strong>{translations.orderConfirm?.step2_strong}</strong>{translations.orderConfirm?.step2_2}</li>
                      <li>{translations.orderConfirm?.step3_1}<strong>{translations.orderConfirm?.step3_strong}</strong>{translations.orderConfirm?.step3_2}</li>
                      <li>
                        {translations.orderConfirm?.step4_1} <br/> 
                        <code style={{ backgroundColor: 'var(--p-color-bg-surface-secondary)', padding: '2px 4px', borderRadius: '4px' }}>
                          {translations.orderConfirm?.step4_code}
                        </code>
                      </li>
                      <li>{translations.orderConfirm?.step5_1}<strong>{translations.orderConfirm?.step5_strong}</strong>{translations.orderConfirm?.step5_2}</li>
                    </ol>
                  </div>

                  <div style={{ position: 'relative', backgroundColor: 'var(--p-color-bg-surface-secondary)', padding: '16px', borderRadius: '8px', border: '1px solid var(--p-color-border-subdued)', overflowX: 'auto' }}>
                    <pre style={{ margin: 0, fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace' }}>
{`{% assign is_group_buy = false %}
{% for line in subtotal_line_items %}
  {% for property in line.properties %}
    {% if property.first == '_groupbuy_campaign_id' %}
      {% assign is_group_buy = true %}
    {% endif %}
  {% endfor %}
{% endfor %}

{% if is_group_buy %}
  <br><br><strong>Thank you for joining the Group Buy!</strong><br>Your payment method has been authorized. If this campaign successfully reaches its goal, we will capture your payment and notify you when your item ships.<br><br>If the campaign does not reach its goal, your order will be automatically canceled and you will not be charged.<br><br>
{% else %}
  We're getting your order ready to be shipped. We will notify you when it has been sent.
{% endif %}`}
                    </pre>
                    <div style={{ position: 'absolute', top: '8px', right: '8px' }}>
                      <Button size="micro" onClick={() => {
                        const code = `{% assign is_group_buy = false %}\n{% for line in subtotal_line_items %}\n  {% for property in line.properties %}\n    {% if property.first == '_groupbuy_campaign_id' %}\n      {% assign is_group_buy = true %}\n    {% endif %}\n  {% endfor %}\n{% endfor %}\n\n{% if is_group_buy %}\n  <br><br><strong>Thank you for joining the Group Buy!</strong><br>Your payment method has been authorized. If this campaign successfully reaches its goal, we will capture your payment and notify you when your item ships.<br><br>If the campaign does not reach its goal, your order will be automatically canceled and you will not be charged.<br><br>\n{% else %}\n  We're getting your order ready to be shipped. We will notify you when it has been sent.\n{% endif %}`;
                        navigator.clipboard.writeText(code);
                        app.toast.show(translations.orderConfirm?.copiedToast);
                      }}>{translations.orderConfirm?.copyBtnEn || "Copy English Code"}</Button>
                    </div>
                  </div>

                  <hr style={{ border: 'none', borderTop: '1px solid var(--p-color-border-subdued)', margin: '16px 0' }} />

                  {/* --- STEP 2: CHINESE TEMPLATE --- */}
                  <Text variant="headingMd" as="h2">{translations.orderConfirm?.multiLangTitle}</Text>
                  <Text as="p" tone="subdued">{translations.orderConfirm?.multiLangDesc}</Text>
                  
                  <div style={{ paddingLeft: '16px', color: 'var(--p-color-text)' }}>
                    <ol style={{ margin: 0, padding: 0, listStylePosition: 'inside', lineHeight: '1.6' }} start="6">
                      <li>{translations.orderConfirm?.step6}</li>
                      <li>{translations.orderConfirm?.step7}</li>
                      <li>
                        {translations.orderConfirm?.step8_1}
                        <code style={{ backgroundColor: 'var(--p-color-bg-surface-secondary)', padding: '2px 4px', borderRadius: '4px' }}>
                          {translations.orderConfirm?.step8_code}
                        </code>
                        {translations.orderConfirm?.step8_2}
                      </li>
                    </ol>
                  </div>

                  <div style={{ position: 'relative', backgroundColor: 'var(--p-color-bg-surface-secondary)', padding: '16px', borderRadius: '8px', border: '1px solid var(--p-color-border-subdued)', overflowX: 'auto' }}>
                    <pre style={{ margin: 0, fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace' }}>
{`{% assign is_group_buy = false %}
{% for line in subtotal_line_items %}
  {% for property in line.properties %}
    {% if property.first == '_groupbuy_campaign_id' %}
      {% assign is_group_buy = true %}
    {% endif %}
  {% endfor %}
{% endfor %}

{% if is_group_buy %}
  <br><br><strong>感謝您參與團購！</strong><br>您的付款方式已獲得授權。如果此活動成功達到目標，我們將會進行扣款，並在商品出貨時通知您。<br><br>如果活動未達目標，您的訂單將會自動取消，且不會向您收取任何費用。<br><br>
{% else %}
  您的訂單已準備好配送。我們會在寄出後通知您。
{% endif %}`}
                    </pre>
                    <div style={{ position: 'absolute', top: '8px', right: '8px' }}>
                      <Button size="micro" onClick={() => {
                        const code = `{% assign is_group_buy = false %}\n{% for line in subtotal_line_items %}\n  {% for property in line.properties %}\n    {% if property.first == '_groupbuy_campaign_id' %}\n      {% assign is_group_buy = true %}\n    {% endif %}\n  {% endfor %}\n{% endfor %}\n\n{% if is_group_buy %}\n  <br><br><strong>感謝您參與團購！</strong><br>您的付款方式已獲得授權。如果此活動成功達到目標，我們將會進行扣款，並在商品出貨時通知您。<br><br>如果活動未達目標，您的訂單將會自動取消，且不會向您收取任何費用。<br><br>\n{% else %}\n  您的訂單已準備好配送。我們會在寄出後通知您。\n{% endif %}`;
                        navigator.clipboard.writeText(code);
                        app.toast.show(translations.orderConfirm?.copiedToast);
                      }}>{translations.orderConfirm?.copyBtnZh || "Copy Chinese Code"}</Button>
                    </div>
                  </div>

                  <InlineStack gap="300" blockAlign="center">
                    <Button onClick={() => open('shopify://admin/email_templates/order_confirmation/edit', '_top')}>
                      {translations.orderConfirm?.openBtn}
                    </Button>
                    <Button variant="plain" onClick={() => window.open('mailto:support@appublic.com', '_blank')}>
                      {translations.orderConfirm?.contactSupportBtn || "Contact Support"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection title={translations.checkout?.title} description={translations.checkout?.description}>
              <Card>
                <BlockStack gap="400">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ display: 'flex' }}><Icon source={isEnforcerActive ? ShieldCheckMarkIcon : AlertCircleIcon} tone={isEnforcerActive ? "success" : "critical"} /></span>
                    <Text variant="headingMd" as="h2">{translations.checkout?.boxTitle}</Text>
                  </div>
                  <Banner tone={isEnforcerActive ? "info" : "warning"} title={isEnforcerActive ? translations.checkout?.activeTitle : translations.checkout?.inactiveTitle}>
                    <p>{isEnforcerActive ? translations.checkout?.activeDesc : translations.checkout?.inactiveDesc}</p>
                  </Banner>
                  <div style={{ display: 'flex' }}>
                    <Button onClick={() => open('shopify://admin/settings/checkout', '_top')}>{isEnforcerActive ? translations.checkout?.manageBtn : translations.checkout?.configureBtn}</Button>
                  </div>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection title={translations.shipping?.title} description={translations.shipping?.description}>
              <Card>
                <BlockStack gap="400">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ display: 'flex' }}><Icon source={isGuardianActive ? CheckCircleIcon : InfoIcon} tone={isGuardianActive ? "info" : "subdued"} /></span>
                    <Text variant="headingMd" as="h2">{translations.shipping?.boxTitle}</Text>
                  </div>
                  
                  <Banner tone={isGuardianActive ? "info" : "warning"} title={isGuardianActive ? translations.shipping?.activeTitle : translations.shipping?.inactiveTitle}>
                    <p>{isGuardianActive ? translations.shipping?.activeDesc : translations.shipping?.inactiveDesc}</p>
                  </Banner>

                  {/* ✨ TRANSLATED: Dynamic Multi-Select Checkboxes */}
                  <Box paddingBlockStart="200" paddingBlockEnd="200">
                    <Text variant="headingSm" as="h3">{translations.shipping?.multiSelectTitle}</Text>
                    
                    {/* ✨ 1. Made the sub-description smaller */}
                    <Text as="p" variant="bodySm" tone="subdued">{translations.shipping?.multiSelectDesc}</Text>
                    
                    <div style={{ marginTop: '12px', opacity: isGuardianActive ? 1 : 0.5, pointerEvents: isGuardianActive ? 'auto' : 'none' }}>
                      <BlockStack gap="400">
                        {groupedRates.map(group => (
                          <div key={group.title} style={{ padding: '12px', backgroundColor: 'var(--p-color-bg-surface-secondary)', borderRadius: '8px' }}>
                            <Text variant="bodyMd" fontWeight="bold">{group.title}</Text>
                            <div style={{ marginTop: '8px' }}>
                              <BlockStack gap="200">
                                {group.options.map(opt => {
                                  // ✨ Build a fully translated help text string
                                  const helpTextParts = [];
                                  if (opt.cost) helpTextParts.push(`${translations.shipping?.cost}: ${opt.cost}`);
                                  if (opt.condition) helpTextParts.push(opt.condition); 
                                  if (opt.description) helpTextParts.push(`${translations.shipping?.transit}: ${opt.description}`);
                                  const finalHelpText = helpTextParts.join("  •  ");

                                  return (
                                    <Checkbox
                                      key={opt.value}
                                      label={opt.label}
                                      
                                      // ✨ 2. Wrapped the detail info in a small Text component!
                                      helpText={<Text variant="bodySm" tone="subdued">{finalHelpText}</Text>} 
                                      
                                      checked={hiddenDeliveryRates.includes(opt.value)}
                                      disabled={!isGuardianActive}
                                      onChange={(checked) => {
                                        setHiddenDeliveryRates(prev => {
                                          if (checked) {
                                            return [...prev, opt.value];
                                          } else {
                                            return prev.filter(r => r !== opt.value);
                                          }
                                        });
                                      }}
                                    />
                                  );
                                })}
                              </BlockStack>
                            </div>
                          </div>
                        ))}
                      </BlockStack>
                    </div>
                  </Box>

                  <div style={{ display: 'flex' }}>
                    <Button onClick={() => open('shopify://admin/settings/shipping', '_top')}>
                      {isGuardianActive ? translations.shipping?.manageBtn : translations.shipping?.configureBtn}
                    </Button>
                  </div>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>
        </BlockStack>
      </Box>
    </Page>
  );
}