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

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  
  // Fetch settings for the current shop (defaulting if none exist)
  let settings = await db.settings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings) {
    settings = {
      autoContinueSelling: true,
      disableContinueSellingOnEnd: true,
    };
  }

  return json({ settings });
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

// app.routes.app.settings.jsx

export default function SettingsPage() {
  const { settings } = useLoaderData();
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
      app.toast.show("Settings saved");
    }
  }, [fetcher.state, fetcher.data, app]);

  return (
    <Page
      title="Settings"
      backAction={{ url: "/app" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        loading: fetcher.state !== "idle",
        disabled: !isDirty,
      }}
    >
      {/* ✨ The Best Layout: Uses BlockStack for vertical rhythm and Box for responsive side-breathing */}
      <Box paddingInline={{ xs: '400', sm: '0' }} paddingBlockEnd="800">
        <BlockStack gap="500">
          <Layout>
            <Layout.AnnotatedSection
              title="Inventory Automation"
              description="Automatically update product inventory settings when group buy campaigns start or end."
            >
              <Card>
                <FormLayout>
                  <Checkbox
                    label="Enable 'Continue selling when out of stock' on campaign creation"
                    helpText="Ensures customers can join the group buy even if physical inventory is zero."
                    checked={autoContinueSelling}
                    onChange={(val) => setAutoContinueSelling(val)}
                  />
                  <Checkbox
                    label="Disable 'Continue selling' when campaign ends or is deleted"
                    helpText="Reverts the product to its original inventory behavior once the campaign is inactive."
                    checked={disableContinueSellingOnEnd}
                    onChange={(val) => setDisableContinueSellingOnEnd(val)}
                  />
                </FormLayout>
              </Card>
            </Layout.AnnotatedSection>

            <Layout.AnnotatedSection
              title="Future Upgrades"
              description="Manage experimental features and future app enhancements."
            >
              <Card>
                <Box padding="400">
                  <Text as="p" tone="subdued">
                    New beta features and automation settings will appear here in future updates.
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