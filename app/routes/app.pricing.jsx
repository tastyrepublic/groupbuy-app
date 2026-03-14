import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { 
  Page, 
  Layout, 
  Card, 
  BlockStack, 
  Text, 
  Button, 
  List, 
  Badge, 
  Divider,
  InlineStack,
  Box
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getI18n } from "../utils/i18n.server.js";

// ✨ 1. Check if the merchant is already subscribed using billing.check()
export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  const { t } = await getI18n(request);

  // Safely check active subscriptions without forcing a redirect
  const billingCheck = await billing.check({
    plans: ["Premium Plan"],
    isTest: true, // ⚠️ Change to false before submitting to the App Store
  });

  const isPremium = billingCheck.hasActivePayment;

  const translations = {
    title: t("Pricing.title", "Subscription Plan"),
    description: t("Pricing.description", "Start your 30-day free trial today."),
    plan: t("Pricing.plan", { returnObjects: true })
  };

  return json({ translations, isPremium });
};

// ✨ 2. Trigger the Shopify Payment Screen using billing.request()
export const action = async ({ request }) => {
  const { billing } = await authenticate.admin(request);

  // Force the Shopify billing approval screen to open
  await billing.request({
    plan: "Premium Plan",
    isTest: true, // ⚠️ Change to false before submitting to the App Store
    // ✨ FIXED: Removed the extra "https://" because process.env.SHOPIFY_APP_URL already has it!
    returnUrl: `${process.env.SHOPIFY_APP_URL}/app/pricing`, 
  });

  return null; 
};

export default function PricingPage() {
  const { translations, isPremium } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isUpgrading = navigation.state === "submitting";

  const handleUpgrade = () => {
    submit({}, { method: "post" });
  };

  return (
    <Page title={translations.title} subtitle={translations.description}>
      <Layout>
        <Layout.Section>
          <Box paddingBlockStart="400">
            <div style={{ maxWidth: '600px', margin: '0 auto' }}>
              <Card background="bg-surface-secondary">
                <BlockStack gap="500">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingLg">{translations.plan.title}</Text>
                    {isPremium ? (
                      <Badge tone="success">{translations.plan.actionActive}</Badge>
                    ) : (
                      <Badge tone="info">{translations.plan.trial}</Badge>
                    )}
                  </InlineStack>

                  <BlockStack gap="100">
                    <Text as="p" variant="heading3xl">{translations.plan.price}</Text>
                    <Text as="p" tone="subdued">{translations.plan.trial}</Text>
                  </BlockStack>

                  <Button 
                    size="large" 
                    variant="primary" 
                    onClick={handleUpgrade}
                    loading={isUpgrading}
                    disabled={isPremium}
                  >
                    {isPremium ? translations.plan.actionActive : translations.plan.actionStart}
                  </Button>

                  <Divider />

                  <Box paddingBlockStart="200">
                    <List type="bullet">
                      {translations.plan.features.map((feature, idx) => (
                        <List.Item key={idx}>
                          <Text as="span" variant="bodyMd">{feature}</Text>
                        </List.Item>
                      ))}
                    </List>
                  </Box>
                </BlockStack>
              </Card>
            </div>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}