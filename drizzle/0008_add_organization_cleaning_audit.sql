ALTER TABLE `organizations` ADD COLUMN `cleaning_status` text DEFAULT 'unreviewed' NOT NULL;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `audit_note` text;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `retry_count` integer DEFAULT 0 NOT NULL;
