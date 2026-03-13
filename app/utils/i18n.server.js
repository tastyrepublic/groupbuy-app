import { createCookie } from "@remix-run/node";
import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import zhTW from "../locales/zh-TW.json";

// ✨ 1. Create a secure, enterprise-grade cookie
export const localeCookie = createCookie("shop_locale", {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "none",
  maxAge: 31536000, // Remembers the language for 1 year
});

export async function getLocale(request) {
  const url = new URL(request.url);
  
  // 2. Try to get it from Shopify's URL parameter first (Initial Load)
  let rawLocale = url.searchParams.get("locale");

  // 3. ✨ If missing (during fast background navigation), read the secure cookie!
  if (!rawLocale) {
    const cookieHeader = request.headers.get("Cookie");
    rawLocale = (await localeCookie.parse(cookieHeader)) || "en";
  }

  // 4. Safely check for Traditional Chinese
  const lowerLocale = rawLocale.toLowerCase();
  if (lowerLocale.includes("zh-tw") || lowerLocale.includes("zh-hk") || lowerLocale.includes("zh-hant")) {
    return "zh-TW";
  }
  
  // Otherwise, fallback to the standard 2-letter code
  return rawLocale.split('-')[0];
}

export async function getI18n(request) {
  const locale = await getLocale(request);
  const instance = createInstance();
  
  await instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: "en",
    resources: {
      en: { translation: en },
      "zh-TW": { translation: zhTW },
    },
    interpolation: { escapeValue: false },
  });

  return { t: instance.t, locale };
}