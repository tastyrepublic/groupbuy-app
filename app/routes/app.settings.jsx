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
    };
  }

  // ✨ 2. Fetch translations on the server
  const { t } = await getI18n(request);

  // ✨ 3. Package the translated strings into the loader data
  // (I've added English fallbacks here just in case your JSON files aren't perfectly set up yet)
  const translations = {
    title: t("Settings.title", "Settings"),
    saveButton: t("Settings.save", "Save"),
    toastSaved: t("Settings.saved", "Settings saved"),
    inventory: {
      title: t("Settings.inventory.title", "Inventory Automation"),
      desc: t("Settings.inventory.description", "Automatically update product inventory settings when group buy campaigns start or end."),
      enableLabel: t("Settings.inventory.enableLabel", "Enable 'Continue selling when out of stock' on campaign creation"),
      enableHelp: t("Settings.inventory.enableHelp", "Ensures customers can join the group buy even if physical inventory is zero."),
      disableLabel: t("Settings.inventory.disableLabel", "Disable 'Continue selling' when campaign ends or is deleted"),
      disableHelp: t("Settings.inventory.disableHelp", "Reverts the product to its original inventory behavior once the campaign is inactive.")
    },
    future: {
      title: t("Settings.future.title", "Future Upgrades"),
      desc: t("Settings.future.description", "Manage experimental features and future app enhancements."),
      text: t("Settings.future.text", "New beta features and automation settings will appear here in future updates.")
    }
  };

  return json({ settings, translations });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const autoContinueSelling = formData.get("autoContinueSelling") === "true";
  const disableContinueSellingOnEnd = formData.get("disableContinueSellingOnEnd") === "true";

  await db.settings.upsert({
    where: { shop: session.shop },
    update: { autoContinueSelling, disableContinueSellingOnEnd },
    create: { 
      shop: session.shop, 
      autoContinueSelling, 
      disableContinueSellingOnEnd 
    },
  });

  return json({ success: true });
};

export default function SettingsPage() {
  // ✨ 4. Extract translations from useLoaderData
  const { settings, translations } = useLoaderData();
  const fetcher = useFetcher();
  const app = useAppBridge();

  const [autoContinueSelling, setAutoContinueSelling] = useState(settings.autoContinueSelling);
  const [disableContinueSellingOnEnd, setDisableContinueSellingOnEnd] = useState(settings.disableContinueSellingOnEnd);

  const isDirty = 
    autoContinueSelling !== settings.autoContinueSelling || 
    disableContinueSellingOnEnd !== settings.disableContinueSellingOnEnd;

  const handleSave = () => {
    fetcher.submit(
      { 
        autoContinueSelling: String(autoContinueSelling), 
        disableContinueSellingOnEnd: String(disableContinueSellingOnEnd) 
      }, 
      { method: "post" }
    );
  };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      app.toast.show(translations.toastSaved); // ✨ Translated Toast
    }
  }, [fetcher.state, fetcher.data, app, translations]);

  return (
    <Page
      title={translations.title} // ✨ Translated Title
      backAction={{ url: "/app" }}
      primaryAction={{
        content: translations.saveButton, // ✨ Translated Button
        onAction: handleSave,
        loading: fetcher.state !== "idle",
        disabled: !isDirty,
      }}
    >
      <Box paddingInline={{ xs: '400', sm: '0' }} paddingBlockEnd="800">
        <BlockStack gap="500">
          <Layout>
            <Layout.AnnotatedSection
              title={translations.inventory.title} // ✨ Translated Text
              description={translations.inventory.desc}
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

            <Layout.AnnotatedSection
              title={translations.future.title}
              description={translations.future.desc}
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