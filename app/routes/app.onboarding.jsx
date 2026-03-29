import { json, redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useState, useEffect } from "react";
import { 
  Page, Layout, Card, BlockStack, Text, Button, ProgressBar, InlineStack, Icon, Banner, Box, Checkbox, Badge, ChoiceList, Select
} from "@shopify/polaris";
import { ShieldCheckMarkIcon, AlertCircleIcon, CheckCircleIcon, InfoIcon } from '@shopify/polaris-icons';
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getI18n } from "../utils/i18n.server.js";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  let settings = await db.settings.findUnique({ where: { shop: session.shop } });
  
  if (settings?.isOnboarded) {
    return redirect("/app");
  }

  const response = await admin.graphql(`
    #graphql
    query checkLiveRules {
      shopifyFunctions(first: 25) { nodes { id title } }
      validations(first: 10) { nodes { enabled shopifyFunction { id } } }
      deliveryCustomizations(first: 10) { nodes { enabled shopifyFunction { id } } }
      shop { contactEmail }
    }
  `);

  const { data } = await response.json();
  const liveContactEmail = data?.shop?.contactEmail;

  if (!settings) {
    settings = await db.settings.create({
      data: { shop: session.shop, contactEmail: liveContactEmail }
    });
  }

  const enforcerFunctionId = data?.shopifyFunctions?.nodes?.find(f => f.title.includes("Cart Enforcer"))?.id;
  const guardianFunctionId = data?.shopifyFunctions?.nodes?.find(f => f.title.includes("Shipping Guardian"))?.id;

  const isEnforcerActive = data?.validations?.nodes?.some((rule) => rule.shopifyFunction?.id === enforcerFunctionId && rule.enabled === true) || false;
  const isGuardianActive = data?.deliveryCustomizations?.nodes?.some((cust) => cust.shopifyFunction?.id === guardianFunctionId && cust.enabled === true) || false;

  const { t } = await getI18n(request);
  const translations = {
    // ✨ Added an "Onboarding" specific block for the new UI text
    onboarding: t("Onboarding", { returnObjects: true }),
    inventory: t("Settings.inventory", { returnObjects: true }), 
    checkout: t("Settings.checkout", { returnObjects: true }),
    shipping: t("Settings.shipping", { returnObjects: true }),
    email: t("Settings.email", { returnObjects: true }),
    orderConfirm: t("Settings.orderConfirm", { returnObjects: true })
  };

  return json({ 
    settings, 
    isEnforcerActive, 
    isGuardianActive, 
    translations 
  });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("_action");

  if (actionType === "complete_onboarding") {
    await db.settings.update({
      where: { shop: session.shop },
      data: { isOnboarded: true },
    });
    return redirect("/app");
  }

  if (actionType === "save_step_1") {
    await db.settings.update({ 
      where: { shop: session.shop }, 
      data: {
        autoContinueSelling: formData.get("autoContinueSelling") === "true",
        disableContinueSellingOnEnd: formData.get("disableContinueSellingOnEnd") === "true",
      } 
    });
    return json({ success: true });
  }

  if (actionType === "save_step_2") {
    await db.settings.update({ 
      where: { shop: session.shop }, 
      data: {
        sendSuccessEmail: formData.get("sendSuccessEmail") === "true",
        sendFailedEmail: formData.get("sendFailedEmail") === "true",
      } 
    });
    return json({ success: true });
  }

  return json({ success: false });
};

export default function OnboardingWizard() {
  const { settings, isEnforcerActive, isGuardianActive, translations } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator(); 
  
  const [step, setStep] = useState(1);
  const totalSteps = 4;

  const [autoContinueSelling, setAutoContinueSelling] = useState([]);
  const [disableContinueSellingOnEnd, setDisableContinueSellingOnEnd] = useState([]);
  const [sendSuccessEmail, setSendSuccessEmail] = useState([]);
  const [sendFailedEmail, setSendFailedEmail] = useState([]);

  const [isStep1Confirmed, setIsStep1Confirmed] = useState(false);
  const [isStep2Confirmed, setIsStep2Confirmed] = useState(false);
  const [isStep3Confirmed, setIsStep3Confirmed] = useState(false);

  // ✨ The new state for the code language
  const [codeLang, setCodeLang] = useState('en'); 

  const emailCodeSnippets = {
    'en': `{% assign is_group_buy = false %}
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
{% endif %}`,

    'zh-TW': `{% assign is_group_buy = false %}
{% for line in subtotal_line_items %}
  {% for property in line.properties %}
    {% if property.first == '_groupbuy_campaign_id' %}
      {% assign is_group_buy = true %}
    {% endif %}
  {% endfor %}
{% endfor %}

{% if is_group_buy %}
  <br><br><strong>感謝您參與團購！</strong><br>您的付款方式已獲得授權。如果此活動成功達到目標，我們將會進行請款，並在商品出貨時通知您。<br><br>如果活動未達到目標，您的訂單將會自動取消，且不會向您收取任何費用。<br><br>
{% else %}
  您的訂單已準備好配送，我們會在出貨後通知您。
{% endif %}`
  };

  useEffect(() => {
    if (step !== 3) return;

    const handleFocus = () => {
      if (document.visibilityState === 'visible' && revalidator.state === "idle") {
        revalidator.revalidate();
      }
    };

    document.addEventListener("visibilitychange", handleFocus);
    window.addEventListener("focus", handleFocus);
    
    const interval = setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, 3000); 

    return () => {
      document.removeEventListener("visibilitychange", handleFocus);
      window.removeEventListener("focus", handleFocus);
      clearInterval(interval);
    };
  }, [step, revalidator]);

  const handleNext = () => {
    if (step === 1) {
      fetcher.submit({ 
        _action: "save_step_1", 
        autoContinueSelling: autoContinueSelling[0],
        disableContinueSellingOnEnd: disableContinueSellingOnEnd[0]
      }, { method: "post" });
    } else if (step === 2) {
      fetcher.submit({ 
        _action: "save_step_2", 
        sendSuccessEmail: sendSuccessEmail[0],
        sendFailedEmail: sendFailedEmail[0]
      }, { method: "post" });
    }
    
    setStep((prev) => Math.min(prev + 1, totalSteps));
    window.scrollTo(0, 0);
  };

  const handleBack = () => {
    setStep((prev) => Math.max(prev - 1, 1));
    window.scrollTo(0, 0);
  };

  const handleComplete = () => {
    fetcher.submit({ _action: "complete_onboarding" }, { method: "post" });
  };

  const isNextDisabled = () => {
    if (step === 1 && !isStep1Confirmed) return true;
    if (step === 2 && !isStep2Confirmed) return true;
    if (step === 3 && !isStep3Confirmed) return true;
    return false; 
  };

  return (
    <Page title={translations.onboarding?.pageTitle || translations.onboardingTitle || "Welcome to Group Buy! 🎉"}>
      <BlockStack gap="500">
        
        <Banner tone="info">
          <p>
            <strong>{translations.onboarding?.welcomeTitle || "Why do we need this setup?"}</strong> {translations.onboarding?.welcomeDesc || "To ensure your customers have a flawless experience, Group Buy needs permission to automate your inventory, send automated emails, and protect your checkout from abuse."}
          </p>
        </Banner>

        <Card>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd" tone="subdued">
              {translations.onboarding?.stepProgress?.replace('{step}', step).replace('{total}', totalSteps) || `Setup Step ${step} of ${totalSteps}`}
            </Text>
            <ProgressBar progress={(step / totalSteps) * 100} color="primary" size="small" />
          </BlockStack>
        </Card>

        {/* --- STEP 1: INVENTORY --- */}
        {step === 1 && (
          <BlockStack gap="400">
            <Text variant="headingLg" as="h1">{translations.inventory?.pageTitle || "Inventory Automation"}</Text>
            <Text as="p" tone="subdued">{translations.inventory?.pageDesc || "Configure how the app handles your product inventory when a campaign starts and ends."}</Text>
            
            <Card>
              <BlockStack gap="600">
                <ChoiceList
                  title={translations.inventory?.enableLabel || "Auto-continue selling when campaign starts?"}
                  choices={[
                    { 
                      label: translations.inventory?.enableYesLabel || 'Yes, automatically allow out-of-stock sales (Recommended)', 
                      value: 'true',
                      helpText: translations.inventory?.enableYesHelp || 'Ensures buyers can always join the group buy, even if your Shopify inventory hits zero.' 
                    },
                    { 
                      label: translations.inventory?.enableNoLabel || 'No, I will manage it manually', 
                      value: 'false' 
                    },
                  ]}
                  selected={autoContinueSelling}
                  onChange={setAutoContinueSelling}
                />
                
                <ChoiceList
                  title={translations.inventory?.disableLabel || "Stop selling when campaign ends?"}
                  choices={[
                    { 
                      label: translations.inventory?.disableYesLabel || 'Yes, automatically block out-of-stock sales (Recommended)', 
                      value: 'true',
                      helpText: translations.inventory?.disableYesHelp || 'Prevents accidental purchases after the group buy has officially closed.'
                    },
                    { 
                      label: translations.inventory?.disableNoLabel || 'No, I will manage it manually', 
                      value: 'false' 
                    },
                  ]}
                  selected={disableContinueSellingOnEnd}
                  onChange={setDisableContinueSellingOnEnd}
                />
              </BlockStack>
            </Card>

            <Box paddingBlockStart="200">
              <Card background="bg-surface-secondary">
                <Checkbox 
                  label={translations.onboarding?.step1ConfirmLabel || "I confirm I have set my desired inventory rules."} 
                  checked={isStep1Confirmed} 
                  onChange={setIsStep1Confirmed} 
                  disabled={autoContinueSelling.length === 0 || disableContinueSellingOnEnd.length === 0}
                  helpText={(autoContinueSelling.length === 0 || disableContinueSellingOnEnd.length === 0) ? (translations.onboarding?.step1HelpLocked || "Please select an option for both inventory settings above to proceed.") : (translations.onboarding?.step1HelpUnlocked || "Options selected! You may proceed.")}
                />
              </Card>
            </Box>
          </BlockStack>
        )}

        {/* --- STEP 2: SIMPLIFIED EMAILS --- */}
        {step === 2 && (
          <BlockStack gap="400">
            <Text variant="headingLg" as="h1">{translations.email?.pageTitle || "Customer Email Notifications"}</Text>
            <Text as="p" tone="subdued">{translations.email?.pageDesc || "Choose whether you want the app to automatically notify customers when a group buy reaches its goal or fails."}</Text>
            
            <Card>
              <BlockStack gap="600">
                <Banner tone="info">
                  <p dangerouslySetInnerHTML={{ __html: translations.email?.customizeNote || "<strong>Note:</strong> You can fully customize the email text, translate it into other languages, and add your store logo later in the main <strong>Settings</strong> page." }} />
                </Banner>

                <ChoiceList
                  title={translations.email?.successToggle || "Send Success Email when a campaign reaches its goal?"}
                  choices={[
                    { 
                      label: translations.email?.successYesLabel || 'Yes, send success emails (Recommended)', 
                      value: 'true',
                      helpText: translations.email?.successYesHelp || 'Keeps buyers excited and informed that their order is being processed, significantly reducing support tickets.'
                    },
                    { 
                      label: translations.email?.successNoLabel || 'No, do not send', 
                      value: 'false' 
                    },
                  ]}
                  selected={sendSuccessEmail}
                  onChange={setSendSuccessEmail}
                />
                
                <ChoiceList
                  title={translations.email?.failedToggle || "Send Failed Email if a campaign expires without reaching its goal?"}
                  choices={[
                    { 
                      label: translations.email?.failedYesLabel || 'Yes, send failed emails (Recommended)', 
                      value: 'true',
                      helpText: translations.email?.failedYesHelp || 'Automatically notifies buyers so they aren\'t left wondering what happened to their order.'
                    },
                    { 
                      label: translations.email?.failedNoLabel || 'No, do not send', 
                      value: 'false' 
                    },
                  ]}
                  selected={sendFailedEmail}
                  onChange={setSendFailedEmail}
                />
              </BlockStack>
            </Card>

            <Box paddingBlockStart="200">
              <Card background="bg-surface-secondary">
                <Checkbox 
                  label={translations.onboarding?.step2ConfirmLabel || "I have decided which automatic emails to enable."} 
                  checked={isStep2Confirmed} 
                  onChange={setIsStep2Confirmed} 
                  disabled={sendSuccessEmail.length === 0 || sendFailedEmail.length === 0}
                  helpText={(sendSuccessEmail.length === 0 || sendFailedEmail.length === 0) ? (translations.onboarding?.step2HelpLocked || "Please select an option for both email settings above to proceed.") : (translations.onboarding?.step2HelpUnlocked || "Options selected! You may proceed.")}
                />
              </Card>
            </Box>
          </BlockStack>
        )}

        {/* --- STEP 3: SHOPIFY FUNCTIONS --- */}
        {step === 3 && (
          <BlockStack gap="400">
            <Text variant="headingLg" as="h1">{translations.checkout?.pageTitle || "Activate Store Protection"}</Text>
            <Text as="p" tone="subdued">{translations.checkout?.pageDesc || "Enable our native Shopify Functions to ensure buyers cannot bypass group buy rules or manipulate shipping options at checkout."}</Text>
            
            <Layout>
              <Layout.Section variant="oneHalf">
                <Card>
                  <BlockStack gap="400">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ display: 'flex' }}><Icon source={isEnforcerActive ? ShieldCheckMarkIcon : AlertCircleIcon} tone={isEnforcerActive ? "success" : "critical"} /></span>
                      <Text variant="headingMd" as="h2">{translations.checkout?.boxTitle || "Cart Enforcer"}</Text>
                    </div>
                    <Banner tone={isEnforcerActive ? "info" : "warning"} title={isEnforcerActive ? (translations.checkout?.activeTitle || "Active") : (translations.checkout?.inactiveTitle || "Action Required")}>
                      <p>{isEnforcerActive ? translations.checkout?.activeDesc : translations.checkout?.inactiveDesc}</p>
                    </Banner>
                    <div style={{ display: 'flex' }}>
                      <Button onClick={() => open('shopify://admin/settings/checkout', '_blank')}>{isEnforcerActive ? (translations.checkout?.manageBtn || "Manage") : (translations.checkout?.configureBtn || "Configure")}</Button>
                    </div>
                  </BlockStack>
                </Card>
              </Layout.Section>

              <Layout.Section variant="oneHalf">
                <Card>
                  <BlockStack gap="400">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ display: 'flex' }}><Icon source={isGuardianActive ? CheckCircleIcon : InfoIcon} tone={isGuardianActive ? "info" : "subdued"} /></span>
                      <Text variant="headingMd" as="h2">{translations.shipping?.boxTitle || "Shipping Guardian"}</Text>
                    </div>
                    <Banner tone={isGuardianActive ? "info" : "warning"} title={isGuardianActive ? (translations.shipping?.activeTitle || "Active") : (translations.shipping?.inactiveTitle || "Action Required")}>
                      <p>{isGuardianActive ? translations.shipping?.activeDesc : translations.shipping?.inactiveDesc}</p>
                    </Banner>
                    <div style={{ display: 'flex' }}>
                      <Button onClick={() => open('shopify://admin/settings/shipping', '_blank')}>{isGuardianActive ? (translations.shipping?.manageBtn || "Manage") : (translations.shipping?.configureBtn || "Configure")}</Button>
                    </div>
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>

            <Box paddingBlockStart="200">
              <Card background="bg-surface-secondary">
                <Checkbox 
                  label={translations.onboarding?.step3ConfirmLabel || "I confirm I have enabled the required Checkout and Shipping extensions."} 
                  checked={isStep3Confirmed} 
                  onChange={setIsStep3Confirmed} 
                  disabled={!isEnforcerActive || !isGuardianActive}
                  helpText={(!isEnforcerActive || !isGuardianActive) ? (translations.onboarding?.step3HelpLocked || "Please activate both extensions above to unlock this checkbox.") : (translations.onboarding?.step3HelpUnlocked || "Both extensions are active! You may proceed.")}
                />
              </Card>
            </Box>
          </BlockStack>
        )}

        {/* --- STEP 4: TEMPLATE PATCHING (OPTIONAL) --- */}
        {step === 4 && (
          <BlockStack gap="400">
            <InlineStack gap="300" blockAlign="center">
              <Text variant="headingLg" as="h1">{translations.orderConfirm?.pageTitle || "Update Order Confirmations"}</Text>
              <Badge tone="info">{translations.onboarding?.optionalBadge || "Optional Final Step"}</Badge>
            </InlineStack>
            
            <Text as="p" tone="subdued">
              {translations.orderConfirm?.pageDesc || "Because Group Buys only capture payments if they reach their goal, you can optionally update your Shopify Order Confirmation email template to explain this to customers so they don't get confused. If you prefer your standard emails, you can skip this step."}
            </Text>
            
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">{translations.orderConfirm?.boxTitle}</Text>
                
                <div style={{ paddingLeft: '16px', color: 'var(--p-color-text)' }}>
                  <ol style={{ margin: 0, padding: 0, listStylePosition: 'inside', lineHeight: '1.6' }}>
                    <li>{translations.orderConfirm?.step1 || "Open your Shopify Email Templates."}</li>
                    <li>{translations.orderConfirm?.step2_1}<strong>{translations.orderConfirm?.step2_strong || "Order confirmation"}</strong>{translations.orderConfirm?.step2_2}</li>
                    <li>{translations.orderConfirm?.step3_1}<strong>{translations.orderConfirm?.step3_strong || "Edit code"}</strong>{translations.orderConfirm?.step3_2}</li>
                    <li>
                      {translations.orderConfirm?.step4_1 || "Find the line:"} <br/> 
                      <code style={{ backgroundColor: 'var(--p-color-bg-surface-secondary)', padding: '2px 4px', borderRadius: '4px' }}>
                        {translations.orderConfirm?.step4_code || "{% capture email_body %}"}
                      </code>
                    </li>
                    <li>{translations.orderConfirm?.step5_1}<strong>{translations.orderConfirm?.step5_strong || "paste"}</strong>{translations.orderConfirm?.step5_2}</li>
                  </ol>
                </div>

                <div style={{ position: 'relative', backgroundColor: 'var(--p-color-bg-surface-secondary)', padding: '16px', borderRadius: '8px', border: '1px solid var(--p-color-border-subdued)' }}>
                  {/* ✨ NEW: Language Selector */}
                  <Box paddingBlockEnd="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <div style={{ width: '200px' }}>
                        <Select
                          label="Code Language"
                          labelHidden
                          options={[
                            { label: 'English', value: 'en' },
                            { label: '繁體中文 (Traditional Chinese)', value: 'zh-TW' },
                          ]}
                          onChange={setCodeLang}
                          value={codeLang}
                        />
                      </div>
                      <Button size="micro" onClick={() => {
                        navigator.clipboard.writeText(emailCodeSnippets[codeLang]);
                        shopify.toast.show(translations.orderConfirm?.copiedToast || "Code copied!");
                      }}>
                        {codeLang === 'zh-TW' 
                          ? (translations.orderConfirm?.copyBtnZh || "Copy Chinese Code") 
                          : (translations.orderConfirm?.copyBtnEn || "Copy English Code")}
                      </Button>
                    </InlineStack>
                  </Box>

                  {/* ✨ The Code Display */}
                  <div style={{ overflowX: 'auto' }}>
                    <pre style={{ margin: 0, fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace' }}>
                      {emailCodeSnippets[codeLang]}
                    </pre>
                  </div>
                </div>

                <InlineStack gap="300" blockAlign="center">
                  <Button onClick={() => open('shopify://admin/email_templates/order_confirmation/edit', '_blank')}>
                    {translations.orderConfirm?.openBtn || "Open Template"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        )}

        {/* --- NAVIGATION FOOTER --- */}
        <Box paddingBlockStart="400">
          <InlineStack align="space-between">
            {step > 1 ? (
              <Button onClick={handleBack}>{translations.onboarding?.prevBtn || "Previous Step"}</Button>
            ) : (
              <div></div> 
            )}
            
            {step < totalSteps ? (
              <Button variant="primary" onClick={handleNext} disabled={isNextDisabled()}>
                {translations.onboarding?.nextBtn || "Next Step"}
              </Button>
            ) : (
              <Button variant="primary" onClick={handleComplete} loading={fetcher.state !== "idle"}>
                {translations.onboarding?.completeBtn || "Complete Setup & Enter Dashboard"}
              </Button>
            )}
          </InlineStack>
        </Box>

      </BlockStack>
    </Page>
  );
}