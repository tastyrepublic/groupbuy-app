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
import { StarFilledIcon } from "@shopify/polaris-icons";
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
          }
        }
      }`, { variables: { ids: allCampaignVariantGIDs } }
    );
    const { data } = await variantQueryRes.json();
    allCampaignVariants = data.nodes.filter(Boolean).map(v => ({
      id: v.id.split('/').pop(), 
      title: v.title
    }));
  }

  if (!selectedVariantId && allCampaignVariants.length > 0) {
    selectedVariantId = allCampaignVariants[0].id;
  }
  
  const fullVariantId = selectedVariantId ? `gid://shopify/ProductVariant/${selectedVariantId}` : null;

  // --- 2. Get the Correct List of Participants ---
  let participantQuery = {
    group: { campaignId: campaign.id },
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
      productVariantId: true 
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
        variantTitle: variant 
          ? (variant.title === 'Default Title' ? 'N/A' : variant.title) 
          : (p.productVariantId ? 'Variant not found' : 'N/A')
      };
    });

    participantData = {
      count: new Set(participants.map(p => p.customerId)).size,
      quantity: participants.reduce((sum, p) => sum + p.quantity, 0)
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
  
  // --- ✅ NEW: MULTI-SEGMENT PROGRESS BAR LOGIC ---
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

  let goalQuantity = 0;
  let fakePercent = 0;
  let realPercent = 0;
  let progressText = `${totalProgress}`;
  let finalDiscountTier = null;

  if (sortedTiers.length > 0) {
    const finalGoalTier = sortedTiers[sortedTiers.length - 1];
    const nextGoalTier = sortedTiers.find(tier => totalProgress < Number(tier.quantity));
    
    goalQuantity = nextGoalTier ? Number(nextGoalTier.quantity) : Number(finalGoalTier.quantity);
    
    if (goalQuantity > 0) {
      // Calculate fake bar width
      fakePercent = Math.min((fakeCount / goalQuantity) * 100, 100);
      // Calculate real bar width (capped so it never breaks out of the 100% container)
      realPercent = Math.min((realCount / goalQuantity) * 100, 100 - fakePercent);
    }
    progressText = `${totalProgress} / ${goalQuantity}`;
    
    const achievedTiers = [...tiers].sort((a, b) => Number(b.quantity) - Number(a.quantity));
    finalDiscountTier = achievedTiers.find(tier => totalProgress >= Number(tier.quantity));
  }
  
  const scopeLabel = campaign.scope === 'PRODUCT' ? 'Product-wide' : 'Per-Variant';
  const countingLabel = campaign.countingMethod === 'ITEM_QUANTITY' ? 'By Item Quantity' : 'By Participants';
  // --- END MULTI-SEGMENT LOGIC ---

  const rowMarkup = rows.map((row, index) => {
    return (
      <IndexTable.Row id={`${row.orderId}-${index}`} key={`${row.orderId}-${index}`} position={index}>
        <IndexTable.Cell>
          <Link
            url={`shopify://admin/orders/${row.orderShopifyId}`}
            target="_top"
            removeUnderline
          >
            <Text variant="bodyMd" fontWeight="bold" as="span">
              {row.orderName}
            </Text>
          </Link>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {new Date(row.createdAt).toLocaleDateString()}
        </IndexTable.Cell>
        <IndexTable.Cell>{row.customerName}</IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" fontWeight="semibold">{row.variantTitle}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{row.quantity}</IndexTable.Cell>
        <IndexTable.Cell>
          {row.isLeader && (
            <Badge tone="success" icon={StarFilledIcon}>Leader</Badge>
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={getBadgeTone(row.paymentStatus)}>
            {row.paymentStatus.replace('_', ' ')}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={getFulfillmentBadgeTone(row.fulfillmentStatus)}>
            {row.fulfillmentStatus.replace('_', ' ')}
          </Badge>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

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
                    source={campaign.productImage || ''} 
                    alt={campaign.productTitle} 
                    size="large"
                  />
                  <Text as="span" variant="bodyLg" fontWeight="bold">
                    {campaign.productTitle}
                  </Text>
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
              <Text as="h2" variant="headingMd">Campaign Progress</Text>
              
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
                  
                  {/* ✅ NEW: Custom Multi-Color Stacked Progress Bar */}
                  <div style={{ 
                    width: '100%', 
                    height: '8px', 
                    backgroundColor: 'var(--p-color-bg-surface-secondary-active, #e3e3e3)', 
                    borderRadius: '4px', 
                    display: 'flex', 
                    overflow: 'hidden' 
                  }}>
                    {/* Fake Count Segment (Lighter info color) */}
                    <div 
                      style={{ width: `${fakePercent}%`, backgroundColor: 'var(--p-color-bg-surface-info, #91c0ff)', transition: 'width 0.3s ease' }} 
                      title={`Boosted Participants: ${fakeCount}`}
                    />
                    {/* Real Count Segment (Primary info color) */}
                    <div 
                      style={{ width: `${realPercent}%`, backgroundColor: 'var(--p-color-bg-fill-info, #005bd3)', transition: 'width 0.3s ease' }} 
                      title={`Real Orders: ${realCount}`}
                    />
                  </div>
                  
                  {/* ✅ NEW: Mini Legend */}
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