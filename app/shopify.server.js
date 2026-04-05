import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  BillingInterval, 
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { DEFAULT_EMAIL_TEMPLATES } from "./utils/emailDictionary.js";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,

  billing: {
    "Premium Plan": {
      amount: 27.00,
      currencyCode: "USD",
      interval: BillingInterval.Every30Days,
      trialDays: 30, 
    },
  },

  // ✨ NEW: The Install Hook (Day 1 Data Capture)
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // 1. Shopify registers the webhooks you put in the .toml file
      shopify.registerWebhooks({ session });

      // 2. Fetch the contact email AND Address the exact second they install
      try {
        const response = await admin.graphql(`
          #graphql
          query getContactEmailOnInstall {
            shop {
              contactEmail
              billingAddress { address1 city country zip } # ✨ FETCH ADDRESS HERE
            }
          }
        `);
        
        const { data } = await response.json();
        const contactEmail = data?.shop?.contactEmail;
        
        // ✨ Parse the address
        const addr = data?.shop?.billingAddress;
        const fallbackAddress = addr ? [addr.address1, addr.city, addr.country, addr.zip].filter(Boolean).join(', ') : "";

        if (contactEmail) {
          // 3. Create their Settings row immediately with ALL defaults
          await prisma.settings.upsert({
            where: { shop: session.shop },
            update: { contactEmail: contactEmail },
            create: { 
              shop: session.shop, 
              contactEmail: contactEmail,
              emailStoreAddress: fallbackAddress, // ✨ Save the address immediately!
              hiddenDeliveryRates: "[]",          // ✨ Ensure new array format is seeded
              enableAutoTagging: false,           // ✨ Default new features
              autoDiscountTag: "group-buy-active",
              isOnboarded: false,
              successEmailSubject: JSON.stringify(DEFAULT_EMAIL_TEMPLATES.successSubject),
              successEmailBody: JSON.stringify(DEFAULT_EMAIL_TEMPLATES.successBody),
              failedEmailSubject: JSON.stringify(DEFAULT_EMAIL_TEMPLATES.failedSubject),
              failedEmailBody: JSON.stringify(DEFAULT_EMAIL_TEMPLATES.failedBody)
            },
          });
          console.log(`[Install Sync] Captured contactEmail and Address for new install: ${session.shop}`);
        }
      } catch (error) {
        console.error(`[Install Sync] Failed to fetch data for ${session.shop}:`, error);
      }
    },
  },

  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;