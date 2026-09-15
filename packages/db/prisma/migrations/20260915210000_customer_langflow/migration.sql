-- AlterTable
ALTER TABLE "customer_behaviors" ADD COLUMN     "knowledge" JSONB,
ADD COLUMN     "modelCredentialId" TEXT,
ADD COLUMN     "modelId" TEXT,
ADD COLUMN     "runtime" JSONB,
ALTER COLUMN "credentialId" DROP NOT NULL;
