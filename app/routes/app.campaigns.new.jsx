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

import { getI18n } from "../utils/i18n.server.js";

// ✨ 1. Update the loader to grab the whole dictionary object
export const loader = async ({ request }) => {
  await authenticate.admin(request);
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

// --- ACTION (No changes needed) ---
export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const errors = { tiers: [], schedule: {}, product: null, leaderDiscount: null, form: null };

  const productId = formData.get("productId");
  if (!productId) {
    errors.product = "You must select a product.";
  }

  const selectedVariantIdsJson = formData.get("selectedVariantIdsJson");
  const selectedVariantIds = selectedVariantIdsJson ? JSON.parse(selectedVariantIdsJson) : [];

  if (selectedVariantIds.length === 0) {
      errors.product = "You must select at least one product variant.";
  }
  
  const leaderDiscount = parseInt(formData.get("leaderDiscount"), 10);
  if (isNaN(leaderDiscount) || leaderDiscount < 0 || leaderDiscount > 100) {
    errors.leaderDiscount = 'Must be 0-100.';
  }

  const tiers = JSON.parse(formData.get("tiers"));
  const tierErrors = validateTiers(tiers);
  if (tierErrors.some(e => e)) {
    errors.tiers = tierErrors;
  }

  const campaignTimezone = formData.get("timezone");
  const startDateTimeLocal = formData.get("startDate");
  const endDateTimeLocal = formData.get("endDate");
  const startDateTimeUtc = toDate(startDateTimeLocal, { timeZone: campaignTimezone });
  const endDateTimeUtc = toDate(endDateTimeLocal, { timeZone: campaignTimezone });
  
  const nowUtc = new Date();
  if (startDateTimeUtc.getTime() < nowUtc.getTime() - 60000) {
    errors.schedule.startDate = 'Cannot be in the past.';
  }
  if (startDateTimeUtc >= endDateTimeUtc) {
    errors.schedule.endDate = 'Must be after start date.';
  }

  if (errors.product || errors.leaderDiscount || errors.tiers.some(e => e) || Object.keys(errors.schedule).length > 0) {
    return json({ errors }, { status: 422 });
  }

  try {
    const sellingPlanMutation = `
      mutation sellingPlanGroupCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
        sellingPlanGroupCreate(input: $input, resources: $resources) {
          sellingPlanGroup {
            id
            sellingPlans(first: 1) {
              edges {
                node {
                  id
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const sellingPlanInput = {
      name: "Group Buy Special Offer", 
      merchantCode: `GB-${Date.now()}`,
      options: ["Discount Tier"], 
      position: 1,
      sellingPlansToCreate: [
        {
          name: "Join Group Buy (Pay $0 Today)", 
          options: ["Join Group Buy"],
          position: 1,
          category: "PRE_ORDER", 
          billingPolicy: {
            fixed: { 
              checkoutCharge: { type: "PERCENTAGE", value: { percentage: 0 } },
              remainingBalanceChargeTrigger: "EXACT_TIME",
              remainingBalanceChargeExactTime: endDateTimeUtc.toISOString()
            } 
          },
          deliveryPolicy: {
            fixed: { 
              fulfillmentTrigger: "EXACT_TIME",
              fulfillmentExactTime: endDateTimeUtc.toISOString() 
            } 
          },
          pricingPolicies: [
            {
              fixed: { adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 0 } } 
            }
          ]
        }
      ]
    };

    const sellingPlanResources = {
      productIds: [productId],
      productVariantIds: selectedVariantIds
    };

    const spResponse = await admin.graphql(sellingPlanMutation, { 
      variables: { 
        input: sellingPlanInput,
        resources: sellingPlanResources
      } 
    });
    
    const spData = await spResponse.json();
    
    if (spData.data?.sellingPlanGroupCreate?.userErrors?.length > 0) {
      console.error("Selling Plan Errors:", spData.data.sellingPlanGroupCreate.userErrors);
      throw new Error("Failed to create Shopify Selling Plan");
    }

    const generatedSellingPlanGroupId = spData.data.sellingPlanGroupCreate.sellingPlanGroup.id;
    const generatedSellingPlanId = spData.data.sellingPlanGroupCreate.sellingPlanGroup.sellingPlans.edges[0].node.id;

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
        tiersJson: JSON.stringify(tiers),
        status: "ACTIVE",
        startingParticipants: parseInt(formData.get("startingParticipants"), 10) || 0,
        scope: formData.get("scope"),
        countingMethod: formData.get("countingMethod"),
        sellingPlanId: generatedSellingPlanId, 
        sellingPlanGroupId: generatedSellingPlanGroupId 
      },
    });

    await toggleContinueSelling(admin, session.shop, newCampaign.productId, newCampaign.id, "START");

    return redirect(`/app/campaigns/${newCampaign.id}?success=true`);

  } catch (error) {
    console.error("Error creating campaign:", error);
    errors.form = "An unexpected error occurred while creating the campaign. Please try again.";
    return json({ errors }, { status: 500 });
  }
};

export default function NewCampaignPage() {
  // ✨ 3. Call useLoaderData to access the translated strings
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

  useEffect(() => {
    if (isDirty) {
      app.saveBar.show('campaign-save-bar');
    } else {
      app.saveBar.hide('campaign-save-bar');
    }
  }, [isDirty, app]);
  
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname
  );

  const handleDirtyChange = useCallback((dirty) => {
    setIsDirty(dirty);
  }, []);

  const handleValidityChange = useCallback((isValid) => {
    setIsFormValid(isValid);
  }, []);
  
  const handleSave = () => {
    campaignFormRef.current?.submit(); 
  };

  const handleDiscard = () => { 
    campaignFormRef.current?.discard(); 
  };
  
  const handleBackAction = () => {
    navigate('/app');
  };

  useEffect(() => {
    if (blocker.state === "blocked") {
      app.saveBar.leaveConfirmation()
        .then((confirmed) => confirmed ? blocker.proceed() : blocker.reset());
    }
  }, [blocker, app]);
  
  return (
    <Page
      title={translations.title}
      backAction={{ content: translations.campaignsLabel, onAction: handleBackAction }}
    >
      <SaveBar id="campaign-save-bar">
        <button 
          variant="primary" 
          onClick={handleSave}
          loading={isBusy ? "" : undefined}
          disabled={!isFormValid || isBusy}
        >
          {translations.save} {/* ✨ Translated Save Button */}
        </button>
        <button onClick={handleDiscard}>
          {translations.discard} {/* ✨ Translated Discard Button */}
        </button>
      </SaveBar>

      <Layout>
        <Layout.Section>
          <CampaignForm
            ref={campaignFormRef}
            onDirtyChange={handleDirtyChange}
            onValidityChange={handleValidityChange}
            isStarted={false}
            hasParticipants={false}
            formErrors={actionData?.errors}
            translations={translations.form}
          />
        </Layout.Section>
      </Layout>
    </Page>
  );
}