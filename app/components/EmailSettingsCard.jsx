import { useState, useEffect } from "react";
import { useFetcher } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Layout, Card, Checkbox, BlockStack, Text, Box, FormLayout, Button, TextField, Divider, ButtonGroup, InlineStack, Icon, Banner,
} from "@shopify/polaris";
import { EmailIcon, ImageIcon } from '@shopify/polaris-icons';

// ✨ IMPORT THE SHARED DICTIONARY
import { SUPPORTED_LANGUAGES, EMAIL_LOCALE_DICT } from "../utils/emailDictionary";

const parseSafe = (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } };

export default function EmailSettingsCard({ settings, shopEmail, translations, onStateChange }) {
  const fetcher = useFetcher();
  const app = useAppBridge();

  const [activeLang, setActiveLang] = useState(SUPPORTED_LANGUAGES[0].code);
  const [activeTemplate, setActiveTemplate] = useState("SUCCESS");
  const [previewRole, setPreviewRole] = useState("LEADER"); 
  const [testEmailAddress, setTestEmailAddress] = useState(shopEmail);
  
  // ✨ NEW: State to control if the preview box is visible (Defaults to false/hidden)
  const [showPreview, setShowPreview] = useState(false);

  const [successSubjectObj, setSuccessSubjectObj] = useState(parseSafe(settings.successEmailSubject, { "EN": "Great news! Your Group Buy succeeded 🎉", "ZH-TW": "好消息！您的團購已成功 🎉" }));
  const [successBodyObj, setSuccessBodyObj] = useState(parseSafe(settings.successEmailBody, { "EN": "Your group buy reached its goal! Your payment will be captured shortly, and your item is currently being processed for shipping.", "ZH-TW": "您的團購已達標！我們即將為您進行扣款，商品目前正在處理中，即將為您出貨。" }));
  const [failedSubjectObj, setFailedSubjectObj] = useState(parseSafe(settings.failedEmailSubject, { "EN": "Update on your Group Buy", "ZH-TW": "關於您的團購更新" }));
  const [failedBodyObj, setFailedBodyObj] = useState(parseSafe(settings.failedEmailBody, { "EN": "Unfortunately, the group buy did not reach its goal this time. We have canceled your order and voided the payment authorization. No funds were captured.", "ZH-TW": "很遺憾，本次團購未達目標。我們已取消您的訂單，並取消了您的信用卡授權，不會向您收取任何費用。" }));

  const [sendSuccessEmail, setSendSuccessEmail] = useState(settings.sendSuccessEmail);
  const [sendFailedEmail, setSendFailedEmail] = useState(settings.sendFailedEmail);

  const [emailLogoUrl, setEmailLogoUrl] = useState(settings.emailLogoUrl);
  const [emailStoreAddress, setEmailStoreAddress] = useState(settings.emailStoreAddress);
  const [emailHeaderColor, setEmailHeaderColor] = useState(settings.emailHeaderColor);

  const handleUpdate = (setter, obj, lang, value) => setter({ ...obj, [lang]: value });

  useEffect(() => {
    const isDirty = 
      sendSuccessEmail !== settings.sendSuccessEmail || sendFailedEmail !== settings.sendFailedEmail ||
      emailLogoUrl !== settings.emailLogoUrl || emailStoreAddress !== settings.emailStoreAddress || emailHeaderColor !== settings.emailHeaderColor ||
      JSON.stringify(successSubjectObj) !== settings.successEmailSubject || JSON.stringify(successBodyObj) !== settings.successEmailBody ||
      JSON.stringify(failedSubjectObj) !== settings.failedEmailSubject || JSON.stringify(failedBodyObj) !== settings.failedEmailBody;

    onStateChange({
      isDirty,
      data: {
        sendSuccessEmail: String(sendSuccessEmail), sendFailedEmail: String(sendFailedEmail),
        successEmailSubject: JSON.stringify(successSubjectObj), successEmailBody: JSON.stringify(successBodyObj),
        failedEmailSubject: JSON.stringify(failedSubjectObj), failedEmailBody: JSON.stringify(failedBodyObj),
        emailLogoUrl, emailStoreAddress, emailHeaderColor
      }
    });
  }, [sendSuccessEmail, sendFailedEmail, successSubjectObj, successBodyObj, failedSubjectObj, failedBodyObj, emailLogoUrl, emailStoreAddress, emailHeaderColor, settings, onStateChange]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && fetcher.data.action === "test") {
      
      // ✨ Pull the translation and swap the placeholder
      const toastMessage = translations.email?.testSentToast?.replace('{{email}}', testEmailAddress) 
        || `Test email sent to ${testEmailAddress}`; // Fallback just in case
        
      app.toast.show(toastMessage);
      
    } else if (fetcher.data?.error) {
      // You can also translate the error message here if you want!
      const errorMessage = translations.email?.testErrorToast?.replace('{{error}}', fetcher.data.error)
        || `Error sending email: ${fetcher.data.error}`;
        
      app.toast.show(errorMessage, { isError: true });
    }
  }, [fetcher.state, fetcher.data, app, testEmailAddress, translations]); // Added translations to dependencies

  const handleTestEmail = () => {
    const subject = activeTemplate === "SUCCESS" ? successSubjectObj[activeLang] : failedSubjectObj[activeLang];
    const body = activeTemplate === "SUCCESS" ? successBodyObj[activeLang] : failedBodyObj[activeLang];
    
    fetcher.submit({ 
      _action: "test_email", testEmail: testEmailAddress, subject, body, emailLogoUrl, emailStoreAddress, emailHeaderColor, activeLang,
      previewRole: activeTemplate === "SUCCESS" ? previewRole : "MEMBER",
      isSuccessTab: String(activeTemplate === "SUCCESS")
    }, { method: "post" });
  };

  const renderPreview = (subject, body, isSuccessType) => {
    const t = EMAIL_LOCALE_DICT[activeLang] || EMAIL_LOCALE_DICT["EN"];

    return (
      <Box background="bg-surface-secondary" padding="400" borderRadius="200">
        <BlockStack gap="300">
          <Text variant="headingSm">{translations.email?.livePreview || "Live Preview"} ({activeLang})</Text>
          
          <div style={{ background: "#fff", border: "1px solid #dfe3e8", borderRadius: "8px", overflow: 'hidden' }}>
            <div style={{ background: emailHeaderColor || '#000', padding: '20px', textAlign: 'center' }}>
              {emailLogoUrl ? (
                <img src={emailLogoUrl} alt="Logo" style={{ maxHeight: '40px', maxWidth: '150px' }} />
              ) : (
                <h1 style={{ color: '#fff', margin: 0, fontSize: '18px' }}>{t.header}</h1>
              )}
            </div>
            
            <div style={{ padding: '20px' }}>
              <h2 style={{ margin: "0 0 10px 0", fontSize: "16px", color: "#333" }}>{subject}</h2>
              <p style={{ margin: "0", color: "#444", whiteSpace: "pre-wrap", fontSize: '14px' }}>{body}</p>
              
              <div style={{ marginTop: "24px", padding: "16px", border: "1px solid #e3e3e3", borderRadius: "6px", backgroundColor: "#fafafa" }}>
                <p style={{ margin: "0 0 12px 0", fontSize: "13px", fontWeight: "600", color: "#202223", borderBottom: "1px solid #e3e3e3", paddingBottom: "8px" }}>
                  {t.summary}
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: "15px" }}>
                  <div style={{ width: "50px", height: "50px", backgroundColor: "#e9ecef", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px" }}>🎧</div>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: "0", fontSize: "14px", fontWeight: "600", color: "#202223" }}>{t.product}</p>
                    <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#6d7175" }}>{t.variant}</p>
                  </div>
                  <div><p style={{ margin: "0", fontSize: "14px", color: "#444" }}>{t.qtyUi}</p></div>
                </div>
              </div>

              {isSuccessType && previewRole === "LEADER" && (
                <div style={{ marginTop: "16px", padding: "12px", borderRadius: "6px", backgroundColor: "#eaf3ff", border: "1px solid #b6d4fe", color: "#084298", fontSize: "13px", lineHeight: "1.5" }}>
                  <strong style={{ display: "block", marginBottom: "4px" }}>{t.breakTitle}</strong>
                  <span dangerouslySetInnerHTML={{ __html: t.breakDesc(2, 50, 20) }} />
                </div>
              )}

              <p style={{ marginTop: "24px", fontSize: "12px", color: "#888" }}>{t.ref} <strong>#1001</strong></p>
            </div>

            <div style={{ background: '#fafafa', padding: '15px', textAlign: 'center', borderTop: '1px solid #e3e3e3' }}>
              <p style={{ margin: "0 0 5px 0", fontSize: "11px", color: "#8c9196" }}>{t.thanks}</p>
              {emailStoreAddress && <p style={{ margin: "0", fontSize: "10px", color: "#a0a5aa" }}>{emailStoreAddress}</p>}
            </div>
          </div>

          <InlineStack gap="300" blockAlign="center">
            <TextField value={testEmailAddress} onChange={setTestEmailAddress} placeholder={translations.email?.testEmailPlaceholder || "test@email.com"} autoComplete="off" />
            <Button icon={EmailIcon} onClick={handleTestEmail} loading={fetcher.state !== "idle"}>
              {translations.email?.sendTest || "Send Test"}
            </Button>
          </InlineStack>
        </BlockStack>
      </Box>
    );
  };

  const isSuccessTab = activeTemplate === "SUCCESS";
  const currentSubjectObj = isSuccessTab ? successSubjectObj : failedSubjectObj;
  const currentBodyObj = isSuccessTab ? successBodyObj : failedBodyObj;
  const setSubjectObj = isSuccessTab ? setSuccessSubjectObj : setFailedSubjectObj;
  const setBodyObj = isSuccessTab ? setSuccessBodyObj : setFailedSubjectObj;
  const isEnabled = isSuccessTab ? sendSuccessEmail : sendFailedEmail;
  const setToggle = isSuccessTab ? setSendSuccessEmail : setSendFailedEmail;

  return (
    <Layout.AnnotatedSection title={translations.email?.title || "Email Notifications"} description={translations.email?.description}>
      <Card>
        <BlockStack gap="400">
          
          {/* ✨ NEW: Contact Email Check Banner (Consistent with Checkout/Shipping cards) */}
          <Banner 
            tone={!settings.contactEmail ? "warning" : "info"} 
            title={!settings.contactEmail ? (translations.email?.missingEmailTitle || "Missing Customer Support Email") : (translations.email?.activeEmailTitle || "Reply-To Address Configured")}
          >
            <p>
              {!settings.contactEmail 
                ? <>{translations.email?.missingEmailDesc || "We couldn't find a public 'Sender email' for your store. If customers reply to these automated emails, their messages might bounce. Please add a Sender Email in your "}<strong>Shopify Settings &gt; Store Details</strong>.</>
                : <>{translations.email?.activeEmailDesc || "When customers reply to these notifications, the emails will be routed directly to your support inbox: "}<strong>{settings.contactEmail}</strong>.</>
              }
            </p>
          </Banner>
          
          <div style={{ display: 'flex' }}>
            <Button onClick={() => open('shopify://admin/settings/notifications', '_top')}>
              {!settings.contactEmail ? (translations.email?.fixEmailBtn || "Update in Shopify") : (translations.email?.changeEmailBtn || "Change Email")}
            </Button>
          </div>

          <Text variant="headingSm" as="h3">{translations.email?.brandStyling || "Brand Styling"}</Text>
          <FormLayout>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
              {emailLogoUrl ? (
                <div style={{ width: '60px', height: '60px', borderRadius: '8px', border: '1px solid #dfe3e8', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: '#fff', flexShrink: 0, marginTop: '24px' }}>
                  <img src={emailLogoUrl} alt="Logo preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                </div>
              ) : (
                <div style={{ width: '60px', height: '60px', borderRadius: '8px', border: '1px dashed #c9cccf', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fafafa', flexShrink: 0, marginTop: '24px' }}>
                  <Icon source={ImageIcon} tone="subdued" />
                </div>
              )}
              <div style={{ flex: 1 }}>
                <TextField label={translations.email?.logoUrl || "Store Logo URL"} helpText={translations.email?.logoHelp} value={emailLogoUrl} onChange={setEmailLogoUrl} autoComplete="off" />
              </div>
            </div>
            <FormLayout.Group>
              <TextField label={translations.email?.headerColor || "Header Color"} type="color" value={emailHeaderColor} onChange={setEmailHeaderColor} autoComplete="off" />
              <TextField label={translations.email?.storeAddress || "Store Physical Address"} helpText={translations.email?.storeAddressHelp} value={emailStoreAddress} onChange={setEmailStoreAddress} autoComplete="off" />
            </FormLayout.Group>
          </FormLayout>
          
          <Divider />

          <InlineStack align="space-between">
            <BlockStack gap="200">
              <Text variant="headingSm" as="h3">{translations.email?.emailType || "Email Type:"}</Text>
              <ButtonGroup variant="segmented">
                <Button pressed={activeTemplate === "SUCCESS"} onClick={() => setActiveTemplate("SUCCESS")}>{translations.email?.successTab || "Success Email"}</Button>
                <Button pressed={activeTemplate === "FAILED"} onClick={() => setActiveTemplate("FAILED")}>{translations.email?.failedTab || "Failed Email"}</Button>
              </ButtonGroup>
            </BlockStack>

            {isSuccessTab && (
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">{translations.email?.previewRole || "Preview Role:"}</Text>
                <ButtonGroup variant="segmented">
                  <Button pressed={previewRole === "LEADER"} onClick={() => setPreviewRole("LEADER")}>{translations.email?.roleLeader || "Leader"}</Button>
                  <Button pressed={previewRole === "MEMBER"} onClick={() => setPreviewRole("MEMBER")}>{translations.email?.roleMember || "Member"}</Button>
                </ButtonGroup>
              </BlockStack>
            )}
            
            <BlockStack gap="200">
              <Text variant="headingSm" as="h3">{translations.email?.templateLanguage || "Template Language:"}</Text>
              <ButtonGroup variant="segmented">
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <Button 
                    key={lang.code} 
                    pressed={activeLang === lang.code} 
                    onClick={() => setActiveLang(lang.code)}
                  >
                    {lang.label}
                  </Button>
                ))}
              </ButtonGroup>
            </BlockStack>
          </InlineStack>

          <Box paddingBlockStart="200">
            <Checkbox 
              label={isSuccessTab ? translations.email?.successToggle : translations.email?.failedToggle} 
              checked={isEnabled} 
              onChange={setToggle} 
            />
          </Box>
          
          {isEnabled && (
            <Box paddingInlineStart="400" paddingBlockEnd="400">
              <FormLayout>
                <TextField 
                  label={isSuccessTab ? translations.email?.successSubject : translations.email?.failedSubject} 
                  value={currentSubjectObj[activeLang] || ""} 
                  onChange={(v) => handleUpdate(setSubjectObj, currentSubjectObj, activeLang, v)} 
                  autoComplete="off" 
                />
                <TextField 
                  label={isSuccessTab ? translations.email?.successBody : translations.email?.failedBody} 
                  value={currentBodyObj[activeLang] || ""} 
                  onChange={(v) => handleUpdate(setBodyObj, currentBodyObj, activeLang, v)} 
                  multiline={4} 
                  autoComplete="off" 
                />
                
                {/* ✨ NEW: The Toggle Button that controls the preview visibility */}
                <div style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                  <InlineStack>
                    <Button onClick={() => setShowPreview(!showPreview)}>
                      {showPreview 
                        ? (translations.email?.hidePreview || "Hide Email Preview") 
                        : (translations.email?.showPreview || "Show Email Preview")}
                    </Button>
                  </InlineStack>
                </div>

                {/* ✨ NEW: Only render the massive preview box if showPreview is true! */}
                {showPreview && renderPreview(currentSubjectObj[activeLang], currentBodyObj[activeLang], isSuccessTab)}
              </FormLayout>
            </Box>
          )}

        </BlockStack>
      </Card>
    </Layout.AnnotatedSection>
  );
}