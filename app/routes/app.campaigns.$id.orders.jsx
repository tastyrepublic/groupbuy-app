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
  EmptyState,
  Divider
} from "@shopify/polaris";
import { StarFilledIcon, ImageIcon } from "@shopify/polaris-icons";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// ✨ Import i18n utility
import { getI18n } from "../utils/i18n.server.js";

// --- LOADER ---

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const campaignId = parseInt(params.id, 10);
  
  // ✨ Fetch translations
  const { t } = await getI18n(request);

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
      status: true
    },
  });

  let participantData = { count: 0, quantity: 0 };
  let rows = [];
  let fulfillmentSummary = {};

  if (participants.length > 0) {
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

    const orderGroups = new Map();

    participants.forEach(p => {
      const order = orderMap.get(p.orderId);
      const variant = variantMap.get(p.productVariantId);
      const variantTitle = variant 
          ? (variant.title === 'Default Title' ? 'N/A' : variant.title) 
          : (p.productVariantId ? 'Variant not found' : 'N/A');

      if (!orderGroups.has(p.orderId)) {
        orderGroups.set(p.orderId, {
          orderId: p.orderId,
          orderName: order ? order.name : 'Unknown',
          orderShopifyId: order ? order.id.split('/').pop() : '#',
          createdAt: order ? order.createdAt : new Date().toISOString(),
          customerName: order?.customer ? order.customer.displayName : 'No customer',
          paymentStatus: order ? order.displayFinancialStatus : 'UNKNOWN',
          fulfillmentStatus: order ? order.displayFulfillmentStatus : 'UNFULFILLED',
          isLeader: p.isLeader,
          dbStatus: p.status, 
          totalQuantity: 0,
          items: [] 
        });
      }

      const group = orderGroups.get(p.orderId);
      group.totalQuantity += p.quantity;
      if (p.isLeader) group.isLeader = true; 
      
      group.items.push({
        variantTitle,
        quantity: p.quantity,
        status: p.status
      });
    });

    rows = Array.from(orderGroups.values());
    rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const activeParticipants = participants.filter(p => p.status === 'ACTIVE' || p.status === 'SUCCESSFUL');
    
    participantData = {
      count: new Set(activeParticipants.map(p => p.customerId)).size,
      quantity: activeParticipants.reduce((sum, p) => sum + p.quantity, 0)
    };

    activeParticipants.forEach(p => {
      const variant = variantMap.get(p.productVariantId);
      if (variant) {
        if (!fulfillmentSummary[variant.id]) {
          fulfillmentSummary[variant.id] = {
            title: variant.title === 'Default Title' ? 'Standard' : variant.title,
            totalActive: 0
          };
        }
        fulfillmentSummary[variant.id].totalActive += p.quantity;
      }
    });
  }

  const translations = {
    title: t("Orders.title", { productTitle: campaign.productTitle, defaultValue: `Orders for "${campaign.productTitle}"` }),
    back: t("Orders.back", "Campaigns"),
    ProductDetails: t("Orders.ProductDetails", { returnObjects: true }),
    FulfillmentSummary: t("Orders.FulfillmentSummary", { returnObjects: true }),
    CampaignProgress: t("Orders.CampaignProgress", { returnObjects: true }),
    ParticipantOrders: t("Orders.ParticipantOrders", { returnObjects: true }),
    Dates: {
      startTime: t("Orders.Dates.startTime", "Start Time"),
      endTime: t("Orders.Dates.endTime", "End Time")
    }
  };

  return json({ campaign, rows, allCampaignVariants, participantData, fulfillmentSummary, translations });
};


// --- PAGE COMPONENT ---

export default function CampaignOrdersPage() {
  const { campaign, rows, allCampaignVariants, participantData, fulfillmentSummary, translations } = useLoaderData();
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
    label: v.title === 'Default Title' ? translations.ProductDetails.standardProduct : v.title,
    value: v.id,
  }));
  
  const getBadgeTone = (status) => {
    switch (status) {
      case 'PAID': return 'success';
      case 'PENDING': return 'warning';
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

  const getDisplayStatusRaw = (campaign) => {
    if (campaign.status === 'SUCCESSFUL' || campaign.status === 'FAILED') {
      return campaign.status.toLowerCase();
    }
    const now = new Date();
    const startTime = new Date(campaign.startDateTime);
    const endTime = new Date(campaign.endDateTime);

    if (now < startTime) return 'scheduled';
    if (now >= startTime && now < endTime) {
      if (campaign.status === 'PROCESSING') return 'processing';
      return 'active';
    }
    if (now >= endTime) return 'processing';
    return 'unknown';
  };

  const rawStatus = getDisplayStatusRaw(campaign);
  const translatedStatus = translations.CampaignProgress.status[rawStatus] || rawStatus.toUpperCase();

  const getStatusBadgeTone = (statusKey) => {
    switch (statusKey) {
      case 'active': return 'info';
      case 'processing': return 'warning';
      case 'successful': return 'success';
      case 'failed': return 'critical';
      case 'scheduled': return 'attention';
      default: return 'default';
    }
  };
  
  const fakeCount = campaign.startingParticipants || 0;
  const realCount = campaign.countingMethod === 'ITEM_QUANTITY' 
    ? participantData.quantity 
    : participantData.count;
  const totalProgress = realCount + fakeCount;

  const progressLabel = campaign.countingMethod === 'ITEM_QUANTITY' 
    ? (campaign.scope === 'VARIANT' ? translations.CampaignProgress.progressLabels.variantItems : translations.CampaignProgress.progressLabels.totalItems) 
    : (campaign.scope === 'VARIANT' ? translations.CampaignProgress.progressLabels.variantParticipants : translations.CampaignProgress.progressLabels.totalParticipants);

  const tiers = JSON.parse(campaign.tiersJson || '[]');
  const sortedTiers = [...tiers].sort((a, b) => Number(a.quantity) - Number(b.quantity));

  let maxGoal = 0;
  let fakePercent = 0;
  let realPercent = 0;
  let finalDiscountTier = null;

  if (sortedTiers.length > 0) {
    const finalGoalTier = sortedTiers[sortedTiers.length - 1];
    maxGoal = Number(finalGoalTier.quantity);
    
    if (maxGoal > 0) {
      const cappedReal = Math.min(realCount, maxGoal);
      const cappedFake = Math.min(fakeCount, maxGoal - cappedReal);
      
      realPercent = (cappedReal / maxGoal) * 100;
      fakePercent = (cappedFake / maxGoal) * 100;
    }
    
    const achievedTiers = [...tiers].sort((a, b) => Number(b.quantity) - Number(a.quantity));
    finalDiscountTier = achievedTiers.find(tier => totalProgress >= Number(tier.quantity));
  }
  
  const progressText = `${totalProgress} / ${maxGoal > 0 ? maxGoal : '∞'}`;
  
  const scopeLabel = campaign.scope === 'PRODUCT' ? translations.CampaignProgress.values.productWide : translations.CampaignProgress.values.perVariant;
  const countingLabel = campaign.countingMethod === 'ITEM_QUANTITY' ? translations.CampaignProgress.values.byItem : translations.CampaignProgress.values.byParticipant;

  // ✨ THE UX MAGIC: Full-width sub-rows, now with slimmed-down heights!
  const rowMarkup = rows.flatMap((row, index) => {
    const isCancelled = row.dbStatus === 'CANCELLED' || ['VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(row.paymentStatus);
    const rowStyle = isCancelled ? { opacity: 0.5, backgroundColor: 'var(--p-color-bg-surface-secondary)' } : {};

    const hasMultipleVariants = row.items.length > 1;

    // 1. THE PARENT ROW
    const parentRow = (
      <IndexTable.Row id={`${row.orderId}-parent-${index}`} key={`${row.orderId}-parent-${index}`} position={index}>
        <IndexTable.Cell>
          <div style={rowStyle}>
            <Link url={`shopify://admin/orders/${row.orderShopifyId}`} target="_top" removeUnderline>
              <Text variant="bodyMd" fontWeight={isCancelled ? "regular" : "bold"} as="span" tone={isCancelled ? "subdued" : "base"}>
                {row.orderName}
              </Text>
            </Link>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell><div style={rowStyle}>{new Date(row.createdAt).toLocaleDateString()}</div></IndexTable.Cell>
        <IndexTable.Cell><div style={rowStyle}>{row.customerName}</div></IndexTable.Cell>
        
        {/* VARIANT COLUMN SUMMARY */}
        <IndexTable.Cell>
          <div style={rowStyle}>
            {hasMultipleVariants ? (
               <Text as="span" tone="subdued">—</Text>
            ) : (
              <Text as="span" fontWeight={isCancelled ? "regular" : "semibold"} tone={isCancelled ? "subdued" : "base"}>
                 {row.items[0]?.variantTitle === 'Default Title' ? translations.ProductDetails.standardProduct : row.items[0]?.variantTitle}
              </Text>
            )}
          </div>
        </IndexTable.Cell>
        
        {/* TOTAL QUANTITY */}
        <IndexTable.Cell>
          <div style={rowStyle}>
            {hasMultipleVariants ? (
               <Text as="span" tone="subdued">—</Text>
            ) : (
               row.totalQuantity
            )}
          </div>
        </IndexTable.Cell>
        
        <IndexTable.Cell>
          <div style={rowStyle}>
            {isCancelled ? (
               <Badge tone="critical">{translations.ParticipantOrders.roles.canceled}</Badge>
            ) : row.isLeader ? (
              <BlockStack gap="100">
                <Badge tone="success" icon={StarFilledIcon}>{translations.ParticipantOrders.roles.leader}</Badge>
                {campaign.leaderDiscount > 0 && (
                   <Text variant="bodySm" tone="subdued">
                     {campaign.leaderDiscount}% {translations.CampaignProgress.off}
                     {campaign.leaderMaxQty > 0 && ` (${translations.CampaignProgress.max}: ${campaign.leaderMaxQty} ${translations.CampaignProgress.qtySuffix})`}
                   </Text>
                )}
              </BlockStack>
            ) : (
              <Text variant="bodySm" tone="subdued">{translations.ParticipantOrders.roles.member}</Text>
            )}
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div style={rowStyle}>
            <Badge tone={getBadgeTone(row.paymentStatus)}>
              {translations.ParticipantOrders.badges?.payment?.[row.paymentStatus] || row.paymentStatus.replace('_', ' ')}
            </Badge>
          </div>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <div style={rowStyle}>
            <Badge tone={getFulfillmentBadgeTone(row.fulfillmentStatus)}>
              {translations.ParticipantOrders.badges?.fulfillment?.[row.fulfillmentStatus] || row.fulfillmentStatus.replace('_', ' ')}
            </Badge>
          </div>
        </IndexTable.Cell>
      </IndexTable.Row>
    );

    // 2. THE FULL-WIDTH CHILD ROW (Slimmer Height)
    if (hasMultipleVariants) {
      const childRow = (
        <IndexTable.Row id={`${row.orderId}-variants-${index}`} key={`${row.orderId}-variants-${index}`} position={index}>
          <IndexTable.Cell colSpan={8}>
            {/* ✨ REDUCED PADDING: Changed paddingTop and paddingBottom to pull the row tighter */}
            <div style={{ ...rowStyle, paddingBottom: '2px', paddingTop: '2px', paddingLeft: '16px', paddingRight: '16px' }}>
              {/* ✨ REDUCED GAP: Changed gap from 200 to 100 for tighter badge spacing */}
              <InlineStack gap="100" wrap blockAlign="center">
                
                {/* The Totals */}
                <div style={{ marginRight: '8px', padding: '2px 0' }}>
                  <Text as="span" tone="subdued" variant="bodySm" fontWeight="medium">
                    ↳ {row.items.length} {translations.FulfillmentSummary.items} ({translations.ParticipantOrders.table.qty}: {row.totalQuantity})
                  </Text>
                </div>
  
                {/* The Horizontal Variant Badges */}
                {row.items.map((item, i) => (
                  <div key={i} style={{ 
                    display: 'inline-flex', 
                    alignItems: 'center', 
                    backgroundColor: isCancelled ? 'transparent' : 'var(--p-color-bg-surface-secondary)', 
                    border: isCancelled ? 'none' : '1px solid var(--p-color-border-subdued)',
                    // ✨ REDUCED BADGE SIZE: Slimmer padding and slightly smaller border radius
                    padding: '2px 8px', 
                    borderRadius: '12px', 
                    whiteSpace: 'nowrap'
                  }}>
                    <Text as="span" fontWeight={isCancelled ? "regular" : "medium"} tone={isCancelled ? "subdued" : "base"} variant="bodySm">
                      {item.variantTitle === 'Default Title' ? translations.ProductDetails.standardProduct : item.variantTitle}
                    </Text>
                    {/* ✨ REDUCED FONT SIZE: Made the 'x Qty' text slightly smaller */}
                    <span style={{ color: 'var(--p-color-text-subdued)', marginLeft: '6px', fontSize: '12px', fontWeight: 'bold' }}>× {item.quantity}</span>
                  </div>
                ))}
              </InlineStack>
            </div>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
      
      return [parentRow, childRow];
    }

    // If they only bought 1 variant, just return the standard parent row
    return [parentRow];
  });

  const activeVariant = allCampaignVariants.find(v => v.id === selectedVariantId) || allCampaignVariants[0];
  const fulfillmentItems = Object.values(fulfillmentSummary);

  return (
    <Page
      title={translations.title}
      backAction={{ content: translations.back, url: '/app' }}
    >
      <Layout>
        {/* --- LEFT COLUMN --- */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">{translations.ProductDetails.title}</Text>
                <Box paddingBlockStart="200" paddingBlockEnd="200">
                  <InlineStack blockAlign="center" gap="400" wrap={false}>
                    <Thumbnail 
                      source={campaign.productImage || ImageIcon} 
                      alt={campaign.productTitle} 
                      size="large"
                    />
                    <BlockStack gap="100">
                      <Text as="span" variant="bodyLg" fontWeight="bold">
                        {campaign.productTitle}
                      </Text>
                      {activeVariant?.price && (
                        <Text as="span" variant="bodyMd" tone="subdued">
                          {translations.ProductDetails.retailPrice} {activeVariant.price}
                        </Text>
                      )}
                    </BlockStack>
                  </InlineStack>
                </Box>
                
                {campaign.scope === 'VARIANT' && variantOptions.length > 0 && (
                  <Box paddingBlockStart="200">
                    <Select
                      label={translations.ProductDetails.filterVariant}
                      options={variantOptions}
                      onChange={handleVariantChange}
                      value={selectedVariantId}
                    />
                  </Box>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">{translations.FulfillmentSummary.title}</Text>
                <Text as="p" tone="subdued">{translations.FulfillmentSummary.description}</Text>
                <Divider />
                
                {fulfillmentItems.length > 0 ? (
                  <BlockStack gap="200">
                    {fulfillmentItems.map((item, index) => (
                      <InlineStack key={index} align="space-between" wrap={false}>
                        <Text as="span" variant="bodyMd">
                          {item.title === 'Standard' ? translations.ProductDetails.standardProduct : item.title}
                        </Text>
                        <Text as="span" fontWeight="bold">
                          {item.totalActive} {translations.FulfillmentSummary.items}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                ) : (
                  <Text tone="subdued">{translations.FulfillmentSummary.empty}</Text>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* --- RIGHT COLUMN --- */}
        <Layout.Section variant="twoThirds">
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">{translations.CampaignProgress.title}</Text>
                <Badge tone={getStatusBadgeTone(rawStatus)} size="medium">
                  {translatedStatus}
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
                          borderRight: isLast ? 'none' : '2px solid white' 
                        }}>
                          
                          <div style={{ 
                            width: '100%', 
                            height: '8px', 
                            backgroundColor: 'var(--p-color-bg-surface-secondary-active, #e3e3e3)', 
                            borderTopLeftRadius: isFirst ? '4px' : '0',
                            borderBottomLeftRadius: isFirst ? '4px' : '0',
                            borderTopRightRadius: isLast ? '4px' : '0',
                            borderBottomRightRadius: isLast ? '4px' : '0',
                            display: 'flex', 
                            overflow: 'hidden' 
                          }}>
                            <div style={{ width: `${realPercent}%`, backgroundColor: 'var(--p-color-bg-fill-info, #005bd3)', transition: 'width 0.3s ease' }} />
                            <div style={{ width: `${fakePercent}%`, backgroundColor: 'var(--p-color-bg-surface-info, #91c0ff)', transition: 'width 0.3s ease' }} />
                          </div>

                          <div style={{ marginTop: '8px', textAlign: 'center' }}>
                            <span style={{ 
                              display: 'block',
                              fontSize: '12px', 
                              lineHeight: '16px',
                              fontWeight: 'bold', 
                              color: isAchieved ? '#2ecc71' : 'var(--p-color-text-subdued, #8a8a8a)'
                            }}>
                              {tier.discount}% {translations.CampaignProgress.off}
                            </span>
                            <Text variant="bodyXs" tone="subdued">{tier.quantity}</Text>
                          </div>
                          
                        </div>
                      );
                    })}
                  </div>
                  
                  <InlineStack gap="300">
                    <InlineStack gap="100" blockAlign="center">
                      <div style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: 'var(--p-color-bg-fill-info, #005bd3)' }} />
                      <Text as="span" variant="bodySm" tone="subdued">{translations.CampaignProgress.realOrders} ({realCount})</Text>
                    </InlineStack>
                    {fakeCount > 0 && (
                      <InlineStack gap="100" blockAlign="center">
                        <div style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: 'var(--p-color-bg-surface-info, #91c0ff)' }} />
                        <Text as="span" variant="bodySm" tone="subdued">{translations.CampaignProgress.fakeCount} ({fakeCount})</Text>
                      </InlineStack>
                    )}
                  </InlineStack>
                </BlockStack>
              </Box>

              <DescriptionList
                items={[
                  // ✨ NEW: Start and End Times formatted nicely
                  { term: translations.Dates.startTime, description: new Date(campaign.startDateTime).toLocaleString() },
                  { term: translations.Dates.endTime, description: new Date(campaign.endDateTime).toLocaleString() },
                  { term: translations.CampaignProgress.terms.scope, description: scopeLabel },
                  { term: translations.CampaignProgress.terms.countingMethod, description: countingLabel },
                  { 
                    term: translations.CampaignProgress.terms.leaderDiscount, 
                    description: campaign.leaderDiscount > 0 
                      ? `${campaign.leaderDiscount}% ${translations.CampaignProgress.off}${
                          campaign.leaderMaxQty > 0 
                            ? ` (${translations.CampaignProgress.max}: ${campaign.leaderMaxQty} ${translations.CampaignProgress.qtySuffix})` 
                            : ''
                        }` 
                      : translations.CampaignProgress.values.disabled 
                  },
                  { term: translations.CampaignProgress.terms.discountAchieved, description: finalDiscountTier ? `${finalDiscountTier.discount}% ${translations.CampaignProgress.off}` : translations.CampaignProgress.values.noneMet },
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* --- BOTTOM ROW: ORDERS TABLE --- */}
        <Layout.Section>
          <Card padding="0">
            <Box padding="400" paddingBlockEnd="0">
              <Text as="h2" variant="headingMd">{translations.ParticipantOrders.title}</Text>
            </Box>
            
            {rows.length > 0 ? (
              <Box paddingBlockStart="400">
                <IndexTable
                  itemCount={rowMarkup.length} 
                  headings={[
                    { title: translations.ParticipantOrders.table.order },
                    { title: translations.ParticipantOrders.table.date },
                    { title: translations.ParticipantOrders.table.customer },
                    { title: translations.ParticipantOrders.table.variant },
                    { title: translations.ParticipantOrders.table.qty },
                    { title: translations.ParticipantOrders.table.role },
                    { title: translations.ParticipantOrders.table.payment },
                    { title: translations.ParticipantOrders.table.fulfillment },
                  ]}
                  selectable={false}
                >
                  {rowMarkup}
                </IndexTable>
              </Box>
            ) : (
              <Box padding="800">
                <EmptyState
                  heading={translations.ParticipantOrders.empty.title}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    {translations.ParticipantOrders.empty.descBase}
                    {campaign.scope === 'VARIANT' ? translations.ParticipantOrders.empty.descVariant : '.'}
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