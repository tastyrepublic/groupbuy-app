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
} from "@shopify/polaris";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { useAppBridge } from "@shopify/app-bridge-react";

// ✨ 1. Import your new i18n utility
import { getI18n } from "../utils/i18n.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  
  let settings = await db.settings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings) {
    settings = {
      autoContinueSelling: true,
      disableContinueSellingOnEnd: true,
      enableBadge: false, // ✨ Added default
      enableTimer: false, // ✨ Added default
    };
  }

  // ✨ 2. Fetch translations on the server
  const { t } = await getI18n(request);

  // ✨ 3. Package the translated strings into the loader data using returnObjects for cleaner code
  const translations = {
    title: t("Settings.title", "Settings"),
    saveButton: t("Settings.save", "Save"),
    toastSaved: t("Settings.saved", "Settings saved"),
    inventory: t("Settings.inventory", { returnObjects: true }),
    storefront: t("Settings.storefront", { returnObjects: true }),
    future: t("Settings.future", { returnObjects: true })
  };

  return json({ settings, translations });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const autoContinueSelling = formData.get("autoContinueSelling") === "true";
  const disableContinueSellingOnEnd = formData.get("disableContinueSellingOnEnd") === "true";
  
  // ✨ Parse the new storefront toggles
  const enableBadge = formData.get("enableBadge") === "true";
  const enableTimer = formData.get("enableTimer") === "true";

  // ✨ Save everything to the database
  await db.settings.upsert({
    where: { shop: session.shop },
    update: { 
      autoContinueSelling, 
      disableContinueSellingOnEnd,
      enableBadge,
      enableTimer
    },
    create: { 
      shop: session.shop, 
      autoContinueSelling, 
      disableContinueSellingOnEnd,
      enableBadge,
      enableTimer 
    },
  });

  return json({ success: true });
};

export default function SettingsPage() {
  const { settings, translations } = useLoaderData();
  const fetcher = useFetcher();
  const app = useAppBridge();

  const [autoContinueSelling, setAutoContinueSelling] = useState(settings.autoContinueSelling);
  const [disableContinueSellingOnEnd, setDisableContinueSellingOnEnd] = useState(settings.disableContinueSellingOnEnd);

  // ✨ Initialize state directly from the database load
  const [enableBadge, setEnableBadge] = useState(settings.enableBadge || false);
  const [enableTimer, setEnableTimer] = useState(settings.enableTimer || false);

  const isDirty = 
    autoContinueSelling !== settings.autoContinueSelling || 
    disableContinueSellingOnEnd !== settings.disableContinueSellingOnEnd ||
    enableBadge !== settings.enableBadge || 
    enableTimer !== settings.enableTimer;

  const handleSave = () => {
    fetcher.submit(
      { 
        autoContinueSelling: String(autoContinueSelling), 
        disableContinueSellingOnEnd: String(disableContinueSellingOnEnd),
        enableBadge: String(enableBadge),
        enableTimer: String(enableTimer)
      }, 
      { method: "post" }
    );
  };

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
        onAction: handleSave,
        loading: fetcher.state !== "idle",
        disabled: !isDirty,
      }}
    >
      <Box paddingInline={{ xs: '400', sm: '0' }} paddingBlockEnd="800">
        <BlockStack gap="500">
          <Layout>
            <Layout.AnnotatedSection
              title={translations.inventory.title} 
              description={translations.inventory.description}
            >
              <Card>
                <FormLayout>
                  <Checkbox
                    label={translations.inventory.enableLabel}
                    helpText={translations.inventory.enableHelp}
                    checked={autoContinueSelling}
                    onChange={(val) => setAutoContinueSelling(val)}
                  />
                  <Checkbox
                    label={translations.inventory.disableLabel}
                    helpText={translations.inventory.disableHelp}
                    checked={disableContinueSellingOnEnd}
                    onChange={(val) => setDisableContinueSellingOnEnd(val)}
                  />
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            {/* ✨ NEW: Storefront Display Settings Section */}
            <Layout.AnnotatedSection
              title={translations.storefront.title}
              description={translations.storefront.description}
            >
              <Card>
                <FormLayout>
                  <Checkbox
                    label={translations.storefront.badgeLabel}
                    helpText={translations.storefront.badgeHelp}
                    checked={enableBadge}
                    onChange={(val) => setEnableBadge(val)}
                  />
                  <Checkbox
                    label={translations.storefront.timerLabel}
                    helpText={translations.storefront.timerHelp}
                    checked={enableTimer}
                    onChange={(val) => setEnableTimer(val)}
                  />
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title={translations.future.title}
              description={translations.future.description}
            >
              <Card>
                <Box padding="400">
                  <Text as="p" tone="subdued">
                    {translations.future.text}
                  </Text>
                </Box>
              </Card>
            </Layout.AnnotatedSection>
          </Layout>
        </BlockStack>
      </Box>
    </Page>
  );
}