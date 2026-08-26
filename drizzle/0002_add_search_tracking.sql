ALTER TABLE `organizations` ADD COLUMN `last_searched_at` text;
--> statement-breakpoint
ALTER TABLE `organizations` ADD COLUMN `search_status` text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
CREATE INDEX `organizations_search_schedule_idx` ON `organizations` (`search_status`,`last_searched_at`);
