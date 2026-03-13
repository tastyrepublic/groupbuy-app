import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useNavigation } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Thumbnail,
  Button,
  Collapsible,
  BlockStack,
  DescriptionList,
  Select,
  Badge,
  Modal,
  InlineStack,
  Checkbox,
  EmptyState,
  Box,
  Link,
  useBreakpoints,
  Popover, 
  ActionList, 
  IndexFilters,
  useSetIndexFiltersMode,
  IndexFiltersMode,
  SkeletonThumbnail, // ✨ Restored Skeleton imports
  SkeletonBodyText 
} from "@shopify/polaris";
import { SettingsIcon, ViewIcon, OrderIcon, ChevronDownIcon, ChevronUpIcon, ImageIcon, EditIcon, DeleteIcon } from '@shopify/polaris-icons';
import { useState, useEffect, useMemo } from "react";
import { formatInTimeZone } from 'date-fns-tz';
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { toggleContinueSelling } from "../utils/inventory.server.js";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const PAGE_SIZE = 10; 
  const skip = (page - 1) * PAGE_SIZE;

  const totalCampaigns = await db.campaign.count({
    where: { shop: session.shop },
  });

  const totalPages = Math.ceil(totalCampaigns / PAGE_SIZE);
  const hasNextPage = page < totalPages;
  const hasPreviousPage = page > 1;

  const campaigns = await db.campaign.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE, 
    skip: skip,      
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
    pagination: { page, totalPages, hasNextPage, hasPreviousPage } 
  });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("_action") === "delete") {
    const campaignId = parseInt(formData.get("campaignId"), 10);
    
    const campaign = await db.campaign.findUnique({
      where: { id: campaignId, shop: session.shop }
    });

    if (!campaign) {
      return json({ error: "Campaign not found" }, { status: 404 });
    }

    if (campaign.sellingPlanGroupId) {
      try {
        const deleteSellingPlanMutation = `
          mutation sellingPlanGroupDelete($id: ID!) {
            sellingPlanGroupDelete(id: $id) {
              deletedSellingPlanGroupId
              userErrors {
                field
                message
              }
            }
          }
        `;

        const deleteResponse = await admin.graphql(deleteSellingPlanMutation, {
          variables: { id: campaign.sellingPlanGroupId }
        });
        
        const deleteData = await deleteResponse.json();
        
        if (deleteData.data?.sellingPlanGroupDelete?.userErrors?.length > 0) {
          console.error("Shopify failed to delete Selling Plan:", deleteData.data.sellingPlanGroupDelete.userErrors);
        } else {
          console.log(`✅ Successfully removed Selling Plan Group ${campaign.sellingPlanGroupId} from Shopify.`);
        }
      } catch (graphqlError) {
        console.error("Network error deleting Selling Plan:", graphqlError);
      }
    }

    await toggleContinueSelling(admin, session.shop, campaign.productId, campaign.id, "END");

    await db.campaign.delete({
      where: { id: campaignId },
    });
    
    return json({ success: true });
  }
}

const getDisplayStatus = (campaign) => {
  if (campaign.status === 'SUCCESSFUL' || campaign.status === 'FAILED') {
    return campaign.status.charAt(0).toUpperCase() + campaign.status.slice(1).toLowerCase();
  }
  const now = new Date();
  const startTime = new Date(campaign.startDateTime);
  const endTime = new Date(campaign.endDateTime);

  if (now < startTime) return 'Scheduled';
  if (now >= startTime && now < endTime) {
    if (campaign.status === 'PROCESSING') return 'Processing'; 
    return 'Active';
  }
  if (now >= endTime) return 'Processing';
  return 'Unknown';
};

function CampaignRow({ campaign, index, primaryDomainUrl, deleteFetcher }) {
  const [open, setOpen] = useState(false);
  const [displayTimezone, setDisplayTimezone] = useState('Europe/London');
  const { smDown } = useBreakpoints(); 
  
  const [popoverActive, setPopoverActive] = useState(false);
  const togglePopover = () => setPopoverActive((active) => !active);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isConsentChecked, setIsConsentChecked] = useState(false);

  const tiers = JSON.parse(campaign.tiersJson || '[]');
  const tierTones = ['info', 'success', 'attention', 'warning', 'new'];

  const displayStatus = getDisplayStatus(campaign);
  const isLocked = ['Successful', 'Failed', 'Processing'].includes(displayStatus); 
  const isDeleteLocked = isLocked || campaign.hasOrders;

  const getStatusBadgeTone = (status) => {
    switch (status) {
      case 'Active': return 'info';
      case 'Processing': return 'warning'; 
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

  const isDeleting = 
    deleteFetcher.state !== 'idle' && 
    deleteFetcher.formData?.get('campaignId') === campaign.id.toString() &&
    deleteFetcher.formData?.get('_action') === 'delete';

  const toggleDeleteModal = () => {
    setIsDeleteModalOpen((active) => !active);
    setIsConsentChecked(false); 
    setPopoverActive(false); 
  };

  const handleDelete = () => {
    const formData = { _action: 'delete', campaignId: campaign.id.toString() };
    deleteFetcher.submit(formData, { method: 'post' });
    // ✨ REMOVED: setIsDeleteModalOpen(false) 
    // The modal will now stay open and show the spinner until the campaign is destroyed!
  };

  const actionMenu = (
    <Popover
      active={popoverActive}
      activator={<Button onClick={togglePopover} disclosure>Actions</Button>}
      autofocusTarget="first-node"
      onClose={togglePopover}
      preferredAlignment="right"
    >
      <ActionList
        actionRole="menuitem"
        items={[
          ...(productUrl ? [{ 
            content: 'Preview on Store', 
            icon: ViewIcon, 
            onAction: () => window.open(productUrl, '_blank') 
          }] : []),
          { content: 'View Orders', icon: OrderIcon, url: `/app/campaigns/${campaign.id}/orders` },
          { 
            content: 'Edit', 
            icon: EditIcon, 
            url: isLocked ? undefined : `/app/campaigns/${campaign.id}`, // ✨ FIX applied here
            disabled: isLocked 
          },
          { 
            content: 'Delete', 
            icon: DeleteIcon, 
            destructive: true, 
            disabled: isDeleteLocked || isDeleting, 
            onAction: toggleDeleteModal 
          }
        ]}
      />
    </Popover>
  );

  return (
    <>
      <IndexTable.Row id={campaign.id} key={campaign.id} position={index}>
        {smDown ? (
          <IndexTable.Cell>
            <BlockStack gap="400">
              <InlineStack blockAlign="center" gap="300" wrap={false}>
                <Button variant="tertiary" onClick={() => setOpen(!open)} icon={open ? ChevronUpIcon : ChevronDownIcon} accessibilityLabel={open ? "Collapse details" : "Expand details"} />
                <Thumbnail source={campaign.productImage || ImageIcon} alt={campaign.productTitle} size="small" />
                <Link url={`shopify://admin/products/${numericProductId}`} target="_top" removeUnderline>
                  <Text variant="bodyMd" fontWeight="bold" as="span">{campaign.productTitle}</Text>
                </Link>
              </InlineStack>
              <InlineStack align="space-between" blockAlign="center" wrap>
                <InlineStack gap="300" blockAlign="center">
                  <Badge size="small" tone={getStatusBadgeTone(displayStatus)}>{displayStatus}</Badge>
                  <Text variant="bodySm" tone="subdued">Date Created: {formatDateOnly(campaign.createdAt)}</Text>
                </InlineStack>
                {actionMenu} 
              </InlineStack>
            </BlockStack>
          </IndexTable.Cell>
        ) : (
          <>
            <IndexTable.Cell>
              <InlineStack blockAlign="center" gap="300" wrap={false}>
                <Button variant="tertiary" onClick={() => setOpen(!open)} icon={open ? ChevronUpIcon : ChevronDownIcon} accessibilityLabel={open ? "Collapse details" : "Expand details"} />
                <Thumbnail source={campaign.productImage || ImageIcon} alt={campaign.productTitle} size="small" />
                <Link url={`shopify://admin/products/${numericProductId}`} target="_top" removeUnderline>
                  <Text variant="bodyMd" fontWeight="bold" as="span">{campaign.productTitle}</Text>
                </Link>
              </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Badge size="small" tone={getStatusBadgeTone(displayStatus)}>{displayStatus}</Badge>
            </IndexTable.Cell>
            <IndexTable.Cell>{formatDateOnly(campaign.createdAt)}</IndexTable.Cell>
            <IndexTable.Cell>
              {actionMenu} 
            </IndexTable.Cell>
          </>
        )}
      </IndexTable.Row>

      <IndexTable.Row id={`details-${campaign.id}`} key={`details-${campaign.id}`}>
        <td colSpan={smDown ? 1 : 4} className="Polaris-IndexTable__TableCell" style={{ padding: 0, borderTop: 'none', maxWidth: 0 }}>
          <div style={{ width: '100%', minWidth: 0 }}>
            <Collapsible open={open} id={`collapsible-${campaign.id}`} transition={{ duration: '300ms', timingFunction: 'ease-in-out' }}>
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
                              <Select label="Display Time In" labelHidden options={timezoneOptions} onChange={setDisplayTimezone} value={displayTimezone} />
                            </div>
                          </InlineStack>
                        ) 
                      },
                      { term: 'Converted Start Time', description: formatForDisplay(campaign.startDateTime, displayTimezone) },
                      { term: 'Converted End Time', description: formatForDisplay(campaign.endDateTime, displayTimezone) },
                      { 
                        term: 'Discount Tiers', 
                        description: tiers.length > 0 ? (
                          <InlineStack gap="200" wrap>
                            {tiers.map((tier, idx) => (
                              <Badge key={idx} tone={tierTones[idx % tierTones.length]}>
                                {tier.quantity} {campaign.countingMethod === 'ITEM_QUANTITY' ? 'items' : 'buyers'} ➔ {tier.discount}% off
                              </Badge>
                            ))}
                          </InlineStack>
                        ) : (
                          <Text variant="bodyMd" tone="subdued">No tiers configured.</Text>
                        )
                      }
                    ]}
                  />
                </BlockStack>
              </Box>
            </Collapsible>
          </div>
        </td>
      </IndexTable.Row>

      <Modal
        open={isDeleteModalOpen}
        onClose={toggleDeleteModal}
        title="Delete this campaign?"
        primaryAction={{
          content: 'Delete campaign',
          destructive: true,
          onAction: handleDelete,
          loading: isDeleting, // ✨ Controls the spinner on the button!
          disabled: !isConsentChecked || (deleteFetcher.state !== 'idle' && !isDeleting),
        }}
        secondaryActions={[{ content: 'Cancel', onAction: toggleDeleteModal }]}
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
    </>
  );
}

export default function Index() {
  const { campaigns: initialCampaigns, primaryDomainUrl, pagination } = useLoaderData();
  const [hasMounted, setHasMounted] = useState(false);
  const { smDown } = useBreakpoints(); 
  
  const app = useAppBridge();
  const deleteFetcher = useFetcher();
  const navigate = useNavigate(); 
  const navigation = useNavigation();

  const [itemStrings] = useState(['All', 'Active', 'Processing', 'Completed']);
  
  const [selected, setSelected] = useState(0);
  const [queryValue, setQueryValue] = useState('');
  const [sortSelected, setSortSelected] = useState(['date desc']);
  const { mode, setMode } = useSetIndexFiltersMode(IndexFiltersMode.Default);

  const [appliedFilters, setAppliedFilters] = useState({ selected: 0, queryValue: '', sortSelected: ['date desc'] });
  const [isFiltering, setIsFiltering] = useState(false);

  useEffect(() => {
    setIsFiltering(true);
    const timer = setTimeout(() => {
      setAppliedFilters({ selected, queryValue, sortSelected });
      setIsFiltering(false);
    }, 250); 
    
    return () => clearTimeout(timer);
  }, [selected, queryValue, sortSelected]);

  const isNavigating = navigation.state === "loading";
  const isDeleting = deleteFetcher.state !== 'idle' && deleteFetcher.formData?.get('_action') === 'delete';
  const isBusy = isNavigating || isDeleting || isFiltering; 

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

  const filteredCampaigns = useMemo(() => {
    let filtered = [...initialCampaigns];

    if (appliedFilters.queryValue) {
      const q = appliedFilters.queryValue.toLowerCase();
      filtered = filtered.filter(c => c.productTitle.toLowerCase().includes(q));
    }

    if (appliedFilters.selected > 0) {
      const tabName = itemStrings[appliedFilters.selected];
      filtered = filtered.filter(c => {
        const status = getDisplayStatus(c);
        if (tabName === 'Completed') return ['Successful', 'Failed'].includes(status);
        return status === tabName;
      });
    }

    if (appliedFilters.sortSelected[0] === 'date asc') {
      filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else {
      filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    return filtered;
  }, [initialCampaigns, appliedFilters, itemStrings]);

  const rowMarkup = filteredCampaigns.map(
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

  const tableHeadings = smDown 
    ? [{ title: 'Campaigns' }] 
    : [
        { title: 'Product' },
        { title: 'Status' },
        { title: 'Date Created' },
        { title: 'Action' },
      ];

  const tabs = itemStrings.map((item, index) => ({
    content: item,
    id: `${item}-${index}`,
    actions: [],
    isLocked: index === 0,
  }));

  // ✨ RESTORED: Skeleton Rows for initial loading state
  const skeletonRows = Array.from({ length: 5 }).map((_, index) => (
    <IndexTable.Row id={`skeleton-${index}`} key={`skeleton-${index}`} position={index}>
      {smDown ? (
        <IndexTable.Cell>
          <BlockStack gap="400">
            <InlineStack blockAlign="center" gap="300" wrap={false}>
              <Button variant="tertiary" icon={ChevronDownIcon} disabled />
              <SkeletonThumbnail size="small" />
              <div style={{ flex: 1 }}><SkeletonBodyText lines={1} /></div>
            </InlineStack>
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Box width="60px"><SkeletonBodyText lines={1} /></Box>
              <Button disabled disclosure>Actions</Button>
            </InlineStack>
          </BlockStack>
        </IndexTable.Cell>
      ) : (
        <>
          <IndexTable.Cell>
            <InlineStack blockAlign="center" gap="300" wrap={false}>
              <Button variant="tertiary" icon={ChevronDownIcon} disabled />
              <SkeletonThumbnail size="small" />
              <Box width="150px"><SkeletonBodyText lines={1} /></Box>
            </InlineStack>
          </IndexTable.Cell>
          <IndexTable.Cell><Box width="60px"><SkeletonBodyText lines={1} /></Box></IndexTable.Cell>
          <IndexTable.Cell><Box width="80px"><SkeletonBodyText lines={1} /></Box></IndexTable.Cell>
          <IndexTable.Cell>
            <Button disabled disclosure>Actions</Button>
          </IndexTable.Cell>
        </>
      )}
    </IndexTable.Row>
  ));

  return (
    <Page
  title="Group Buy Campaigns"
  primaryAction={{
    content: "Create campaign",
    url: "/app/campaigns/new",
  }}
  secondaryActions={[ // ✨ Add this block
    {
      content: "Settings",
      icon: SettingsIcon,
      url: "/app/settings",
    }
  ]}
>
      <style>{`
        .native-fade-table .Polaris-IndexTable tbody {
          transition: opacity 250ms ease-in-out !important;
        }
        .native-fade-table.is-busy .Polaris-IndexTable tbody {
          opacity: 0.4 !important;
          pointer-events: none;
        }
      `}</style>

      <Layout>
        <Layout.Section>
          <Card padding="0">
            <IndexFilters
              sortOptions={[
                { label: 'Date (Newest first)', value: 'date desc', directionLabel: 'Descending' },
                { label: 'Date (Oldest first)', value: 'date asc', directionLabel: 'Ascending' },
              ]}
              sortSelected={sortSelected}
              queryValue={queryValue}
              queryPlaceholder="Search products"
              onQueryChange={setQueryValue}
              onQueryClear={() => setQueryValue('')}
              onSort={setSortSelected}
              tabs={tabs}
              selected={selected}
              onSelect={setSelected}
              canCreateNewView={false}
              filters={[]}
              appliedFilters={[]}
              onClearAll={() => {}}
              mode={mode}
              setMode={setMode}
              disabled={isDeleting}
              loading={isBusy} 
              cancelAction={{
                onAction: () => {
                  setQueryValue('');
                  setMode(IndexFiltersMode.Default);
                },
              }}
            />

            {!hasMounted ? (
              <IndexTable itemCount={5} headings={tableHeadings} selectable={false}>
                {skeletonRows}
              </IndexTable>
            ) : initialCampaigns.length === 0 ? (
              <EmptyState
                heading="Manage your group buy campaigns"
                action={{ content: 'Create campaign', url: '/app/campaigns/new' }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Create your first campaign to start offering group buy discounts to your customers.</p>
              </EmptyState>
            ) : (
              <div className={`native-fade-table ${isBusy ? 'is-busy' : ''}`}>
                <IndexTable
                  itemCount={filteredCampaigns.length}
                  headings={tableHeadings}
                  selectable={false}
                  pagination={{
                    hasNext: pagination.hasNextPage,
                    hasPrevious: pagination.hasPreviousPage,
                    onNext: () => navigate(`?page=${pagination.page + 1}`),
                    onPrevious: () => navigate(`?page=${pagination.page - 1}`),
                    label: `Page ${pagination.page} of ${pagination.totalPages}`,
                  }}
                >
                  {filteredCampaigns.length === 0 ? (
                    <IndexTable.Row>
                      <IndexTable.Cell colSpan={4}>
                        <Box padding="400" textAlign="center">
                          <Text tone="subdued">No campaigns match your filter.</Text>
                        </Box>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ) : rowMarkup}
                </IndexTable>
              </div>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}