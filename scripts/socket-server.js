// This is socket-server.js
import 'dotenv/config';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PubSub } from '@google-cloud/pubsub';

const pubSubClient = new PubSub();
const updateSubscriptionName = 'campaign-progress-updates-sub';
const port = 8080;

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });

/**
 * Creates a unique room key based on campaign scope
 */
function getRoomKey(campaignId, campaignScope, productVariantId) {
  if (campaignScope === 'PRODUCT') {
    return `campaign_${campaignId}`;
  } else {
    // Normalize the variant ID just in case
    const simpleVariantId = productVariantId.split('/').pop();
    return `campaign_${campaignId}_variant_${simpleVariantId}`;
  }
}

/**
 * Broadcasts a message to all clients in a specific room.
 */
function broadcast(roomKey, message) {
  io.to(roomKey).emit('update', message);
  console.log(`Socket Server: Broadcasted update to room ${roomKey}`);
}

// 1. --- Handle New Socket.IO Connections ---
io.on('connection', (socket) => {
  console.log(`Socket Server: Client connected (${socket.id})`);

  // Listen for a "subscribe" message from the client
  socket.on('subscribe', (data) => {
    try {
      if (data && data.campaignId && data.productVariantId && data.campaignScope) {
        const roomKey = getRoomKey(data.campaignId, data.campaignScope, data.productVariantId);
        
        // socket.join adds this client to the room
        socket.join(roomKey);
        console.log(`Socket Server: Client ${socket.id} joined room ${roomKey}`);
      }
    } catch (e) {
      console.error('Socket Server: Failed to subscribe', e);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Socket Server: Client disconnected (${socket.id})`);
    // Socket.IO automatically handles leaving rooms on disconnect.
  });
});

// 2. --- Listen for Internal Updates (from your worker) ---
try {
  const subscription = pubSubClient.subscription(updateSubscriptionName);
  
  const messageHandler = (message) => {
    try {
      const data = JSON.parse(message.data.toString());
      if (data.campaignId && data.newProgress !== undefined) {
        
        const { campaignId, campaignScope, productVariantId, newProgress } = data;
        
        // Find the correct room and broadcast the update
        const roomKey = getRoomKey(campaignId, campaignScope, productVariantId);
        broadcast(roomKey, {
          newProgress: newProgress
        });
        
      }
    } catch (e) { console.error('Socket Server: Error processing Pub/Sub message:', e); }
    message.ack();
  };

  subscription.on('message', messageHandler);

  httpServer.listen(port, () => {
    console.log(`🚀 Socket.IO Server listening on http://localhost:${port}`);
    console.log(`Socket Server: Subscribed to Pub/Sub topic "${updateSubscriptionName}" for updates.`);
  });

} catch (error) {
  console.error(`Socket Server: Failed to subscribe to Pub/Sub topic "${updateSubscriptionName}".`);
  console.error(error);
  process.exit(1);
}