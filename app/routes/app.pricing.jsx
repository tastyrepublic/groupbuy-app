import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { 
  Page, 
  Layout, 
  Card, 
  BlockStack, 
  Text, 
  Button, 
  Badge, 
  Divider,
  InlineStack,
  Box,
  Icon
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { getI18n } from "../utils/i18n.server.js";

// ✨ 1. Check if the merchant is already subscribed using billing.check()
export const loader = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  const { t } = await getI18n(request);

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

  await billing.request({
    plan: "Premium Plan",
    isTest: true, // ⚠️ Change to false before submitting to the App Store
    returnUrl: `${process.env.SHOPIFY_APP_URL}/app/pricing`, 
  });

  // ✨ FIXED: Return a valid JSON response instead of null just to be completely safe
  return json({ success: true }); 
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
          <Box paddingBlockStart="400" paddingBlockEnd="800">
            <div style={{ maxWidth: '500px', margin: '0 auto' }}>
              <Card padding="0"> 
                
                {/* Colored Hero Header Section */}
                <Box padding="500" background="bg-surface-magic-subdued">
                  <BlockStack gap="200" inlineAlign="center">
                    <Text as="h2" variant="headingXl">{translations.plan.title}</Text>
                    {isPremium ? (
                      <Badge tone="success" size="large">{translations.plan.actionActive}</Badge>
                    ) : (
                      <Badge tone="info" size="large">{translations.plan.trial}</Badge>
                    )}
                  </BlockStack>
                </Box>

                {/* Main Content Section */}
                <Box padding="500">
                  <BlockStack gap="500">
                    
                    {/* Price Focus */}
                    <BlockStack gap="100" inlineAlign="center">
                      <Text as="p" variant="heading3xl">{translations.plan.price}</Text>
                    </BlockStack>

                    {/* Massive Call to Action */}
                    <BlockStack gap="200">
                      <Button 
                        size="large" 
                        variant="primary" 
                        fullWidth 
                        onClick={handleUpgrade}
                        loading={isUpgrading}
                        disabled={isPremium}
                      >
                        {isPremium ? translations.plan.actionActive : translations.plan.actionStart}
                      </Button>
                      <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                        {translations.plan.trust}
                      </Text>
                    </BlockStack>

                    <Divider />

                    {/* ✨ PERFECTLY ALIGNED FEATURE LIST - POLARIS NATIVE WAY */}
                    <InlineStack align="center">
                      <BlockStack gap="300" inlineAlign="start">
                        <Text as="h3" variant="headingSm">{translations.plan.includes}</Text>
                        
                        {translations.plan.features.map((feature, idx) => (
                          <InlineStack key={idx} gap="200" wrap={false} blockAlign="start">
                            {/* Box handles the slight downward nudge to align the icon with text */}
                            <Box paddingBlockStart="025">
                              <Icon source={CheckIcon} tone="success" />
                            </Box>
                            <Text as="span" variant="bodyMd">{feature}</Text>
                          </InlineStack>
                        ))}

                      </BlockStack>
                    </InlineStack>

                  </BlockStack>
                </Box>
              </Card>
            </div>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}