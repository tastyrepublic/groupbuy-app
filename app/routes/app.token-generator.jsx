import { json } from "@remix-run/node";
import { Page, Card, Text } from "@shopify/polaris";
import { useLoaderData } from "@remix-run/react";
import shopify from "../shopify.server";

// This server-side code runs when you visit the page.
export const loader = async ({ request }) => {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
    mutation StorefrontAccessTokenCreate($input: StorefrontAccessTokenInput!) {
      storefrontAccessTokenCreate(input: $input) {
        storefrontAccessToken {
          accessToken
        }
        userErrors {
          message
        }
      }
    }`,
    {
      variables: { input: { title: "Temporary Test Token" } },
    }
  );

  const responseJson = await response.json();
  const tokenData = responseJson.data.storefrontAccessTokenCreate;

  // The token will be printed in your terminal.
  console.log("✅ STOREFRONT ACCESS TOKEN GENERATED:", tokenData);

  return json({
    errors: tokenData.userErrors,
    token: tokenData.storefrontAccessToken,
  });
};

// This is the page component that shows the result.
export default function TokenGenerator() {
  const { errors, token } = useLoaderData();

  return (
    <Page>
      <Card>
        <Text as="h1" variant="headingLg">Storefront Token Generator</Text>
        {token ? (
          <>
            <Text as="p">Success! Your new token is below and in the terminal.</Text>
            <Text as="p" variant="bodyLg" emphasis>
              <strong>{token.accessToken}</strong>
            </Text>
          </>
        ) : (
          <Text as="p">Failed to generate token: {JSON.stringify(errors)}</Text>
        )}
      </Card>
    </Page>
  );
}