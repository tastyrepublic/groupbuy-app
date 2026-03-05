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
  DescriptionList,
  Thumbnail,
  Select,
  ProgressBar
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
  let selectedVariantId = url.searchParams.get("variantId"); // This will be a simple ID

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
      id: v.id.split('/').pop(), // Store simple ID
      title: v.title
    }));
  }
  // --- End Fetch ---

  if (!selectedVariantId && allCampaignVariants.length > 0) {
    selectedVariantId = allCampaignVariants[0].id;
  }
  
  const fullVariantId = `gid://shopify/ProductVariant/${selectedVariantId}`;


  // --- 2. Get the Correct List of Participants ---
  let participantQuery = {
    group: { campaignId: campaign.id },
  };

  if (campaign.scope === 'VARIANT') {
    // If "Per-Variant", filter participants by the selected variant
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

  if (participants.length === 0) {
    return json({ 
      campaign, 
      rows: [], // Send empty rows array
      allCampaignVariants, 
      participantData: { count: 0, quantity: 0 } 
    });
  }

  // --- 3. Enrich Data with Shopify Details ---
  const shopifyOrderIds = [...new Set(participants.map(p => p.orderId))];
  const shopifyVariantIds = [...new Set(participants.map(p => p.productVariantId))];

  // Get Order and Customer details
  const orderResponse = await admin.graphql(
    `#graphql
    query getOrderDetails($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id, name, createdAt, displayFinancialStatus,
          customer { displayName }
        }
      }
    }`, { variables: { ids: shopifyOrderIds } }
  );
  const orderData = await orderResponse.json();
  const orderMap = new Map(
    orderData.data.nodes.filter(Boolean).map(order => [order.id, order])
  );

  // Get Variant details (titles)
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
  const rows = participants.map(p => {
    const order = orderMap.get(p.orderId);
    const variant = variantMap.get(p.productVariantId);

    return {
      orderId: p.orderId,
      orderName: order ? order.name : 'Unknown',
      orderShopifyId: order ? order.id.split('/').pop() : '#',
      createdAt: order ? order.createdAt : new Date().toISOString(),
      customerName: order?.customer ? order.customer.displayName : 'No customer',
      paymentStatus: order ? order.displayFinancialStatus : 'UNKNOWN',
      isLeader: p.isLeader,
      quantity: p.quantity,
      variantTitle: variant ? variant.title : (p.productVariantId ? 'Variant not found' : 'N/A')
    };
  });

  // Calculate stats based on the *filtered* list
  const participantData = {
    count: new Set(participants.map(p => p.customerId)).size,
    quantity: participants.reduce((sum, p) => sum + p.quantity, 0)
  };

  return json({ campaign, rows, allCampaignVariants, participantData });
};


// --- PAGE COMPONENT ---

export default function CampaignOrdersPage() {
  const { campaign, rows, allCampaignVariants, participantData } = useLoaderData();
  const navigate = useNavigate();
  
  const url = new URL(window.location.href);
  const [selectedVariantId, setSelectedVariantId] = useState(
    url.searchParams.get("variantId") || allCampaignVariants[0]?.id || ""
  );

  const handleVariantChange = (value) => {
    setSelectedVariantId(value);
    navigate(`/app/campaigns/${campaign.id}/orders?variantId=${value}`);
  };

  const variantOptions = allCampaignVariants.map(v => ({
    label: v.title,
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
  
  // --- ✅ NEW PROGRESS BAR LOGIC ---
  const totalProgress = (
    campaign.countingMethod === 'ITEM_QUANTITY' 
      ? participantData.quantity 
      : participantData.count
  ) + campaign.startingParticipants;

  const progressLabel = campaign.countingMethod === 'ITEM_QUANTITY' 
    ? (campaign.scope === 'VARIANT' ? 'Variant Items Sold' : 'Total Items Sold') 
    : (campaign.scope === 'VARIANT' ? 'Variant Participants' : 'Total Participants');

  const tiers = JSON.parse(campaign.tiersJson);
  const sortedTiers = [...tiers].sort((a, b) => Number(a.quantity) - Number(b.quantity));

  let goalQuantity = 0;
  let progressPercent = 0;
  let progressText = `${totalProgress}`;
  let finalDiscountTier = null;

  if (sortedTiers.length > 0) {
    const finalGoalTier = sortedTiers[sortedTiers.length - 1];
    const nextGoalTier = sortedTiers.find(tier => totalProgress < Number(tier.quantity));
    
    // Use the next tier as the goal, or the final tier if all are met
    goalQuantity = nextGoalTier ? Number(nextGoalTier.quantity) : Number(finalGoalTier.quantity);
    
    if (goalQuantity > 0) {
      progressPercent = Math.min((totalProgress / goalQuantity) * 100, 100);
    }
    progressText = `${totalProgress} / ${goalQuantity}`;
    
    // Find the highest tier that has been *achieved*
    const achievedTiers = [...tiers].sort((a, b) => Number(b.quantity) - Number(a.quantity));
    finalDiscountTier = achievedTiers.find(tier => totalProgress >= Number(tier.quantity));
  }
  
  const scopeLabel = campaign.scope === 'PRODUCT' ? 'Product-wide' : 'Per-Variant';
  const countingLabel = campaign.countingMethod === 'ITEM_QUANTITY' ? 'By Item Quantity' : 'By Participants';
  // --- END NEW LOGIC ---


  const rowMarkup = rows.map((row, index) => {
    return (
      <IndexTable.Row id={`${row.orderId}-${index}`} key={`${row.orderId}-${index}`} position={index}>
        <IndexTable.Cell>
          <Link
            url={`shopify://admin/orders/${row.orderShopifyId}`}
            target="_top"
            removeUnderline
          >
            {row.orderName}
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
      </IndexTable.Row>
    );
  });

  return (
    <Page
      title={`Orders for "${campaign.productTitle}"`}
      backAction={{ content: 'Campaigns', url: '/app' }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
            
              {/* --- ✅ NEW: Progress Bar Section --- */}
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" tone="subdued">
                  {progressLabel}
                </Text>
                <ProgressBar progress={progressPercent} tone="primary" size="small" />
                <Text as="p" variant="bodyMd" fontWeight="semibold" alignment="end">
                  {progressText}
                </Text>
              </BlockStack>
              {/* --- END Progress Bar --- */}
              
              <DescriptionList
                items={[
                  {
                    term: 'Product',
                    description: (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Thumbnail source={campaign.productImage} alt={campaign.productTitle} />
                        <Text as="span" fontWeight="semibold">{campaign.productTitle}</Text>
                      </div>
                    ),
                  },
                  ...(campaign.scope === 'VARIANT' ? [{
                    term: 'Viewing Variant',
                    description: (
                      <Select
                        options={variantOptions}
                        onChange={handleVariantChange}
                        value={selectedVariantId}
                      />
                    )
                  }] : []),
                  {
                    term: 'Campaign Scope',
                    description: scopeLabel
                  },
                  {
                    term: 'Counting Method',
                    description: countingLabel
                  },
                  { term: 'Discount Achieved', description: finalDiscountTier ? `${finalDiscountTier.discount}% off` : 'None' },
                ]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {rows.length > 0 ? (
              <IndexTable
                itemCount={rows.length}
                headings={[
                  { title: 'Order' },
                  { title: 'Date' },
                  { title: 'Customer' },
                  { title: 'Variant' },
                  { title: 'Qty' },
                  { title: 'Role' },
                  { title: 'Payment Status' },
                ]}
                selectable={false}
              >
                {rowMarkup}
              </IndexTable>
            ) : (
              <div style={{ padding: '16px', textAlign: 'center' }}>
                <Text as="p">No orders have been placed for this campaign {campaign.scope === 'VARIANT' ? 'for this variant' : ''} yet.</Text>
              </div>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}