-- AlterTable
ALTER TABLE "public"."Campaign" ADD COLUMN     "schedulerJobName" TEXT,
ADD COLUMN     "startingParticipants" INTEGER NOT NULL DEFAULT 0;
