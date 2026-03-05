import { json } from "@remix-run/node";
import { CloudSchedulerClient } from '@google-cloud/scheduler';
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Thumbnail,
  Button,
  ButtonGroup, 
  Collapsible,
  BlockStack,
  DescriptionList,
  Select,
  Badge,
  Modal,
  Tooltip,
  Link,
  InlineStack,
  Checkbox,
} from "@shopify/polaris";
import { ViewIcon, OrderIcon, ChevronDownIcon, ChevronUpIcon, ImageIcon } from '@shopify/polaris-icons';
import { useState, useEffect } from "react";
import { formatInTimeZone } from 'date-fns-tz';
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const campaigns = await db.campaign.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });

  let primaryDomainUrl = '';
  
  if (campaigns.length === 0) {
    const domainResponse = await admin.graphql(`query { shop { primaryDomain { url } } }`);
    const { data } = await domainResponse.json();
    primaryDomainUrl = data.shop.primaryDomain.url;
    return json({ campaigns: [], primaryDomainUrl });
  }

  const productIds = campaigns.map((c) => c.productId);
  const response = await admin.graphql(
    `#graphql
      query getShopData($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            handle
          }
        }
        shop {
          primaryDomain {
            url
          }
        }
      }`,
    {
      variables: {
        ids: productIds,
      },
    },
  );

  const graphqlResponse = await response.json();
  primaryDomainUrl = graphqlResponse.data.shop.primaryDomain.url;

  const productData = graphqlResponse.data.nodes.reduce((acc, node) => {
    if (node) {
      acc[node.id] = node;
    }
    return acc;
  }, {});

  const campaignsWithHandles = campaigns.map((campaign) => ({
    ...campaign,
    productHandle: productData[campaign.productId]?.handle,
  }));

  return json({ campaigns: campaignsWithHandles, primaryDomainUrl });
};

export const action = async ({ request }) => {
  const formData = await request.formData();

  if (formData.get("_action") === "delete") {
    const campaignId = formData.get("campaignId");

    try {
      const campaign = await db.campaign.findUnique({
        where: { id: parseInt(campaignId, 10) },
      });

      if (!campaign) {
        return json({ error: "Campaign not found" }, { status: 404 });
      }

      if (campaign.schedulerJobName) {
        const schedulerClient = new CloudSchedulerClient();
        const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
        const location = 'asia-east2'; 

        const jobPath = `projects/${projectId}/locations/${location}/jobs/${campaign.schedulerJobName}`;

        console.log(`Attempting to delete Google Cloud Scheduler job: ${jobPath}`);
        
        try {
          await schedulerClient.deleteJob({ name: jobPath });
          console.log(`Successfully deleted scheduler job: ${jobPath}`);
        } catch (error) {
           if (error.code !== 5) { 
             throw error; 
           }
            console.log(`Scheduler job not found (code: 5), proceeding with DB deletion.`);
        }
      }

      await db.campaign.delete({
        where: { id: parseInt(campaignId, 10) },
      });

      return json({ success: true });

    } catch (error) {
      console.error("Failed to delete campaign or scheduler job:", error);
      return json({ error: "Failed to delete campaign" }, { status: 500 });
    }
  }

  return json({ error: "Invalid action" }, { status: 400 });
};

// ✅ UPDATED: DeleteCampaignButton 
// accepts the parent fetcher to avoid the "Zombie" issue
function DeleteCampaignButton({ campaignId, fetcher }) {
  // NOTE: No `useFetcher()` here. We use the one passed in props.
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isConsentChecked, setIsConsentChecked] = useState(false);

  // ✅ SMART SPINNER LOGIC
  // Only return true if the fetcher is busy AND it is working on THIS campaign ID
  const isDeleting = 
    fetcher.state !== 'idle' && 
    fetcher.formData?.get('campaignId') === campaignId &&
    fetcher.formData?.get('_action') === 'delete';

  const handleDelete = () => {
    const formData = {
      _action: 'delete',
      campaignId: campaignId,
    };
    // Submit using the parent's fetcher
    fetcher.submit(formData, { method: 'post' });
    setIsModalOpen(false); 
  };

  const toggleModal = () => {
    setIsModalOpen((active) => !active);
    setIsConsentChecked(false); 
  };

  return (
    <div>
      <Button
        destructive
        onClick={toggleModal}
        loading={isDeleting} // Only spins if this specific button triggered the action
        disabled={fetcher.state !== 'idle' && !isDeleting} // Disable other buttons while one is deleting
      >
        Delete
      </Button>

      <Modal
        open={isModalOpen}
        onClose={toggleModal}
        title="Delete this campaign?"
        primaryAction={{
          content: 'Delete campaign',
          destructive: true,
          onAction: handleDelete,
          loading: isDeleting,
          disabled: !isConsentChecked || (fetcher.state !== 'idle' && !isDeleting),
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: toggleModal,
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            This action can’t be undone. All campaign data will be permanently lost.
          </Text>
          <Checkbox
              label="I understand this action cannot be undone."
              checked={isConsentChecked}
              onChange={(newValue) => setIsConsentChecked(newValue)}
            />
        </Modal.Section>
      </Modal>
    </div>
  );
}

// ✅ UPDATED: CampaignRow accepts deleteFetcher prop
function CampaignRow({ campaign, index, primaryDomainUrl, deleteFetcher }) {
  const [open, setOpen] = useState(false);
  const [displayTimezone, setDisplayTimezone] = useState('Europe/London');

  const tiers = JSON.parse(campaign.tiersJson || '[]');

  const getDisplayStatus = (campaign) => {
    if (campaign.status === 'SUCCESSFUL' || campaign.status === 'FAILED') {
      return campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1).toLowerCase();
    }

    const now = new Date();
    const startTime = new Date(campaign.startDateTime);
    const endTime = new Date(campaign.endDateTime);

    if (now < startTime) {
      return 'Scheduled';
    }
    
    if (now >= startTime && now < endTime) {
      return 'Active';
    }

    return 'Active'; 
  };

  const getStatusBadgeTone = (status) => {
    switch (status) {
      case 'Active': return 'info';
      case 'Successful': return 'success';
      case 'Failed': return 'critical';
      case 'Scheduled': return 'attention';
      default: return 'default';
    }
  };

  const formatForDisplay = (isoString, timeZone) => {
    if (!isoString || !timeZone) return "N/A";
    return formatInTimeZone(new Date(isoString), timeZone, 'yyyy-MM-dd @ HH:mm (zzz)');
  };
  
  const formatDateOnly = (isoString) => isoString.slice(0, 10);

  const timezoneOptions = [
    { label: 'London (BST)', value: 'Europe/London' },
    { label: 'Hong Kong (HKT)', value: 'Asia/Hong_Kong' },
    { label: 'New York (EDT)', value: 'America/New_York' },
    { label: 'Los Angeles (PDT)', value: 'America/Los_Angeles' },
    { label: 'Tokyo (UTC+9)', value: 'Asia/Tokyo' },
  ];

  const productUrl = (primaryDomainUrl && campaign.productHandle)
    ? `${primaryDomainUrl}/products/${campaign.productHandle}`
    : null;

  const numericProductId = campaign.productId.split('/').pop();

  return (
    <>
      <IndexTable.Row
        id={campaign.id}
        key={campaign.id}
        position={index}
      >
        <IndexTable.Cell>
          <Thumbnail
            source={campaign.productImage || ImageIcon} 
            alt={campaign.productTitle}
            size="small"
          />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
            <Link
              url={`shopify://admin/products/${numericProductId}`}
              target="_top"
              removeUnderline
            >
              {campaign.productTitle}
            </Link>
            <Button
              variant="tertiary"
              onClick={() => setOpen(!open)}
              icon={open ? ChevronUpIcon : ChevronDownIcon}
              accessibilityLabel={open ? "Collapse details" : "Expand details"}
            />
          </InlineStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {(() => {
            const displayStatus = getDisplayStatus(campaign);
            return (
              <Badge size="small" tone={getStatusBadgeTone(displayStatus)}>
                {displayStatus}
              </Badge>
            );
          })()}
        </IndexTable.Cell>
        <IndexTable.Cell>{formatDateOnly(campaign.createdAt)}</IndexTable.Cell>
        <IndexTable.Cell>
          <ButtonGroup>
            {productUrl && (
              <Tooltip content="Preview on Online Store"> 
                <Button
                  url={productUrl}
                  target="_blank"
                  icon={ViewIcon}
                  accessibilityLabel="Preview product on online store" 
                />
              </Tooltip>
            )}
            <Tooltip content="View all orders for this campaign">
            <Button 
              url={`/app/campaigns/${campaign.id}/orders`}
              icon={OrderIcon}
              accessibilityLabel="View orders for this campaign"
            >
              View Orders
            </Button>
            </Tooltip>
            
            <Button url={`/app/campaigns/${campaign.id}`}>
              Edit
            </Button>
            
            {/* ✅ PASS DOWN THE SINGLE FETCHER */}
            <DeleteCampaignButton 
                campaignId={campaign.id.toString()} 
                fetcher={deleteFetcher}
            />
          </ButtonGroup>
        </IndexTable.Cell>
      </IndexTable.Row>
      <IndexTable.Row id={`details-${campaign.id}`} key={`details-${campaign.id}`}>
        <td colSpan={5} style={{ padding: 0 }}>
          <Collapsible
            open={open}
            id={`collapsible-${campaign.id}`}
            transition={{ duration: '300ms', timingFunction: 'ease-in-out' }}
          >
            <div style={{ padding: '1rem 1rem 1rem 2rem' }}>
              <BlockStack gap="400">
                <DescriptionList
                  items={[
                    { term: 'Campaign Timezone', description: campaign.timezone },
                    { term: 'Converted Start Time', description: formatForDisplay(campaign.startDateTime, displayTimezone) },
                    { term: 'Converted End Time', description: formatForDisplay(campaign.endDateTime, displayTimezone) },
                  ]}
                />
                <Text variant="headingMd" as="h2">Discount Tiers</Text>
                <DescriptionList
                  items={tiers.map((tier, idx) => ({
                    term: `Tier ${idx + 1}`,
                    description: `A ${tier.discount}% discount for ${tier.quantity} or more participants.`
                  }))}
                />
                <div style={{ maxWidth: '200px', marginTop: '1rem' }}>
                  <Select
                    label="Display Time In"
                    labelInline
                    options={timezoneOptions}
                    onChange={setDisplayTimezone}
                    value={displayTimezone}
                  />
                </div>
              </BlockStack>
            </div>
          </Collapsible>
        </td>
      </IndexTable.Row>
    </>
  );
}

export default function Index() {
  const { campaigns, primaryDomainUrl } = useLoaderData();
  const [hasMounted, setHasMounted] = useState(false);
  
  // 2. Get App Bridge Instance
  const app = useAppBridge();
  
  // 3. Create ONE single fetcher for the whole page to handle deletes
  const deleteFetcher = useFetcher();

  useEffect(() => {
    setHasMounted(true);
  }, []);

  // 4. TOAST LOGIC: Watches the single deleteFetcher
  // Even if the row is deleted, this component stays mounted, so the toast will fire.
  useEffect(() => {
    if (deleteFetcher.state === 'idle' && deleteFetcher.data) {
      const toast = app.toast;
      if (deleteFetcher.data.success) {
        toast.show('Campaign deleted successfully.', {
            duration: 5000,
        });
      } else if (deleteFetcher.data.error) {
        toast.show(deleteFetcher.data.error, { 
            isError: true,
            duration: 8000,
        });
      }
    }
  }, [deleteFetcher.state, deleteFetcher.data, app]);

  const rowMarkup = campaigns.map(
    (campaign, index) => (
      <CampaignRow
        key={campaign.id}
        campaign={campaign}
        index={index}
        primaryDomainUrl={primaryDomainUrl}
        // 5. Pass the fetcher down to the row
        deleteFetcher={deleteFetcher}
      />
    )
  );

  return (
    <Page
      title="Group Buy Campaigns"
      primaryAction={{
        content: "Create campaign",
        url: "/app/campaigns/new",
      }}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            {hasMounted ? (
              campaigns.length === 0 ? (
                <div style={{ padding: '16px', textAlign: 'center' }}>
                  <Text as="p">No campaigns created yet.</Text>
                </div>
              ) : (
                <IndexTable
                  itemCount={campaigns.length}
                  headings={[
                    { title: 'Product' },
                    { title: 'Title' },
                    { title: 'Status' },
                    { title: 'Date Created' },
                    { title: 'Action' },
                  ]}
                  selectable={false}
                >
                  {rowMarkup}
                </IndexTable>
              )
            ) : (
              <div style={{ padding: '16px', textAlign: 'center' }}>
                <Text as="p">Loading campaigns...</Text>
              </div>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}