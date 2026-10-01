-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "studyProgramId" INTEGER NOT NULL,
    "timeZone" TEXT NOT NULL,
    "deviceInfo" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastNotifiedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "subscriptions_studyProgramId_idx" ON "subscriptions"("studyProgramId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_channel_address_studyProgramId_key" ON "subscriptions"("channel", "address", "studyProgramId");
