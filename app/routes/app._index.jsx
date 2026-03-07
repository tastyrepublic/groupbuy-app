import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
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
  EmptyState,
  Box,
  Spinner,
} from "@shopify/polaris";
import { ViewIcon, OrderIcon, ChevronDownIcon, ChevronUpIcon, ImageIcon } from '@shopify/polaris-icons';
import { useState, useEffect, useMemo } from "react";
import { formatInTimeZone } from 'date-fns-tz';
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  // --- PAGINATION MATH ---
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const PAGE_SIZE = 10; 
  const skip = (page - 1) * PAGE_SIZE;

  // 1. Get the total count of campaigns for this shop
  const totalCampaigns = await db.campaign.count({
    where: { shop: session.shop },
  });

  const totalPages = Math.ceil(totalCampaigns / PAGE_SIZE);
  const hasNextPage = page < totalPages;
  const hasPreviousPage = page > 1;

  // 2. Fetch ONLY the campaigns for the current page
  const campaigns = await db.campaign.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE, // Limit to 10
    skip: skip,      // Skip previous pages
    include: {
      groups: {
        select: {
          _count: {
            select: { participants: true }
          }
        }
      }
    }
  });

  let primaryDomainUrl = '';
  
  if (campaigns.length === 0) {
    const domainResponse = await admin.graphql(`query { shop { primaryDomain { url } } }`);
    const { data } = await domainResponse.json();
    primaryDomainUrl = data.shop.primaryDomain.url;
    return json({ 
      campaigns: [], 
      primaryDomainUrl,
      pagination: { page, hasNextPage, hasPreviousPage }
    });
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
    { variables: { ids: productIds } },
  );

  const graphqlResponse = await response.json();
  primaryDomainUrl = graphqlResponse.data.shop.primaryDomain.url;

  const productData = graphqlResponse.data.nodes.reduce((acc, node) => {
    if (node) acc[node.id] = node;
    return acc;
  }, {});

  const campaignsWithHandles = campaigns.map((campaign) => {
    const hasOrders = campaign.groups.some(group => group._count.participants > 0);
    return {
      ...campaign,
      productHandle: productData[campaign.productId]?.handle,
      hasOrders
    };
  });

  return json({ 
    campaigns: campaignsWithHandles, 
    primaryDomainUrl,
    pagination: { page, totalPages, hasNextPage, hasPreviousPage } // Send pagination state to the UI
  });
};

export const action = async ({ request }) => {
  const formData = await request.formData();

  if (formData.get("_action") === "delete") {
    const campaignId = formData.get("campaignId");
    await db.campaign.delete({
      where: { id: parseInt(campaignId, 10) },
    });
    return json({ success: true });
  }
}

function DeleteCampaignButton({ campaignId, fetcher, isEnded, hasOrders }) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isConsentChecked, setIsConsentChecked] = useState(false);

  const isDeleting = 
    fetcher.state !== 'idle' && 
    fetcher.formData?.get('campaignId') === campaignId &&
    fetcher.formData?.get('_action') === 'delete';

  const handleDelete = () => {
    const formData = { _action: 'delete', campaignId: campaignId };
    fetcher.submit(formData, { method: 'post' });
    setIsModalOpen(false); 
  };

  const toggleModal = () => {
    setIsModalOpen((active) => !active);
    setIsConsentChecked(false); 
  };

  // ✅ NEW: Combine the lock conditions
  const isLocked = isEnded || hasOrders;

  // Optional: A helpful tooltip message explaining why it's locked
  const lockReason = hasOrders 
    ? "Cannot delete campaigns with existing orders" 
    : "Cannot delete ended campaigns";

  const buttonMarkup = (
    <Button
      destructive
      onClick={toggleModal}
      loading={isDeleting}
      disabled={isLocked || (fetcher.state !== 'idle' && !isDeleting)}
    >
      Delete
    </Button>
  );

  return (
    <div>
      {/* ✅ Wrap in a tooltip if it's locked so the user isn't confused! */}
      {isLocked ? (
        <Tooltip content={lockReason}>
          <span style={{ cursor: 'not-allowed' }}>
            {buttonMarkup}
          </span>
        </Tooltip>
      ) : (
        buttonMarkup
      )}

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
        secondaryActions={[{ content: 'Cancel', onAction: toggleModal }]}
      >
        <Modal.Section>
          <Text as="p">
            This action can’t be undone. All campaign data will be permanently lost.
          </Text>
          <Box paddingBlockStart="200">
            <Checkbox
              label="I understand this action cannot be undone."
              checked={isConsentChecked}
              onChange={(newValue) => setIsConsentChecked(newValue)}
            />
          </Box>
        </Modal.Section>
      </Modal>
    </div>
  );
}

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
    if (now < startTime) return 'Scheduled';
    if (now >= startTime && now < endTime) return 'Active';
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

  const timezoneOptions = useMemo(() => {
    return Intl.supportedValuesOf('timeZone').map((tz) => ({
      label: tz.replace(/_/g, ' '), 
      value: tz
    }));
  }, []);

  const productUrl = (primaryDomainUrl && campaign.productHandle)
    ? `${primaryDomainUrl}/products/${campaign.productHandle}`
    : null;

  const numericProductId = campaign.productId.split('/').pop();

  return (
    <>
      <IndexTable.Row id={campaign.id} key={campaign.id} position={index}>
        <IndexTable.Cell>
          <InlineStack blockAlign="center" gap="300" wrap={false}>
            <Button
              variant="tertiary"
              onClick={() => setOpen(!open)}
              icon={open ? ChevronUpIcon : ChevronDownIcon}
              accessibilityLabel={open ? "Collapse details" : "Expand details"}
            />
            <Thumbnail
              source={campaign.productImage || ImageIcon} 
              alt={campaign.productTitle}
              size="small"
            />
            <Link
              url={`shopify://admin/products/${numericProductId}`}
              target="_top"
              removeUnderline
            >
              <Text variant="bodyMd" fontWeight="bold" as="span">
                {campaign.productTitle}
              </Text>
            </Link>
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
            
            <DeleteCampaignButton 
                campaignId={campaign.id.toString()} 
                fetcher={deleteFetcher}
                isEnded={getDisplayStatus(campaign) === 'Successful' || getDisplayStatus(campaign) === 'Failed'}
            />
          </ButtonGroup>
        </IndexTable.Cell>
      </IndexTable.Row>
      <IndexTable.Row id={`details-${campaign.id}`} key={`details-${campaign.id}`}>
        
        {/* ✅ FINAL FIX: Added `maxWidth: 0`. This stops the HTML table from expanding the first column! */}
        <td colSpan={4} className="Polaris-IndexTable__TableCell" style={{ padding: 0, borderTop: 'none', maxWidth: 0 }}>
          
          {/* ✅ Wrapped in a 100% width div so the internal content safely fills the space */}
          <div style={{ width: '100%', minWidth: 0 }}>
            <Collapsible
              open={open}
              id={`collapsible-${campaign.id}`}
              transition={{ duration: '300ms', timingFunction: 'ease-in-out' }}
            >
              <Box padding="400" background="bg-surface-secondary">
                <BlockStack gap="400">
                  <DescriptionList
                    items={[
                      { 
                        term: 'Campaign Timezone', 
                        description: (
                          <InlineStack blockAlign="center" gap="400">
                            <Text as="span">{campaign.timezone}</Text>
                            <div style={{ width: '220px' }}>
                              <Select
                                label="Display Time In"
                                labelHidden
                                options={timezoneOptions}
                                onChange={setDisplayTimezone}
                                value={displayTimezone}
                              />
                            </div>
                          </InlineStack>
                        ) 
                      },
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
                </BlockStack>
              </Box>
            </Collapsible>
          </div>
        </td>
      </IndexTable.Row>
    </>
  );
}

export default function Index() {
  // ✅ Extract the pagination object from the loader
  const { campaigns, primaryDomainUrl, pagination } = useLoaderData();
  const [hasMounted, setHasMounted] = useState(false);
  
  const app = useAppBridge();
  const deleteFetcher = useFetcher();
  const navigate = useNavigate(); // ✅ Add navigate hook

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (deleteFetcher.state === 'idle' && deleteFetcher.data) {
      const toast = app.toast;
      if (deleteFetcher.data.success) {
        toast.show('Campaign deleted successfully.', { duration: 5000 });
      } else if (deleteFetcher.data.error) {
        toast.show(deleteFetcher.data.error, { isError: true, duration: 8000 });
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
              campaigns.length === 0 && pagination.page === 1 ? (
                <EmptyState
                  heading="Manage your group buy campaigns"
                  action={{
                    content: 'Create campaign',
                    url: '/app/campaigns/new',
                  }}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>Create your first campaign to start offering group buy discounts to your customers.</p>
                </EmptyState>
              ) : (
                <IndexTable
                  itemCount={campaigns.length}
                  headings={[
                    { title: 'Product' },
                    { title: 'Status' },
                    { title: 'Date Created' },
                    { title: 'Action' },
                  ]}
                  selectable={false}
                  // ✅ NEW: Add native Polaris pagination controls to the bottom of the table
                  pagination={{
                    hasNext: pagination.hasNextPage,
                    hasPrevious: pagination.hasPreviousPage,
                    onNext: () => navigate(`?page=${pagination.page + 1}`),
                    onPrevious: () => navigate(`?page=${pagination.page - 1}`),
                    label: `Page ${pagination.page} of ${pagination.totalPages}`,
                  }}
                >
                  {rowMarkup}
                </IndexTable>
              )
            ) : (
              <Box padding="800">
                <InlineStack align="center" blockAlign="center">
                  <Spinner accessibilityLabel="Loading campaigns" size="large" />
                </InlineStack>
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}