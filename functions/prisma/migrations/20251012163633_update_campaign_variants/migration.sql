/*
  Warnings:

  - You are about to drop the column `productVariantId` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `productVariantTitle` on the `Campaign` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."Campaign" DROP COLUMN "productVariantId",
DROP COLUMN "productVariantTitle",
ADD COLUMN     "selectedVariantIdsJson" TEXT;
