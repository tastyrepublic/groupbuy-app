import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, Button, Link, InlineStack } from "@shopify/polaris";
import { ExternalIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { getI18n } from "../utils/i18n.server.js";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { t } = await getI18n(request);

  const translations = {
    title: t("Support.title", "Help & Support"),
    faq: t("Support.faq", { returnObjects: true }),
    contact: t("Support.contact", { returnObjects: true })
  };

  return json({ translations });
};

export default function SupportPage() {
  const { translations } = useLoaderData();
  
  // Replace this with your actual future FAQ URL
  const faqUrl = "https://yourwebsite.com/faq"; 
  const supportEmail = "support@yourwebsite.com";

  return (
    <Page title={translations.title}>
      <Layout>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">{translations.faq.title}</Text>
              <Text as="p" tone="subdued">{translations.faq.description}</Text>
              <InlineStack>
                <Button url={faqUrl} target="_blank" icon={ExternalIcon}>
                  {translations.faq.button}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">{translations.contact.title}</Text>
              <Text as="p" tone="subdued">{translations.contact.description}</Text>
              <BlockStack gap="200">
                <Text as="p" fontWeight="semibold">{translations.contact.emailLabel}</Text>
                <Link url={`mailto:${supportEmail}`}>{supportEmail}</Link>
                <Text as="p" variant="bodySm" tone="subdued">
                  {translations.contact.responseTime}
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}