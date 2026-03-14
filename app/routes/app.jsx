import { json } from "@remix-run/node"; 
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import { Box } from "@shopify/polaris";

import polarisTranslationsEn from "@shopify/polaris/locales/en.json";
import polarisTranslationsZhTW from "@shopify/polaris/locales/zh-TW.json";

// ✨ 1. Import getI18n alongside your other i18n tools
import { getLocale, localeCookie, getI18n } from "../utils/i18n.server.js";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const locale = await getLocale(request);
  
  // ✨ 2. Fetch your custom translations
  const { t } = await getI18n(request);
  
  // ✨ 3. Package the navigation strings
  const translations = {
    home: t("Navigation.home", "Home"),
    create: t("Navigation.create", "Create Campaign"),
    pricing: t("Navigation.pricing", "Pricing"),
    support: t("Navigation.support", "Support"),
    settings: t("Navigation.settings", "Settings")
  };

  return json(
    { 
      apiKey: process.env.SHOPIFY_API_KEY || "", 
      locale,
      translations // ✨ 4. Send translations to the frontend
    },
    {
      headers: {
        "Set-Cookie": await localeCookie.serialize(locale),
      },
    }
  );
};

export default function App() {
  const { apiKey, locale, translations } = useLoaderData(); // ✨ 5. Read translations

  const polarisTranslations = locale === 'zh-TW' ? polarisTranslationsZhTW : polarisTranslationsEn;

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey} i18n={polarisTranslations}>
      {/* ✨ 6. Use the translated strings and add your new pages! */}
      <NavMenu>
        <Link to="/app" rel="home">{translations.home}</Link>
        <Link to="/app/campaigns/new">{translations.create}</Link>
        <Link to="/app/pricing">{translations.pricing}</Link>
        <Link to="/app/support">{translations.support}</Link>
        <Link to="/app/settings">{translations.settings}</Link> 
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