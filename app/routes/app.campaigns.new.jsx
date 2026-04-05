import { json, redirect } from "@remix-run/node";
import { useSubmit, useNavigation, useActionData, useNavigate, useBlocker, useLoaderData } from "@remix-run/react";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { Page, Layout } from "@shopify/polaris";
import { useState, useEffect, useRef, useCallback } from "react";
import { toDate, format, formatInTimeZone } from 'date-fns-tz';
import { CampaignForm } from '../components/CampaignForm';
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { validateTiers } from "../components/validation";
import { toggleContinueSelling } from "../utils/inventory.server.js";
import { requireSetup } from "../utils/guard.server.js";
import { getI18n } from "../utils/i18n.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await requireSetup(session, request);
  const { t } = await getI18n(request);

  return json({
    translations: {
      title: t("CreateCampaign.title", "Create Group Buy Campaign"),
      discard: t("CreateCampaign.back", "Discard"),
      save: t("CreateCampaign.save", "Create Campaign"),
      campaignsLabel: t("Dashboard.title", "Group Buy Campaigns"),
      form: t("CreateCampaign", { returnObjects: true }) 
    }
  });
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  
  // ✨ Fetch translations for the server-side rejections
  const { t } = await getI18n(request);
  
  const errors = { tiers: [], schedule: {}, product: null, leaderDiscount: null, form: null };

  const productId = formData.get("productId");
  if (!productId) {
    errors.product = t("CreateCampaign.notes.selectProduct", "You must select a product.");
  }

  const selectedVariantIdsJson = formData.get("selectedVariantIdsJson");
  const selectedVariantIds = selectedVariantIdsJson ? JSON.parse(selectedVariantIdsJson) : [];

  if (selectedVariantIds.length === 0) {
      errors.product = t("CreateCampaign.notes.selectVariant", "You must select at least one product variant.");
  }
  
  const leaderDiscount = parseInt(formData.get("leaderDiscount"), 10);
  if (isNaN(leaderDiscount) || leaderDiscount < 0 || leaderDiscount > 100) {
    errors.leaderDiscount = t("CreateCampaign.notes.invalidLeaderDiscount", "Must be 0-100.");
  }

  const tiers = JSON.parse(formData.get("tiers"));
  
  // ✨ Translate the Tier Validation Errors
  const tierErrors = validateTiers(tiers, {
    minQty: t("CreateCampaign.sections.tiers.errors.minQty", "Must be > 0."),
    minDiscount: t("CreateCampaign.sections.tiers.errors.minDiscount", "Must be > 0."),
    maxDiscount: t("CreateCampaign.sections.tiers.errors.maxDiscount", "Max 100."),
    greaterThanQty: t("CreateCampaign.sections.tiers.errors.greaterThanQty", "Must be >"),
    greaterThanDiscount: t("CreateCampaign.sections.tiers.errors.greaterThanDiscount", "Must be >")
  });
  
  if (tierErrors.some(e => e)) {
    errors.tiers = tierErrors;
  }

  const campaignTimezone = formData.get("timezone");
  const startDateTimeLocal = formData.get("startDate");
  const endDateTimeLocal = formData.get("endDate");
  
  let startDateTimeUtc = toDate(startDateTimeLocal, { timeZone: campaignTimezone });
  const endDateTimeUtc = toDate(endDateTimeLocal, { timeZone: campaignTimezone });
  
  const nowUtc = new Date();

  // The Auto-Start Correction
  if (startDateTimeUtc.getTime() < nowUtc.getTime()) {
    startDateTimeUtc = nowUtc;
  }

  // ✨ Translate Date Validation Errors
  if (startDateTimeUtc >= endDateTimeUtc) {
    errors.schedule.endDate = t("CreateCampaign.notes.invalidEndDate", "Must be after start date.");
  }

  if (endDateTimeUtc <= nowUtc) {
    errors.schedule.endDate = t("CreateCampaign.notes.invalidEndDate", "End time must be in the future.");
  }

  if (errors.product || errors.leaderDiscount || errors.tiers.some(e => e) || Object.keys(errors.schedule).length > 0) {
    return json({ errors }, { status: 422 });
  }

  try {
    const sellingPlanMutation = `
      mutation sellingPlanGroupCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
        sellingPlanGroupCreate(input: $input, resources: $resources) {
          sellingPlanGroup { id sellingPlans(first: 1) { edges { node { id } } } }
          userErrors { field message }
        }
      }
    `;

    const sellingPlanInput = {
      name: "Group Buy Special Offer", 
      merchantCode: `GB-${Date.now()}`,
      options: ["Discount Tier"], 
      position: 1,
      sellingPlansToCreate: [{
        name: "Join Group Buy (Pay $0 Today)", 
        options: ["Join Group Buy"],
        position: 1,
        category: "PRE_ORDER", 
        billingPolicy: { fixed: { checkoutCharge: { type: "PERCENTAGE", value: { percentage: 0 } }, remainingBalanceChargeTrigger: "EXACT_TIME", remainingBalanceChargeExactTime: endDateTimeUtc.toISOString() } },
        deliveryPolicy: { fixed: { fulfillmentTrigger: "EXACT_TIME", fulfillmentExactTime: endDateTimeUtc.toISOString() } },
        pricingPolicies: [{ fixed: { adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 0 } } }]
      }]
    };

    const spResponse = await admin.graphql(sellingPlanMutation, { variables: { input: sellingPlanInput, resources: { productIds: [productId], productVariantIds: selectedVariantIds } } });
    const spData = await spResponse.json();
    
    if (spData.data?.sellingPlanGroupCreate?.userErrors?.length > 0) throw new Error("Failed to create Shopify Selling Plan");

    const generatedSellingPlanGroupId = spData.data.sellingPlanGroupCreate.sellingPlanGroup.id;
    const generatedSellingPlanId = spData.data.sellingPlanGroupCreate.sellingPlanGroup.sellingPlans.edges[0].node.id;

    const rawMaxQty = parseInt(formData.get("leaderMaxQty"), 10);
    const leaderMaxQty = isNaN(rawMaxQty) || rawMaxQty < 0 ? 0 : rawMaxQty;

    const rawStarting = parseInt(formData.get("startingParticipants"), 10);
    const startingParticipants = isNaN(rawStarting) || rawStarting < 0 ? 0 : rawStarting;
    
    // ✨ SNAPSHOT STEP 1: Fetch the global settings BEFORE creating the campaign
    const shopSettings = await db.settings.findUnique({ where: { shop: session.shop } });
    let tagToApply = null;

    if (shopSettings?.enableAutoTagging && shopSettings?.autoDiscountTag) {
      tagToApply = shopSettings.autoDiscountTag;
    }

    const newCampaign = await db.campaign.create({
      data: {
        shop: session.shop,
        productId: formData.get("productId"),
        productTitle: formData.get("productTitle"),
        productImage: formData.get("productImage"),
        productHandle: formData.get("productHandle"),
        selectedVariantIdsJson: selectedVariantIdsJson,
        startDateTime: startDateTimeUtc,
        endDateTime: endDateTimeUtc,
        timezone: campaignTimezone,
        leaderDiscount: leaderDiscount,
        leaderMaxQty: leaderMaxQty,
        tiersJson: JSON.stringify(tiers),
        status: "ACTIVE",
        startingParticipants: startingParticipants,
        scope: formData.get("scope"),
        countingMethod: formData.get("countingMethod"),
        sellingPlanId: generatedSellingPlanId, 
        sellingPlanGroupId: generatedSellingPlanGroupId,
        appliedDiscountTag: tagToApply, // ✨ SNAPSHOT STEP 2: Save the exact string to the campaign memory!
      },
    });

    await toggleContinueSelling(admin, session.shop, newCampaign.productId, newCampaign.id, "START");
    
    // ✨ SNAPSHOT STEP 3: Apply the tag using the snapshotted variable
    if (tagToApply) {
      try {
        console.log(`🏷️ Attempting to add tag "${tagToApply}" to ${newCampaign.productId}`);
        
        const tagResponse = await admin.graphql(`
          mutation tagsAdd($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { 
              node { id }
              userErrors { message } 
            }
          }
        `, { 
          variables: { 
            id: newCampaign.productId, 
            tags: [tagToApply] 
          } 
        });

        const tagData = await tagResponse.json();
        
        if (tagData.data?.tagsAdd?.userErrors?.length > 0) {
          console.error("❌ Shopify rejected the tag:", tagData.data.tagsAdd.userErrors);
        } else {
          console.log("✅ Tag added successfully!");
        }
      } catch (tagError) {
        console.error("❌ Error running tag mutation:", tagError.message);
      }
    }

    return redirect(`/app/campaigns/${newCampaign.id}?success=true`);

  } catch (error) {
    console.error("Error creating campaign:", error);
    errors.form = "An unexpected error occurred while creating the campaign. Please try again.";
    return json({ errors }, { status: 500 });
  }
};

export default function NewCampaignPage() {
  const { translations } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData();
  const navigate = useNavigate();
  const campaignFormRef = useRef(null);
  const app = useAppBridge();

  const [isDirty, setIsDirty] = useState(false);
  const [isFormValid, setIsFormValid] = useState(false);
  const isBusy = navigation.state === 'submitting' || navigation.state === 'loading';

  useEffect(() => { isDirty ? app.saveBar.show('campaign-save-bar') : app.saveBar.hide('campaign-save-bar'); }, [isDirty, app]);
  
  const blocker = useBlocker(({ currentLocation, nextLocation }) => isDirty && currentLocation.pathname !== nextLocation.pathname);

  const handleDirtyChange = useCallback((dirty) => { setIsDirty(dirty); }, []);
  const handleValidityChange = useCallback((isValid) => { setIsFormValid(isValid); }, []);
  const handleSave = () => { campaignFormRef.current?.submit(); };
  const handleDiscard = () => { campaignFormRef.current?.discard(); };
  const handleBackAction = () => { navigate('/app'); };

  useEffect(() => {
    if (blocker.state === "blocked") {
      app.saveBar.leaveConfirmation().then((confirmed) => confirmed ? blocker.proceed() : blocker.reset());
    }
  }, [blocker, app]);
  
  return (
    <Page title={translations.title} backAction={{ content: translations.campaignsLabel, onAction: handleBackAction }}>
      <SaveBar id="campaign-save-bar">
        <button variant="primary" onClick={handleSave} loading={isBusy ? "" : undefined} disabled={!isFormValid || isBusy}>
          {translations.save}
        </button>
        <button onClick={handleDiscard}>{translations.discard}</button>
      </SaveBar>
      <Layout>
        <Layout.Section>
          <CampaignForm ref={campaignFormRef} onDirtyChange={handleDirtyChange} onValidityChange={handleValidityChange} isStarted={false} hasParticipants={false} formErrors={actionData?.errors} translations={translations.form} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}