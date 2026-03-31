const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function shopifyGraphQL(shop, accessToken, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/2025-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables })
  });
  
  if (!response.ok) {
    throw new Error(`Shopify API HTTP Error: ${response.status}`);
  }
  return response.json();
}

module.exports = { shopifyGraphQL };