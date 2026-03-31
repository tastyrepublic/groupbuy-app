// 1. Webhooks
const { processGroupBuyOrder } = require("./webhooks/orderCreated");
const { processOrderCancellation } = require("./webhooks/orderCancelled");
const { processOrderUpdate } = require("./webhooks/orderUpdated");

// 2. Cron Jobs
const { campaignFinalizer } = require("./crons/sweeper");

// Export to Firebase
exports.processGroupBuyOrder = processGroupBuyOrder;
exports.processOrderCancellation = processOrderCancellation;
exports.processOrderUpdate = processOrderUpdate;
exports.campaignFinalizer = campaignFinalizer;