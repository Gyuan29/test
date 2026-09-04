ALTER TABLE `events` ADD COLUMN `canonical_source_url` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `events_organization_canonical_source_uq` ON `events` (`organization_id`,`canonical_source_url`);
