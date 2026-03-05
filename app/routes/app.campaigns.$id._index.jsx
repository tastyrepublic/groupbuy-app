import { json, redirect } from "@remix-run/node";
import { format } from 'date-fns';
import { CloudSchedulerClient } from '@google-cloud/scheduler';
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
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const campaignId = parseInt(params.id, 10);

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) { throw new Response("Not Found", { status: 404 }); }

  const participantCount = 0; // Replace with your actual participant logic if needed
  const isStarted = new Date(campaign.startDateTime) < new Date();
  const hasParticipants = participantCount > 0;
  const errors = { tiers: [], schedule: {}, leaderDiscount: null };

  // --- Start building the object of data to update ---
  const dataToUpdate = {};

  // --- Get and validate all data from the form ---

  // --- NEW: Handle the array of selected variants ---
  const selectedVariantIdsJson = formData.get("selectedVariantIdsJson");
  if (selectedVariantIdsJson) {
    const selectedVariantIds = JSON.parse(selectedVariantIdsJson);
    if (selectedVariantIds.length > 0) {
      dataToUpdate.selectedVariantIdsJson = selectedVariantIdsJson;
      // Also update parent product info in case it was changed
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

  if (!isStarted) {
    const campaignTimezone = formData.get("timezone");
    const startDateTimeUtc = toDate(formData.get("startDate"), { timeZone: campaignTimezone });
    const endDateTimeUtc = toDate(formData.get("endDate"), { timeZone: campaignTimezone });
    if (startDateTimeUtc.getTime() < new Date().getTime() - 60000) { errors.schedule.startDate = 'Cannot be in the past.'; }
    if (startDateTimeUtc >= endDateTimeUtc) { errors.schedule.endDate = 'Must be after start date.'; }

    dataToUpdate.startDateTime = startDateTimeUtc;
    dataToUpdate.endDateTime = endDateTimeUtc;
    dataToUpdate.startingParticipants = parseInt(formData.get("startingParticipants"), 10);

    // --- Update Google Cloud Scheduler ---
    // (This logic is moved inside the main try/catch block for better error handling)
  }

  // --- Final validation check before proceeding ---
  if (errors.product || errors.leaderDiscount || errors.tiers.some(e => e) || Object.keys(errors.schedule).length > 0) {
    return json({ errors }, { status: 422 });
  }

  try {
    // --- Update Google Cloud Scheduler if schedule has changed ---
    if (!isStarted && dataToUpdate.endDateTime) {
        const schedulerClient = new CloudSchedulerClient();
        const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
        const location = 'asia-east2';
        const parent = `projects/${projectId}/locations/${location}`;

        if (campaign.schedulerJobName) {
            const oldJobPath = `${parent}/jobs/${campaign.schedulerJobName}`;
            try { await schedulerClient.deleteJob({ name: oldJobPath }); }
            catch (error) { if (error.code !== 5) throw error; }
        }

        const newJobName = `finalize-campaign-${campaign.id}-${Date.now()}`;
        const newJob = {
            name: `${parent}/jobs/${newJobName}`,
            description: `Finalize group buy campaign ID ${campaign.id}`,
      httpTarget: {
        uri: `https://${request.headers.get('host')}/api/finalize-campaign`,
        httpMethod: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SCHEDULER_SECRET}` },
        body: Buffer.from(JSON.stringify({ campaignId: campaign.id })),
      },
      schedule: format(dataToUpdate.endDateTime, "m H d M *"),
            timeZone: 'Etc/UTC',
        };
        await schedulerClient.createJob({ parent, job: newJob });
        dataToUpdate.schedulerJobName = newJobName;
    }

    // --- Perform a single database update at the end ---
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