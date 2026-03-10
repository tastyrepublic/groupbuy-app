import { json, redirect } from "@remix-run/node";
import { format } from 'date-fns';
import { useSubmit, useLoaderData, useNavigation, useActionData, useNavigate, useLocation, useBlocker } from "@remix-run/react";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { Page, Layout } from "@shopify/polaris";
import { useState, useEffect, useRef, useCallback } from "react";
import { toDate } from 'date-fns-tz';
import { CampaignForm } from '../components/CampaignForm';
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { validateTiers } from "../components/validation";

// ✅ Replace your existing loader with this complete and future-proof version

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const campaignId = parseInt(params.id, 10);

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) { throw new Response("Campaign Not Found", { status: 404 }); }

  let selectedProducts = [];
  
  if (campaign.selectedVariantIdsJson) {
    const variantIds = JSON.parse(campaign.selectedVariantIdsJson);

    if (variantIds.length > 0) {
      const response = await admin.graphql(
        `#graphql
          query getVariantDetails($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                title
                media(first: 1) {
                  edges {
                    node {
                      ... on MediaImage {
                        image {
                          url
                        }
                      }
                    }
                  }
                }
                product {
                  id
                  title
                  # ✅ UPDATED: Use 'media' on the parent product as well
                  media(first: 1) {
                    edges {
                      node {
                        ... on MediaImage {
                          image {
                            url
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
        { variables: { ids: variantIds } },
      );

      const { data } = await response.json();

      selectedProducts = data.nodes.filter(Boolean).map(variant => {
        // Safely get the URLs using the new structure for both
        const variantImageUrl = variant.media?.edges[0]?.node.image?.url;
        const productImageUrl = variant.product.media?.edges[0]?.node.image?.url;

        return {
          id: variant.product.id,
          variantId: variant.id,
          title: variant.product.title,
          variantTitle: variant.title,
          image: variantImageUrl || productImageUrl || '', // Fallback logic is now consistent
        };
      });
    }
  }

  const initialData = {
    ...campaign,
    selectedProducts: selectedProducts,
  };

  const url = new URL(request.url);
  const version = url.searchParams.get("v");
  const participantCount = 0;

  return json({ campaign: initialData, participantCount, version });
};

// ✅ Corrected and improved action function
export const action = async ({ request, params }) => {
  // ✅ 1. ADDED 'admin' here so we can run GraphQL!
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const campaignId = parseInt(params.id, 10);

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) { throw new Response("Not Found", { status: 404 }); }

  const participantCount = 0; // Replace with your actual participant logic if needed
  const isStarted = new Date(campaign.startDateTime) < new Date();
  const hasParticipants = participantCount > 0;
  const errors = { tiers: [], schedule: {}, leaderDiscount: null };

  const dataToUpdate = {};

  // --- Handle the array of selected variants ---
  const selectedVariantIdsJson = formData.get("selectedVariantIdsJson");
  if (selectedVariantIdsJson) {
    const selectedVariantIds = JSON.parse(selectedVariantIdsJson);
    if (selectedVariantIds.length > 0) {
      dataToUpdate.selectedVariantIdsJson = selectedVariantIdsJson;
      dataToUpdate.productId = formData.get("productId");
      dataToUpdate.productTitle = formData.get("productTitle");
      dataToUpdate.productImage = formData.get("productImage");
    } else {
      errors.product = "You must select at least one product variant.";
    }
  }

  // --- Regular validation logic ---
  if (!hasParticipants) {
    const leaderDiscount = parseInt(formData.get("leaderDiscount"), 10);
    if (isNaN(leaderDiscount) || leaderDiscount < 0 || leaderDiscount > 100) { errors.leaderDiscount = 'Must be 0-100.'; }
    const tiers = JSON.parse(formData.get("tiers"));
    const tierErrors = validateTiers(tiers);
    if (tierErrors.some(e => e)) { errors.tiers = tierErrors; }

    dataToUpdate.tiersJson = JSON.stringify(tiers);
    dataToUpdate.leaderDiscount = leaderDiscount;
    dataToUpdate.scope = formData.get("scope");
    dataToUpdate.countingMethod = formData.get("countingMethod");
  }

  // 1. Keep Start Date protected (cannot change once started)
if (!isStarted) {
  const campaignTimezone = formData.get("timezone");
  const startDateTimeUtc = toDate(formData.get("startDate"), { timeZone: campaignTimezone });
  if (startDateTimeUtc.getTime() < new Date().getTime() - 60000) { 
    errors.schedule.startDate = 'Cannot be in the past.'; 
  }
  dataToUpdate.startDateTime = startDateTimeUtc;
  dataToUpdate.startingParticipants = parseInt(formData.get("startingParticipants"), 10);
}

// 2. MOVE End Date logic out here so it can always be edited
const campaignTimezone = formData.get("timezone");
const endDateTimeUtc = toDate(formData.get("endDate"), { timeZone: campaignTimezone });
const currentStart = dataToUpdate.startDateTime || campaign.startDateTime;

if (currentStart >= endDateTimeUtc) { 
  errors.schedule.endDate = 'Must be after start date.'; 
} else {
  dataToUpdate.endDateTime = endDateTimeUtc;
  dataToUpdate.timezone = campaignTimezone; // Update timezone as well
}

  if (errors.product || errors.leaderDiscount || errors.tiers.some(e => e) || Object.keys(errors.schedule).length > 0) {
    return json({ errors }, { status: 422 });
  }

  try {
    // 🔄 2. IF VARIANTS OR DATES CHANGED, REBUILD THE SELLING PLAN
    // 🔄 IF VARIANTS OR DATES CHANGED, REBUILD THE SELLING PLAN
    if (dataToUpdate.selectedVariantIdsJson || dataToUpdate.endDateTime) {
      
      // ✅ 1. Instantly delete the old group using our saved Group ID!
      if (campaign.sellingPlanGroupId) {
        await admin.graphql(`
          mutation { sellingPlanGroupDelete(id: "${campaign.sellingPlanGroupId}") { deletedSellingPlanGroupId } }
        `);
      }

      const newEndDateUtc = dataToUpdate.endDateTime || campaign.endDateTime;
      const newVariants = dataToUpdate.selectedVariantIdsJson 
        ? JSON.parse(dataToUpdate.selectedVariantIdsJson) 
        : JSON.parse(campaign.selectedVariantIdsJson);
      const productId = dataToUpdate.productId || campaign.productId;
      const title = dataToUpdate.productTitle || campaign.productTitle;

      const spMutation = `
        mutation sellingPlanGroupCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
          sellingPlanGroupCreate(input: $input, resources: $resources) {
            sellingPlanGroup {
              id
              sellingPlans(first: 1) { edges { node { id } } }
            }
            userErrors { field message }
          }
        }
      `;

      const spInput = {
        name: "Group Buy Special Offer",
        merchantCode: `GB-${Date.now()}`,
        options: ["Discount Tier"],
        position: 1,
        sellingPlansToCreate: [{
          name: "Join Group Buy (Pay $0 Today)",
          options: ["Join Group Buy"],
          position: 1,
          category: "PRE_ORDER",
          billingPolicy: { fixed: { checkoutCharge: { type: "PERCENTAGE", value: { percentage: 0 } }, remainingBalanceChargeTrigger: "EXACT_TIME", remainingBalanceChargeExactTime: newEndDateUtc.toISOString() } },
          deliveryPolicy: { fixed: { fulfillmentTrigger: "EXACT_TIME", fulfillmentExactTime: newEndDateUtc.toISOString() } },
          pricingPolicies: [{ fixed: { adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 0 } } }]
        }]
      };
      
      const spResources = { productIds: [productId], productVariantIds: newVariants };

      const spResponse = await admin.graphql(spMutation, { variables: { input: spInput, resources: spResources } });
      const spData = await spResponse.json();
      
      // ✅ 2. Save BOTH NEW IDs to our database update object
      if (spData.data?.sellingPlanGroupCreate?.sellingPlanGroup) {
        dataToUpdate.sellingPlanGroupId = spData.data.sellingPlanGroupCreate.sellingPlanGroup.id;
        dataToUpdate.sellingPlanId = spData.data.sellingPlanGroupCreate.sellingPlanGroup.sellingPlans.edges[0].node.id;
      }
    }

    // 💾 Finally, update NeonDB with all the new form data AND the new sellingPlanId
    if (Object.keys(dataToUpdate).length > 0) {
      await db.campaign.update({ where: { id: campaignId, shop: session.shop }, data: dataToUpdate });
    }

    return redirect(`/app/campaigns/${campaignId}?success=true&v=${Date.now()}`);

  } catch (error) {
    console.error("Error updating campaign:", error);
    return json({ errors: { form: "An unexpected error occurred." } }, { status: 500 });
  }
};

export default function EditCampaignPage() {
  const { campaign, participantCount, version } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData();
  const navigate = useNavigate();
  const campaignFormRef = useRef(null);
  const location = useLocation();
  const app = useAppBridge();

  const [isDirty, setIsDirty] = useState(false);
  const [isFormValid, setIsFormValid] = useState(true);
  const isBusy = navigation.state === 'submitting' || navigation.state === 'loading';
  const isSuccessRedirect = new URLSearchParams(location.search).has("success");

  useEffect(() => {
    if (isDirty && !isSuccessRedirect) {
      app.saveBar.show('edit-campaign-save-bar');
    } else {
      app.saveBar.hide('edit-campaign-save-bar');
    }
  }, [isDirty, isSuccessRedirect, app]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname
  );

  const isStarted = new Date(campaign.startDateTime) < new Date();
// NOTE: This should be updated later to fetch the real participant count
  const hasParticipants = participantCount > 0; 
  const isFinished = campaign.status === 'SUCCESSFUL' || campaign.status === 'FAILED';
  const formKey = version || campaign.id;

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
  
  useEffect(() => {
    if (navigation.state === 'idle' && actionData?.errors) {
      app.toast.show('Please review the errors on the form', { isError: true, duration: 3000 });
    } else if (navigation.state === 'idle' && isSuccessRedirect) {
      app.toast.show('Campaign saved successfully');
      navigate(location.pathname, { replace: true });
    }
  }, [actionData, navigation.state, app, isSuccessRedirect, location.pathname, navigate]);

  useEffect(() => {
    if (blocker.state === "blocked") {
      app.saveBar.leaveConfirmation()
        .then((confirmed) => confirmed ? blocker.proceed() : blocker.reset());
    }
  }, [blocker, app]);

  const handleBackAction = () => {
    navigate('/app');
  };
  
  return (
    <Page
      title="Edit campaign"
      backAction={{ content: 'Campaigns', onAction: handleBackAction }}
    >
      {/* ✅ This now uses the correct child-button pattern */}
      <SaveBar id="edit-campaign-save-bar">
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
            key={formKey}
            ref={campaignFormRef}
            onDirtyChange={handleDirtyChange}
            onValidityChange={handleValidityChange}
            initialData={campaign}
            isStarted={isStarted}
            isFinished={isFinished}
            hasParticipants={hasParticipants}
            formErrors={actionData?.errors}
          />
        </Layout.Section>
      </Layout>
    </Page>
  );
}