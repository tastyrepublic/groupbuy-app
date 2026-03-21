import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Checkbox,
  BlockStack,
  Text,
  Box,
  FormLayout,
  Button,
  Icon,
  Banner,
} from "@shopify/polaris";
import { 
  InfoIcon, 
  CheckCircleIcon, 
  AlertCircleIcon, 
  ShieldCheckMarkIcon 
} from '@shopify/polaris-icons';
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { getI18n } from "../utils/i18n.server.js";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  let dbSettings = await db.settings.findUnique({
    where: { shop: session.shop },
  });

  if (!dbSettings) {
    dbSettings = { autoContinueSelling: true, disableContinueSellingOnEnd: true };
  }

  const response = await admin.graphql(`
    #graphql
    query checkLiveRules {
      shopifyFunctions(first: 25) {
        nodes {
          id
          title
        }
      }
      validations(first: 10) {
        nodes {
          enabled
          shopifyFunction {
            id
          }
        }
      }
      deliveryCustomizations(first: 10) {
        nodes {
          enabled
          shopifyFunction {
            id
          }
        }
      }
    }
  `);

  const { data } = await response.json();

  const enforcerFunctionId = data?.shopifyFunctions?.nodes?.find(f => f.title.includes("Cart Enforcer"))?.id;
  const guardianFunctionId = data?.shopifyFunctions?.nodes?.find(f => f.title.includes("Shipping Guardian"))?.id;

  const isEnforcerActive = data?.validations?.nodes?.some(
    (rule) => rule.shopifyFunction?.id === enforcerFunctionId && rule.enabled === true
  ) || false;

  const isGuardianActive = data?.deliveryCustomizations?.nodes?.some(
    (cust) => cust.shopifyFunction?.id === guardianFunctionId && cust.enabled === true
  ) || false;

  // ✨ Injecting the new translation scopes
  const { t } = await getI18n(request);
  return json({ 
    settings: dbSettings, 
    isEnforcerActive, 
    isGuardianActive,
    translations: {
      title: t("Settings.title", "Settings"),
      saveButton: t("Settings.save", "Save"),
      toastSaved: t("Settings.saved", "Settings saved"),
      inventory: t("Settings.inventory", { returnObjects: true }),
      checkout: t("Settings.checkout", { returnObjects: true }),
      shipping: t("Settings.shipping", { returnObjects: true })
    }
  });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("_action");
  
  if (actionType === "save_general") {
    const autoContinueSelling = formData.get("autoContinueSelling") === "true";
    const disableContinueSellingOnEnd = formData.get("disableContinueSellingOnEnd") === "true";
    
    await db.settings.upsert({
      where: { shop: session.shop },
      update: { autoContinueSelling, disableContinueSellingOnEnd },
      create: { shop: session.shop, autoContinueSelling, disableContinueSellingOnEnd },
    });
    return json({ success: true });
  }
  return json({ success: false });
};

export default function SettingsPage() {
  const { settings, isEnforcerActive, isGuardianActive, translations } = useLoaderData();
  const fetcher = useFetcher();
  const app = useAppBridge();

  const [autoContinueSelling, setAutoContinueSelling] = useState(settings.autoContinueSelling);
  const [disableContinueSellingOnEnd, setDisableContinueSellingOnEnd] = useState(settings.disableContinueSellingOnEnd);

  const isGeneralDirty = autoContinueSelling !== settings.autoContinueSelling || disableContinueSellingOnEnd !== settings.disableContinueSellingOnEnd;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      app.toast.show(translations.toastSaved); 
    }
  }, [fetcher.state, fetcher.data, app, translations]);

  return (
    <Page
      title={translations.title} 
      backAction={{ url: "/app" }}
      primaryAction={{
        content: translations.saveButton, 
        onAction: () => fetcher.submit({ 
          _action: "save_general", 
          autoContinueSelling: String(autoContinueSelling), 
          disableContinueSellingOnEnd: String(disableContinueSellingOnEnd) 
        }, { method: "post" }),
        loading: fetcher.state !== "idle",
        disabled: !isGeneralDirty,
      }}
    >
      <Box paddingBlockEnd="800" paddingInline={{ xs: '400', sm: '0' }}>
        <BlockStack gap="500">
          <Layout>
            {/* Inventory Control */}
            <Layout.AnnotatedSection 
              title={translations.inventory?.title} 
              description={translations.inventory?.description}
            >
              <Card>
                <FormLayout>
                  <Checkbox 
                    label={translations.inventory?.enableLabel} 
                    helpText={translations.inventory?.enableHelp}
                    checked={autoContinueSelling} 
                    onChange={setAutoContinueSelling} 
                  />
                  <Checkbox 
                    label={translations.inventory?.disableLabel} 
                    helpText={translations.inventory?.disableHelp}
                    checked={disableContinueSellingOnEnd} 
                    onChange={setDisableContinueSellingOnEnd} 
                  />
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            {/* Checkout Protection */}
            <Layout.AnnotatedSection 
              title={translations.checkout?.title} 
              description={translations.checkout?.description}
            >
              <Card>
                <BlockStack gap="400">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ display: 'flex' }}>
                      <Icon source={isEnforcerActive ? ShieldCheckMarkIcon : AlertCircleIcon} tone={isEnforcerActive ? "success" : "critical"} />
                    </span>
                    <Text variant="headingMd" as="h2">{translations.checkout?.boxTitle}</Text>
                  </div>
                  
                  <Banner tone={isEnforcerActive ? "info" : "warning"} title={isEnforcerActive ? translations.checkout?.activeTitle : translations.checkout?.inactiveTitle}>
                    <p>
                      {isEnforcerActive ? translations.checkout?.activeDesc : translations.checkout?.inactiveDesc}
                    </p>
                  </Banner>

                  <div style={{ display: 'flex' }}>
                    <Button onClick={() => open('shopify://admin/settings/checkout', '_top')}>
                      {isEnforcerActive ? translations.checkout?.manageBtn : translations.checkout?.configureBtn}
                    </Button>
                  </div>
                </BlockStack>
              </Card>
            </Layout.AnnotatedSection>

            {/* Shipping Strategy */}
            <Layout.AnnotatedSection 
              title={translations.shipping?.title} 
              description={translations.shipping?.description}
            >
              <Card>
                <BlockStack gap="400">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ display: 'flex' }}>
                      <Icon source={isGuardianActive ? CheckCircleIcon : InfoIcon} tone={isGuardianActive ? "info" : "subdued"} />
                    </span>
                    <Text variant="headingMd" as="h2">{translations.shipping?.boxTitle}</Text>
                  </div>

                  <Banner tone={isGuardianActive ? "info" : "warning"} title={isGuardianActive ? translations.shipping?.activeTitle : translations.shipping?.inactiveTitle}>
                    <p>
                      {isGuardianActive ? translations.shipping?.activeDesc : translations.shipping?.inactiveDesc}
                    </p>
                  </Banner>
                  
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