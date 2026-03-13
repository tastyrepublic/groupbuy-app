import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Badge,
  Link,
  BlockStack,
  InlineStack,
  DescriptionList,
  Thumbnail,
  Select,
  Box,
  EmptyState
} from "@shopify/polaris";
import { StarFilledIcon, ImageIcon } from "@shopify/polaris-icons";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// --- LOADER ---

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const campaignId = parseInt(params.id, 10);
  
  const url = new URL(request.url);
  let selectedVariantId = url.searchParams.get("variantId");

  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
  });

  if (!campaign) {
    throw new Response("Campaign Not Found", { status: 404 });
  }

  const allCampaignVariantGIDs = JSON.parse(campaign.selectedVariantIdsJson || '[]');
  let allCampaignVariants = [];

  // --- 1. Fetch Variant Titles for the Dropdown ---
  if (allCampaignVariantGIDs.length > 0) {
    const variantQueryRes = await admin.graphql(
      `#graphql
      query getVariantTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            price
          }
        }
      }`, { variables: { ids: allCampaignVariantGIDs } }
    );
    const { data } = await variantQueryRes.json();
    allCampaignVariants = data.nodes.filter(Boolean).map(v => ({
      id: v.id.split('/').pop(), 
      title: v.title,
      price: v.price
    }));
  }

  if (!selectedVariantId && allCampaignVariants.length > 0) {
    selectedVariantId = allCampaignVariants[0].id;
  }
  
  const fullVariantId = selectedVariantId ? `gid://shopify/ProductVariant/${selectedVariantId}` : null;

  let participantQuery = {
    group: { campaignId: campaign.id },
    // Notice: We intentionally do NOT filter by status here so we get the Audit Trail
  };

  if (campaign.scope === 'VARIANT' && fullVariantId) {
    participantQuery.productVariantId = fullVariantId;
  }
  
  const participants = await db.participant.findMany({
    where: participantQuery,
    select: { 
      orderId: true, 
      isLeader: true, 
      customerId: true, 
      quantity: true, 
      productVariantId: true,
      status: true // ✅ NEW: Grab the database status
    },
  });

  let participantData = { count: 0, quantity: 0 };
  let rows = [];

  if (participants.length > 0) {
    // --- 3. Enrich Data with Shopify Details ---
    const shopifyOrderIds = [...new Set(participants.map(p => p.orderId))];
    const shopifyVariantIds = [...new Set(participants.map(p => p.productVariantId))];

    const orderResponse = await admin.graphql(
      `#graphql
      query getOrderDetails($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id, name, createdAt, displayFinancialStatus, displayFulfillmentStatus,
            customer { displayName }
          }
        }
      }`, { variables: { ids: shopifyOrderIds } }
    );
    const orderData = await orderResponse.json();
    const orderMap = new Map(
      orderData.data.nodes.filter(Boolean).map(order => [order.id, order])
    );

    const variantResponse = await admin.graphql(
      `#graphql
      query getVariantTitles($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
          }
        }
      }`, { variables: { ids: shopifyVariantIds } }
    );
    const variantData = await variantResponse.json();
    const variantMap = new Map(
      variantData.data.nodes.filter(Boolean).map(variant => [variant.id, variant])
    );

    // --- 4. Combine all data into "rows" ---
    rows = participants.map(p => {
      const order = orderMap.get(p.orderId);
      const variant = variantMap.get(p.productVariantId);

      return {
        orderId: p.orderId,
        orderName: order ? order.name : 'Unknown',
        orderShopifyId: order ? order.id.split('/').pop() : '#',
        createdAt: order ? order.createdAt : new Date().toISOString(),
        customerName: order?.customer ? order.customer.displayName : 'No customer',
        paymentStatus: order ? order.displayFinancialStatus : 'UNKNOWN',
        fulfillmentStatus: order ? order.displayFulfillmentStatus : 'UNFULFILLED',
        isLeader: p.isLeader,
        quantity: p.quantity,
        dbStatus: p.status, // ✅ NEW: Pass the DB status to the UI
        variantTitle: variant 
          ? (variant.title === 'Default Title' ? 'N/A' : variant.title) 
          : (p.productVariantId ? 'Variant not found' : 'N/A')
      };
    });

    // ✅ NEW: The exact math fix! Only count ACTIVE orders for the progress bar
    const activeParticipants = participants.filter(p => p.status === 'ACTIVE');
    
    participantData = {
      count: new Set(activeParticipants.map(p => p.customerId)).size,
      quantity: activeParticipants.reduce((sum, p) => sum + p.quantity, 0)
    };
  }

  return json({ campaign, rows, allCampaignVariants, participantData });
};


// --- PAGE COMPONENT ---

export default function CampaignOrdersPage() {
  const { campaign, rows, allCampaignVariants, participantData } = useLoaderData();
  const navigate = useNavigate();
  
  const [selectedVariantId, setSelectedVariantId] = useState(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      return url.searchParams.get("variantId") || allCampaignVariants[0]?.id || "";
    }
    return allCampaignVariants[0]?.id || "";
  });

  const handleVariantChange = (value) => {
    setSelectedVariantId(value);
    navigate(`/app/campaigns/${campaign.id}/orders?variantId=${value}`);
  };

  const variantOptions = allCampaignVariants.map(v => ({
    label: v.title === 'Default Title' ? 'Standard Product' : v.title,
    value: v.id,
  }));
  
  const getBadgeTone = (status) => {
    switch (status) {
      case 'PAID': return 'success';
      case 'AUTHORIZED': return 'attention';
      case 'VOIDED': return 'critical';
      default: return 'default';
    }
  };

  const getFulfillmentBadgeTone = (status) => {
    switch (status) {
      case 'FULFILLED': return 'success';
      case 'UNFULFILLED': return 'attention';
      case 'PARTIALLY_FULFILLED': return 'info';
      default: return 'default';
    }
  };

  // --- CAMPAIGN STATUS LOGIC ---
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

  const displayStatus = getDisplayStatus(campaign);
  
  // --- ✅ NEW: TIER-STAGE PROGRESS BAR LOGIC ---
  const fakeCount = campaign.startingParticipants || 0;
  const realCount = campaign.countingMethod === 'ITEM_QUANTITY' 
    ? participantData.quantity 
    : participantData.count;
  const totalProgress = realCount + fakeCount;

  const progressLabel = campaign.countingMethod === 'ITEM_QUANTITY' 
    ? (campaign.scope === 'VARIANT' ? 'Variant Items Sold' : 'Total Items Sold') 
    : (campaign.scope === 'VARIANT' ? 'Variant Participants' : 'Total Participants');

  const tiers = JSON.parse(campaign.tiersJson || '[]');
  const sortedTiers = [...tiers].sort((a, b) => Number(a.quantity) - Number(b.quantity));

  let maxGoal = 0;
  let fakePercent = 0;
  let realPercent = 0;
  let finalDiscountTier = null;

  if (sortedTiers.length > 0) {
    // 1. Set the absolute highest tier as the 100% mark of the visual bar
    const finalGoalTier = sortedTiers[sortedTiers.length - 1];
    maxGoal = Number(finalGoalTier.quantity);
    
    if (maxGoal > 0) {
      // 2. Cap the visual fill at 100% so it doesn't break out of the UI if they over-sell
      const cappedReal = Math.min(realCount, maxGoal);
      const cappedFake = Math.min(fakeCount, maxGoal - cappedReal);
      
      realPercent = (cappedReal / maxGoal) * 100;
      fakePercent = (cappedFake / maxGoal) * 100;
    }
    
    // 3. Find out what tier they have officially unlocked
    const achievedTiers = [...tiers].sort((a, b) => Number(b.quantity) - Number(a.quantity));
    finalDiscountTier = achievedTiers.find(tier => totalProgress >= Number(tier.quantity));
  }
  
  const progressText = `${totalProgress} / ${maxGoal > 0 ? maxGoal : '∞'}`;
  const scopeLabel = campaign.scope === 'PRODUCT' ? 'Product-wide' : 'Per-Variant';
  const countingLabel = campaign.countingMethod === 'ITEM_QUANTITY' ? 'By Item Quantity' : 'By Participants';
  // --- END TIER-STAGE LOGIC ---

  const rowMarkup = rows.map((row, index) => {
    // ✅ Check if the order is dead in our DB OR voided in Shopify
    const isCancelled = row.dbStatus === 'CANCELLED' || ['VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(row.paymentStatus);
    const rowStyle = isCancelled ? { opacity: 0.5, backgroundColor: 'var(--p-color-bg-surface-secondary)' } : {};

    return (
      <IndexTable.Row id={`${row.orderId}-${index}`} key={`${row.orderId}-${index}`} position={index}>
        <IndexTable.Cell>
          <div style={rowStyle}>
            <Link
              url={`shopify://admin/orders/${row.orderShopifyId}`}
              target="_top"
              removeUnderline
            >
              <Text variant="bodyMd" fontWeight={isCancelled ? "regular" : "bold"} as="span" tone={isCancelled ? "subdued" : "base"}>
                {row.orderName}
              </Text>
            </Link>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell><div style={rowStyle}>{new Date(row.createdAt).toLocaleDateString()}</div></IndexTable.Cell>
        <IndexTable.Cell><div style={rowStyle}>{row.customerName}</div></IndexTable.Cell>
        <IndexTable.Cell>
          <div style={rowStyle}>
            <Text as="span" fontWeight={isCancelled ? "regular" : "semibold"} tone={isCancelled ? "subdued" : "base"}>{row.variantTitle}</Text>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell><div style={rowStyle}>{row.quantity}</div></IndexTable.Cell>
        <IndexTable.Cell>
          <div style={rowStyle}>
            {/* ✅ Override role with a "Canceled" badge if the order is dead */}
            {isCancelled ? (
               <Badge tone="critical">Canceled</Badge>
            ) : row.isLeader ? (
              <BlockStack gap="100">
                <Badge tone="success" icon={StarFilledIcon}>Leader</Badge>
                {campaign.leaderDiscount > 0 && (
                   <Text variant="bodySm" tone="subdued">{campaign.leaderDiscount}% off</Text>
                )}
              </BlockStack>
            ) : (
              <Text variant="bodySm" tone="subdued">Member</Text>
            )}
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div style={rowStyle}>
            <Badge tone={getBadgeTone(row.paymentStatus)}>
              {row.paymentStatus.replace('_', ' ')}
            </Badge>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div style={rowStyle}>
            <Badge tone={getFulfillmentBadgeTone(row.fulfillmentStatus)}>
              {row.fulfillmentStatus.replace('_', ' ')}
            </Badge>
          </div>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  const activeVariant = allCampaignVariants.find(v => v.id === selectedVariantId) || allCampaignVariants[0];

  return (
    <Page
      title={`Orders for "${campaign.productTitle}"`}
      backAction={{ content: 'Campaigns', url: '/app' }}
    >
      <Layout>
        {/* --- CARD 1: PRODUCT DETAILS --- */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Product Details</Text>
              <Box paddingBlockStart="200" paddingBlockEnd="200">
                <InlineStack blockAlign="center" gap="400" wrap={false}>
                  <Thumbnail 
                    source={campaign.productImage || ImageIcon} 
                    alt={campaign.productTitle} 
                    size="large"
                  />
                  {/* ✅ NEW: Stacked the title and price together */}
                  <BlockStack gap="100">
                    <Text as="span" variant="bodyLg" fontWeight="bold">
                      {campaign.productTitle}
                    </Text>
                    {activeVariant?.price && (
                      <Text as="span" variant="bodyMd" tone="subdued">
                        Retail Price: {activeVariant.price}
                      </Text>
                    )}
                  </BlockStack>
                </InlineStack>
              </Box>
              
              {campaign.scope === 'VARIANT' && variantOptions.length > 0 && (
                <Box paddingBlockStart="200">
                  <Select
                    label="Filter by Variant"
                    options={variantOptions}
                    onChange={handleVariantChange}
                    value={selectedVariantId}
                  />
                </Box>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- CARD 2: CAMPAIGN DETAILS --- */}
        <Layout.Section variant="twoThirds">
          <Card>
            <BlockStack gap="400">
              {/* ✅ THE NEW HEADER WITH BADGE */}
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">Campaign Progress</Text>
                <Badge tone={getStatusBadgeTone(displayStatus)} size="medium">
                  {displayStatus}
                </Badge>
              </InlineStack>
              
              <Box paddingBlockEnd="400">
                <BlockStack gap="200">
                  <InlineStack align="space-between">
                    <Text as="h3" variant="headingSm" tone="subdued">
                      {progressLabel}
                    </Text>
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {progressText}
                    </Text>
                  </InlineStack>
                  
                  {/* ✅ NEW: Seamless Segmented Bar (8px Height + Perfect Gaps) */}
                  <div style={{ display: 'flex', width: '100%', marginTop: '10px', marginBottom: '12px' }}>
                    
                    {maxGoal > 0 && sortedTiers.map((tier, index) => {
                      const previousTierQty = index === 0 ? 0 : Number(sortedTiers[index - 1].quantity);
                      const tierGoal = Number(tier.quantity);
                      const tierCapacity = tierGoal - previousTierQty;

                      const totalInThisBlock = Math.max(0, Math.min(totalProgress - previousTierQty, tierCapacity));
                      const realInThisBlock = Math.max(0, Math.min(realCount - previousTierQty, tierCapacity));
                      const fakeInThisBlock = totalInThisBlock - realInThisBlock;

                      const realPercent = (realInThisBlock / tierCapacity) * 100;
                      const fakePercent = (fakeInThisBlock / tierCapacity) * 100;
                      const isAchieved = totalProgress >= tierGoal;

                      const isFirst = index === 0;
                      const isLast = index === sortedTiers.length - 1;

                      return (
                        <div key={index} style={{ 
                          flex: tierCapacity, 
                          display: 'flex', 
                          flexDirection: 'column',
                          // ✅ THE GAP FIX: Use a solid 2px white border on the right side of every block (except the last one)
                          borderRight: isLast ? 'none' : '2px solid white' 
                        }}>
                          
                          {/* The Segment */}
                          <div style={{ 
                            width: '100%', 
                            height: '8px', // ✅ THE HEIGHT FIX: Back to the original 8px!
                            backgroundColor: 'var(--p-color-bg-surface-secondary-active, #e3e3e3)', 
                            borderTopLeftRadius: isFirst ? '4px' : '0', // Adjusted to match 8px height
                            borderBottomLeftRadius: isFirst ? '4px' : '0',
                            borderTopRightRadius: isLast ? '4px' : '0',
                            borderBottomRightRadius: isLast ? '4px' : '0',
                            display: 'flex', 
                            overflow: 'hidden' 
                          }}>
                            {/* Real Count Fill */}
                            <div style={{ width: `${realPercent}%`, backgroundColor: 'var(--p-color-bg-fill-info, #005bd3)', transition: 'width 0.3s ease' }} />
                            {/* Fake Count Fill */}
                            <div style={{ width: `${fakePercent}%`, backgroundColor: 'var(--p-color-bg-surface-info, #91c0ff)', transition: 'width 0.3s ease' }} />
                          </div>

                          {/* The Label */}
                          <div style={{ marginTop: '8px', textAlign: 'center' }}>
                            <span style={{ 
                              display: 'block',
                              fontSize: '12px', 
                              lineHeight: '16px',
                              fontWeight: 'bold', 
                              color: isAchieved ? '#2ecc71' : 'var(--p-color-text-subdued, #8a8a8a)'
                            }}>
                              {tier.discount}% off
                            </span>
                            <Text variant="bodyXs" tone="subdued">{tier.quantity}</Text>
                          </div>
                          
                        </div>
                      );
                    })}
                  </div>
                  
                  {/* Mini Legend */}
                  <InlineStack gap="300">
                    <InlineStack gap="100" blockAlign="center">
                      <div style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: 'var(--p-color-bg-fill-info, #005bd3)' }} />
                      <Text as="span" variant="bodySm" tone="subdued">Real Orders ({realCount})</Text>
                    </InlineStack>
                    {fakeCount > 0 && (
                      <InlineStack gap="100" blockAlign="center">
                        <div style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: 'var(--p-color-bg-surface-info, #91c0ff)' }} />
                        <Text as="span" variant="bodySm" tone="subdued">Fake Count ({fakeCount})</Text>
                      </InlineStack>
                    )}
                  </InlineStack>
                </BlockStack>
              </Box>

              <DescriptionList
                items={[
                  { term: 'Campaign Scope', description: scopeLabel },
                  { term: 'Counting Method', description: countingLabel },
                  { term: 'Leader Discount', description: campaign.leaderDiscount > 0 ? `${campaign.leaderDiscount}% off` : 'Disabled' },
                  { term: 'Discount Achieved', description: finalDiscountTier ? `${finalDiscountTier.discount}% off` : 'None (Goal not met)' },
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- CARD 3: ORDERS TABLE --- */}
        <Layout.Section>
          <Card padding="0">
            <Box padding="400" paddingBlockEnd="0">
              <Text as="h2" variant="headingMd">Participant Orders</Text>
            </Box>
            
            {rows.length > 0 ? (
              <Box paddingBlockStart="400">
                <IndexTable
                  itemCount={rows.length}
                  headings={[
                    { title: 'Order' },
                    { title: 'Date' },
                    { title: 'Customer' },
                    { title: 'Variant' },
                    { title: 'Qty' },
                    { title: 'Role' },
                    { title: 'Payment' },
                    { title: 'Fulfillment' },
                  ]}
                  selectable={false}
                >
                  {rowMarkup}
                </IndexTable>
              </Box>
            ) : (
              <Box padding="800">
                <EmptyState
                  heading="No orders found"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    There are currently no orders for this campaign
                    {campaign.scope === 'VARIANT' ? ' for the selected variant.' : '.'}
                  </p>
                </EmptyState>
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>      
    </Page>
  );
}