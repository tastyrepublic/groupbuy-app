import { json } from "@remix-run/node";
import { Page, Card, Text, BlockStack } from "@shopify/polaris";
import { useLoaderData } from "@remix-run/react";
import shopify from "../shopify.server";

// --- CONFIGURATION ---
// PASTE THE NEW TOKEN YOU GENERATED HERE
const YOUR_NEW_TOKEN = "f50bf542fcaf0dbb78e5ac0b69618d78";
// PASTE A VALID NUMERIC VARIANT ID HERE
const YOUR_VARIANT_ID = "42262063284285";
// --------------------


export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const merchandiseId = `gid://shopify/ProductVariant/${YOUR_VARIANT_ID}`;
  const results = {};

  if (!shop) {
    return json({ error: "Missing 'shop' parameter in the URL." });
  }
  if (YOUR_NEW_TOKEN.startsWith("PASTE") || YOUR_VARIANT_ID.startsWith("PASTE")) {
    return json({ error: "Please update the token and variant ID in the code." });
  }

  // --- Method 1: Standard Library ---
  try {
    const { storefront } = await shopify.unauthenticated.storefront(shop);
    // The response from this method is the full JSON body, including the 'data' key.
    const response = await storefront.graphql(
      `mutation C1($i: CartInput!) { cartCreate(input: $i) { cart { id } } }`,
      { variables: { i: { lines: [{ merchandiseId, quantity: 1 }] } } }
    );
    // We log the whole response to see the data.
    results.method1 = { success: true, data: response };
  } catch (e) {
    results.method1 = { success: false, error: e.message };
  }

  // --- Method 2: Custom Client ---
  try {
    const storefront = new shopify.clients.Storefront({
      domain: shop,
      storefrontAccessToken: YOUR_NEW_TOKEN,
    });
    const { data } = await storefront.request(
        `mutation C2($i: CartInput!) { cartCreate(input: $i) { cart { id } } }`,
      { variables: { i: { lines: [{ merchandiseId, quantity: 1 }] } } }
    );
    results.method2 = { success: true, data: data };
  } catch (e) {
    results.method2 = { success: false, error: e.message };
  }

  // --- Method 3: Raw Fetch ---
  try {
    const endpoint = `https://${shop}/api/2025-01/graphql.json`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': YOUR_NEW_TOKEN,
      },
      body: JSON.stringify({
        query: `mutation C3($i: CartInput!) { cartCreate(input: $i) { cart { id } } }`,
        variables: { i: { lines: [{ merchandiseId, quantity: 1 }] } }
      }),
    });
    const data = await response.json();
    if(data.errors) throw new Error(JSON.stringify(data.errors));
    results.method3 = { success: true, data: data };
  } catch (e) {
    results.method3 = { success: false, error: e.message };
  }

  console.log("--- AUTHENTICATION TEST RESULTS ---", results);
  return json(results);
};

export default function AuthTestPage() {
  const results = useLoaderData();

  const renderResult = (result) => {
    if(!result) return <Text as="p">Test did not run.</Text>
    return result.success ? (
      <Text as="p" tone="success">✅ Success: {JSON.stringify(result.data)}</Text>
    ) : (
      <Text as="p" tone="critical">❌ Failed: {result.error}</Text>
    );
  };

  return (
    <Page>
      <Card>
        <BlockStack gap="400">
            <Text as="h1" variant="headingLg">Authentication Test</Text>

            <Text as="h2" variant="headingMd">Method 1: Standard (from .env)</Text>
            {renderResult(results.method1)}

            <Text as="h2" variant="headingMd">Method 2: Custom Client</Text>
            {renderResult(results.method2)}

            <Text as="h2" variant="headingMd">Method 3: Raw Fetch</Text>
            {renderResult(results.method3)}
        </BlockStack>
      </Card>
    </Page>
  );
}