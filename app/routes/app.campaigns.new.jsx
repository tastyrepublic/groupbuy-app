import { json, redirect } from "@remix-run/node";
import { useSubmit, useNavigation, useActionData, useNavigate, useBlocker } from "@remix-run/react";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { Page, Layout } from "@shopify/polaris";
import { useState, useEffect, useRef, useCallback } from "react";
import { toDate, format, formatInTimeZone } from 'date-fns-tz';
import { CampaignForm } from '../components/CampaignForm';
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { validateTiers } from "../components/validation";

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
    // ✅ FIX 1: Add $resources to the mutation definition
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
      options: ["Discount Tier"], // This is the label for the individual option
      position: 1,
      sellingPlansToCreate: [
        {
          name: "Join Group Buy (Pay $0 Today)", // This is the label for the radio button itself
          options: ["Join Group Buy"],
          position: 1,
          // ✅ FIX 1: Explicitly declare this as a Pre-Order
          category: "PRE_ORDER", 
          billingPolicy: {
            fixed: { 
              checkoutCharge: { type: "PERCENTAGE", value: { percentage: 0 } },
              // ✅ FIX 2: Define when the vaulted card should be charged
              remainingBalanceChargeTrigger: "EXACT_TIME",
              remainingBalanceChargeExactTime: endDateTimeUtc.toISOString()
            } 
          },
          deliveryPolicy: {
            fixed: { 
              // ✅ FIX 3: Define when the item will be fulfilled
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

    // ✅ FIX 2: Separate the resources from the input object
    const sellingPlanResources = {
      productIds: [productId],
      productVariantIds: selectedVariantIds
    };

    // ✅ FIX 3: Pass both input AND resources into the variables
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

    // ✅ CAPTURE BOTH IDs
    const generatedSellingPlanGroupId = spData.data.sellingPlanGroupCreate.sellingPlanGroup.id;
    const generatedSellingPlanId = spData.data.sellingPlanGroupCreate.sellingPlanGroup.sellingPlans.edges[0].node.id;

    // ✅ SAVE BOTH TO NEONDB
    const newCampaign = await db.campaign.create({
      data: {
        shop: session.shop,
        productId: formData.get("productId"),
        productTitle: formData.get("productTitle"),
        productImage: formData.get("productImage"),
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

    return redirect(`/app/campaigns/${newCampaign.id}?success=true`);

  } catch (error) {
    console.error("Error creating campaign:", error);
    errors.form = "An unexpected error occurred while creating the campaign. Please try again.";
    return json({ errors }, { status: 500 });
  }
};

export default function NewCampaignPage() {
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
  campaignFormRef.current?.submit(); // Directly call the .submit() method
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
      title="Create campaign"
      backAction={{ content: 'Campaigns', onAction: handleBackAction }}
    >
      {/* ✅ This is the final, correct way to use the SaveBar based on your documentation. */}
      <SaveBar id="campaign-save-bar">
        <button 
          variant="primary" 
          onClick={handleSave}
          loading={isBusy ? "" : undefined}
          disabled={!isFormValid || isBusy}
        >
          Save
        </button>
        <button onClick={handleDiscard}>
          Discard
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
          />
        </Layout.Section>
      </Layout>
    </Page>
  );
}