import { json } from "@remix-run/node"; // ✨ Import json for headers
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { Box } from "@shopify/polaris";

import polarisTranslationsEn from "@shopify/polaris/locales/en.json";
import polarisTranslationsZhTW from "@shopify/polaris/locales/zh-TW.json";

// ✨ 1. Import your smart detector AND the cookie object
import { getLocale, localeCookie } from "../utils/i18n.server.js";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // ✨ 2. Get the locale (this will pull from the Shopify URL on first load)
  const locale = await getLocale(request);

  // ✨ 3. Return the data AND force the browser to save the cookie
  return json(
    { 
      apiKey: process.env.SHOPIFY_API_KEY || "", 
      locale 
    },
    {
      headers: {
        "Set-Cookie": await localeCookie.serialize(locale),
      },
    }
  );
};

export default function App() {
  const { apiKey, locale } = useLoaderData();

  // 4. Select the correct Polaris native translation
  const polarisTranslations = locale === 'zh-TW' ? polarisTranslationsZhTW : polarisTranslationsEn;

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey} i18n={polarisTranslations}>
      <NavMenu>
        <Link to="/app" rel="home">Home</Link>
        <Link to="/app/campaigns/new">Create campaigns</Link>
        <Link to="/app/settings">Settings</Link> 
      </NavMenu>
      
      <Box paddingBlockEnd="1600">
        <Outlet />
      </Box>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};