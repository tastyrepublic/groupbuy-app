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
    // 1. Publish to Sales Channel (Keep this part)
    const appPublicationQuery = `query { currentAppInstallation { publication { id } } }`;
    const pubResponse = await admin.graphql(appPublicationQuery);
    const { data: pubData } = await pubResponse.json();
    const appPublicationId = pubData.currentAppInstallation.publication.id;

    const publishMutation = `
      mutation publishablePublish($productId: ID!, $publicationId: ID!) {
        publishablePublish(id: $productId, input: [{ publicationId: $publicationId }]) {
          publishable { ... on Product { id } }
          userErrors { field message }
        }
      }`;
    
    await admin.graphql(publishMutation, {
      variables: { "productId": productId, "publicationId": appPublicationId }
    });

    // 2. Create the campaign (Keep this part)
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
      },
    });

    // ✅ THE FIX: The crashing line was removed from here.

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