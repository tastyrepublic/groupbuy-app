import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, Box, Banner, List } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { getI18n } from "../utils/i18n.server.js"; // ✨ Import the translation util

// ✨ Helper function to find the REAL function ID based on its name in the .toml
async function getRealFunctionId(admin) {
  const response = await admin.graphql(`
    query {
      shopifyFunctions(first: 25) {
        nodes {
          id
          title
        }
      }
    }
  `);
  const { data } = await response.json();
  const targetFunction = data?.shopifyFunctions?.nodes?.find(
    (f) => f.title.includes("Group Buy Shipping Guardian")
  );
  return targetFunction ? targetFunction.id : null;
}

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const rawId = decodeURIComponent(params.id); 
  
  // 1. Get the REAL ID directly from Shopify
  const realFunctionId = await getRealFunctionId(admin);

  let activeCustomizationId = "";
  let isActive = false;

  if (rawId !== "new" && realFunctionId) {
    try {
      if (rawId.includes("$")) {
        const findResponse = await admin.graphql(`
          query {
            deliveryCustomizations(first: 50) {
              edges {
                node {
                  id
                  shopifyFunction { id }
                  enabled
                }
              }
            }
          }
        `);
        const findData = await findResponse.json();
        
        const node = findData.data?.deliveryCustomizations?.edges.find(
          (edge) => edge.node.shopifyFunction?.id === realFunctionId
        )?.node;
        
        if (node) {
          activeCustomizationId = node.id;
          isActive = node.enabled;
        }
      } else {
        activeCustomizationId = rawId.startsWith("gid://") ? rawId : `gid://shopify/DeliveryCustomization/${rawId}`;
        const response = await admin.graphql(`
          query getCustomization($id: ID!) {
            deliveryCustomization(id: $id) {
              enabled
            }
          }
        `, { variables: { id: activeCustomizationId } });

        const data = await response.json();
        isActive = data.data?.deliveryCustomization?.enabled || false;
      }
    } catch (error) {
      console.log("Loader Error", error);
    }
  }

  // ✨ Fetch translations for this specific page
  const { t } = await getI18n(request);
  const translations = t("ShippingGuardian", { returnObjects: true });

  return json({ 
    activeCustomizationId, 
    isActive, 
    targetFunctionId: realFunctionId || "NOT FOUND - CHECK TOML NAME",
    translations 
  });
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const { id } = params; 
  const submittedCustomizationId = formData.get("customizationId");
  
  // ✨ 1. Get the translation function inside the action
  const { t } = await getI18n(request);
  
  // ✨ 2. Replace the hardcoded string with your dynamic translation!
  const staticTitle = t("ShippingGuardian.ruleName", "Group Buy Shipping Guardian");  

  // 1. Get the REAL ID before attempting to save
  const realFunctionId = await getRealFunctionId(admin);

  if (!realFunctionId) {
    return json({ success: false, errors: [{ message: "Could not find the Shipping Guardian function in Shopify. Did you deploy it?" }] });
  }

  try {
    const findResponse = await admin.graphql(`
      query {
        deliveryCustomizations(first: 50) {
          edges {
            node {
              id
              shopifyFunction { id }
            }
          }
        }
      }
    `);
    const findData = await findResponse.json();
    const existingRule = findData.data?.deliveryCustomizations?.edges.find(
      (edge) => edge.node.shopifyFunction?.id === realFunctionId
    )?.node;

    let result;

    if (id === "new" || id.includes("$")) {
      if (existingRule) {
        result = await admin.graphql(`
          mutation updateCustomization($id: ID!, $input: DeliveryCustomizationInput!) {
            deliveryCustomizationUpdate(id: $id, deliveryCustomization: $input) {
              userErrors { field message }
            }
          }
        `, {
          variables: { id: existingRule.id, input: { title: staticTitle, enabled: true } } 
        });
      } else {
        result = await admin.graphql(`
          mutation createCustomization($input: DeliveryCustomizationInput!) {
            deliveryCustomizationCreate(deliveryCustomization: $input) {
              userErrors { field message }
            }
          }
        `, {
          variables: {
            input: {
              functionId: realFunctionId, // ✨ Using the dynamically fetched ID!
              title: staticTitle,
              enabled: true
            }
          }
        });
      }
    } else {
      const updateId = submittedCustomizationId || (id.startsWith("gid://") ? id : `gid://shopify/DeliveryCustomization/${id}`);
      result = await admin.graphql(`
        mutation updateCustomization($id: ID!, $input: DeliveryCustomizationInput!) {
          deliveryCustomizationUpdate(id: $id, deliveryCustomization: $input) {
            userErrors { field message }
          }
        }
      `, {
        variables: { id: updateId, input: { title: staticTitle, enabled: true } } 
      });
    }
    
    const responseJson = await result.json();
    
    const errors = responseJson.data?.deliveryCustomizationCreate?.userErrors || 
                   responseJson.data?.deliveryCustomizationUpdate?.userErrors || [];

    if (errors.length > 0) {
      return json({ success: false, errors });
    }

    return json({ success: true });

  } catch (error) {
    return json({ success: false, errors: [{ message: error.message }] });
  }
};

export default function DeliveryCustomizationPage() {
  const { activeCustomizationId, isActive, targetFunctionId, translations } = useLoaderData();
  const actionData = useActionData(); 
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const isSaving = navigation.state === "submitting";
  
  // ✨ Check if this is a brand new rule being created
  const isNewRule = !activeCustomizationId; 

  const handleSave = () => {
    submit({ customizationId: activeCustomizationId }, { method: "post" });
  };

  useEffect(() => {
    if (actionData?.success && isNewRule) {
      shopify.toast.show(translations.toastActivated);
      open('shopify://admin/settings/shipping', '_top'); 
    }
  }, [actionData, shopify, isNewRule, translations]);

  return (
    <Page
      title={translations.pageTitle}
      backAction={{ content: translations.backAction, onAction: () => open('shopify://admin/settings/shipping', '_top') }}
      primaryAction={isNewRule ? {
        content: translations.activateBtn,
        onAction: handleSave,
        loading: isSaving,
        disabled: targetFunctionId.includes("NOT FOUND"),
      } : undefined}
    >
      <Layout>
        <Layout.Section>
          {actionData?.errors && actionData.errors.length > 0 && (
            <Box paddingBlockEnd="400">
              <Banner tone="critical" title={translations.errorRejected}>
                <List>
                  {actionData.errors.map((err, index) => (
                    <List.Item key={index}>{err.field ? `${err.field}: ` : ''}{err.message}</List.Item>
                  ))}
                </List>
              </Banner>
            </Box>
          )}

          {targetFunctionId.includes("NOT FOUND") && (
            <Box paddingBlockEnd="400">
              <Banner tone="critical" title={translations.errorNotFoundTitle}>
                {translations.errorNotFoundDesc}
              </Banner>
            </Box>
          )}

          {!isNewRule && (
            <Box paddingBlockEnd="400">
              {isActive ? (
                <Banner tone="success" title={translations.activeTitle}>
                  <p>{translations.activeDesc1}</p>
                  <p style={{ marginTop: '10px' }} dangerouslySetInnerHTML={{ __html: `<em>${translations.activeDesc2}</em>` }} />
                </Banner>
              ) : (
                <Banner tone="warning" title={translations.inactiveTitle}>
                  <p>{translations.inactiveDesc1}</p>
                  <p style={{ marginTop: '10px' }} dangerouslySetInnerHTML={{ __html: `<em>${translations.inactiveDesc2}</em>` }} />
                </Banner>
              )}
            </Box>
          )}
          
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">{translations.cardTitle}</Text>
              <Text as="p" tone="subdued">
                {translations.cardSubtitle} <code>{targetFunctionId}</code>
              </Text>
              <Text as="p">
                {translations.cardDesc}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}