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
  SkeletonThumbnail,
  SkeletonBodyText,
  EmptySearchResult
} from "@shopify/polaris";
import { SettingsIcon, ViewIcon, OrderIcon, ChevronDownIcon, ChevronUpIcon, ImageIcon, EditIcon, DeleteIcon } from '@shopify/polaris-icons';
import { useState, useEffect, useMemo } from "react";
import { formatInTimeZone } from 'date-fns-tz';
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { toggleContinueSelling } from "../utils/inventory.server.js";

// ✨ 1. Import your i18n utility
import { getI18n } from "../utils/i18n.server.js";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { t } = await getI18n(request);

  // 1. Calculate the page and total campaigns FIRST
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

  // 2. NOW we can build the translations, because 'page' and 'totalPages' exist!
  const translations = {
    title: t("Dashboard.title", "Group Buy Campaigns"),
    createCampaign: t("Dashboard.createCampaign", "Create campaign"),
    settings: t("Dashboard.settings", "Settings"),
    tabs: {
      all: t("Dashboard.tabs.all", "All"),
      active: t("Dashboard.tabs.active", "Active"),
      processing: t("Dashboard.tabs.processing", "Processing"),
      completed: t("Dashboard.tabs.completed", "Completed")
    },
    status: {
      scheduled: t("Dashboard.status.scheduled", "Scheduled"),
      active: t("Dashboard.status.active", "Active"),
      processing: t("Dashboard.status.processing", "Processing"),
      successful: t("Dashboard.status.successful", "Successful"),
      failed: t("Dashboard.status.failed", "Failed"),
      unknown: t("Dashboard.status.unknown", "Unknown")
    },
    table: {
      product: t("Dashboard.table.product", "Product"),
      status: t("Dashboard.table.status", "Status"),
      dateCreated: t("Dashboard.table.dateCreated", "Date Created"),
      action: t("Dashboard.table.action", "Action"),
      campaigns: t("Dashboard.table.campaigns", "Campaigns"),
      empty: t("Dashboard.table.empty", "No campaigns match your filter.")
    },
    row: {
      actions: t("Dashboard.row.actions", "Actions"),
      preview: t("Dashboard.row.preview", "Preview on Store"),
      viewOrders: t("Dashboard.row.viewOrders", "View Orders"),
      edit: t("Dashboard.row.edit", "Edit"),
      delete: t("Dashboard.row.delete", "Delete"),
      timezone: t("Dashboard.row.timezone", "Campaign Timezone"),
      displayTimeIn: t("Dashboard.row.displayTimeIn", "Display Time In"),
      startTime: t("Dashboard.row.startTime", "Converted Start Time"),
      endTime: t("Dashboard.row.endTime", "Converted End Time"),
      discountTiers: t("Dashboard.row.discountTiers", "Discount Tiers"),
      items: t("Dashboard.row.items", "items"),
      buyers: t("Dashboard.row.buyers", "buyers"),
      off: t("Dashboard.row.off", "off"),
      noTiers: t("Dashboard.row.noTiers", "No tiers configured.")
    },
    deleteModal: {
      title: t("Dashboard.deleteModal.title", "Delete this campaign?"),
      confirm: t("Dashboard.deleteModal.confirm", "Delete campaign"),
      cancel: t("Dashboard.deleteModal.cancel", "Cancel"),
      warning: t("Dashboard.deleteModal.warning", "This action can’t be undone. All campaign data will be permanently lost."),
      checkbox: t("Dashboard.deleteModal.checkbox", "I understand this action cannot be undone.")
    },
    emptyState: {
      heading: t("Dashboard.emptyState.heading", "Manage your group buy campaigns"),
      description: t("Dashboard.emptyState.description", "Create your first campaign to start offering group buy discounts to your customers.")
    },
    filters: {
      search: t("Dashboard.filters.search", "Search products"),
      newest: t("Dashboard.filters.newest", "Date (Newest first)"),
      oldest: t("Dashboard.filters.oldest", "Date (Oldest first)"),
      descending: t("Dashboard.filters.descending", "Descending"),
      ascending: t("Dashboard.filters.ascending", "Ascending"),
      cancel: t("Dashboard.filters.cancel", "Cancel")
    },
    searchEmpty: {
      title: t("Dashboard.searchEmpty.title", "No Items found"),
      description: t("Dashboard.searchEmpty.description", "Try changing the filters or search term")
    },
    paginationLabel: t("Dashboard.paginationLabel", {
      page: page,
      totalPages: Math.max(1, totalPages), // Much cleaner math now!
      defaultValue: `Page ${page} of ${Math.max(1, totalPages)}`
    }),
    messages: {
      deleteSuccess: t("Dashboard.messages.deleteSuccess", "Campaign deleted successfully.")
    }
  };

  // 3. Fetch the actual campaigns
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
      translations, // ✨ Return translations
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
    translations, // ✨ Return translations
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

    // 1. Delete the Selling Plan
    if (campaign.sellingPlanGroupId) {
      try {
        await admin.graphql(`
          mutation sellingPlanGroupDelete($id: ID!) {
            sellingPlanGroupDelete(id: $id) { deletedSellingPlanGroupId }
          }
        `, { variables: { id: campaign.sellingPlanGroupId } });
      } catch (error) {
        console.error("Network error deleting Selling Plan:", error);
      }
    }

    // ✨ ALL SHIPPING MOVE-OUT LOGIC HAS BEEN DELETED! ✨

    // 2. Toggle Inventory & Delete DB
    await toggleContinueSelling(admin, session.shop, campaign.productId, campaign.id, "END");

    await db.campaign.delete({
      where: { id: campaignId },
    });
    
    return json({ success: true });
  }
}

// ✨ UPDATE: Status logic uses pure uppercase keys for solid internal logic, independent of translation language
const getInternalStatus = (campaign) => {
  if (campaign.status === 'SUCCESSFUL' || campaign.status === 'FAILED') {
    return campaign.status;
  }
  const now = new Date();
  const startTime = new Date(campaign.startDateTime);
  const endTime = new Date(campaign.endDateTime);

  if (now < startTime) return 'SCHEDULED';
  if (now >= startTime && now < endTime) {
    if (campaign.status === 'PROCESSING') return 'PROCESSING'; 
    return 'ACTIVE';
  }
  if (now >= endTime) return 'PROCESSING';
  return 'UNKNOWN';
};

const getStatusBadgeTone = (internalStatus) => {
  switch (internalStatus) {
    case 'ACTIVE': return 'info';
    case 'PROCESSING': return 'warning'; 
    case 'SUCCESSFUL': return 'success';
    case 'FAILED': return 'critical';
    case 'SCHEDULED': return 'attention';
    default: return 'default';
  }
};

function CampaignRow({ campaign, index, primaryDomainUrl, deleteFetcher, translations }) {
  const [open, setOpen] = useState(false);
  const [displayTimezone, setDisplayTimezone] = useState(campaign.timezone || 'Europe/London');
  const { smDown } = useBreakpoints(); 
  
  const [popoverActive, setPopoverActive] = useState(false);
  const togglePopover = () => setPopoverActive((active) => !active);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isConsentChecked, setIsConsentChecked] = useState(false);

  const tiers = JSON.parse(campaign.tiersJson || '[]');
  const tierTones = ['info', 'success', 'attention', 'warning', 'new'];

  // ✨ Evaluate status securely, then map to correct translation
  const internalStatus = getInternalStatus(campaign);
  const displayStatus = translations.status[internalStatus.toLowerCase()] || internalStatus;
  
  const isLocked = ['SUCCESSFUL', 'FAILED', 'PROCESSING'].includes(internalStatus); 
  const isDeleteLocked = isLocked || campaign.hasOrders;

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
  };

  const actionMenu = (
    <Popover
      active={popoverActive}
      activator={<Button onClick={togglePopover} disclosure>{translations.row.actions}</Button>}
      autofocusTarget="first-node"
      onClose={togglePopover}
      preferredAlignment="right"
    >
      <ActionList
        actionRole="menuitem"
        items={[
          ...(productUrl ? [{ 
            content: translations.row.preview, 
            icon: ViewIcon, 
            onAction: () => window.open(productUrl, '_blank') 
          }] : []),
          { content: translations.row.viewOrders, icon: OrderIcon, url: `/app/campaigns/${campaign.id}/orders` },
          { 
            content: translations.row.edit, 
            icon: EditIcon, 
            url: isLocked ? undefined : `/app/campaigns/${campaign.id}`,
            disabled: isLocked 
          },
          { 
            content: translations.row.delete, 
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
                <Button variant="tertiary" onClick={() => setOpen(!open)} icon={open ? ChevronUpIcon : ChevronDownIcon} />
                <Thumbnail source={campaign.productImage || ImageIcon} alt={campaign.productTitle} size="small" />
                <Link url={`shopify://admin/products/${numericProductId}`} target="_top" removeUnderline>
                  <Text variant="bodyMd" fontWeight="bold" as="span">{campaign.productTitle}</Text>
                </Link>
              </InlineStack>
              <InlineStack align="space-between" blockAlign="center" wrap>
                <InlineStack gap="300" blockAlign="center">
                  <Badge size="small" tone={getStatusBadgeTone(internalStatus)}>{displayStatus}</Badge>
                  <Text variant="bodySm" tone="subdued">{translations.table.dateCreated}: {formatDateOnly(campaign.createdAt)}</Text>
                </InlineStack>
                {actionMenu} 
              </InlineStack>
            </BlockStack>
          </IndexTable.Cell>
        ) : (
          <>
            <IndexTable.Cell>
              <InlineStack blockAlign="center" gap="300" wrap={false}>
                <Button variant="tertiary" onClick={() => setOpen(!open)} icon={open ? ChevronUpIcon : ChevronDownIcon} />
                <Thumbnail source={campaign.productImage || ImageIcon} alt={campaign.productTitle} size="small" />
                <Link url={`shopify://admin/products/${numericProductId}`} target="_top" removeUnderline>
                  <Text variant="bodyMd" fontWeight="bold" as="span">{campaign.productTitle}</Text>
                </Link>
              </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Badge size="small" tone={getStatusBadgeTone(internalStatus)}>{displayStatus}</Badge>
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
                        term: translations.row.timezone, 
                        description: (
                          <InlineStack blockAlign="center" gap="400">
                            <Text as="span">{campaign.timezone}</Text>
                            <div style={{ width: '220px' }}>
                              <Select 
                                label={translations.row.displayTimeIn} 
                                labelHidden 
                                options={timezoneOptions} 
                                onChange={setDisplayTimezone} 
                                value={displayTimezone}
                              />
                            </div>
                          </InlineStack>
                        ) 
                      },
                      { term: translations.row.startTime, description: formatForDisplay(campaign.startDateTime, displayTimezone) },
                      { term: translations.row.endTime, description: formatForDisplay(campaign.endDateTime, displayTimezone) },
                      { 
                        term: translations.row.discountTiers, 
                        description: tiers.length > 0 ? (
                          <InlineStack gap="200" wrap>
                            {tiers.map((tier, idx) => (
                              <Badge key={idx} tone={tierTones[idx % tierTones.length]}>
                                {tier.quantity} {campaign.countingMethod === 'ITEM_QUANTITY' ? translations.row.items : translations.row.buyers} ➔ {tier.discount}% {translations.row.off}
                              </Badge>
                            ))}
                          </InlineStack>
                        ) : (
                          <Text variant="bodyMd" tone="subdued">{translations.row.noTiers}</Text>
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
        title={translations.deleteModal.title}
        primaryAction={{
          content: translations.deleteModal.confirm,
          destructive: true,
          onAction: handleDelete,
          loading: isDeleting,
          disabled: !isConsentChecked || (deleteFetcher.state !== 'idle' && !isDeleting),
        }}
        secondaryActions={[{ content: translations.deleteModal.cancel, onAction: toggleDeleteModal }]}
      >
        <Modal.Section>
          <Text as="p">{translations.deleteModal.warning}</Text>
          <Box paddingBlockStart="200">
            <Checkbox
              label={translations.deleteModal.checkbox}
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
  const { campaigns: initialCampaigns, primaryDomainUrl, pagination, translations } = useLoaderData();
  const [hasMounted, setHasMounted] = useState(false);
  const { smDown } = useBreakpoints(); 
  
  const app = useAppBridge();
  const deleteFetcher = useFetcher();
  const navigate = useNavigate(); 
  const navigation = useNavigation();

  // Internal keys logic for proper filtering unaffected by languages
  const internalTabs = ['ALL', 'ACTIVE', 'PROCESSING', 'COMPLETED'];
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
        toast.show(translations.messages.deleteSuccess, { duration: 5000 });
      } else if (deleteFetcher.data.error) {
        toast.show(deleteFetcher.data.error, { isError: true, duration: 8000 });
      }
    }
  }, [deleteFetcher.state, deleteFetcher.data, app, translations]);

  const filteredCampaigns = useMemo(() => {
    let filtered = [...initialCampaigns];

    if (appliedFilters.queryValue) {
      const q = appliedFilters.queryValue.toLowerCase();
      filtered = filtered.filter(c => c.productTitle.toLowerCase().includes(q));
    }

    if (appliedFilters.selected > 0) {
      const tabKey = internalTabs[appliedFilters.selected];
      filtered = filtered.filter(c => {
        const status = getInternalStatus(c);
        if (tabKey === 'COMPLETED') return ['SUCCESSFUL', 'FAILED'].includes(status);
        return status === tabKey;
      });
    }

    if (appliedFilters.sortSelected[0] === 'date asc') {
      filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else {
      filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    return filtered;
  }, [initialCampaigns, appliedFilters, internalTabs]);

  const rowMarkup = filteredCampaigns.map(
    (campaign, index) => (
      <CampaignRow
        key={campaign.id}
        campaign={campaign}
        index={index}
        primaryDomainUrl={primaryDomainUrl}
        deleteFetcher={deleteFetcher}
        translations={translations} // ✨ Pass down text
      />
    )
  );

  const tableHeadings = smDown 
    ? [{ title: translations.table.campaigns }] 
    : [
        { title: translations.table.product },
        { title: translations.table.status },
        { title: translations.table.dateCreated },
        { title: translations.table.action },
      ];

  // ✨ Map actual display text onto the index elements
  const tabs = [
    translations.tabs.all,
    translations.tabs.active,
    translations.tabs.processing,
    translations.tabs.completed
  ].map((item, index) => ({
    content: item,
    id: `${item}-${index}`,
    actions: [],
    isLocked: index === 0,
  }));

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
              <Button disabled disclosure>{translations.row.actions}</Button>
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
            <Button disabled disclosure>{translations.row.actions}</Button>
          </IndexTable.Cell>
        </>
      )}
    </IndexTable.Row>
  ));

  return (
    <Page
      title={translations.title}
      primaryAction={{
        content: translations.createCampaign,
        url: "/app/campaigns/new",
      }}
      secondaryActions={[
        {
          content: translations.settings,
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
                { label: translations.filters.newest, value: 'date desc', directionLabel: translations.filters.descending },
                { label: translations.filters.oldest, value: 'date asc', directionLabel: translations.filters.ascending },
              ]}
              sortSelected={sortSelected}
              queryValue={queryValue}
              queryPlaceholder={translations.filters.search}
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
                heading={translations.emptyState.heading}
                action={{ content: translations.createCampaign, url: '/app/campaigns/new' }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>{translations.emptyState.description}</p>
              </EmptyState>
            ) : (
              <div className={`native-fade-table ${isBusy ? 'is-busy' : ''}`}>
                <IndexTable
                  itemCount={filteredCampaigns.length}
                  headings={tableHeadings}
                  selectable={false}
                  emptyState={
                    <EmptySearchResult
                      title={translations.searchEmpty.title}
                      description={translations.searchEmpty.description}
                      withIllustration
                    />
                  }
                  pagination={{
                    hasNext: pagination.hasNextPage,
                    hasPrevious: pagination.hasPreviousPage,
                    onNext: () => navigate(`?page=${pagination.page + 1}`),
                    onPrevious: () => navigate(`?page=${pagination.page - 1}`),
                    label: translations.paginationLabel, // ✨ Replaces the hardcoded "Page 1 of 1"
                  }}
                >
                  {rowMarkup}
                </IndexTable>
              </div>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}