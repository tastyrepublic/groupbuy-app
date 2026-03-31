const admin = require("firebase-admin");
const { PrismaClient } = require("@prisma/client");
const { Resend } = require("resend");

// 1. Initialize Firebase exactly once
if (!admin.apps.length) {
  admin.initializeApp();
}
const firestore = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// 2. Initialize Prisma exactly once
const prisma = new PrismaClient();

// 3. Initialize Resend exactly once
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = { admin, firestore, FieldValue, prisma, resend };